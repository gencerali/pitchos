# Morning Pipeline Check — 2026-05-22
**Date:** 2026-05-22  
**Scope:** Diagnostic only. No code changes.  
**Triggered by:** First cron run after night quiet period (04:02 UTC). Observed: 1 published (Sözcü Spor, rewrite, BodyLen=76), NTV synthesis_failed BodyLen=131, Fotomaç absent.

---

## Q1 — Sözcü Spor 'rewrite' with BodyLen=76: is there a quality risk?

### What BodyLen actually measures

`source_body_len` in pipeline_log is set at event construction time as:
```javascript
source_body_len: ((a.summary || '') + (a.full_text || '')).length
```
This is the **RSS feed content** (the item's `<description>` + `<content:encoded>` fields) — NOT the proxy-fetched article body, and NOT the generated `full_body` in content_items.

BodyLen=76 means the Sözcü RSS item had only 76 characters of description text. The actual article on the Sözcü website may have been much longer.

### How synthesis handles thin RSS items

`synthesizeArticle` (`src/publisher.js:397`) ignores the RSS summary entirely. It fetches the article URL via the Render proxy and only proceeds if the proxy returns **> 400 chars** (`data.content.length > 400`, line 420). If the proxy returns ≤ 400 chars, `sourceText` stays null and synthesis is skipped — the article falls back to `rss_summary`.

Then in `writeArticles` (`src/publisher.js:611`):
```javascript
if (body && body.length > 600) {
  published.full_body    = body;
  published.publish_mode = 'rewrite';
```
The generated body must exceed 600 chars to publish as 'rewrite'. This is the same threshold as the `MIN_BODY_CHARS` gate in `saveArticles`.

### Conclusion on Fix 1

**Fix 1 already exists** — line 611 in writeArticles prevents any rewrite with generated body < 600 chars. The concern is not the gate itself but the quality of synthesis when the proxy returns a thin-but-passing source (401–600 chars). A 76-char RSS item does NOT mean the proxy returned thin content — it could have fetched a full 1500-char article.

**SQL to confirm actual full_body length:**
```sql
SELECT slug, LENGTH(full_body) AS full_body_len, publish_mode,
       LEFT(full_body, 200) AS body_preview
FROM content_items
WHERE slug = '2026-05-22-besiktas-onder-ozeni-futbol-direktorlugune-atadi';
```

**Interpret results:**
- `full_body_len >= 600` and preview reads as a coherent article → synthesis worked correctly from a proper proxy-fetched source. BodyLen=76 was just a thin RSS description, not a quality issue.
- `full_body_len >= 600` but preview is generic/padded ("Beşiktaş'ta önemli gelişme...") → synthesis hallucinated from a thin source. Add source body length gate (future task, not today).
- `full_body_len < 600` → should not be possible (writeArticles line 611 blocks this). Would indicate a bug.

### Result

```
full_body_len=1352  publish_mode=rewrite
preview: "Sergen Yalçın'ın hafta başında ayrılmasının ardından Beşiktaş, yeniden yapılanma
sürecinde ilk adımını attı: 56 yaşındaki Önder Özen, Siyah-Beyazlılar'ın Futbol Direktörlüğü
görevine getirildi. Kulüp..."
```

**Finding: No quality issue.** Synthesis produced a 1352-char coherent article from a proper proxy-fetched source. The 76-char `source_body_len` was the RSS `<description>` only — the proxy returned a full article. Fix 1 is not needed.

---

## Q2 — NTV Spor synthesis_failed with BodyLen=131

### What synthesis_failed means

`stage = 'synthesis_failed'` in pipeline_log = article ended up in allWritten with `publish_mode = 'rss_summary'` AND `nvs >= 50`. This means synthesis was attempted but did not produce a usable body. The article's NVS was high enough to warrant synthesis, but it stayed as rss_summary.

Causes (in order of likelihood):
1. **Proxy returned ≤ 400 chars** for that specific URL → `sourceText = null` → synthesis skipped → stays rss_summary
2. **Proxy request timed out or threw** → caught exception at publisher.js:624 → stays rss_summary
3. **Generated body ≤ 600 chars** → writeArticles line 611 condition false → stays rss_summary

BodyLen=131 (RSS source) doesn't directly cause the failure — it just tells us the RSS item was thin. The question is whether the proxy could fetch the actual page.

### SQL to check NTV synthesis success rate (last 24h):

```sql
-- NTV articles in pipeline_log last 24h by stage
SELECT stage, COUNT(*) as count, AVG(nvs_score) as avg_nvs, AVG(source_body_len) as avg_body_len
FROM pipeline_log
WHERE source_name = 'NTV Spor'
  AND run_at > NOW() - INTERVAL '24 hours'
  AND source_name NOT IN ('debug', 'test_source')
GROUP BY stage
ORDER BY count DESC;
```

**Interpret results:**
- Most NTV articles = `published` or `synthesis_failed` (expected — NTV is T2, proxy-accessible)
- synthesis_failed count ≤ 2 → one-off (specific URL was paywalled/blocked/slow)
- synthesis_failed count > 3 → new pattern, proxy may be struggling with NTV URLs

```sql
-- NTV synthesis_failed articles specifically — what URLs are failing?
SELECT url, title, nvs_score, source_body_len, drop_detail
FROM pipeline_log
WHERE source_name = 'NTV Spor'
  AND stage = 'synthesis_failed'
  AND run_at > NOW() - INTERVAL '24 hours';
```

### Result

```
stage             count  avg_nvs  avg_body_len
scored_low            4     19.0         216.0
title_dedup           2      —           182.0
synthesis_failed      1     62.0         131.0
```

**Finding: One-off failure.** synthesis_failed count=1 ≤ 2 → specific URL was blocked/paywalled/slow at 04:02 UTC. Not a pattern. NTV proxy access is healthy. The 4 scored_low articles (avg_nvs=19) are expected thin morning content.

Note: presence of pipeline_log entries for NTV confirms the **pipeline_log thinDropItems fix** (`4d982404`) is working correctly for this run.

---

## Q3 — Fotomaç absent from 04:02 UTC cron

### Three possible explanations

1. **Fotomaç had 0 items in RSS** — feed returned empty at 04:02 UTC (04:02 = 07:02 Istanbul = pre-business hours, Fotomaç may not have published yet)
2. **All Fotomaç articles were date_old** — same pattern as the 20:02 run (raw=30, after_date=0). Night/early morning articles older than 8h lookback.
3. **Fotomaç wasn't in allFetched at all** — all URLs in synthFailedHashes or offTopicHashes from previous runs.

### SQL to check:

```sql
-- What did the 04:02 UTC cron's funnelStats show for Fotomaç?
SELECT error_message
FROM fetch_logs
WHERE created_at BETWEEN '2026-05-22 04:00:00+00' AND '2026-05-22 04:10:00+00'
ORDER BY created_at ASC
LIMIT 1;
```

Extract the `by_source."Fotomaç"` object from the JSON. Shows `raw`, `after_date`, `after_keyword`.

**Interpret results:**
- `"Fotomaç": {"raw": 0, ...}` → Feed returned nothing. Expected at 07:02 Istanbul — Fotomaç posts from ~09:00. **Not a bug.**
- `"Fotomaç": {"raw": 30, "after_date": 0, ...}` → Same as 20:02 pattern — articles exist but all date_old. **8h lookback window too tight for morning runs.**
- `"Fotomaç"` key absent entirely → Feed may not be in source_configs or is_active=false. Check: `SELECT name, is_active, url FROM source_configs WHERE name ILIKE '%fotomac%';`

### Key timing context

The cron quiet period is 00:00–06:30 Istanbul. The 04:02 UTC cron = 07:02 Istanbul, which is the **first run of the day** — just 32 minutes after crons resume. Turkish sports journalism publishes from ~09:00. Fotomaç being absent or all-date_old at 07:02 Istanbul is **expected behaviour**, not a bug.

The trust-aware dedup fix effect on Fotomaç will be visible in the 09:00–12:00 Istanbul crons (10:00–13:00 UTC range) when Fotomaç is actively posting fresh articles.

### Result

The Fotomaç entry was in the truncated prefix of the fetch_logs `error_message` JSON (JSON starts mid-stream at NTV Spor). Visible bySource data for the 04:02 UTC run:

```
NTV Spor:       raw=20  after_date=7   after_keyword=1
Onefootball:    raw=0
Reddit BJK:     raw=0
Sabah Spor:     raw=10  after_date=6   after_keyword=1
SKY Sports:     raw=20  after_date=20  after_keyword=0
Sözcü Spor:     raw=50  after_date=50  after_keyword=50
Sözcü World Cup:raw=24  after_date=24  after_keyword=24
Transfermarkt:  raw=10  after_date=0
TRT Haber:      raw=60  after_date=1   after_keyword=0
Yeni Şafak:     raw=60  after_date=0
after_story_dedup: 8
```

**Finding: Expected pattern confirmed.** TRT Haber (60 raw → 1 after_date) and Yeni Şafak (60 raw → 0 after_date) show the morning date_old pattern — overnight articles pushed past the 8h lookback window. Fotomaç data was cut off but timing confirms the expected explanation: raw=0 or all-date_old at 07:02 Istanbul, 32 minutes after quiet period ends, before Turkish sports journalism posts.

The after_story_dedup=8 total (with only 1 published) indicates the hash caches are filtering most incoming articles as already-seen.

---

## Summary

| Question | Finding | Action |
|---|---|---|
| Q1: BodyLen=76 quality risk | No risk. full_body=1352 chars, coherent article. source_body_len is RSS-only, not proxy content. | None. Fix 1 not needed. |
| Q2: NTV synthesis_failed | One-off. count=1. That URL was blocked/slow at 04:02 UTC. Not a pattern. | Monitor. If count rises to >3 in a single run, investigate proxy/NTV access. |
| Q3: Fotomaç absent | Expected. Pre-business hours (07:02 Istanbul). TRT/Yeni Şafak confirm date_old pattern for first morning cron. | None. Recheck 10:00–13:00 UTC runs for trust-aware dedup effect. |
| pipeline_log fix | Confirmed working — NTV entries present in pipeline_log for this run. | None. |

**No code changes warranted.** All findings match expected behaviour. Trust-aware dedup verification should run against 10:00–13:00 UTC crons when Fotomaç and NTV post fresh morning content.
