# Source Config Audit — Fotomaç + Google News BJK
**Date:** 2026-05-21  
**Scope:** Diagnostic only. No code changes. No source_configs changes.  
**Status:** SQL-dependent items (1.1, 1.2, 2.1, 2.2) pending Ali to run in Supabase dashboard.

---

## Source 1 — Fotomaç

**Observed gap:** Pipeline_log shows only ~6 Fotomaç items in last 24h, zero published. Direct RSS feed has 50+ current BJK articles with real content (Muçi, Önder Özen, Anguissa, Pavlidis, Vlachodimos). Something is killing articles before they reach synthesis.

---

### 1.1 — Source config inspection  
**Status: REQUIRES SQL — run in Supabase dashboard**

```sql
SELECT name, url, is_active, trust_tier, bjk_filter, 
       polling_interval_minutes, max_per_run, 
       custom_config, created_at, updated_at
FROM source_configs 
WHERE name ILIKE '%fotomac%' OR url ILIKE '%fotomac%';
```

**Why this matters — CRITICAL:** The pipeline uses source_configs DB rows in place of hardcoded RSS_FEEDS when the DB table is populated (worker-fetch-agent.js:4652–4658). If source_configs has a Fotomaç row, the hardcoded entry at `src/fetcher.js:57` is never used. The DB row may have a different URL, lower max_per_run, or `is_active = false`.

Hardcoded fallback URL: `https://www.fotomac.com.tr/rss/Besiktas.xml` (capital B, proxy: true)  
Expected DB URL: `https://www.fotomac.com.tr/rss/besiktas.xml` (lowercase, from seed)

The two URLs are functionally identical (301 redirect confirmed), but document which is active.

---

### 1.2 — Pipeline stage breakdown for Fotomaç  
**Status: REQUIRES SQL — run in Supabase dashboard**

```sql
SELECT stage, COUNT(*), 
       MIN(run_at) as earliest, 
       MAX(run_at) as latest,
       ROUND(AVG(nvs_score)) as avg_nvs
FROM pipeline_log 
WHERE source_name = 'Fotomaç' 
  AND run_at > NOW() - INTERVAL '48 hours'
GROUP BY stage 
ORDER BY COUNT(*) DESC;
```

**What to look for:**
- `off_topic` dominant → keyword filter too aggressive for Fotomaç titles  
- `title_dedup` dominant → Fotomaç duplicates Hürriyet/NTV/Fanatik; dedup retains higher-trust source  
- `scored_low` dominant → fetched and scored but NVS < 50  
- `synthesis_failed` dominant → fetched, scored, attempted synthesis, failed  
- Near-zero rows anywhere → not being fetched at all (config/URL problem)

---

### 1.3 — Proxy fetch test on Fotomaç  
**Status: COMPLETE**

**Test 1** (`/besiktas/2026/05/21/besiktas-guirassy-transferinde-…`):
```
STATUS: 200
TIME:   80.8s  (Render cold start)
BODY:   507 chars
```
Content: Article body extracted but thin — below MIN_BODY_CHARS threshold (600). Cold-start latency not a problem (proxy was warming up); body length IS a problem.

**Test 2** (`/besiktas/2026/05/20/besiktastan-muci-icin-resmi-aciklama`):
```
STATUS: 200
TIME:   7.9s  (warm)
BODY:   1011 chars
```
Content: Real article body extracted, above MIN_BODY_CHARS. Proxy works correctly once warm.

**Verdict on proxy:** Fotomaç is **NOT 403-blocked**. Proxy can extract content. Cold-start first article may drop at isSynth body check (507 < 600), warm articles pass. This is not a Duhuliye-class problem.

---

### 1.4 — Direct RSS fetch test  
**Status: COMPLETE**

URL tested: `https://www.fotomac.com.tr/rss/Besiktas.xml` (hardcoded in fetcher.js:57)  
- HTTP 301 → `https://www.fotomac.com.tr/rss/besiktas.xml` (lowercase)  
- Feed live: 50+ BJK-tagged articles, timestamps May 18–21 2026  
- Topics: Muçi transfer, Önder Özen appointment, Sergen Yalçın departure, Sampaoli rumor, Anguissa, Pavlidis, Vlachodimos  
- Article descriptions: 200–500 chars in RSS (substantial summaries)

Feed is healthy and populated. The bottleneck is not RSS availability.

---

### Fotomaç — Verdict and Recommendation

**The RSS feed works. The proxy works (warm). The feed has 50+ current articles.**  
Only 6 appear in pipeline_log in 24h.

Most likely causes in priority order:
1. **source_configs URL or is_active mismatch** — can't confirm without SQL 1.1. If DB row has `is_active = false` or wrong URL, entire source is silently skipped.
2. **Off_topic / title_dedup filtering** — Fotomaç titles often follow pattern "Beşiktaş [player] transferinde" which should pass keyword filter, but if dedup finds the same story from NTV/Hürriyet (higher trust), Fotomaç loses.
3. **max_per_run too low** — if DB row has `max_per_run = 2` instead of default, only 2 articles enter per run × 3 runs/6h = 6. Consistent with observed 6/24h.

**Recommendation: F-A (fix URL/config) — but first run SQL 1.1 and 1.2.**

If 1.1 shows `is_active = false`:
```sql
UPDATE source_configs 
SET is_active = true, updated_at = NOW()
WHERE name ILIKE '%fotomac%';
```

If 1.1 shows wrong URL:
```sql
UPDATE source_configs
SET url = 'https://www.fotomac.com.tr/rss/besiktas.xml', updated_at = NOW()
WHERE name ILIKE '%fotomac%';
```

If 1.1 shows `max_per_run` too low (< 10):
```sql
UPDATE source_configs
SET max_per_run = 15, updated_at = NOW()
WHERE name ILIKE '%fotomac%';
```

If 1.1 looks correct, 1.2 will reveal whether it's F-D (off_topic/dedup). In that case, no quick fix — needs keyword tuning separately.

**Reversibility:** All `UPDATE source_configs` changes are immediately reversible. No code changes needed.

---

## Source 2 — Google News BJK

**Observed gap:** Feed has 100+ items but most are archive (2011, 2018, 2019, 2022), non-football (basketball, gymnastics, volleyball), or institutional (tickets, sponsorships). Question: is this feed adding value?

---

### 2.1 — Source config inspection  
**Status: REQUIRES SQL — run in Supabase dashboard**

```sql
SELECT name, url, is_active, trust_tier, bjk_filter, 
       polling_interval_minutes, max_per_run, custom_config
FROM source_configs 
WHERE name ILIKE '%google news%' 
   OR url ILIKE '%news.google%';
```

Hardcoded entries to compare against:
- `Google News`: `https://news.google.com/rss/search?q=Besiktas+BJK&hl=tr&gl=TR&ceid=TR:tr`, proxy: true  
- `Google News Transfer`: `https://news.google.com/rss/search?q=Besiktas+transfer&hl=tr&gl=TR&ceid=TR:tr`, proxy: true, keywordFilter: true

---

### 2.2 — Pipeline stage breakdown  
**Status: REQUIRES SQL — run in Supabase dashboard**

```sql
SELECT stage, COUNT(*), 
       ROUND(AVG(nvs_score)) as avg_nvs
FROM pipeline_log 
WHERE source_name LIKE '%Google News%'
  AND run_at > NOW() - INTERVAL '48 hours'
GROUP BY source_name, stage 
ORDER BY source_name, COUNT(*) DESC;
```

If 90%+ land in `date_old`: the 8h lookback is correctly filtering archive items, but this also confirms almost no useful articles are passing.  
If 90%+ land in `off_topic`: keyword filter is killing the few current articles.  
If many land in `url_seen`: URL dedup is dropping the same Google News redirect on every cycle.

---

### 2.3 — Date filtering check  
**Status: COMPLETE**

Date filter code: `src/processor.js:9` — `lookbackMs = 3 * 60 * 60 * 1000` (3h default)

Actual lookback at runtime (worker-fetch-agent.js:3836–3839):
```javascript
const lookbackMs = opts.lookbackMs != null
  ? opts.lookbackMs
  : opts.cronExpr
    ? Math.max(3 * cronToIntervalMs(opts.cronExpr), 8 * 60 * 60 * 1000)
    : 8 * 60 * 60 * 1000  // fallback
```

Normal pipeline cron: `0 */2 * * *` (every 2 hours)  
→ `cronToIntervalMs = 2h` → `Math.max(6h, 8h)` = **8 hours**

**Finding:** The pipeline uses an 8-hour lookback window. Any article older than 8h is dropped as `date_old`. Google News archive items from 2011/2018/2019/2022 will be filtered IF their RSS pubDate field is accurate.

**Caveat:** Google News RSS sometimes sets pubDate to the date Google indexed/re-surfaced an article, not the original publication date. If that's the case, a 2018 article re-surfaced today would have today's pubDate and would NOT be filtered. This can only be confirmed from SQL 2.2 — if `date_old` count is low but `off_topic` count is high, pubDate is being fabricated.

---

### 2.4 — Google News redirect resolution test  
**Status: COMPLETE**

Tested URL: `https://pitchos-proxy.onrender.com/article?url=https://news.google.com/rss/articles/CBMiW0FV…?oc=5`

```
STATUS: 500
BODY:   {"error":"Readability could not extract content","content":""}
```

**Finding:** Proxy hits Google News redirect URL and receives a Google interstitial/consent page that Readability cannot parse into article text. This means any article that requires body content (publish_mode = `rewrite`, `original_synthesis`, `template_transfer`) will fail at the fetch stage for Google News items.

**Note:** `template_transfer` path in `src/firewall.js:131–133` uses `title + RSS summary only` — it does NOT call the proxy for content. So Google News items could still generate template_transfer articles from RSS title + description alone. This is functional but produces low-context output (no article body).

---

### 2.5 — Direct bjk.com.tr proxy test  
**Status: BLOCKED**

Could not obtain a clean bjk.com.tr URL to test — Google News redirect doesn't resolve to extractable content (2.4 above), and bjk.com.tr RSS returns 403 (see 2.6). Cannot test proxy against bjk.com.tr article directly.

---

### 2.6 — Check if bjk.com.tr publishes RSS directly  
**Status: COMPLETE**

```
GET bjk.com.tr/rss            → HTTP 403
GET bjk.com.tr/feed           → HTTP 403
GET bjk.com.tr/rss/haberler   → HTTP 403
GET bjk.com.tr/haberler/rss   → HTTP 403
```

Homepage: Returns Cloudflare JS challenge — not scrapeable by server-side fetch.  
`fetchBJKOfficial()` via allorigins.win: Returns `error code: 522` (connection timeout to origin).

**Finding:** bjk.com.tr blocks all datacenter IPs (Cloudflare Workers egress, Render proxy, allorigins.win). No RSS feed accessible at any tested path. This source is non-functional and already noted at worker-fetch-agent.js:4661: `// fetchBJKOfficial disabled — bjk.com.tr blocks all datacenter IPs`.

---

### Google News BJK — Verdict and Recommendation

**The Google News redirect chain is broken for content extraction.** Proxy receives Google consent/interstitial pages, not article text. The feed can only contribute `template_transfer` articles (title + RSS summary, no body fetch). Whether that's worth keeping depends on SQL 2.2 output.

**Scenario A — SQL 2.2 shows near-zero published output from Google News:**  
Recommend **G-C (disable)**.

```sql
UPDATE source_configs
SET is_active = false, updated_at = NOW()
WHERE name ILIKE '%google news%' AND url ILIKE '%news.google%';
```

Both rows (Google News + Google News Transfer) should be disabled together.  
Reversibility: immediate — `SET is_active = true` to re-enable.

**Scenario B — SQL 2.2 shows Google News IS publishing template_transfer articles (even 3–5/day):**  
Recommend **G-D (keep as-is)**. The feed costs zero money (template_transfer doesn't synthesize), and if those articles are passing NVS ≥ 50, they're adding value. The noise items from 2018/2019 are caught by the 8h date filter.

**Do NOT apply G-A (replace with direct bjk.com.tr RSS)** — no accessible bjk.com.tr RSS exists.

---

## Section 3 — Summary

| Source | Root cause | Recommendation | Effort | Requires SQL first? |
|---|---|---|---|---|
| Fotomaç | Unknown (config or filter) | F-A: check/fix source_configs | 1 min if config; larger if F-D | YES — run 1.1 + 1.2 |
| Google News BJK | Redirect chain unresolvable for body fetch | G-C or G-D (depends on 2.2) | 1 min if disabling | YES — run 2.2 |
| bjk.com.tr | All datacenter IPs blocked | No action — already disabled | N/A | No |

**Estimated volume uplift if recommendations applied:**

- **Fotomaç F-A (if config fix):** 50+ articles available in RSS, of which perhaps 15–20 would pass date/dedup/topic filters per 8h cycle. Proxy warm-path extracts ~1000 chars body, publishable. Realistic uplift: **+3–6 Fotomaç articles/day** in pipeline, of which maybe 1–2 publish (synthesis success rate ~30% per earlier RCA).

- **Fotomaç F-A (if max_per_run fix):** Similar uplift but capped by whatever max_per_run is set to.

- **Google News G-C (disable):** No net impact on published volume if SQL 2.2 shows zero published output. Marginal improvement in pipeline efficiency (fewer items to score, dedupe, and discard).

- **bjk.com.tr:** No path to fix without the club unblocking datacenter IPs. Monitoring JSON-LD investigation (in NEXT.md) is the only remaining option, but only if Cloudflare Worker egress IP is not blocked.

**Is Fotomaç fix 1-minute (config) or larger (proxy work)?**  
If SQL 1.1 reveals a config problem (wrong URL, is_active = false, max_per_run too low): **1-minute SQL UPDATE**.  
If SQL 1.2 reveals off_topic or title_dedup killing articles after fetch: **larger — requires keyword tuning**, not covered here.

**Does a bjk.com.tr direct RSS feed exist?**  
No. All tested paths (4 RSS endpoints, homepage, allorigins.win, fetchBJKOfficial) return 403 or timeout. No RSS feed accessible from datacenter IPs.

---

## Pending SQL queries

Run these in Supabase dashboard before acting on recommendations:

```sql
-- 1.1 Fotomaç source config
SELECT name, url, is_active, trust_tier, bjk_filter, 
       polling_interval_minutes, max_per_run, custom_config, created_at, updated_at
FROM source_configs 
WHERE name ILIKE '%fotomac%' OR url ILIKE '%fotomac%';

-- 1.2 Fotomaç pipeline breakdown (48h)
SELECT stage, COUNT(*), MIN(run_at) as earliest, MAX(run_at) as latest, ROUND(AVG(nvs_score)) as avg_nvs
FROM pipeline_log 
WHERE source_name = 'Fotomaç' AND run_at > NOW() - INTERVAL '48 hours'
GROUP BY stage ORDER BY COUNT(*) DESC;

-- 2.1 Google News source configs
SELECT name, url, is_active, trust_tier, bjk_filter, polling_interval_minutes, max_per_run, custom_config
FROM source_configs 
WHERE name ILIKE '%google news%' OR url ILIKE '%news.google%';

-- 2.2 Google News pipeline breakdown (48h)
SELECT stage, COUNT(*), ROUND(AVG(nvs_score)) as avg_nvs
FROM pipeline_log 
WHERE source_name LIKE '%Google News%' AND run_at > NOW() - INTERVAL '48 hours'
GROUP BY source_name, stage ORDER BY source_name, COUNT(*) DESC;
```
