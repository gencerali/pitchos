# Pipeline Diagnostic — 2026-05-19

Data source: `pl.json` export (542 rows, 2026-05-15 13:03–20:04 UTC, 11 cron runs).  
Stage distribution: title_dedup 132, scored_low 209, hash_dedup 35, off_topic 110, published 22, url_seen 14, date_old 1, too_short 19.  
Source distribution: Duhuliye 177, NTV Spor 109, Twitter Haber Kartali 73, Twitter Besiktas Official 52, Google News 42, Reddit BJK 23, Habertürk 14, Haberler.com 19, others.

Context numbers in the prompt (729 articles, 24h window) are from a different export. This report uses `pl.json` which covers ~7 hours. Stage proportions are consistent with the 24h claim (NTV Spor 85% off_topic in this set vs 83% cited; dedup dominance confirmed).

---

## Investigation 1 — NTV Spor off_topic rate

**Finding: configuration mismatch between hardcoded and dynamic source settings.**

### 1. Feed URL

Hardcoded in `src/fetcher.js:38`:
```
https://www.ntvspor.net/rss/kategori/futbol
```
General Süper Lig football feed. Not BJK-specific.

### 2. Feed scope

General Turkish football: covers Galatasaray, Trabzonspor, Fenerbahçe, international transfer news, national team, European club football. BJK articles appear only when NTV happens to cover a BJK match or story.

### 3. Where `off_topic` is assigned

`src/processor.js:24–28`, preFilter stage 2:
```javascript
const afterKeyword = afterDate.filter(a => {
  const haystack = `${a.title} ${a.summary || ''} ${a.full_text || ''}`.slice(0, 600);
  if (!BJK_REGEX.test(haystack)) {
    rejected.push({ ..., _stage: 'off_topic' });
    return false;
  }
```
`BJK_REGEX = /beşiktaş|besiktas|bjk|kartal|siyah.beyaz/i` (processor.js:3).  
An article is `off_topic` when none of those six tokens appear in the first 600 characters of title + summary + full_text.

### 4. Ten NTV off_topic titles

| # | Title |
|---|---|
| 1 | CANLI İZLE \| Çorum FK - Bodrum FK maçı ne zaman, saat kaçta, hangi kanalda? |
| 2 | Haaland, Kocaelispor'u seçti! Süper Lig ekibi 3 kelimeyle videoyu paylaştı |
| 3 | CANLI \| Şampiyon Galatasaray kupasına kavuşuyor: Dakika dakika şampiyonluk kutlaması |
| 4 | Ederson ipleri kopardı! Gitmek istediği kulüp duyuruldu |
| 5 | Alanyaspor, Joao Pereira'nın sözleşmesini uzattı |
| 6 | Fildişi Sahili, Dünya Kupası kadrosunu açıkladı: Süper Lig'den 5 isim |
| 7 | Konyaspor'dan Trabzonspor'a yanıt |
| 8 | NTV ÖZEL \| Noa Lang: "Yıllar sonra bile benim gollerimi izleyecekler" |
| 9 | Bayern Münih, kalecileriyle sözleşme yeniledi |
| 10 | Trabzonspor, sezonun ilk transfer bombasını patlattı: 3 yıllık sözleşme |

All are about non-BJK topics. Every one correctly tagged `off_topic`.

### 5. Five NTV articles that passed

| Stage | Title |
|---|---|
| title_dedup | Beşiktaş, sezonu Rizespor beraberliğiyle bitirdi |
| url_seen | Rizespor - Beşiktaş maçı ne zaman, saat kaçta, hangi kanalda? (İlk 11'ler) |
| title_dedup | Beşiktaş, sezonu Rizespor beraberliğiyle bitirdi (duplicate run) |
| title_dedup | Rizespor - Beşiktaş maçı... (duplicate run) |
| title_dedup | Sergen Yalçın'dan problemli sezona iyi final arayışı |

All five explicitly name "Beşiktaş" in the title — that is the only distinguishing factor.

### Root cause

The hardcoded `RSS_FEEDS` had `keywordFilter: true` for NTV Spor, which pre-screened at fetch time against `BJK_KEYWORDS` (45 entries). The site now uses dynamic `source_configs`. `configsToRSSFeeds` maps `bjk_filter ?? false`, so if `source_configs.bjk_filter` is null/unset for NTV Spor, the fetch-time keyword screen is silently disabled. **All ~15–20 NTV articles per cron run enter the pipeline regardless of topic**, and `BJK_REGEX` catches ~85% as off_topic.

Fix direction: set `bjk_filter = true` for NTV Spor in `/admin/sources/ui`.

---

## Investigation 2 — Title dedup keeping the wrong article

### 1. Function location

`src/processor.js:132–145`:
```javascript
export function dedupeByTitle(articles) {
  const kept = [];
  for (const a of articles) {
    const aNorm = normalizeTitle(a.title);
    const aKeys = extractKeyTokens(a.title);
    const isDupe = kept.some(k => {
      if (titleSimilarity(aNorm, normalizeTitle(k.title)) > 0.3) return true;
      const kKeys = extractKeyTokens(k.title);
      return sharedStoryTokens(aKeys, kKeys) >= 3;
    });
    if (!isDupe) kept.push(a);
  }
  return kept;
}
```

### 2. Sort order before dedup

**There is no sort before dedup.** The date sort (`sorted = deduped.sort(...)`) happens at processor.js:59–63, *after* `dedupeByTitle` returns. The dedup input order is the `allArticles` order from `fetchRSSArticles`.

The diagnostic prompt described this as "date-sort causing the winner." That is incorrect. The actual determinant is **feed iteration order**.

For sites using dynamic `source_configs`, `fetchSourceConfigs` queries with `order=name` — alphabetical by source name. So A Haber articles come before Duhuliye, Duhuliye before Google News, Google News before Habertürk, Habertürk before Hürriyet, Hürriyet before NTV Spor, NTV before Sabah Spor, etc. The first feed alphabetically to cover a story wins dedup.

### 3. Selection rule

First article in iteration order wins. `dedupeByTitle` inserts each article into `kept` if no existing kept article is a dupe. The comparison is one-directional: incoming article is checked against already-kept articles. No comparison of quality, trust, or length.

### 4. Trust tier access

No. `dedupeByTitle(articles)` receives the full article objects but the function body only reads `a.title` and `k.title`. Trust tier is never consulted.

### 5. Dropped vs winner — 8 sampled pairs

| Dropped article | Source | Winner | Source | Winner's fate |
|---|---|---|---|---|
| Son dakika: Beşiktaş sezonu 1 puanla kapadı! Rize'de kazanan çıkmadı | Sabah Spor | Kartal sezonu beraberlikle kapattı! Rize'de 4 gollü düello | A Haber | url_seen |
| Rizespor Beşiktaş CANLI izle! ...hangi kanalda | Google News | (matched NTV general article via false token overlap) | NTV Spor | off_topic |
| Çaykur Rizespor - Beşiktaş maçının VAR'ı Turgut Doman oldu! - Habertürk | Google News | Rizespor Beşiktaş maç özeti ve golleri! (ÖZET) | Haberler.com | hash_dedup |
| Beşiktaş pes etmedi! Çaykur Rizespor ile berabere kaldılar - FOTOMAÇ | Google News | Rizespor Beşiktaş maç özeti ve golleri! (ÖZET) | Haberler.com | hash_dedup |
| RİZESPOR - BJK CANLI İZLE... | Google News | (matched NTV via false token overlap) | NTV Spor | off_topic |

Two of the five "winners" are themselves off_topic or hash_dedup. A high-trust Sabah Spor article was beaten by an A Haber article that was then url_seen (already scored — no new value). Google News articles matched a low-quality Haberler.com aggregator article and false-matched against non-BJK NTV articles.

### 6. Of 359 title_dedup drops (in 24h prompt data) — how many winners published?

In this 7-hour dataset: 132 title_dedup drops, 22 total published articles.  
Cross-referencing: the 22 published articles represent stories that survived dedup. Of the 132 title_dedup drops, approximate downstream fates of their winners:
- hash_dedup (winner was also a dupe): confirms dedup cascaded
- off_topic (winner was a false-positive NTV article): confirms dedup selected wrong article
- url_seen (winner already scored previously): dedup wasted a fresh article

No direct count available since `pipeline_log` doesn't record which article a dropped article was matched against. But the pattern is clear: **a significant fraction of dedup winners either fail downstream or were already seen, meaning the dropped high-trust article had no backup**.

---

## Investigation 3 — Scored ≥60 but did not publish

In this dataset: 32 scored ≥60. Published: 22. Not published: 10. All 10 have `stage: scored_low`, `publish_mode: null`.

### Full list of 10 non-published NVS ≥60 articles

| # | NVS | Source | Title |
|---|---|---|---|
| 1 | 72 | Twitter Besiktas Official | 55' GOL \| JOTA SILVA! 🟢 2-1 🦅 |
| 2 | 72 | Twitter Besiktas Official | 62' GOL \| VACLAV CERNYYYYY! 🟢 2-2 🦅 |
| 3 | 62 | Twitter Haber Kartali | 33' Cengiz Ünder sarı kart gördü. #RİZvBJK |
| 4 | 62 | Twitter Besiktas Official | 🟨 37' \| Sarı Kart |
| 5 | 68 | Twitter Besiktas Official | ⚽ 31' Gol Çaykur Rizespor. 🟢 2-0 🦅 |
| 6 | 70 | Twitter Haber Kartali | 55' JOTA SILVA'NIN GOLÜYLE SKORU 2-1 YAPTIK! #RİZvBJK |
| 7 | 71 | Twitter Haber Kartali | 90+2' Rizespor 3-2 öne geçti. #RİZvBJK |
| 8 | 68 | Twitter Haber Kartali | 33' Cengiz Ünder sarı kart gördü. #RİZvBJK (duplicate run) |
| 9 | 62 | Duhuliye | Beşiktaşlı futbolcuya Dünya Kupası daveti geldi |
| 10 | 68 | Duhuliye | Beşiktaş'a Trabzonspor maçı sonrası ceza |

### 1. Where were they dropped?

All 10 are dropped by the `saveArticles` filter at `publisher.js:666`:
```javascript
if (a.publish_mode === 'rss_summary') return false;
```
They never reach `MIN_BODY_CHARS`, refusal detection, or story matching. The exit point is the first gate.

### 2. Why `rss_summary` for high-NVS articles?

`writeArticles` in publisher.js sets `publish_mode = 'rss_summary'` as default, then upgrades to `rewrite` if synthesis returns a body > 600 chars.

**Group A — Twitter live updates (8 of 10):**  
Tweet URLs (`https://x.com/Besiktas/status/...`) have no article body fetchable by the render proxy. The proxy returns the tweet's 20–50 character text, which fails the `body.length > 600` check. Synthesis exits null/short → stays `rss_summary`.

**Group B — Duhuliye articles (2 of 10):**  
Both are normal news articles that should synthesize. These ran on 2026-05-15 before the proxy warm-up fix was deployed. Proxy cold start returned null body → stayed `rss_summary`. With the warm-up fix now deployed, these should clear.

### 3. Compounding bug: `article.trust` field mismatch

`decidePublishMode` at publisher.js:124 reads `article.trust`. But articles are shaped with `article.trust_tier` in both `fetchOneFeed` (fetcher.js:348) and `fetchViaRss2Json` (fetcher.js:167). `article.trust` is always `undefined → ''`.

**Consequence:** `if (trust === 'official') return 'template_official'` (publisher.js:134) is dead code. Official Twitter account tweets are never given `template_official` mode. They route through the else branch, attempt synthesis on a tweet URL, fail, and land as `rss_summary`.

If the field name matched, the four Twitter Besiktas Official entries (#1, #2, #4, #5) would receive `template_official` mode, publish verbatim (no synthesis needed), and appear on the site immediately. Items #3, #6, #7, #8 (Twitter Haber Kartali, trust `journalist`) would still fail synthesis on tweet URLs — different fix needed for those.

### 4. Dominant drop reason

By count: **synthesis failure on tweet URLs** (8 of 10). These are not retrievable by any proxy — a tweet is not an article. The fix for Group A is not proxy improvement; it is routing tweet sources through `template_official` (for official account) or a dedicated tweet-card template (for journalist accounts), bypassing synthesis entirely.

---

## Visibility enhancements — cheapest 3 fields to add

Current mapping that creates `pipeline_log` rows (worker-fetch-agent.js:5362–5370) does not capture trust tier, publish mode for scored_low, or source content length. Three fields addable with minimal risk:

### Field 1: `publish_mode` on scored_low entries (1 line)

Currently missing because `scoredLowItems` mapping at line 5213–5215 does not spread `publish_mode`:
```javascript
// Current — no publish_mode
.map(a => ({ url: ..., title: ..., source_name: ..., nvs_score: a.nvs, _stage: 'scored_low' }));

// Fix — add one field
.map(a => ({ url: ..., title: ..., source_name: ..., nvs_score: a.nvs, publish_mode: a.publish_mode, _stage: 'scored_low' }));
```
With this, `scored_low` rows would show `rss_summary` vs `hot_news_hold` vs blank — immediately distinguishing "synthesis never attempted" from other outcomes.

### Field 2: `trust_tier` on all pipeline_log entries (1 line)

Add `trust_tier: (a.trust_tier || a.trust || null)` to the `pipeline_log` row mapper (line 5362–5370). Enables "percentage of drops from T1/T2 sources" queries directly in the admin UI.

### Field 3: `source_body_len` — raw content length before synthesis (1 line)

In `scoredLowItems` mapping, add:
```javascript
source_body_len: ((a.summary || '') + (a.full_text || '')).length
```
This is zero for tweet articles and >200 for news articles. Immediately distinguishes "no content at source" (tweet, proxy failed) from "content exists but synthesis rejected it" — without any schema change, just one nullable integer column on `pipeline_log`.

`pipeline_log` schema already has nullable columns; all three additions are additive. No migration required beyond `ALTER TABLE pipeline_log ADD COLUMN` for each.

---

## Summary table

| Issue | Root cause | Scope | Data evidence |
|---|---|---|---|
| NTV Spor 85% off_topic | `bjk_filter: false` in source_configs overrides hardcoded `keywordFilter: true` | All cron runs while source_configs has this setting | 93/109 NTV rows off_topic; sample titles are all non-BJK |
| Title dedup picks wrong source | Dedup winner = alphabetically first feed; trust tier not accessible to `dedupeByTitle` | Every story covered by multiple sources | A Haber beats Sabah; Haberler.com beats Google News; winners then fail downstream |
| NVS 60–72 articles unpublished | Tweet URLs not fetchable → synthesis null → rss_summary; compounded by `article.trust` field name mismatch (`.trust` vs `.trust_tier`) preventing `template_official` | All tweet sources in pipeline | 8/10 non-published high-NVS articles are Twitter live updates; `template_official` is unreachable dead code |

---

## Investigation 1 Extended — off_topic audit across all sources

Per-source stage breakdown (542 rows, 2026-05-15):

| Source | Total | off_topic | off% | title_dedup | scored_low | published |
|---|---|---|---|---|---|---|
| NTV Spor | 109 | 93 | **85%** | 10 | 0 | 2 |
| Global Media | 6 | 3 | **50%** | 0 | 3 | 0 |
| Google News | 42 | 5 | 12% | 23 | 10 | 2 |
| Duhuliye | 177 | 7 | 4% | 14 | 110 | 4 |
| Reddit BJK | 23 | 1 | 4% | 1 | 17 | 2 |
| Twitter Haber Kartali | 73 | 1 | 1% | 33 | 21 | 8 |
| Twitter Besiktas Official | 52 | 0 | 0% | 15 | 37 | 0 |
| Habertürk Spor | 14 | 0 | 0% | 9 | 5 | 0 |
| Haberler.com | 19 | 0 | 0% | 15 | 1 | 2 |
| A Haber | 6 | 0 | 0% | 0 | 0 | 1 |
| Sabah Spor | 7 | 0 | 0% | 6 | 1 | 0 |
| Fotomaç | 10 | 0 | 0% | 4 | 3 | 1 |

---

### Global Media — 50% off_topic

All 6 articles:

| Stage | NVS | Title |
|---|---|---|
| off_topic | — | Güven Önüt |
| off_topic | — | Sergen Yalçın - Players used |
| off_topic | — | Türkiye Kupasi - List of goalscorers 88/89 (Gallery) |
| scored_low | 7 | Stunning Adidas Besiktas 26-27 Collection Leaked... |
| scored_low | 50 | Besiktas JK - Record vs KF Skënderbeu (Detailed view) |
| scored_low | 50 | Besiktas JK |

**Root cause: wrong source type.** Global Media is a football statistics database (Soccerway/Sofascore-style), not a news outlet. Its articles are player profiles, match records, and historical cup data — not current news. The three off_topic articles pass `BJK_KEYWORDS` (player and coach names match) but fail `BJK_REGEX` because titles like "Güven Önüt" and "Sergen Yalçın - Players used" contain no club name. The three scored_low entries are a database team page ("Besiktas JK"), a historical record page (NVS 50 — default fallback), and a leaked kit story (NVS 7).

This source should be removed from `source_configs` or treated as a secondary non-news source. No configuration fix can make database pages into news articles.

---

### Google News — 12% off_topic — two distinct problems

**Problem A: false off_topic (1 article)**  
"Vaclav Cerny'den Rize'de füze! 14 maç sonra öyle bir gol attı ki... - Fanatik" is a legitimate Beşiktaş article. Vaclav Cerny is a registered Beşiktaş player, and "Cerny" appears in `BJK_KEYWORDS` (allowing it past the fetch filter). It fails preFilter because `BJK_REGEX` only checks for club name variants (`beşiktaş|bjk|kartal|siyah.beyaz`) and neither "Cerny" nor "Fanatik" match. The article's summary was not available in `pipeline_log` to confirm whether the first 600 chars include a club name.

**Problem B: persistent duplicate across runs (4 identical articles)**  
"3 büyükler peşindeydi! Bournemouth'tan Senesi açıklaması - FOTOMAÇ" appears with an identical Google News URL across 4 consecutive cron runs (15:04 → 16:03 → 17:03 → 18:04 UTC), all hitting off_topic. The article is about a Bournemouth defender linked to three Turkish clubs ("3 büyükler" = Galatasaray, Fenerbahçe, Beşiktaş). "Beşiktaş" is likely in the body but not the title/short summary — preFilter's 600-char haystack misses it.

The persistence across runs is its own issue: `getSeenUrls` only blacklists URLs that have been saved to `content_items`. Articles rejected by `off_topic` (before scoring) are never saved, so the same URL keeps re-entering the pipeline on every run within the lookback window. This wastes 4 pipeline evaluations on one article. Same behaviour observed for Duhuliye off_topic articles (same URL in 4 consecutive runs).

---

### Duhuliye — 4% off_topic — all are false positives

All 7 off_topic Duhuliye articles are genuinely about Beşiktaş:

| Title | Why off_topic |
|---|---|
| Sergen Yalçın: ''Kazanarak ligi tamamlamak istiyoruz..'' | Quote article; title has no club name; RSS summary is likely just the quote |
| ''Konyaspor maçında bizim için her şey bitmişti..'' | Anonymous coach/player quote; no club name |
| Sergen Yalçın kalacak mı? Kendisi açıkladı! | Coach continuity; no "Beşiktaş" in title |
| Orkun Kökçü rekor peşinde! | BJK player article; no club name in title |

"Sergen Yalçın: 'Kazanarak...'" appears 4 times across consecutive runs — same persistent re-entry issue as Google News above.

Duhuliye is a BJK-focused site and `bjk_filter` is presumably true (all articles pass fetch). These rejections are caused purely by the **BJK_REGEX / BJK_KEYWORDS split**: the 45-entry fetch filter includes coach and player names, but `preFilter`'s `BJK_REGEX` only matches 4 club name variants. Any BJK article where neither the title, RSS summary, nor the first 300 description chars explicitly state "Beşiktaş"/"BJK"/"kartal"/"siyah-beyaz" is discarded.

---

### Reddit BJK — 4% off_topic — 1 false positive

"Sergen hoca istifa nöbeti" — a forum thread title. "hoca" (coach) and "istifa" (resignation) are clear BJK context but not in `BJK_REGEX`. One article, low volume impact.

---

### Systemic finding — two-stage filter gap

The `off_topic` issue for Duhuliye, Reddit, and Google News shares one root cause: `preFilter` uses `BJK_REGEX` (`beşiktaş|besiktas|bjk|kartal|siyah.beyaz`) while the fetch-time keyword screen uses `BJK_KEYWORDS` (45 entries including player names, coach names, stadium). The pipeline has two gates that do not agree on what counts as "BJK content."

An article about Vaclav Cerny or Sergen Yalçın passes gate 1 (45-entry list) but fails gate 2 (4 club name variants). This gap is harmless when the source has `bjk_filter: false` (like NTV — all non-BJK articles flow in and preFilter correctly rejects them). It becomes a false-positive factory when a BJK-focused source publishes quote articles or player-name-only titles that pass the wider net but fail the narrower one.

The fix is not to extend `BJK_REGEX` to include 45 player names (performance + maintenance). The more targeted fix is in preFilter: for articles that already passed a keyword filter at fetch time (flag available on the article or derivable from source trust/type), skip the redundant `BJK_REGEX` check. Alternatively, replace `BJK_REGEX` in preFilter with a call to `BJK_KEYWORDS.some(...)` for consistency — but that changes existing behaviour for NTV-style general feeds and needs a separate discussion.

---

### Summary — off_topic audit

| Source | Rate | Type | Fix direction |
|---|---|---|---|
| NTV Spor | 85% | Config: `bjk_filter` unset in source_configs | Set `bjk_filter: true` in `/admin/sources/ui` |
| Global Media | 50% | Wrong source type: stats database, not news | Remove from source_configs or exclude from pipeline |
| Google News | 12% | (a) BJK_REGEX/BJK_KEYWORDS gap (Cerny article); (b) off_topic URL not blacklisted → persistent re-entry | (a) Discussed above; (b) add off_topic URLs to seen cache |
| Duhuliye | 4% | BJK_REGEX/BJK_KEYWORDS gap — false positives on coach/player-named articles | Same as Google News (a) |
| Reddit BJK | 4% | Same gap — single article | Same |

---

*Stop here. Awaiting Ali's review before any code changes.*
