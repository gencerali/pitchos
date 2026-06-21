# NVS Decision Points Audit — 2026-05-21

**Scope**: Complete inventory of every place NVS is consulted, thresholds, comparisons, inconsistencies.
**Diagnostic only. No code changes.**

---

## Section 1 — Complete NVS Inventory

| # | File:line | Function/context | Type | Threshold | Operator | Pass result | Fail result | Override |
|---|---|---|---|---|---|---|---|---|
| 1 | `src/processor.js:201-214` | `scoreArticles` — nvs_hint bypass | gate | `a.nvs_hint != null` | existence check | Skip Claude; use preset NVS directly | Run Claude scoring | Applies to any article with nvs_hint set (currently: youtube articles) |
| 2 | `src/processor.js:247` | `scoreArticles` — prompt NVS bands | scoring | 0-19, 20-39, 40-59, 60-79, 80-100 (bands) | band assignment | NVS set by LLM | n/a | See band definitions below |
| 3 | `src/processor.js:294,320,325,337` | `scoreArticles` — error/truncation fallback | default | n/a | n/a | n/a | NVS=**50** (default on parse fail, truncation, or chunk error) | None — always 50 |
| 4 | `src/processor.js:303` | Post-scoring NVS cap | cap | 25 | n/a | n/a | `rival_pov=true` → `nvs = Math.min(nvs, 25)` | None |
| 5 | `src/processor.js:304` | Post-scoring NVS cap | cap | 19 | n/a | n/a | `relevant=false` → `nvs = Math.min(nvs, 19)` | None |
| 6 | `src/processor.js:305` | Post-scoring NVS cap | cap | 30 | n/a | n/a | `sentiment=rival_celebration` → `nvs = Math.min(nvs, 30)` | None |
| 7 | `src/processor.js:312` | Age penalty | modifier | 48h | `>= 48h` | No penalty | NVS -= 30 (min 0) | Age check skipped if published_at absent |
| 8 | `src/processor.js:313` | Age penalty | modifier | 24h | `>= 24h && < 48h` | No penalty | NVS -= 15 | Same |
| 9 | `src/publisher.js:139` | `decidePublishMode` — template_transfer | gate | 70 | `>= 70` | mode = `template_transfer` | Falls through to `rss_summary` | Only when `cat === 'transfer'` |
| 10 | `src/publisher.js:557` | `writeArticles` — proxy warm | trigger | 50 | `>= 50` | Warm proxy connection before synthesis loop | No warm (synthesis loop may be slower) | `a.treatment !== 'embed'` |
| 11 | `src/publisher.js:605` | `writeArticles` — synthesis trigger | gate | 50 | `>= 50` | Attempt rewrite synthesis; mode may upgrade to `rewrite` | Article stays `rss_summary` | None |
| 12 | `src/publisher.js:678-691` | `saveArticles` — MIN_BODY_CHARS | gate | 600 chars | `< 600` | Article saved to DB | Blocked (`SAVE BLOCKED` log) | Only when `publish_mode ∈ ['rewrite', 'original_synthesis']`; `synthesis` mode **NOT covered** |
| 13 | `src/publisher.js:968-999` | `rankAndEvict` — rank formula | rank | floor=5 | rank-based | Survives pool eviction | Soft-evicted (rescued if above hard floor 5, or by minPool) | hardTtl overrides rank for time-expired articles |
| 14 | `src/publisher.js:1011` | `rankAndEvict` — pool eviction | gate | 5 (rank, NOT NVS) | `< floor` | Survives | Soft-evicted | minPool=20 can rescue sub-floor articles up to 20 total |
| 15 | `worker-fetch-agent.js:5282` | `processSite` — auto-publish gate | gate | `site.auto_publish_threshold \|\| 30` | `>= publishThreshold` | Article included in `toPublish` for DB save | Not saved to DB | `template_official` bypasses NVS check entirely |
| 16 | `worker-fetch-agent.js:5275-5280` | `processSite` — pipeline_log label | log label | n/a | `publish_mode === 'rss_summary'` | Logged as `_stage: 'scored_low'` | n/a | — |
| 17 | `worker-fetch-agent.js:6644` | `renderArticleHTML` — NVS display pill | display | 40 | `>= 40` | Show "NVS N" pill on article page | No pill shown | None |
| 18 | `worker-fetch-agent.js:104` | H5 synthesis eligibility | gate | 60 | `< 60` | Return ineligible (no H5 synthesis) | Proceed with synthesis eligibility check | Only for H5 path (story-level synthesis) |
| 19 | `worker-fetch-agent.js:2863-2865` | Admin content browser NVS filter | filter | hi ≥ 75, mid 60-75, lo < 60 | `>=`, `&&` | Filtered view in admin | Full unfiltered view | Display only, no pipeline logic |
| 20 | `src/story-matcher.js:331,548` | Hardcoded NVS for template cards | default | 75, 82 | n/a | KV card written with preset NVS | n/a | Cards bypass scoring entirely |

### NVS band definitions (processor.js:249-280)

```
0-19   IRRELEVANT: BJK barely mentioned, rival team article, general league table
20-39  LOW: BJK context present but low value (training note, minor rumour)
40-59  MEDIUM: Standard news, transfer rumour, squad announcement
60-79  HIGH: Confirmed transfer, match preview, injury to key player
80-100 CRITICAL: Match result, official statement, major signing confirmed
```

Special rules applied post-scoring:
- `rival_pov=true` → floor NVS at 25
- `!relevant` → floor NVS at 19
- `sentiment=rival_celebration` → floor NVS at 30
- Age ≥ 48h: −30 penalty; 24-48h: −15 penalty

---

## Section 2 — Expected vs Actual Gates

### 2.1 — Auto-publish gate

**Location**: `worker-fetch-agent.js:5282-5286`

```javascript
const publishThreshold = site.auto_publish_threshold || 30;
const toPublish = allWritten.filter(a =>
  (a.nvs >= publishThreshold || a.publish_mode === 'template_official') &&
  a.publish_mode !== 'hot_news_hold');
```

- **Threshold source**: `sites.auto_publish_threshold` (DB-configured). Default `|| 30` hardcoded.
- **Comparison operator**: `>=` (inclusive — NVS=30 passes)
- **Bypass**: `template_official` skips NVS check entirely
- **Per-source override**: None — single threshold for all sources
- **Dead path**: `rss_summary` articles included in `toPublish` when NVS ≥ 30, but `saveArticles` at `src/publisher.js:680` filters `rss_summary` out immediately. The gate has no practical effect on rss_summary articles.

**DB query for Ali** — verify current threshold:
```sql
SELECT id, short_code, auto_publish_threshold FROM sites WHERE short_code = 'BJK';
```

### 2.2 — Synthesis trigger gate

**Location**: `src/publisher.js:605`

```javascript
if ((article.nvs || 0) >= 50) {
  // attempt rewrite synthesis
```

- **Threshold**: 50 (hardcoded — NOT the same as auto_publish_threshold)
- **Effect**: Articles 30-49 pass the auto-publish gate but are NOT synthesized → they stay `rss_summary` → filtered out by `saveArticles` → effectively never published to DB
- **Path to publish_mode decision**: `decidePublishMode` at `src/publisher.js:121` returns `rss_summary` as the default. Synthesis upgrade to `rewrite` happens later inside `writeArticles` when `nvs >= 50`.
- **Synthesis cap**: 6 rewrites per run. Articles above NVS=50 but past the cap go to `rewrite_queue` KV for hourly drain.

**Summary of publish_mode assignment:**

| NVS range | Default mode | Upgraded to |
|---|---|---|
| 0-29 | rss_summary (decidePublishMode) | Never; fails auto-publish gate |
| 30-49 | rss_summary (decidePublishMode) | Never; passes gate but saveArticles blocks |
| 50+ | rss_summary initially | `rewrite` if synthesis succeeds; stays `rss_summary` if no source/synthesis fails |
| Any + trust=official | `template_official` | Not upgraded; bypasses NVS gate |
| Any + cat=injury | `template_injury` | Not synthesized (no body generation for this mode) |
| 70+ + cat=transfer | `template_transfer` | Not synthesized |

### 2.3 — Pool ranking gate

**Formula** (`src/publisher.js:990`):
```javascript
rankScore = nvs * Math.exp(-ageHours / halfLife) * storyBoost * trustMultiplier
```

Where:
- `nvs` = article.nvs (0-100)
- `halfLife` = per-mode decay constant (0.5h for rss_summary, 24h for rewrite/synthesis)
- `storyBoost` = min(1.4, 1.0 + contributions_last_6h × 0.05)
- `trustMultiplier` = clamp(trust_score/50, 0.2, 2.0)

**Floor**: `floor=5` is **rank-based, not NVS-based**. A fresh NVS=5 article starts with rank≈5; it passes initially but ages out within 0.5-1h depending on halfLife. There is no NVS floor preventing pool entry.

**Key**: A high-NVS article can survive in the pool indefinitely as long as its decayed rank stays above 5. A low-NVS article enters and exits quickly.

### 2.4 — Pipeline_log "scored_low" label

**Location**: `worker-fetch-agent.js:5275-5280`

```javascript
scoredLowItems = allWritten
  .filter(a => a.publish_mode === 'rss_summary')
  .map(a => ({ ..., _stage: 'scored_low', ... }));
```

**Actual condition**: `publish_mode === 'rss_summary'` — NOT `nvs < threshold`.

**What `scored_low` actually captures**:
1. Articles with NVS 0-49: synthesis not triggered, mode stays rss_summary
2. Articles with NVS 50+: synthesis attempted but returned null body (source unavailable, Claude refusal, synthesis cap hit) → mode reverts to rss_summary → logged as `scored_low`
3. Template modes (template_injury, template_transfer) that stay at their original mode without synthesis are NOT logged as `scored_low` — they proceed to saveArticles and are published

**Mismatch with UI**: Admin panel displays `scored_low` as "Below threshold" with yellow badge. This is factually wrong for case 2 above — an NVS=85 article that hit the synthesis cap (6 per run) appears as "Below threshold" even though it scored above all thresholds.

### 2.5 — Display labels

**NVS pill on article page**: `worker-fetch-agent.js:6644` — shown when `nvs >= 40`.

This threshold (40) is **lower** than the synthesis trigger (50). Articles between NVS 40-49 get a pill shown but were not synthesized — they're rss_summary articles in the pool.

No color coding exists. All NVS pills render identically regardless of value.

**Admin content browser NVS filter** (`worker-fetch-agent.js:2863-2865`):
- hi: ≥ 75
- mid: 60-75
- lo: < 60

These thresholds are display-only and have no pipeline correlation.

### 2.6 — Cost cap / scoring bypass

`checkCostCap` (`src/utils.js:379`) reads KV key `cost:YYYY-MM`. If cap exceeded:
- `scoreArticles` is called with an empty article list → returns 0 scored articles → `preFiltered.length === 0` → pipeline falls into "quiet run" / seed-from-DB path
- NVS for zero-scored articles: N/A — no articles reach scoring
- Articles that bypass scoring due to cap hit: none explicitly skipped mid-scoring; the cap gates the entire cron run

No mechanism exists to score a partial batch and skip the rest. Cost cap is a full-run gate, not a per-article gate.

**DB representation**: Cost is tracked in KV only. No `pipeline_log` entry is written for a cost-cap blocked run.

### 2.7 — Other NVS-based decisions

**Manual promote** (`worker-fetch-agent.js:1052`): No NVS gate — any article can be promoted regardless of score.

**Duplicate cleanup** (`worker-fetch-agent.js:466`): Within same-slug duplicates, higher `nvs_score` wins when status is equal.

**Rewrite queue drain** (`src/publisher.js:862-880`): Articles queued have their `nvs` stored. When drained hourly, NVS is preserved. No second NVS gate at drain time.

**Story dedup** (`src/processor.js:170`): Keeps highest-NVS article per story cluster. NVS used as tiebreaker.

**H5 synthesis** (`worker-fetch-agent.js:104`): Story-level synthesis requires `maxNvs >= 60` across contributing articles. Single-article-story threshold.

---

## Section 3 — Inconsistency Findings

### 3.1 — Threshold inconsistencies

Seven distinct NVS thresholds, four different source types:

| Threshold | File:line | Source | Logical purpose |
|---|---|---|---|
| 19 | `src/processor.js:304` | Hardcoded | Irrelevance cap |
| 25 | `src/processor.js:303` | Hardcoded | Rival POV cap |
| 30 | `src/processor.js:305` | Hardcoded | Rival celebration cap |
| 30 | `worker-fetch-agent.js:5282` | DB (`auto_publish_threshold`) + hardcoded default | Auto-publish gate |
| 40 | `worker-fetch-agent.js:6644` | Hardcoded | Display pill |
| 50 | `src/publisher.js:605` | Hardcoded | Synthesis trigger |
| 60 | `worker-fetch-agent.js:104` | Hardcoded | H5 story eligibility |
| 70 | `src/publisher.js:139` | Hardcoded | template_transfer mode assignment |

**Problem**: The auto-publish threshold (30) is DB-configured but all others are hardcoded. If `auto_publish_threshold` is ever changed in the DB (e.g., raised to 50 to improve feed quality), it would create a gap: the synthesis trigger at 50 would now be AT the publish floor — no buffer between "publish" and "synthesize."

**Problem**: The auto-publish threshold (30) is below the synthesis trigger (50). This range (30-49) is a dead band — articles in this range pass the auto-publish gate (`nvs >= 30`) but are always filtered as `rss_summary` by `saveArticles`. The "auto-publish" gate at 30 has no effect because rss_summary articles are never DB-published regardless.

**Effective publish floor is 50, not 30**, because only synthesized articles (NVS ≥ 50) escape rss_summary mode and reach the DB.

### 3.2 — Comparison operator inconsistencies

All NVS gates use `>=` (inclusive). No `>` divergence found.

Exception check: `src/processor.js:104` uses `< 60` for H5 eligibility — equivalent to `<= 59` not `<= 60`. This is correct (60 is the floor for eligibility, not the ceiling for rejection). No operator inconsistency.

### 3.3 — Bypass condition inconsistencies

| Bypass | Auto-publish gate (≥30) | Synthesis trigger (≥50) | Pool eviction | DB body gate (≥600 chars) |
|---|---|---|---|---|
| `template_official` | ✅ Bypasses | ❌ Not relevant (no body generation) | No bypass — decays normally | ❌ No bypass |
| `template_injury`, `template_transfer` | ❌ No bypass | ❌ No bypass (no synthesis triggered for template modes) | No bypass | ❌ No bypass |
| `publish_mode === 'manual'` | No — goes through gate normally | No | 168h halfLife (slower decay) | ❌ No bypass |
| `synthesis` mode | n/a | n/a | n/a | ✅ BYPASSES (isSynth only covers rewrite, original_synthesis) |
| Template card (T10, T11 etc.) | ✅ Bypasses (template cards enter KV directly) | n/a | hardTtl evicts | ❌ No bypass |

**Critical gap**: `synthesis` mode bypasses MIN_BODY_CHARS=600 at `src/publisher.js:687`. `synthesis` is not in `['rewrite', 'original_synthesis']`. Note: Muçi article (DB-verified) is `template_transfer`, not synthesis — but the gap still applies to synthesis-mode articles with thin LLM output.

### 3.4 — Label-vs-reality mismatches

| Label | UI text | Actual assignment condition | Mismatch |
|---|---|---|---|
| `scored_low` | "Below threshold" | `publish_mode === 'rss_summary'` | **YES** — NVS may be ≥ threshold; mode is the discriminator, not score |
| `published` | "Published" | DB write succeeded + `saveArticles` accepted | ✅ Accurate |
| `url_seen` | "Already seen" | URL in seen-hashes KV or URL-dedup set | ✅ Accurate |
| `off_topic` | "Off-topic" | BJK keyword match failed in preFilter | ✅ Accurate |
| `date_old` | "Too old" | Published date outside lookback window | ✅ Accurate |
| `title_dedup` | "Near-dupe" | Title similarity ≥ threshold vs seen articles | ✅ Accurate |
| `hash_dedup` | "Hash dup" | Content hash in seen-hashes | ✅ Accurate |
| `too_short` | "Too short" | Source body below minimum length | ✅ Accurate |

**Only `scored_low` is mislabeled.** The label was introduced when rss_summary was the only below-threshold output mode. Now that synthesis failures also produce rss_summary, the label conflates three different cases:
1. Below synthesis trigger (NVS 0-49) — correctly "low"
2. Above synthesis trigger, synthesis failed — incorrectly "low"
3. Category forced to rss_summary (injury/transfer templates that didn't route to template mode) — ambiguous

The NVS histogram chart in the admin panel (`worker-fetch-agent.js:2658-2661`) plots `scored_low` articles in the "rejected" bucket alongside `published`. This inflates the "rejected" count with synthesis-failure cases that had high NVS scores.

---

## Section 4 — Recommendations

### 4.1 — Consolidate thresholds

**Immediate opportunity**: Replace hardcoded `50` synthesis trigger with a constant or DB field.

Proposed:
```javascript
const synthesisThreshold = site.synthesis_threshold || 50;  // new DB field
```

This allows per-site tuning without code changes. Call sites:
- `src/publisher.js:557` (proxy warm)
- `src/publisher.js:605` (synthesis trigger)

Effort: ~10 lines, 1 DB migration to add column. Low risk.

**Dead band fix**: The 30-49 NVS range passes the auto-publish gate but is always blocked by rss_summary filtering. Options:
- **Option A**: Raise `auto_publish_threshold` to match synthesis threshold (50). Removes the dead band. Impact: dashboard counts change (fewer "published" items appear in pipeline funnel since the gate now reflects reality). No functional change to what actually publishes.
- **Option B**: Accept dead band as-is; it's harmless. The gate still has semantic value for future non-rss_summary modes.
- **Option C**: Allow rss_summary articles to publish when NVS ≥ threshold (explicit choice: surface low-effort articles). This would change pipeline behavior.

**Recommendation**: Option A. Align `auto_publish_threshold` default to 50 in code (`|| 50`) to match synthesis trigger. If Ali wants to adjust per site, DB field takes precedence. **1-line change, no DB change needed**.

### 4.2 — Fix scored_low label

**Current**: `_stage: 'scored_low'` for all `publish_mode === 'rss_summary'` articles.

**Proposed split**:

```javascript
// worker-fetch-agent.js:5275
scoredLowItems = allWritten
  .filter(a => a.publish_mode === 'rss_summary')
  .map(a => ({
    ...,
    _stage: (a.nvs || 0) >= 50 ? 'synthesis_failed' : 'scored_low',
    drop_detail: (a.nvs || 0) >= 50 ? 'synthesis_cap_or_source_unavailable' : null,
  }));
```

UI label changes:
- `scored_low` → "Below synthesis threshold" (NVS < 50)
- `synthesis_failed` → "Synthesis failed" (NVS ≥ 50 but output was rss_summary)

**Call sites**: 1 write (`worker-fetch-agent.js:5277`), 1 admin UI label map (line 8782), 1 stage filter button (line 8339), 1 histogram bucket logic (line 2660).

Effort: ~20 lines. Low risk.

### 4.3 — Per-source-tier thresholds

**Question**: Should T1 (official) sources have a different threshold than T4 (general press)?

Current state: `template_official` articles bypass the NVS gate entirely. Other trust tiers share the same threshold (50 for synthesis, 30 for auto-publish).

**Assessment**: The current bypass for `template_official` IS a per-tier behavior — it just happens at mode-assignment time rather than at the NVS gate. Trust multiplier in `rankAndEvict` also gives higher-trust articles better pool survival.

**Recommendation**: No change needed for publish thresholds. Trust is adequately expressed through:
1. `template_official` mode bypass
2. `trustMultiplier` in rank formula
3. NVS age-penalty application (same for all tiers — no per-tier override here, which is a potential future improvement)

If a per-source threshold is ever needed, the DB column `auto_publish_threshold` on `sites` is the right pattern. A similar `per_source_override` JSONB column on `source_configs` would be the extension point.

### 4.4 — Post-synthesis quality gate

**Gap identified in Section 0 of reconciliation audit**: No post-synthesis NVS re-score or body quality check for `synthesis` mode articles.

**Options:**

**Option A (minimal)**: Add `'synthesis'` to `isSynth` at `src/publisher.js:687`. Blocks thin synthesis bodies via MIN_BODY_CHARS=600. Does not re-score NVS.

```javascript
const isSynth = ['rewrite', 'original_synthesis', 'synthesis'].includes(a.publish_mode);
```

Effort: 1 token change. Zero risk of regression. Ships this week.

**Option B (proper)**: Post-synthesis NVS re-scoring. After synthesis generates a body, feed the output text to a quick NVS check:
- Word count < 80: treat as synthesis failure, drop
- Sentence repetition detected: treat as synthesis failure, drop
- Body starts with `#` markdown: strip headers before saving

Effort: ~50 lines in `src/publisher.js`. Requires one small Claude call per synthesis. Additional cost ~$0.0002/article.

**Option C (full)**: Dedicated "output quality scorer" — separate from source NVS scorer. Runs after synthesis. Scores the generated body (not source) for: factual density, completeness, structural quality. Feeds into a separate `output_quality_score` field.

Effort: Large — schema change, new scoring prompt, new display. Defer to Sprint L.

**Recommended**: Option A now (1 line). Option B follow-up (50 lines, same sprint). Option C parked.

---

## End-of-Report Summary

### Inventory table
See Section 1 — 20 NVS reference points documented.

### Inconsistency findings

| # | Finding | File:line | Severity |
|---|---|---|---|
| I-1 | `scored_low` label means rss_summary mode, not below-threshold | worker:5275-5280, worker:8782 | Medium — misleads admin monitoring |
| I-2 | Dead band: NVS 30-49 passes auto-publish gate but rss_summary is always blocked by saveArticles | worker:5282 vs publisher.js:680 | Low — no functional impact, but gate is misleading |
| I-3 | `synthesis` mode bypasses MIN_BODY_CHARS=600 gate | publisher.js:687 | **HIGH — allows thin articles to publish** |
| I-4 | Fail-safe NVS default = 50 (above synthesis trigger) | processor.js:294,320,325 | Medium — scoring failures auto-promote to synthesis |
| I-5 | 7 distinct NVS thresholds, only 1 is DB-configured (30) | Multiple | Low — creates fragility if site threshold is ever changed |
| I-6 | NVS pill display threshold (40) is lower than synthesis trigger (50) | worker:6644 | Low cosmetic — rss_summary articles show NVS pill |

### DB queries needed

```sql
-- Verify current auto_publish_threshold
SELECT id, short_code, auto_publish_threshold FROM sites WHERE short_code = 'BJK';

-- Confirm scored_low NVS distribution (are high-NVS articles appearing as scored_low?)
SELECT nvs_score, COUNT(*) FROM pipeline_log
WHERE stage = 'scored_low' AND run_at > NOW() - INTERVAL '7 days'
GROUP BY nvs_score ORDER BY nvs_score DESC LIMIT 20;

-- How many scored_low have NVS >= 50 (synthesis should have run but failed)?
SELECT COUNT(*) as synthesis_failures, AVG(nvs_score)
FROM pipeline_log
WHERE stage = 'scored_low' AND nvs_score >= 50
  AND run_at > NOW() - INTERVAL '7 days';
```

### Top 3 recommended changes (impact/effort order)

1. **Add `'synthesis'` to `isSynth` at `src/publisher.js:687`** — 1 token. Closes the synthesis MIN_BODY_CHARS gap (separate from Muçi, which is template_transfer). Ship immediately.

2. **Change `|| 30` to `|| 50` in `worker-fetch-agent.js:5282`** — 1 character. Aligns published auto_publish_threshold default with the actual effective publish floor (synthesis trigger). Removes misleading dead band in pipeline funnel metrics.

3. **Split `scored_low` into `scored_low` vs `synthesis_failed`** — ~20 lines. Fixes misleading "Below threshold" label for high-NVS synthesis failures. Improves admin diagnostic accuracy.
