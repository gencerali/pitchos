# Pipeline Calibration + Pool Composition Diagnostic
**Date:** 2026-05-20  
**Trigger:** 95%/5% video-to-news pool ratio observed; NVS 68 article manually published; multiple recurring below-threshold articles in pipeline_log.

---

## Issue 1 — auto_publish_threshold miscalibrated

### Findings

**Code location:** `worker-fetch-agent.js:5256`
```javascript
const publishThreshold = site.auto_publish_threshold || 30;
```

**Default value:** 30 NVS. Exception: `template_official` always publishes regardless of score (`worker-fetch-agent.js:5258-5260`).

**Per-source/trust-tier overrides:** None. Single per-site value, DB-configured via `sites.auto_publish_threshold`.

**Actual configured threshold (inferred from data):** The default is 30 but real pipeline log shows NVS 68 as "below threshold" while NVS 72 published. This means `site.auto_publish_threshold` is set to approximately **70** in the `sites` table — NOT the code default of 30. The code default is irrelevant; the live value is what matters and it is not visible from code alone.

**Comparison logic** (`worker-fetch-agent.js:5258-5260`):
```javascript
const toPublish = allWritten.filter(a =>
  (a.nvs >= publishThreshold || a.publish_mode === 'template_official') &&
  a.publish_mode !== 'hot_news_hold');
```

**"scored_low" population** (`worker-fetch-agent.js:5249-5254`): All articles with `publish_mode === 'rss_summary'` are logged as `scored_low`. These include both genuinely low-NVS articles AND quality articles that happen to be in `rss_summary` mode.

**Root cause hypothesis:** The live `auto_publish_threshold` (~70) is aggressive. Turkish sports journalism at this topic specificity (one club, ongoing season) regularly produces NVS 60-70 articles that contain factual, publishable content. The NVS scorer may be applying a Süper Lig-average calibration that penalizes sub-viral angles. A threshold of 70 means roughly the top quartile only — leaving genuine BJK news (NVS 62-70) stranded as below-threshold and requiring manual override every time.

**Data needed to confirm:** Query `pipeline_log` for last 7 days: count NVS 60-75 articles by stage (published vs scored_low), cross-reference with `source_body_len ≥ 800`. If majority of 60-75 NVS articles with long bodies are scored_low, threshold is too strict.

**Severity:** HIGH — directly suppresses publishable content every cron run. Each manually published article is a threshold error by definition.

**Possible fix shape:** Lower `auto_publish_threshold` in `sites` table from ~70 to 60-65. Alternatively, add a trust-tier override: T1/T2 sources auto-publish at NVS ≥ 60, others at NVS ≥ 70.

---

## Issue 2 — Arda Turan article incorrectly marked near-dupe

### Findings

**Dedup logic location:** `src/processor.js:147-167`

**Similarity threshold:** `> 0.3` (30% word overlap) OR `>= 3` shared story tokens — either condition alone triggers a drop (`processor.js:154-159`):
```javascript
const isDupe = kept.some(k => {
  if (titleSimilarity(aNorm, normalizeTitle(k.title)) > 0.3) { winner = k; return true; }
  const kKeys = extractKeyTokens(k.title);
  if (sharedStoryTokens(aKeys, kKeys) >= 3) { winner = k; return true; }
  return false;
});
```

**Stopwords excluded from token comparison** (`processor.js:105`):
```javascript
const DEDUP_STOPWORDS = new Set(['beşiktaş', 'besiktas', 'bjk', 'siyahbeyaz']);
```

**Token minimum length:** 4+ characters (`/\b([A-ZÇĞİÖŞÜa-zçğışöşü]{4,}|\d+-\d+)\b/g`, line 101).

**Morphological matching:** `tokensMatch()` checks prefix match (min 4 chars), so "Beşiktaş'ta" and "Beşiktaş'ın" share the token "Beşiktaş" but it's in stopwords. Non-stopword morphological variants DO collapse (e.g., "Bayındır" and "Bayındır'ın").

**False match analysis on Arda Turan case:**

Title dropped: `"Arda Turan ile söz kesildi, Beşiktaş'tan süre istedi"`  
Tokens (4+ chars, non-stopword): `arda`, `turan`, `söz`, `kesildi`, `beşiktaş` (stopword), `süre`, `istedi`

Published same run: `"Beşiktaş'ta Reçber görevinden ayrıldı, Özen atandı"`  
Tokens: `beşiktaş` (stopword), `reçber`, `görevinden`, `ayrıldı`, `atandı`

These two articles share **zero non-stopword tokens** of 4+ characters. They should NOT match on token similarity. They could only match on `titleSimilarity > 0.3` — but with zero shared tokens that's also impossible.

**Likely actual cause:** The Arda Turan article was deduplicated against a **different earlier article in the same batch** (not the Reçber article). The `drop_detail` column would show the winner URL. Without a live DB query, the specific winner cannot be determined from code. A plausible candidate: an earlier article about coaching search / technical director search that shares tokens like `"Beşiktaş"` (stopword), `"hoca"`, `"süre"` — if those 3 match, the dedup fires.

**Threshold assessment:** The `>= 3 token` threshold is aggressive for a corpus where nearly all articles share "Beşiktaş" (in stopwords, correctly) plus 2 more football-context words ("hoca", "süre", "kadro", etc.). False matches are likely when two distinct stories use common Turkish football vocabulary.

**Severity:** MEDIUM — each false dedup drops a real story. Hard to quantify without live `drop_detail` query.

**Possible fix shape:** Raise token threshold from `>= 3` to `>= 4`, or add more stopwords (`hoca`, `kadro`, `sezon`, `süre`, `istedi`, `ayrıldı`). Or require tokens to include at least one named entity (person/place name, detectable by leading uppercase).

---

## Issue 3 — Altay Bayındır marked off_topic

### Findings

**All names checked against `src/utils.js:25-106` (BJK_KEYWORDS, 164 entries):**

| Name | In BJK_KEYWORDS |
|------|----------------|
| altay bayındır / altay bayindır | ABSENT |
| altay (bare) | ABSENT |
| cyle larin / larin | ABSENT |
| salih özcan / salih ozcan | ABSENT |
| atiba hutchinson / atiba | ABSENT |
| domagoj vida / vida | ABSENT |
| adem ljajic / ljajic | ABSENT |
| anderson talisca / talisca | ABSENT |
| burak yılmaz / burak yilmaz | ABSENT |

**All 9 former players are entirely absent from BJK_KEYWORDS.**

**Altay Bayındır article assessment:** Cannot fetch live article body from static analysis. However:
- Altay Bayındır left BJK for Fenerbahçe then moved to Manchester United in 2023
- A "Altay Bayındır transferinde yeni gelişme! Son karar hocanın" headline in May 2026 is ambiguous — could be ManUtd internal, could be return-to-Turkey angle
- `drop_detail` for off_topic rows is `"no_match"` (confirmed in code: `src/processor.js:30-31`)
- Correct rejection if the article is ManUtd internal; false rejection if it has a BJK return angle

**Keyword gap severity by former player:**
- **High impact** (regularly in news): Anderson Talisca (current Neom, often linked to return), Burak Yılmaz (active coach, regularly mentioned in BJK context), Atiba Hutchinson (retired, legend-level tributes ongoing)
- **Medium impact** (occasionally): Altay Bayındır (ManUtd regular, BJK connection fading), Salih Özcan (Dortmund, still active)
- **Low impact** (rarely in BJK context): Cyle Larin, Domagoj Vida, Adem Ljajic

**Severity:** MEDIUM — causes false off_topic rejections on genuinely BJK-relevant articles, especially for Talisca and Burak Yılmaz.

**Possible fix shape:** Add high-impact former players to Tier 4 in BJK_KEYWORDS with full-name forms only (not bare first names to avoid false positives). Specifically: `'anderson talisca', 'talisca', 'burak yılmaz', 'burak yilmaz', 'atiba hutchinson', 'atiba'`. Altay Bayındır: add as `'altay bayındır', 'altay bayindır'` only (bare "altay" would hit Altay FC/Altay Bayındır ambiguously).

---

## Issue 4 — Below-threshold articles re-entering pipeline every cron

### Findings

**Pipeline exit points for below-threshold articles:**

| Stage | Exit mechanism |
|-------|---------------|
| off_topic (preFilter) | ✅ `seen:off_topic:BJK` KV cache (Fix B, deployed today) |
| url_seen (Supabase dedup) | ✅ Permanent — article URL must be in `content_items` |
| scored_low (below NVS threshold) | ❌ **No cache. No Supabase row. Re-scored every run.** |
| hash_dedup (preFilter) | ✅ `seen:BJK` KV cache (50 entries, 48h TTL) |

**Why scored_low has no protection:**
- `saveArticles` only saves articles in `toPublish` to Supabase (`content_items`)
- Below-threshold articles never enter `content_items`, so `getSeenUrls` never returns their URLs
- `getSeenHashes` uses content hash (title+summary), not URL — would catch re-fetch only if title+summary are identical, which is likely but not guaranteed
- Net result: same URL re-scored every cron run until it either (a) ages out of the RSS feed's lookback window, or (b) gets a score upgrade that crosses the publish threshold

**Reddit "Do we still have a future?" case:**
- Appeared in 06:01 run (NVS 22) AND 08:02 run (NVS 28) — score changed between runs, confirming it's being re-scored each time, not a log display artifact
- NVS variance (22→28) is normal Claude scoring variation on borderline content

**Volume estimate:** Cannot compute exact count without live DB query. However: a typical cron run fetches 20-40 RSS articles. If 30% pass preFilter and score below threshold (~70 NVS cutoff), that's 6-12 articles re-scored per run. At 12 cron runs/day (every 2h) = **72-144 wasted Haiku scoring calls/day**. Each Haiku call costs ~$0.001. Estimated waste: **$0.07-0.14/day** (~$2-4/month). Low absolute cost but 100% wasted.

**Severity:** LOW (cost) / MEDIUM (pipeline log noise). Cost is minimal; the real harm is pipeline_log pollution making it harder to see real signal.

**Possible fix shape:** `seen:scored_low:` KV cache, same design as Fix B. TTL = lookbackMs. Cap 200 entries. Load before `scoreArticles`, filter articles whose URL hash is in cache; save newly scored_low URLs after scoring. Exact same pattern as off_topic cache, different stage.

---

## Issue 5 — Pool composition skewed ~95% videos / 5% articles

### Findings

**Pool ranking formula** (`src/publisher.js:968-999`):
```
rankScore = nvs × exp(-ageHours / halfLife) × storyBoost × trustMultiplier
```
Template articles get `+0.1` bonus. No mode-based weighting — video_embed and rewrite/synthesis use the same formula.

**Half-lives by publish_mode:**

| Mode | Half-life |
|------|-----------|
| rewrite | 24h |
| synthesis / original_synthesis | 24h |
| video_embed | **24h** |
| copy_source | 3h |
| rss_summary | 0.5h |
| manual | 96h |

**Half-lives by template (overrides mode):**

| Template | Half-life |
|----------|-----------|
| T10, T-HT, T-RED, T-VAR, T-OG, T-PEN | 0.5h |
| T11 | 4h |
| T01, T02, T03, T-REF | 18h |
| T12, T13 | 24h |
| T07 | 36h |
| T08c | 8h |
| T-XG | 12h |
| T05 | null (pinned) |

**Pool capacity:** 200 slots. Purely score-based, no mode-balancing (`src/publisher.js:1032`).

**No minimum news ratio:** Pool composition is entirely driven by publish rate × half-life × NVS. There is no mechanism to guarantee any minimum proportion of news articles.

**Root cause of 95/5 skew (from code analysis):**

The skew is a **publish rate problem, not a ranking problem**. Video_embed and rewrite/synthesis have the same 24h half-life, so ranking doesn't favor videos. The issue is upstream:

1. **Videos are publishing reliably.** YouTube channels (5+ active: Beşiktaş JK, beIN Sports TR, A Spor, Rabona Digital, TRT Spor) produce multiple videos per day. Each qualifies via `qualifyYouTubeVideo()` independently of NVS — YouTube content bypasses the NVS scoring gate.

2. **News articles are failing the publish threshold.** With threshold ~70, most RSS articles (NVS 35-68) never publish. On a typical cron run, 0-1 news articles publish while 3-5 YouTube videos may publish.

3. **24h half-life means videos accumulate.** Over 24 hours: 12 cron runs × ~3 videos each = 36 videos. 12 cron runs × ~0.5 news articles = 6 news articles. **Ratio: 6:1 videos to news by count.** At 36 videos each at full NVS, they score higher than older news articles and dominate the 200-slot pool.

4. **YouTube NVS bypass:** `qualifyYouTubeVideo()` assigns NVS via `nvs_hint` from channel metadata, not the same Haiku scoring gate as RSS articles. YouTube content doesn't face the same ~70 NVS bar.

**Manual publish surface path:** When Ali manually published the Sabah Spor article via `/admin/content-publish`, it was written to Supabase and pushed to KV. It would appear in the pool but immediately face the ranking formula: NVS 68 × exp(-age/24) × 1.0. At its age (~2h after manual publish), rankScore ≈ 68 × 0.92 = 62.5. A fresh YouTube video at NVS 75 scores 75 × 1.0 = 75. The news article enters the pool but ranks below recent videos.

**Severity:** HIGH — visible site-quality problem. A BJK news site showing 95% YouTube embeds reads as a video aggregator, not a news publisher. Directly impacts AdSense quality review.

**Possible fix shape (two options):**

Option A — Fix the threshold (Issue 1 fix): Lower auto_publish_threshold to 60-65. More news articles pass → ratio naturally improves. No architecture change needed.

Option B — Mode-based pool balancing: In `rankAndEvict`, enforce a cap on video_embed articles (e.g., max 50% of pool). Simple post-ranking filter. Ensures news is always visible regardless of publish rate.

Option A is lower risk and fixes the root cause. Option B is a safety net.

---

## Leverage Ranking

From highest to lowest impact on daily published article count:

| Rank | Issue | Leverage | Why |
|------|-------|----------|-----|
| 1 | **Issue 1 — threshold miscalibrated (~70)** | HIGH | Directly controls how many articles auto-publish. Lowering to 60-65 would likely double daily news output immediately. No code change needed — DB update only. |
| 2 | **Issue 5 — 95/5 pool skew** | HIGH | Resolved by fixing Issue 1 (more news publishes). If Issue 1 fix alone doesn't balance the pool, Option B (video cap in rankAndEvict) is a direct lever. |
| 3 | **Issue 3 — BJK_KEYWORDS former player gaps** | MEDIUM | Recovers articles that are now silently discarded as off_topic. High-value former player news (Talisca, Burak Yılmaz, Atiba) would re-enter pipeline. |
| 4 | **Issue 2 — title_dedup false matches** | MEDIUM | Recovers dropped articles that are actually different stories. Token threshold `>= 3` is likely causing false matches on common football vocabulary. |
| 5 | **Issue 4 — scored_low re-entry** | LOW | Cost is ~$2-4/month, pipeline_log noise is real but not blocking. Fix is straightforward (seen:scored_low: cache) but impact is operational hygiene, not article count. |

**Recommended sequence (for Ali's decision):**
1. Confirm actual `site.auto_publish_threshold` value in Supabase `sites` table. If it is ~70, lower to 62-65 and observe next 24h.
2. After threshold fix, re-check pool composition — skew likely self-corrects.
3. Add former player keywords (Talisca, Burak Yılmaz, Atiba at minimum).
4. Revisit title_dedup threshold only if false matches are confirmed via drop_detail query.
5. scored_low cache: low priority, schedule for quiet week.
