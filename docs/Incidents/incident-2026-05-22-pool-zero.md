# Incident: Article Pool → 0 (Site Dark)
**Date:** 2026-05-22  
**Severity:** P0 — site served zero articles to all visitors  
**Duration:** ~08:02 UTC onward (KV expiry); alert noticed ~10:05 UTC  
**Status:** RESOLVED. Pool restored manually ~10:30 UTC. Root fix deployed (`db1e0092`).

---

## 1. Problem Definition

The Kartalix homepage (`kartalix.com`) stopped serving articles. The admin panel showed two concurrent alerts:

- **majorPool-size floor** — "Article pool has 0 articles (≤ 20 — at minimum floor) for 2 consecutive cron runs"
- **majorZero published in 4h** — "No articles published in the last 4 hours during normal operating hours (07:00–23:00 local)"

The KV key `articles:BJK` (the article pool backing the frontend) returned an empty array. The `minPool: 20` floor in `rankAndEvict` (`src/publisher.js:1023`) could not rescue articles because there was nothing in KV to rescue — the key had expired entirely.

---

## 2. Timeline

| UTC | Event |
|-----|-------|
| 2026-05-21 20:02 | Last cron before incident. 10 youtube_embed articles in DB (nvs_score=72). |
| 2026-05-22 04:02 | Successful 2h-cron. 1 article published: Sözcü Spor rewrite (BodyLen=76, full_body=1352). `cacheToKV` called → KV TTL set to 4h → **expires ~08:02 UTC**. |
| 2026-05-22 06:01 | 2h-cron FAILED. `error_message: "Claude API error 529: overloaded_error"`. `cacheToKV` never reached. KV TTL not refreshed. |
| 2026-05-22 08:01 | 2h-cron FAILED. Same 529 error. KV TTL drains to zero. |
| ~2026-05-22 08:02 | KV key `articles:BJK` expires (4h TTL since 04:02 write). Pool → 0. Site goes dark. |
| ~2026-05-22 10:05 | User notices alerts. Reports incident. |
| ~2026-05-22 10:30 | Fix deployed (`829f2659`). `/run` triggered. Site still at 0. |

---

## 3. Findings

### 3a. The gap between 04:02 and 06:01

The fetch_logs show only three runs on 2026-05-22: 04:02 (success), 06:01 (failed), 08:01 (failed). There are no entries between 04:02 and 06:01 despite the `*/5 * * * *` cron schedule. This is expected: the 5-minute cron handles lightweight match detection only and does not call `processSite` or write to fetch_logs. Only the `0 */2 * * *` (2-hour) cron runs the full article pipeline and logs to fetch_logs. The 5-minute crons between 04:02 and 06:01 did not write to KV.

### 3b. Why Claude returning 529 empties the pool

The call chain on failure:

```
runAllSites
  └─ processSite (worker-fetch-agent.js:4639)
       ├─ fetchRSSArticles, preFilter, URL dedup  ← success
       ├─ scoreArticles (line 4774)               ← throws Claude 529
       └─ [exception propagates up]
  └─ catch (line 3853): logFetch('failed'); return
       ← cacheToKV at line 5375 is NEVER reached
       ← KV TTL is never refreshed
```

`scoreArticles` at line 4774 is called without any try-catch inside `processSite`. There is a try-catch at line 5277 (DB-FIRST SAVE block) but scoring happens before it. The Claude 529 exception propagates directly to `runAllSites`'s catch at line 3853, which only calls `logFetch('failed')` and discards the run entirely.

With the 2-hour cron interval and a 4-hour KV TTL:
- 1 failed run: KV still alive (TTL refreshed ≤ 2h ago, still has 2h left)
- 2 consecutive failed runs: KV expires between the two failures

Two consecutive 529s at 06:01 and 08:01 UTC were enough to drain the TTL.

### 3c. Why `minPool: 20` did not protect the pool

`cacheToKV` calls `rankAndEvict(articles, 200, { minPool: 20 })`. The `minPool` guarantee rescues articles with `_rank > 0 && _rank < floor` — articles that are stale but still exist. It cannot rescue articles from an **expired KV key**. Once the key expires, KV returns null, there is nothing to re-rank, and `minPool` has no effect.

### 3d. DB state at time of incident

The 30-day DB seed query (used as fallback when KV < 10 items) would find:

| publish_mode | count | newest published_at | nvs_score |
|---|---|---|---|
| youtube_embed | 10 | 2026-05-21 20:00:29 UTC | 72 |

The Sözcü Spor rewrite from 04:02 (full_body=1352, nvs≈50) also exists in content_items, but its `published_at` is the original RSS article date (likely 2026-05-21), not the processing time. The 24h diagnostic query missed it; the 30-day seed query would find it.

All youtube_embed articles have `nvs_score=72`. Their age at incident time (~08:02 UTC):
- Newest (2026-05-21 20:00): ~12h old → `rank = 72 × exp(-12/24) = 72 × 0.61 = 43.9` ✓ above `floor=5`
- Oldest (2026-05-20 08:30): ~48h old → `rank = 72 × exp(-48/24) = 72 × 0.14 = 10.0` ✓ above `floor=5`

All DB articles should survive `rankAndEvict`. The seed path, if reached, would restore the pool to ~10–20 articles.

### 3e. Why the DB seed was not reached during the failed runs

The DB seed at line 5340 is inside the DB-FIRST SAVE try block, which is after `scoreArticles`. It is never reached when scoring throws. There is also a DB seed in the `preFiltered.length === 0` quiet-run branch (line 4741), but that branch is bypassed when `preFiltered.length > 0` — and RSS feeds always return articles to pre-filter.

---

## 4. Fix Attempted

**Deploy `829f2659`** — wrap `scoreArticles` in a try-catch at `worker-fetch-agent.js:4774`.

On Claude failure the catch block:
1. Reads existing KV. If ≥ 5 articles: calls `cacheToKV` to re-rank and refresh the 4h TTL.
2. If KV is empty (< 5 articles): queries DB for all non-rss_summary/copy_source articles from the last 30 days, maps them through `toKVShape`, calls `cacheToKV` to restore the pool.
3. Logs `fetch_logs.status = 'failed'` with the original error message.
4. Returns early — does not crash `processSite` or affect other sites.

```javascript
// worker-fetch-agent.js ~line 4772
let scored, scoreUsage;
try {
  ({ scored, usage: scoreUsage } = await scoreArticles(preFiltered, site, env));
} catch(e) {
  console.error(`SCORING FAILED (Claude unavailable): ${e.message}`);
  const kvRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
  const kvExisting = kvRaw ? JSON.parse(kvRaw) : [];
  if (kvExisting.length >= 5) {
    await cacheToKV(env, site.short_code, kvExisting);
  } else {
    // DB seed (30-day window, excludes rss_summary + copy_source)
    const dbRows = await supabase(env, 'GET', `/rest/v1/content_items?...`);
    if (Array.isArray(dbRows) && dbRows.length > 0) {
      const seeded = dbRows.map(r => toKVShape({ ...r, nvs: r.nvs_score || 0, ... }));
      await cacheToKV(env, site.short_code, seeded);
    }
  }
  await logFetch(env, site.id, 'failed', stats, e.message, funnelStats);
  return stats;
}
```

---

## 5. Result of First Fix (`829f2659`)

**Pool remained at 0 after deploy + `/run`.**

Possible reasons:

1. **Claude still returning 529 during `/run`** — the fallback catch block fires, DB seed runs, but the seed itself fails silently (inner `catch(seedErr)` swallows all errors). This is the most likely cause if Claude was still overloaded when `/run` was triggered.

2. **`toKVShape` mapping issue** — the fallback passes `r.nvs_score` as `nvs` but `toKVShape` may expect a differently-shaped object. A throw inside `toKVShape` would be caught by the inner `catch(seedErr)` and silently suppressed.

3. **Propagation delay** — Cloudflare Worker deploys propagate across PoPs within ~30–60s. If `/run` was triggered immediately after `wrangler deploy` confirmed, the old code may have still been active on some PoPs.

4. **Claude recovered but pipeline ran clean with 0 published articles** — scoring succeeded, but all morning articles scored below the 50 NVS publish threshold. The DB seed at line 5340 would then fire (KV empty → length < 10), but if the Supabase query returned 0 rows for an unexpected reason (e.g., RLS policy, connection timeout), `latestKV` stays `[]` and `cacheToKV` is called with an empty array.

---

## 6. Resolution

**Pool restored ~10:30 UTC** via the "Önbelleği Yenile" (Refresh Cache) button in admin/tools. This fetched 20 articles and wrote them to KV, ending the dark period.

**Root fix deployed as `db1e0092`** (2026-05-22, after 10:30 UTC). Two changes:

1. **DB seed query hardened** (`worker-fetch-agent.js` ~line 5376):
   - Changed `select=*` to explicit column list — `select=*` caused a Supabase query failure (likely response too large or RLS-adjacent issue)
   - Added `encodeURIComponent(seedCutoff)` — raw ISO date string in URL was being mishandled
   - Added explicit `console.error` when `dbRows === null` (Supabase returns `null`, not throw, on non-OK responses — silent failures now logged)
   - Added `fetched_at` to `toKVShape` mapping

2. **`youtube_embed` added to `HALF_LIFE_BY_MODE`** (`src/publisher.js:828`):
   - Was missing → defaulted to 8h halfLife → articles decayed too fast
   - Now set to 48h — consistent with video content longevity

**Why fix `829f2659` didn't recover the pool:**
The scoring fallback DB seed (the inner `catch(e)` block) did run, but the `supabase()` call returned `null` instead of throwing — `Array.isArray(null)` is false → `seeded` never populated → `cacheToKV` not called in the fallback path. Fix `db1e0092` addresses the same seed query in the main pipeline path (line 5376); the fallback seed at line 4783 was also corrected.

---

## 7. Remaining Hardening (not yet done)

- [ ] **Surface seed failures to fetch_logs**: the `catch(seedErr)` in the scoring fallback only `console.error`s. A `fetch_logs.error_message` entry would make these visible in the admin panel.
- [ ] **DB-FIRST SAVE catch path**: the catch at line ~5433 (writeArticles/saveArticles failure) also doesn't call `cacheToKV` — same vulnerability as the pre-fix scoreArticles path.
- [ ] **KV TTL fragility**: 4h TTL with a 2h cron leaves only 1 failed run as buffer. Consider raising TTL to 6–8h, or unconditionally refreshing KV TTL on every run even if 0 new articles.

---

## 7. Related Code Locations

| Location | Role |
|---|---|
| `worker-fetch-agent.js:4774` | `scoreArticles` call — fix applied here |
| `worker-fetch-agent.js:3853` | `runAllSites` catch — where unhandled errors land |
| `worker-fetch-agent.js:5375` | `cacheToKV` final write — unreachable on scoring failure |
| `worker-fetch-agent.js:5335–5368` | DB seed (KV < 10 articles) — inside DB-FIRST SAVE block, also unreachable on scoring failure |
| `worker-fetch-agent.js:4735–4769` | Quiet-run branch DB seed — bypassed when `preFiltered.length > 0` |
| `src/publisher.js:1097` | `cacheToKV` KV write — `expirationTtl: 14400` (4h) |
| `src/publisher.js:956` | `rankAndEvict` — `minPool: 20` protects against floor eviction but not KV expiry |
