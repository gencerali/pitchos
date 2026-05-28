# Session Report: 2026-05-28 — Issues, Fixes, and Unknowns

**Date:** 2026-05-28  
**Commits shipped:** `33aa535`, `3010bd7`, `ff07ffd`  
**Deployed workers version (final):** `58b4928f-12d1-4eb9-8e18-b7995cf9df94`

---

## Table of Contents

1. [Issue 1 — `published_at` NULL in 66% of rows](#issue-1)
2. [Issue 2 — `/rebuild-cache` wiped the homepage](#issue-2)
3. [Issue 3 — `/run` silently dying (30-second wall-clock limit)](#issue-3)
4. [Issue 4 — 22 synthesis_failed, only 6 published per run](#issue-4)
5. [Change 5 — Pipeline tuning: cap, cron, YouTube](#change-5)
6. [robots.txt structural issue (analysis only, not shipped)](#robots)
7. [Still unclear / needs observation](#unclear)

---

<a name="issue-1"></a>
## Issue 1 — `published_at` NULL in 66% of rows

### Problem

A Supabase audit showed 868 of 1306 rows in `content_items` (for site `2b5cfe49-...` / BJK) had `published_at = NULL`. The column has no database-level default (`column_default: null, is_nullable: YES`).

This mattered in two ways:
- `/rebuild-cache` sorted by `ORDER BY published_at DESC`, which places NULLs **last** in PostgreSQL DESC order. The `LIMIT 100` therefore returned the oldest articles with real dates, skipping every NULL row — meaning all recently processed articles were excluded.
- Any display or age-based logic that used `published_at` to compute article freshness received NULL and fell back to stale defaults.

### Root cause

`saveArticles` in `src/publisher.js` received `published_at` from the RSS feed's `<pubDate>` field. If the feed provided no valid date, `published_at` was `null`. Before commit `d864504`, the INSERT into `content_items` did not set `published_at` at all, so rows landed with `NULL`.

After `d864504` patched `saveArticles`, three other insert paths were still missing `published_at`:

| Path | File | Line | What it does |
|------|------|------|--------------|
| Admin manual article create | `worker-fetch-agent.js` | ~3006 | Admin panel "create article" form |
| Admin sync-kv-to-db | `worker-fetch-agent.js` | ~3584 | POST `/admin/sync-kv-to-db` syncs KV articles to Supabase |
| `backfillArticleToSupabase` | `worker-fetch-agent.js` | ~6057 | On-demand backfill triggered when a KV article has no Supabase row |

Additionally, a one-time SQL backfill was needed for the 868 existing NULL rows. A `UPDATE content_items SET published_at = COALESCE(fetched_at, created_at)` was run directly in Supabase SQL editor. The editor returned "Success. No rows returned" — initially misread as 0 rows updated. Correct interpretation: PostgreSQL UPDATE with no `RETURNING` clause produces no result set; the message means success, not zero rows.

A worker-side `/admin/backfill-published-at` POST endpoint was also added as a reusable tool for future drift.

### Fix (commit `33aa535`)

1. `src/publisher.js:919` — `saveArticles` row construction: already had `published_at: a.published_at || a.fetched_at || new Date().toISOString()` from `d864504`. Confirmed live.
2. `worker-fetch-agent.js:3006` — admin create path: added `published_at: now` to `newRow`.
3. `worker-fetch-agent.js:3584` — `sync-kv-to-db`: added `published_at: a.published_at || now`.
4. `worker-fetch-agent.js:6057` — `backfillArticleToSupabase`: added `published_at: kvArticle.published_at || now`.
5. New endpoint `POST /admin/backfill-published-at`: fetches `published_at=is.null` rows in chunks of 50, patches each with `fetched_at || created_at` via PATCH, returns `{ updated: N }`.

### Test result

After deploying `33aa535`, `POST kartalix.com/admin/backfill-published-at` returned `{ updated: 0, message: 'no null rows' }` — confirming the SQL backfill had already fixed all 868 rows and no new NULLs existed. The worker endpoint is now a safety valve for future drift.

---

<a name="issue-2"></a>
## Issue 2 — `/rebuild-cache` wiped the homepage

### Problem

Clicking **Önbelleği Yenile** (the rebuild-cache button in the admin panel) caused the homepage to show zero articles. The blank state persisted until the next scheduled pipeline run (up to 2 hours). Video widgets remained visible because they use a separate KV key.

### Root cause

Two diverging query strategies wrote to `articles:BJK` KV:

| Path | Sort column | Limit | Risk |
|------|------------|-------|------|
| Normal pipeline (`processSite`) | `created_at DESC` | 300 | None — `created_at` is a server timestamp, never NULL |
| `/rebuild-cache` (pre-fix) | `published_at DESC` | 100 | NULLs sort last; old RSS dates rank above recent |

`/rebuild-cache` at `worker-fetch-agent.js:506` was using `order=published_at.desc&limit=100`. With 868 NULL rows, PostgreSQL sorted all those NULLs to the bottom. The `LIMIT 100` returned only the oldest 100 rows that had real `published_at` values — articles from early May or older. These were then written to `articles:BJK` KV.

The frontend `index.html:1126` applies `isExpired()` using `SHELF_LIFE` thresholds (e.g. Other: 48h, Club: 72h). A May 10 article rendered on May 28 is 18 days old — far past every threshold. The KV contained valid JSON but `isExpired()` filtered every article out, rendering a blank homepage.

### Fix (commit `33aa535`)

Changed `worker-fetch-agent.js:506`:
```
Before: order=published_at.desc&limit=100
After:  order=created_at.desc&limit=300
```

This mirrors the normal pipeline seed exactly. `created_at` is Supabase's server-side insertion timestamp — never NULL, always reflects when the article first entered the database.

### Test result

After deploying, `GET kartalix.com/rebuild-cache` (via admin panel or direct call) returned:
```json
{ "rebuilt": 300, "source": "supabase", "site": "BJK" }
```
Homepage populated correctly with recent articles. No blank state.

---

<a name="issue-3"></a>
## Issue 3 — `/run` silently dying (30-second wall-clock limit)

### Problem

`POST kartalix.com/run` returned a 200 response immediately but no pipeline work was actually done. The response message claimed the run was in progress, but `/cache` showed no new articles after waiting several minutes.

### Root cause

The `/run` handler called `ctx.waitUntil(runAllSites(...))` to background the work. `ctx.waitUntil` is designed to extend a Worker's lifetime *after the response is sent* — but this only works in **fetch handlers up to the subrequest limit**. Cloudflare's HTTP wall-clock limit still applies: a Worker request (including any `waitUntil` work) is hard-killed at 30 seconds for free/bundled plans.

`runAllSites` involves fetching RSS feeds, calling Claude API for rewrites, saving to Supabase, and writing to KV. This pipeline takes well over 30 seconds for any real run. Everything past the 30-second mark was silently discarded.

Scheduled handlers (cron triggers) do **not** have this wall-clock limit — they can run for the full CPU time allotment.

### Fix (commit `3010bd7`)

Replaced the `ctx.waitUntil(runAllSites(...))` pattern with a **KV-flag dispatch**:

1. `/run` now writes `run:requested` to KV with a 15-minute TTL:
   ```js
   await env.PITCHOS_CACHE.put('run:requested', new Date().toISOString(), { expirationTtl: 900 });
   ```
2. The `*/5 * * * *` scheduled handler checks for this flag on every tick:
   ```js
   const runRequested = await env.PITCHOS_CACHE.get('run:requested');
   if (runRequested) { work.push(runAllSites(...)); }
   ```
3. Because the `*/5` handler is a scheduled handler, `runAllSites` runs under the cron budget with no wall-clock limit.
4. `/run` response changed to `{ status: 'queued', message: 'Pipeline queued — fires within 5 min on next cron tick.' }`.

### Test result

After deploying `3010bd7`, `/run` returned:
```json
{
  "status": "queued",
  "preflight": { "sites_found": 1, "site_codes": ["BJK"], "cost_blocked": false, "cost_current": 4.52, "cost_cap": 8 },
  "message": "Pipeline queued — fires within 5 min on next cron tick. Check /cache after ~5 min."
}
```
After ~5 minutes, `/cache` confirmed new articles were processed. The pipeline ran to completion.

**Side note — preflight checks added to `/run`:** The handler also runs pre-flight checks before queueing (active sites, cost cap). If the monthly cost cap is already exceeded or no active sites exist, `/run` returns a blocked status immediately without writing the KV flag, preventing wasted cron ticks.

---

<a name="issue-4"></a>
## Issue 4 — 22 synthesis_failed, only 6 published per run

### Problem

After `/run`, the pipeline_log showed 22 `synthesis_failed` entries and only 6 successfully published rewrites. The question was whether this was a bug (something broken in the rewrite path) or expected behaviour.

### Analysis

**The 6-per-run cap is intentional.** `src/publisher.js:736` (pre-`ff07ffd`) checked `if (rewritesSoFar < 6)` before attempting any rewrite. `rewritesSoFar` counts only *successful* rewrites where `body.length > 600`. Failed attempts (synthesis_failed) do not increment the counter and do not count toward the cap.

**The 22 synthesis_failed are overflow, not errors.** With only 6 slots per run and a backlog of NVS≥30 articles, the remaining 22 were queued to `rewrite:queue:BJK` KV for drain on the next cycle. The drain cap is 8/run (`src/publisher.js:1072`). So at the time, the backlog would drain over ~3 runs (22 articles / 8 drain slots ≈ 3 cycles). These are not lost — they are held in KV.

**Why was the backlog so large?** The pipeline had been silently failing for ~18 hours due to the `/run` wall-clock issue (Issue 3) and separately a Claude API spend limit being reached at the console level (the Anthropic account hit its monthly spend cap — subsequently increased by the user). During the outage window, new RSS articles accumulated that never got processed.

### Resolution

No code change needed for the synthesis_failed themselves. The queue drains automatically over subsequent cron cycles. The underlying /run timeout was the root bug (fixed in Issue 3). The per-run cap was raised in Change 5 below to accelerate queue drain.

---

<a name="change-5"></a>
## Change 5 — Pipeline tuning: synthesis cap 6→18, cron 2h→3h, YouTube 2→3

### Context

With Issue 3 fixed and the backlog draining, three pipeline parameters were reviewed together for the testing phase:

| Parameter | Before | After | File | Line |
|-----------|--------|-------|------|------|
| Synthesis rewrite cap / run | 6 | 18 | `src/publisher.js` | 736 |
| Main pipeline cron | `0 */2 * * *` (every 2h) | `0 */3 * * *` (every 3h) | `wrangler.toml` | 18 |
| YouTube per-channel cap / run | 2 | 3 | `worker-fetch-agent.js` | 4753 |

### Reasoning

**Cap 6→18:** At 6/run and every-2h cron, maximum daily rewrites = 6 × 12 = 72. But real supply is constrained by NVS≥30 eligible articles, so actual output was much lower. With 18/run the cap stops being the binding constraint even at 3h frequency: 18 × 8 = 144 theoretical daily max. Volume is now source-constrained rather than cap-constrained, which is the desired state during the observation phase.

**Cron 2h→3h:** Each full pipeline run calls Claude for rewrites (Haiku 4.5: $0.80/1M input, $4.00/1M output). With 3× the per-run work potential but 33% fewer runs, the net cost is neutral or lower. Fewer runs also reduces Supabase query overhead and Cloudflare Worker invocations. The `0 4 * * *`, `0 3 * * 1`, `0 2 * * 7` weekly/daily crons are unaffected.

**YouTube 2→3:** One extra video embed per channel per run. The risk of homepage saturation with video content was noted (belgeseller/unutulmazlar channels have high NVS and currently crowd news articles toward the bottom). The 2→3 change is intentionally modest. The full solution — a dedicated `featured_videos` KV slot showing 3-4 curated videos on the homepage separately from the main article pool — is on the roadmap but not yet built.

**Cost estimate comparison:**

| Scenario | Runs/day | Max rewrites/day | Est. cost/month |
|----------|----------|-----------------|-----------------|
| Before (cap=6, 2h) | 12 | 72 | ~$5 |
| After (cap=18, 3h) | 8 | 144 | ~$3.50–7 |

### Test result

Deploy confirmed crons registered:
```
schedule: */5 * * * *
schedule: 0 */3 * * *   ← confirmed changed
schedule: 0 4 * * *
schedule: 0 3 * * 1
schedule: 0 2 * * 7
```
Worker version `58b4928f-12d1-4eb9-8e18-b7995cf9df94` live.

No post-deploy full-pipeline run confirmed under the new caps yet — the queue needs to fire via cron or `/run` through the admin panel (session auth required; direct curl returns 401). Results observable via `/cache` within 5 minutes of next cron tick.

---

<a name="robots"></a>
## robots.txt structural issue (analysis only — not shipped)

### Problem

The `robots.txt` file has two separate `User-agent: *` blocks:

```
User-agent: *        ← Cloudflare-managed block (AI crawlers)
...Disallow rules for GPTBot, ClaudeBot, etc...

User-agent: *        ← Our block
Allow: /
Disallow: /api/
```

Per RFC 9309, a user-agent matches the **first** group that applies. Having two `User-agent: *` blocks means the second block is unreachable for any crawler that matched the first. The `Disallow: /api/` in the second block protects nothing in practice because `/api/` returns 404 anyway.

### Proposed fix (Option A)

Remove our `User-agent: *` block entirely, keep only the Sitemap line:
```
# ... Cloudflare-managed block stays untouched ...

Sitemap: https://kartalix.com/sitemap.xml
```

The Cloudflare-managed block (which protects against AI scrapers) is unaffected because it precedes ours. Googlebot and Mediapartners-Google are not mentioned in either block, so they crawl freely regardless.

### Status

**Not implemented.** The fix is low-urgency (no crawlability impact confirmed) and was discussed but not confirmed for implementation during this session.

---

<a name="unclear"></a>
## Still unclear / needs observation

### 1. Actual drain rate of the rewrite queue backlog

The `rewrite:queue:BJK` KV key holds overflow NVS≥30 articles that didn't fit in the per-run rewrite cap. After the cap was raised to 18 and the cron adjusted, the drain rate changes:

- **Drain cap:** still 8/run (`src/publisher.js:1072` — `queue.slice(0, 8)` — this was not changed)
- **New pipeline cap:** 18/run
- **What's unclear:** whether the 22 queued articles from the post-outage backlog have fully drained, and what the steady-state queue length looks like under the new parameters. Check `rewrite:queue:BJK` KV value directly to verify.

### 2. Published_at on articles that already exist in Supabase with wrong dates

`saveArticles` uses `Prefer: resolution=ignore-duplicates`. If an article already exists with an old or wrong `published_at`, the re-INSERT is silently dropped and the original row is preserved. The `/admin/backfill-published-at` endpoint only patches rows where `published_at IS NULL` — it does not fix rows that have an old-but-wrong date (e.g., an AI-rewritten article whose source RSS `<pubDate>` was from April).

**Practical impact:** These articles still exist in Supabase and still appear in normal pipeline results (sorted by `created_at`). The frontend's `isExpired()` check will eventually expire them from display. No immediate user-facing problem, but the `published_at` column does not reliably reflect "when this article was processed by Kartalix" for rows inserted before `d864504`.

### 3. Homepage video dominance (belgeseller/unutulmazlar)

Channels with high NVS (belgeseller, unutulmazlar) produce YouTube embed articles that score highly in `rankAndEvict`. On the homepage, these video cards appear near the top, pushing AI-rewritten news articles below the fold. The YouTube per-channel cap was raised 2→3, which slightly increases the number of such embeds per run — potentially worsening this in the short term.

**The planned fix** is a `featured_videos` KV slot: 3-4 curated/high-NVS videos displayed in a dedicated section of the homepage, removed from the main article pool. This keeps the video content visible without competing with news in the main feed. Status: **on roadmap, not started.** No timeline set.

### 4. Claude API spend cap vs cron schedule alignment

The pipeline was silently idle for ~18 hours because the Anthropic account hit its monthly spend cap. The cap was manually increased after discovery. The worker itself has a `MONTHLY_CLAUDE_CAP` env var (currently `"16"` USD) with a `checkCostCap` guard, but this only protects against runaway Worker spend — it does not protect against or detect the external Anthropic account-level cap being hit.

**What's unclear:** There is no monitoring or alarm for the external cap being hit. The pipeline silently stops generating rewrites (falls back to `rss_summary`) with no visible signal in the admin dashboard. An alarm that detects "X consecutive runs produced 0 rewrites despite eligible articles" would surface this quickly. Not yet built.

### 5. `/run` requires admin session auth — no curl shortcut

`/run` is protected by `requireOps` which validates a session token stored in KV (`admin:session:{token}`). The token is set by the admin login flow. Direct `curl kartalix.com/run` returns `{"error":"Unauthorized"}`. The only way to trigger an on-demand run outside of cron is via the admin panel UI or by supplying a valid session cookie. This is intentional but worth noting for operational awareness.

### 6. `synthesis_failed` seen-cache TTL interaction

`synthesis_failed` URLs are cached in `seen:synth_failed:BJK` KV with a 6-hour TTL to prevent re-scoring them on every `*/5` cron tick. With the main pipeline now running every 3 hours (not 2), the seen-cache TTL covers 2 full pipeline cycles instead of 3. Articles that failed synthesis in one run will be suppressed for the next run but re-eligible on the third run (6h / 3h = 2 covered runs). This is probably fine but represents a small change in retry cadence that was not explicitly evaluated.

---

## Commit Summary

| Commit | Title | Key changes |
|--------|-------|-------------|
| `33aa535` | fix: repair published_at NULL across all insert paths + backfill endpoint | 4 insert paths fixed; `/admin/backfill-published-at` endpoint; rebuild-cache sort `published_at→created_at` |
| `3010bd7` | fix: /run now queues via KV flag, fires on next cron tick with full budget | `/run` writes KV flag; `*/5` cron picks it up; no more 30s wall-clock kill |
| `ff07ffd` | feat: synthesis cap 6→18, cron 2h→3h, YouTube per-channel 2→3 | Three parameter changes; DECISIONS.md + ROADMAP.md updated |
