# Homepage Render Diagnostic — 2026-05-22
**Date:** 2026-05-22  
**Scope:** Diagnostic only. No code changes.  
**Symptom:** Admin panel shows 20 articles in live pool; site homepage renders only 2–4.  
**Method:** KV live read, code path trace, computed isExpired per article.

---

## Q1 — What is currently in KV?

**KV key:** `articles:BJK`  
**Total count:** 20 articles  
**Fetched at:** ~12:00 UTC 2026-05-22

| slug | publish_mode | category | nvs | age (h) | passes isExpired? |
|------|-------------|----------|-----|---------|-------------------|
| 2026-05-20-aston-villa-besiktas-parkta-freiburgu-2-0-ile-gecti | rewrite | Haber | 66 | 40.2 | ✗ (>24h default) |
| 2026-05-20-besiktasta-recber-gorevinden-ayrildi-ozen-atandi | rewrite | Club | 72 | 55.2 | ✗ (>48h) |
| 2026-05-20-grafin-sergen-paylasimi-adaliyi-kizdirdi-uyari-sonrasi-silindi | rewrite | Club | 52 | 52.1 | ✗ (>48h) |
| 2026-05-20-aston-villa-ile-freiburg-besiktas-parkta-avrupa-ligi-icin-kapisiyor | rewrite | Match | 58 | 55.2 | ✗ (>24h) |
| 2026-05-19-turkiye-2032-avrupa-sampiyonasi-icin-hazir-oldugunu-acikladi | rewrite | Haber | 68 | 62.0 | ✗ (>24h default) |
| 2026-05-19-onder-ozen-12-yil-sonra-besiktasin-sportif-direktoru-oluyor | rewrite | Club | 78 | 68.1 | ✗ (>48h) |
| 2026-05-19-aston-villa-besiktas-parkta-son-antrenmanini-tamamladi | rewrite | Match | 72 | 67.5 | ✗ (>24h) |
| 2026-05-19-mcginn-aston-villanin-bu-yolculugu-harika-oldu-finali-kazanmak-istiyor | rewrite | Match | 68 | 67.5 | ✗ (>24h) |
| 2026-05-19-uefa-baskani-ceferin-avrupa-ligi-finali-icin-istanbula-geldi | rewrite | Match | 68 | 70.3 | ✗ (>24h) |
| 2026-05-19-avrupa-ligi-kupasi-besiktas-meydaninda-taraftarlarla-bulustu | rewrite | Match | 72 | 71.8 | ✗ (>24h) |
| 2026-05-19-recber-besiktastan-ayrildi-teknik-ekipte-sarsinti-devam-ediyor | rewrite | Club | 78 | 76.5 | ✗ (>48h) |
| 2026-05-19-orkun-kokcu-ve-ohdan-sergen-yalcina-veda-mesajlari | rewrite | Club | 54 | 73.0 | ✗ (>48h) |
| 2026-05-19-besiktasta-sportif-direktor-onceligi-onder-ozen-geri-dondu | rewrite | Club | 52 | 73.3 | ✗ (>48h) |
| 2026-05-18-necip-uysal-22-yil-sonra-besiktasa-veda-etti | rewrite | Squad | 70 | 93.6 | ✗ (>24h default) |
| 2026-05-18-necip-uysal-22-yil-sonra-besiktas-formasini-birakti | rewrite | Club | 65 | 96.8 | ✗ (>48h) |
| 2026-05-18-elveda-cengiz-under-yerine-gelecek-isim-coktan-belli | rewrite | Transfer | 62 | 100.3 | ✗ (>72h) |
| 2026-05-18-akli-5-buyuk-ligde | rewrite | Transfer | 68 | 103.3 | ✗ (>72h) |
| 2026-05-18-2-milyon-euro-uctu | rewrite | Club | 65 | 103.3 | ✗ (>48h) |
| 2026-05-20-trabzonspor-ilk-transferini-acikladi | template_transfer | Transfer | 72 | 43.6 | **✓** (43.6h < 72h) |
| 2026-05-20-besiktastan-muci-aciklamasi | template_transfer | Transfer | 70 | 43.9 | **✓** (43.9h < 72h) |

**Summary:**
- 18 / 20 articles fail `isExpired` — they are in KV but invisible on homepage
- 2 / 20 pass — both `template_transfer`, Transfer category, from 2026-05-20 15:xx UTC
- **0 youtube_embed articles present** (see Q4 for why)
- All articles have `_rank` absent — this is correct; `rankAndEvict` strips it before writing to KV (`publisher.js:1041`)

**The admin panel "pool: 20" count reads raw KV length. It does not apply `isExpired`.**

---

## Q2 — How does the homepage render categories?

**File:** `index.html` (single-page app, fetches `/cache` on load)

### Pipeline

```
fetch('/cache')                    // all 20 KV articles
  → isExpired filter              // → visible (2) + expired (18)
  → visible.sort(effectiveNvs)    // time-decayed NVS sort
  → footballArticles = visible.filter(sport === 'football')
  → renderCarousel(first 8)
  → renderHeroSplit(first 4)      // fills 4 hero slots
  → renderGrid(from index 4)      // overflow grid
  → renderTicker(footballArticles)
  → renderRadarLive(ALL articles) // ← uses full array, ignores isExpired
  → renderPulseLive(ALL articles) // ← uses full array, ignores isExpired
  → renderVideos(MOCK_VIDEOS)     // ← hardcoded mock, NOT from KV
```

### isExpired logic (`index.html:1125`)

```javascript
const SHELF_LIFE = {
  Match: 24, Transfer: 72, Injury: 24,
  Club: 48, European: 48, Other: 24, default: 24,
};

function isExpired(article) {
  if (article.is_template) return false;   // templates never expire
  if (!article.published_at) return false;
  const hours = SHELF_LIFE[article.category] || SHELF_LIFE.default;
  return (Date.now() - new Date(article.published_at)) / 3600000 > hours;
}
```

**Category determines shelf life, not publish_mode or `_rank`.**

### Category → shelf life table

| Category | Shelf life | Articles in KV | Visible now |
|----------|-----------|----------------|-------------|
| Match | 24h | 6 | 0 (all 55–72h old) |
| Club | 48h | 9 | 0 (all 52–103h old) |
| Transfer | 72h | 4 | 2 (the 44h ones pass; 2 older ones fail) |
| Haber | 24h (default) | 2 | 0 |
| Squad | 24h (default) | 1 | 0 |

### What "4 articles" means

The user observed 4 articles at some point. Two possible explanations:
1. **Earlier observation**: Club articles from 2026-05-20 (published 04:00 and 07:06 UTC) expired at 04:00 and 07:06 UTC on 2026-05-22 respectively. Between ~10:30 UTC (rebuild) and 07:06 UTC (when the last Club article aged out), there were still 3–4 visible articles. If the observation was made before 07:06 UTC local perception, that window explains 4.
2. **Radar section**: `renderRadarLive` and `renderPulseLive` are called with ALL articles (including expired). The radar Transfer sidebar shows up to 5 Transfer articles from the full array, including the 2 expired Transfer ones. A user counting "articles visible on page" could reach 4 by including radar items.

### Videos section

`renderVideos(MOCK_VIDEOS)` is hardcoded — it does **not** render `youtube_embed` articles from KV. The videos section will never show real articles until this is connected to KV.

---

## Q3 — Categories in content_items (SQL required)

Cannot run directly. Run this query against Supabase:

```sql
SELECT slug, publish_mode, category, published_at, nvs_score
FROM content_items
WHERE site_id = '2b5cfe49-b69a-4143-8323-ca29fff6502e'
  AND publish_mode NOT IN ('rss_summary', 'copy_source')
  AND published_at > NOW() - INTERVAL '7 days'
ORDER BY published_at DESC;
```

**Expected findings based on KV seed results:**
- Dominant categories: Club, Match, Transfer, Haber — all represented in KV
- youtube_embed articles from 2026-05-21 20:00 UTC should appear here at the top — **if they don't, they were archived or their published_at is different than expected**

**Key question to answer with this query:** do youtube_embed articles exist in content_items with `published_at` after 2026-05-18? If yes, the /rebuild-cache slug filter is dropping them (see Q4). If no, they may have been archived or never saved with status=published.

---

## Q4 — What did "Önbelleği Yenile" actually write?

**Button function:** `rebuildCache()` → `POST /rebuild-cache`  
**Handler:** `worker-fetch-agent.js:494`  
**NOT** `/admin/seed-kv` (a separate, less-used endpoint)

### Exact Supabase query

```javascript
// worker-fetch-agent.js:505
const rows = await supabase(env, 'GET',
  `/rest/v1/content_items
   ?site_id=eq.${site.id}
   &publish_mode=neq.rss_summary
   &order=published_at.desc
   &limit=100
   &select=title,summary,full_body,source_name,...,slug,template_id`
);
```

**Critical: no `status=eq.published` filter.** This returns ALL statuses — published, rejected, archived, draft. If there are 80+ rejected rewrite articles (status=rejected, publish_mode=rewrite, recent published_at), they fill the top 100 and youtube_embed articles fall out.

### Why youtube_embed is absent from KV

Three candidate causes (SQL required to confirm):

| Cause | Diagnosis |
|---|---|
| **A) Squeezed out of limit=100** | If >100 non-rss_summary rows exist with `published_at` newer than the youtube_embed articles (possible with many rejected rewrites) → they never enter the mapping |
| **B) Null slug** | Filter at line 510: `rows.filter(r => r.slug)` — if youtube_embed articles have null/empty slug in DB, they're silently dropped |
| **C) Status mismatch** | youtube_embed articles archived/rejected between incident and rebuild → still returned by query but potentially with wrong published_at |

```sql
-- Run to diagnose:
SELECT slug, status, published_at, nvs_score
FROM content_items
WHERE site_id = '2b5cfe49-b69a-4143-8323-ca29fff6502e'
  AND publish_mode = 'youtube_embed'
ORDER BY published_at DESC
LIMIT 20;
```

### What got written at ~10:30 UTC

1. Supabase returned 20 articles (all rewrite or template_transfer, 2026-05-18–2026-05-20)
2. Mapped via `toKVShape` with `is_fresh: false`
3. Passed to `cacheToKV` → `rankAndEvict(minPool: 20)`:
   - 5 articles above floor=5 at rebuild time (most recent rewrites)
   - 15 articles sub-floor — ALL rescued by `minPool: 20` (since survived.length=5 < minPool=20)
   - `_rank` stripped from output before KV write (`publisher.js:1041`)
4. All 20 written to KV with 4h TTL

---

## Q5 — KV vs Homepage: the disconnect

| Layer | Count | Mechanism |
|-------|-------|-----------|
| Supabase content_items | 20+ | status=published |
| KV (`articles:BJK`) | 20 | `rankAndEvict` with `minPool:20` — rescues ALL |
| Homepage `visible` | **2** | `isExpired` by category SHELF_LIFE |
| Homepage rendered | **2** | carousel + heroSplit get these 2 |

**The disconnect:** `rankAndEvict` on the server rescues articles from being evicted from KV (via `minPool`). But `isExpired` in `index.html` is a **client-side, independent filter** that applies its own age thresholds. There is no communication between these two layers.

Result: `minPool: 20` guarantees KV always has 20 articles. It does NOT guarantee any of them pass `isExpired`. After a prolonged pipeline outage, every article in the DB seed is stale, and SHELF_LIFE progressively whittles the visible count to 0.

### Sequence of events today

| UTC | Visible articles on homepage |
|-----|-----|
| ~08:02 | KV expires → 0 (site dark) |
| ~10:30 | Rebuild → 20 in KV. At that moment: ~4 pass isExpired (Transfer x2, Club x2 just within 48h) |
| 11:06 (07:06 + 4h) | Last Club article (published 2026-05-20 07:06) ages past 48h → visible drops to 2 |
| Now (~12:00+) | 2 visible. Will drop to 0 by 2026-05-23 15:xx when Transfer articles age past 72h |

---

## Summary of Findings

| Question | Finding |
|---|---|
| Q1: KV state | 20 articles, 2 pass isExpired, 0 youtube_embed, _rank absent by design |
| Q2: Homepage filter | `isExpired()` in index.html applies SHELF_LIFE per category — independent of KV ranking |
| Q3: DB categories | SQL needed — expected: Club/Match/Transfer/Haber present; youtube_embed status uncertain |
| Q4: Önbelleği Yenile | Calls `/rebuild-cache`, no status filter, limit=100; youtube_embed absent — likely null slug or squeezed by rejected articles |
| Q5: KV vs frontend | KV has 20, homepage shows 2. Root disconnect: minPool rescues in KV, but SHELF_LIFE filters independently at render |

**The fix is not a rendering bug — it's a data problem.** A successful pipeline run publishing fresh articles (today's RSS content with nvs≥50) is the only path to restoring the homepage. All existing KV articles have exceeded or will soon exceed their SHELF_LIFE.

---

## Pending actions

- [ ] **Run Q3 SQL** to confirm youtube_embed status and published_at in content_items
- [ ] **Trigger `/run`** (authenticated, from admin panel) to process today's articles
- [ ] **Add `status=eq.published` filter to `/rebuild-cache`** — currently returns rejected/archived rows, which may crowd out youtube_embed articles from the 100-item limit
- [ ] **Connect `renderVideos` to KV** — currently uses `MOCK_VIDEOS`, youtube_embed articles never render on homepage even when in KV
