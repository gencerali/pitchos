# DECISIONS.md — Kartalix Architectural Decision Log

**How to use this file**:
- **Append-only.** Never edit past entries. If a decision is reversed, write a new entry that supersedes it and reference the old entry's date.
- One entry per material decision. Format below.
- Future-you and any co-founder reads this to understand *why* the system is the way it is, not just *what* it is.
- The PM agent watches this file — if architecture-level decisions appear in chat without a corresponding entry here, it nudges.

---

## ENTRY FORMAT

```
### [DATE] — [SHORT TITLE]

**Decision**: [one sentence]

**Alternatives considered**:
- A: [option] — [why rejected]
- B: [option] — [why rejected]

**Why this one**: [reasoning]

**What would change our mind**: [conditions under which we'd revisit]

**Related**: [links to other entries, slices, or external sources]
```

---

## ENTRIES

### 2026-05-28 — VH curated sections: category column as section discriminator

**Decision**: Use `category` column (free-text, no constraint) to tag curated videos into belgeseller/unutulmaz/haber/mac/roportaj sections; store `video_type: 'news'` as a safe placeholder regardless of section.

**Alternatives considered**:
- A: Add 'belgeseller'/'unutulmaz' to the `video_type` CHECK constraint — rejected; schema migration requires Supabase dashboard access, adds values that carry classifier meaning to a field used by the pipeline; risk of constraint pollution.
- B: Separate `curated_items` table — rejected; overkill for a handful of manually-curated videos; loses all existing article-page infrastructure (slug routing, renderArticleHTML, RSS, sitemap) for free.

**Why this one**: `category` is already a free-text column with no constraint. Setting `category = 'belgeseller'` and `video_type = 'news'` lets the VH page filter curated tabs by `v.category === s.value` while standard tabs (haber/mac/roportaj) exclude them via `!_VH_PURE_CURATED_CATS.has(v.category)`. Zero schema changes; fully reversible.

**What would change our mind**: If `category` gains a CHECK constraint in a future migration, or if curated videos need a fundamentally different content pipeline (e.g. separate editorial workflow), a dedicated table would be warranted.

**Related**: `_VH_CURATED_SECTIONS`, `_VH_ALL_SECTION_MAP`, `_VH_PURE_CURATED_CATS` constants in `worker-fetch-agent.js`; ROADMAP VH7.

---

### 2026-05-28 — VH curated sort order: KV slug array

**Decision**: Store manual sort order as a JSON array of slugs in KV key `curated:order`; apply at query time in both admin page and VH public tabs.

**Alternatives considered**:
- A: `sort_order` integer column on `content_items` — requires schema migration; PATCH on every reorder is N DB writes; ordering state belongs to editorial UX, not source data.
- B: Client-side-only sort (not persisted) — reorder lost on page reload; useless for controlling public VH tab order.

**Why this one**: KV write is one atomic PUT of the full ordered slug array. Read cost is one KV GET per page load (already paying for `curated:order` alongside the Supabase fetch). Drag-and-drop UI is self-contained; save button gives explicit confirmation. Public VH page applies same order with no extra Supabase query.

**What would change our mind**: If curated sections grow to hundreds of videos per section, a per-section sort (e.g. `curated:order:belgeseller`) would reduce payload size.

**Related**: `PUT /admin/curated-video` handler; `renderCuratedVideoPage` drag-and-drop JS; `renderVideoHubPage` curated sort application.

---

### 2026-05-28 — Related videos on article pages: same-section Supabase query

**Decision**: On `youtube_embed` article pages, show up to 3 related video cards fetched from Supabase filtered by same `category` (for curated) or excluding curated categories (for standard embeds); sorted by `published_at desc`.

**Alternatives considered**:
- A: Same section + recency from KV `articles:BJK` — rejected; KV cache doesn't reliably contain curated articles (category-tagged videos may fall outside the top-100 pipeline window); zero related videos shown for belgeseller/unutulmaz pages.
- B: Title keyword overlap — rejected at design time; Turkish stopword list adds maintenance burden; short titles give weak signal; value-add uncertain vs implementation cost.
- C: No related videos — missed opportunity; session depth drops, ad impressions/visit lower.

**Why this one**: One additional Supabase SELECT (3-row limit) on article page load — negligible cost, reliable results regardless of KV state. Curated articles correctly get same-bucket suggestions; regular youtube_embeds get recent non-curated embeds.

**What would change our mind**: If article-page load time becomes a concern (currently two Supabase calls), could cache related results in KV per slug with short TTL.

**Related**: `serveArticlePage()` related query; `renderArticleHTML()` `relatedHtml` block; `.related-vids` CSS.

---

### 2026-05-21 — Synthesis_failed seen-cache + template_transfer_thin pipeline_log

**Decision**: Two additive fixes from Duhuliye synthesis failure RCA (`docs/duhuliye-rca-2026-05-21.md`). Both are monitoring/cost fixes — no behavior changes for articles that pass synthesis.

**Fix 1 — Synthesis_failed seen-cache** (`src/processor.js:388`, `worker-fetch-agent.js:4677`):  
URLs that fail synthesis are now cached in KV key `seen:synth_failed:{siteCode}` (TTL 6h, 200-entry cap) and filtered before `preFilter` on subsequent cron runs. Same pattern as the off_topic seen-cache (Fix B, 2026-05-20). Prevents the same failing URLs (e.g., Duhuliye 403s) from being re-scored with NVS every 5 minutes indefinitely. Cache is populated after `scoredLowItems` is built — only `synthesis_failed` stage rows contribute (nvs≥50 rss_summary). `scored_low` rows (nvs<50) are not cached — they may score higher in the future if source improves.  
**Verified-by**: `src/processor.js:388,397` — `getSynthesisFailedHashes`/`saveSynthesisFailedHashes`; `worker-fetch-agent.js:4677` — load + filter; `worker-fetch-agent.js:5315-5323` — save after run

**Fix 2 — template_transfer_thin pipeline_log entries** (`src/publisher.js:679`, `worker-fetch-agent.js:5303`):  
Closes monitoring gap created by Fix 1 (isSynth gate, 2026-05-21 five-fix session). When `saveArticles` blocks a thin `template_transfer` body (< 600 chars), the article now appears in pipeline_log with `stage='template_transfer_thin'` and `drop_detail=<body_char_count>`. Previously these drops were silent — only a `console.warn` in Cloudflare logs, no DB row, invisible to admin panel. `thinDropped[]` array threaded through all 3 `saveArticles` return paths; mapped to log items in worker.  
UI: pink badge (`pl-template_transfer_thin`), filter button "Transfer thin", `plStageMeta` label, `PL_STAGE_LABELS` entry.  
**Verified-by**: `src/publisher.js:679,690,696,764,776,779` — thinDropped capture and threading; `worker-fetch-agent.js:5303-5307` — pipeline_log mapping; `worker-fetch-agent.js:5449` — allEvents spread; `worker-fetch-agent.js:8229,8367,8814` — UI

**Deployed**: version `9b3ada04-fbd7-4aca-ba39-0b5b9baf8624`

---

### 2026-05-21 — Trust-aware dedup pre-sort

**Decision**: Sort `allFetched` by trust_tier ascending rank (T1=0, T2=1, T3=2, T4=3) before `dedupeByTitle` runs inside `preFilter`. Ensures higher-trust sources consistently win title dedup collisions regardless of RSS fetch arrival order.

**Root cause addressed**: `dedupeByTitle` (`src/processor.js:161`) is first-come-first-served — first article for a title in the input array wins, with no trust-tier awareness. Diagnostic (`docs/dedup-deep-dive-2026-05-21.md`) confirmed Duhuliye (T4 after tonight's downgrade, previously T2) was beating Fotomaç (T3) on every shared story because "D" precedes "F" in the alphabetically-ordered source_configs feed list. Duhuliye then failed synthesis (proxy 403), so no article published for those stories.

**Change**: 2 lines inserted at `worker-fetch-agent.js:4683–4684`, after `allFetched` filter, before `preFilter` call. Stable sort preserves within-tier order (arrival order unchanged among same-trust sources).

**Null/unknown trust_tier**: `?? 3` fallback — treated as T4, sorts last. Safe for hardcoded RSS_FEEDS fallback path (trust values 'press'/'broadcast'/'journalist') which is inactive when source_configs is populated.

**Combined with**: Duhuliye trust_tier SQL downgrade T2 → T4 (same session). Both fixes together break the Duhuliye-blocks-Fotomaç chain.

**Per**: `docs/dedup-deep-dive-2026-05-21.md` Finding 3 / Sprint I2 scope.

**Verified-by**: `worker-fetch-agent.js:4683` — `const TRUST_RANK = { T1: 0, T2: 1, T3: 2, T4: 3 };`; `worker-fetch-agent.js:4684` — `allFetched.sort(...)`. Verification SQL in NEXT.md — run after 2 cron cycles (~4h post-deploy `2026-05-21 [deploy time]`).

**Deployed**: version `04ec21f3-333f-4273-9890-f50bf394f54f`

**Rollback**: delete lines 4683–4684 and redeploy. No schema, no data, no dependencies.

---

### 2026-05-22 — Volume recovery: SHELF_LIFE expansion + dedupeByStory ≥2 + synthesis sibling fallback

**Decision**: Three additive changes to increase published article volume from ~2-3/day to ~8-12/day visible on homepage. Background analysis: `temp/0 . kartalix_volume_deep_analysis.md`. All three independently reversible, no quality gates lowered.

**Item 1 — SHELF_LIFE doubled (`index.html`)**:  
`Match: 24→48, Transfer: 72→96, Injury: 24→48, Club: 48→72, European: 48→72, Other: 24→48, default: 24→48`. Client-side `isExpired()` was filtering 18/20 KV articles — only 2 Transfer articles (43–44h) survived the 72h shelf life. Homepage showed 2 articles despite 20 live in KV. Football news has longer relevance than 24h; next-day post-match coverage is still the primary story. Bounded by `rankAndEvict` which still drops articles below decay floor regardless of shelf life.  
**Verified-by**: `index.html:1120` — `SHELF_LIFE` object. Diagnosis in `docs/homepage-render-2026-05-22.md`.

**Item 2 — dedupeByStory threshold ≥1 → ≥2 (`src/processor.js:197`)**:  
Two articles sharing ONE 4+ char word (after stopword removal) should not be marked same-story. Was killing 53% of scored articles (30 scored → 14 after dedup). Raising to ≥2 shared tokens. Pre-scoring `dedupeByTitle` (Stage 4) still catches genuine title matches at 0.3 similarity or ≥3 shared tokens — worst-case duplicates do not slip through.  
**Verified-by**: `src/processor.js:197` — `return sharedStoryTokens(aKeys, kKeys) >= 2;`  
**Verification SQL** (run after 2 cron cycles):
```sql
SELECT funnel_stats->>'scored' as scored,
       funnel_stats->>'after_story_dedup' as after_dedup,
       ROUND(100.0 * (funnel_stats->>'after_story_dedup')::int
             / NULLIF((funnel_stats->>'scored')::int, 0)) as retention_pct
FROM fetch_logs
WHERE created_at > '2026-05-22 10:00:00+00'
ORDER BY created_at DESC LIMIT 5;
```
Expected: `retention_pct` rises from ~47% baseline to 70–80%.

**Items 1 + 2 deployed**: version `09d54344` (exact ID from wrangler deploy output)

---

**Item 3 — Synthesis sibling fallback (`src/processor.js`, `src/publisher.js`, `worker-fetch-agent.js`)**:  
When primary source fails synthesis (proxy 403, thin output, refusal), retry with up to 2 dedup-collapsed sibling articles (same story, different source URL). Bounded at 2 sibling attempts per failure to cap Claude cost on days with large story clusters. 

Three sub-components:

**3a — Cap counts successes not attempts (verification only, no code change)**:  
`rewritesSoFar = results.filter(r => r.publish_mode === 'rewrite').length` counts only SUCCESS outcomes. `publish_mode` is set to `'rewrite'` only when `body.length > 600` (`publisher.js:648`). Failed attempts leave `publish_mode` as `'rss_summary'` and do not consume the 6-per-run cap. Verified 2026-05-22 — logic already correct, no change needed. Cap comment added at `src/publisher.js:608`.

**3b — dupeSiblings map in `dedupeByTitle`** (`src/processor.js:167`):  
Extended `dedupeByTitle` return value from `{ kept, dupeWinnerMap }` to `{ kept, dupeWinnerMap, dupeSiblings }`. `dupeSiblings` maps winner URL → array of losing articles (same-story dedup losers). No change to dedup logic — same articles win/lose as before; losers are now preserved as data rather than discarded.  
**Verified-by**: `src/processor.js:170` — `const dupeSiblings = new Map();`; `src/processor.js:192` — returned in tuple

**3c — `_siblings` attached to articles at preFilter** (`src/processor.js:75`):  
After `dedupeByTitle`, each surviving article gets `a._siblings = dupeSiblings.get(key) || []`. Most articles have `_siblings = []` (the common case — no dedup losers). `_siblings` is an internal pipeline field excluded from KV by `toKVShape`'s explicit property whitelist (confirmed `worker-fetch-agent.js:4048`).  
**Verified-by**: `src/processor.js:78–81` — siblings attach loop; `worker-fetch-agent.js:4048` — `toKVShape` whitelist comment

**3d — Sibling retry block in `writeArticles`** (`src/publisher.js:618–643`):  
After primary `synthesizeArticle` call fails (null body or ≤600 chars), loop over `article._siblings.slice(0, 2)`. Each sibling is synthesized with the winner's `nvs` and `category` inherited. On first success: attribution fully rewritten to sibling's source (all four fields: `source_name`, `source`, `url`, `original_url`). `_used_sibling_source` set for log tracing. Loop breaks on first success. If all siblings fail, article stays `rss_summary` as before.  
Attribution rewrite rationale: reader trust requires attribution to point to the source whose content was actually synthesized, not the story "winner" who failed. Rewriting all four fields ensures both admin display and article page render the correct source.  
**Verified-by**: `src/publisher.js:620` — guard; `src/publisher.js:622` — `.slice(0, 2)`; `src/publisher.js:631–635` — attribution rewrite block; `src/publisher.js:636` — console log for monitoring

**Deployed**: version `211b56f2-4187-4d90-88fc-076118547ff4` (2026-05-22)

**Verification** (after 2 cron cycles post-deploy):
- Q1: Cloudflare worker logs — watch for "SYNTHESIS RECOVERED via sibling: [source]"
- Q2: `SELECT slug, source_name, original_url FROM content_items WHERE publish_mode = 'rewrite' ORDER BY published_at DESC LIMIT 10` — verify source_name matches URL hostname
- Q3: `synthesis_failed` stage count drops vs pre-deploy baseline

**Rollback**: Items 1+2 — single-line reverts in `index.html:1120` and `processor.js:197`. Item 3 — revert `dedupeByTitle` to return only `{ kept, dupeWinnerMap }`, remove `_siblings` attach loop, revert synthesis block to original form. No schema changes, no KV key changes.

---

### 2026-05-22 — P0 incident: pool zero from Claude 529 + KV TTL drain

**Decision**: Two protective fixes after pool hit 0 due to uncaught Claude 529 → cacheToKV never reached → 4h KV TTL expired. Full incident report: `docs/Incidents/incident-2026-05-22-pool-zero.md`.

**Fix 1 — scoreArticles try-catch** (`worker-fetch-agent.js`, deploy `829f2659`):  
`scoreArticles` call wrapped in try-catch. On catch: log error, attempt KV re-seed from Supabase as recovery path. Previously, a Claude 529 threw uncaught from `scoreArticles`, aborted the pipeline function entirely, and `cacheToKV` was never reached. KV TTL continued counting down from last successful write. Two consecutive failures (06:01 + 08:01 UTC) → TTL expired → pool zero.

**Fix 2 — DB seed query hardening** (`worker-fetch-agent.js`, deploy `db1e0092`):  
`supabase()` returns `null` on non-OK HTTP response (does not throw). `Array.isArray(null) = false` → seed silently produced empty array → `cacheToKV([])`. Fix: select specific columns (not `*`), `encodeURIComponent` on date filter, explicit null logging. Also added `youtube_embed: 48` to `HALF_LIFE_BY_MODE` (was missing — defaulted to 8h halfLife, youtube_embed articles decayed too fast).

**Verified-by**: `worker-fetch-agent.js` — deploy `829f2659` + `db1e0092`. Manual pool restore via "Önbelleği Yenile" admin button. `docs/Incidents/incident-2026-05-22-pool-zero.md`.

**Remaining hardening** (not yet done): Add `status=eq.published` filter to `/rebuild-cache` handler (currently returns all statuses). Connect `renderVideos()` to KV youtube_embed articles (currently uses `MOCK_VIDEOS` hardcoded).

---

### 2026-05-21 — PARKED: Transfer Tracker (Sprint M concept)

**Decision**: Concept accepted in principle; parked until AdSense review settles and a 2-day extraction PoC validates LLM quality. Do not start implementation before both conditions are met.

**Concept summary**: A structured transfer claim tracking layer on top of the existing article pipeline. When a scored article (NVS ≥ 50) contains transfer keywords, a focused LLM call extracts a structured claim (player, from_club, to_club, status, fee, source, claim_date, url). Claims are stored in a new `transfer_claims` table and displayed on a public `/transfer-takip` page with multi-source aggregation, lifecycle tracking (rumored → agreed → completed/failed), and eventually journalist accuracy counts. Narrow scope — transfers only, not general fact extraction.

**Why transfer-only beats general fact extraction**:
- Bounded schema: 8 fields, no general entity normalization required
- Clear lifecycle with verifiable outcomes: did the transfer happen?
- Repetition is signal: 10–30 sources on the same rumor → confidence indicator
- Summer transfer window drives peak reader interest (July–August)
- No Turkish BJK site currently offers trust-graded structured tracking — unique AdSense-grade content

**Honest concerns (not killers, but must inform v1 scope)**:
- Attribution chain ambiguity: Turkish papers citing Fabrizio Romano — track publishing source (easy) or originating journalist (hard, requires citation parsing). v1 tracks publishing source only.
- "Claim" threshold is fuzzy: "interested in Anguissa" vs. "in negotiations" — needs explicit prompt rules defining what qualifies.
- LLM hallucination risk in extraction: player/club fields must be verified against article text. Strict prompt + manual spot-check required.
- Sample sizes small for journalist accuracy: 4–6 weeks of data before signals are meaningful. v2.5 is a slow-build feature.
- Cost: per-article Haiku extraction call. Estimate before committing.

**Schema design constraint**: Sprint I3 (`journalist_claims`, `journalist_outcomes` tables) is already designed in SLICES.md. Transfer Tracker v2.5 journalist accuracy MUST join those tables, not duplicate them. Schema design session for `transfer_claims` should happen after Sprint I3 spec is finalized to avoid overlap. `transfer_claims` = article/source-level (no journalist attribution required in v1); `journalist_claims` = journalist-level (requires byline). They coexist and join at v2.5.

**v2 backlog note**: "Transfer Radar board" in ROADMAP.md v2 backlog and "Kartalix Pro: Transfer Radar Pro €3.99/mo" in SLICES.md v2 are the Pro-tier wrapper for this same feature. Transfer Tracker v1 is the free public version that drives engagement + AdSense. Sprint M builds v1–v1.5; Pro tier comes after v1.0 ships and revenue warrants it.

**Trigger conditions** (both required before starting):
1. AdSense review outcome known (submitted 2026-05-18; expected ~7-14 days)
2. 2-day extraction PoC validates LLM quality: run focused extraction on 20–30 recent published transfer articles from Supabase DB; measure % correctly extracted vs hallucinated fields; accept threshold TBD but rough bar: >80% correct on player + from_club + to_club, <10% hallucinated fields

**What would change our mind**: PoC hallucination rate >20% → redesign extraction prompt before committing to schema. Summer transfer window passing without starting (August 31) → defer to January window + post-v1.1 slot.

**Related**: Sprint I3 (journalist_claims), ROADMAP.md v2 "Transfer Radar board", SLICES.md v2 backlog, `temp/16kartalix_transfer_tracker_concept.txt`

---

### 2026-05-21 — Google News feeds disabled (all 3)

**Decision**: Disabled all three Google News RSS feeds in source_configs after pipeline_log diagnostic confirmed near-zero yield and structural content extraction failure.

**Feeds disabled** (SQL UPDATE, not code change):
- `"Google News"` — `https://news.google.com/rss/search?q=Besiktas+BJK…` — T2, proxy: true
- `"Google News BJK Transfer"` — `https://news.google.com/rss/search?q=Besiktas+transfer…` — T3 (partial data; proxy: false in DB vs true in hardcoded — mismatch)
- `"BJK Resmi (Google News)"` — `https://news.google.com/rss/search?q=site:bjk.com.tr…` — T1, proxy: true

**Diagnostic findings** (`docs/source-config-audit-2026-05-21.md`):
- 90%+ pipeline_log entries at `title_dedup` for both named feeds: ~200 items / 48h, 1 published article total (~0.5% yield)
- Proxy returns `{"error":"Readability could not extract content"}` on all Google News redirect URLs — article body extraction structurally impossible
- "BJK Resmi (Google News)" T1 assignment was actively harmful: a T1 Google News redirect won every title_dedup contest against real T2 sources, blocked the real article, then failed content fetch — net result: story publishes nothing

**Alternatives considered**:
- G-D (keep as-is): Rejected — 0.5% yield doesn't justify ~200 items processed per 48h. Template_transfer might work on title+description alone, but the 1-article/48h output confirms it doesn't in practice.
- URL pattern filter: Rejected — redirect chain is broken at the proxy layer regardless of which URLs we filter in/out.
- Replace with direct bjk.com.tr RSS: Not possible — all bjk.com.tr RSS paths return HTTP 403, homepage is Cloudflare JS challenge.

**Why this one**: Zero net loss — the stories these feeds aggregate (Hürriyet, Fanatik, NTV, bjk.com.tr) are already in the pipeline from direct sources. Disabling removes ~200 wasted pipeline_log rows per 48h.

**What would change our mind**: bjk.com.tr removing datacenter IP block (then use direct feed, not Google News search). Or Google News providing a proxy-accessible article endpoint.

**Verified-by**: `pipeline_log` query 2026-05-21 — `source_name LIKE '%Google News%'`, 48h window, 90%+ `title_dedup`, 1 `published` total. Source config rows confirmed at T1/T2/T3 with Google News URLs.

**Reversal**: `UPDATE source_configs SET is_active = true, updated_at = NOW() WHERE name ILIKE '%google news%' AND url ILIKE '%news.google%';`

---

### 2026-05-21 — pipeline_log silent failure fix (thinDropItems scope bug)

**Decision**: Fix `thinDropItems` block-scope bug that caused all pipeline_log writes to silently fail since deploy `9b3ada04`.

**Root cause**: `thinDropItems` was declared with `const` inside the "DB-FIRST SAVE + KV WRITE" try block (`worker-fetch-agent.js:5305`), but referenced outside that block at `worker-fetch-agent.js:5451` (the pipeline_log allEvents spread). In JavaScript, `const` is block-scoped — accessing it outside its block throws `ReferenceError: thinDropItems is not defined`. That error was caught by the outer `try/catch` at line 5470 and swallowed with `console.error('pipeline_log block failed:', ...)`. No POST to Supabase ever fired.

**Why silent**: The `if (allEvents.length > 0)` guard never ran (error thrown before it). Fetch_logs wrote 'success' regardless (it's on line 5437, before the pipeline_log block). Manual Supabase INSERT worked (no schema/RLS issue — the problem was pure JS scope).

**Introduced by**: Deploy `9b3ada04` (2026-05-21 template_transfer_thin feature) — `thinDropItems` was a new variable added in that session.

**Fix**: 2-line change. Move declaration to outer scope alongside `scoredLowItems` and `publishedLogItems` (line 5274–5275); remove `const` from inner assignment (line 5305 → bare assignment).

**Deployed**: version `4d982404-7134-4a6d-93a6-a0bcb28cc460`

**Verification SQL** (run after next cron cycle, ~22:05 UTC):
```sql
SELECT stage, COUNT(*), MAX(run_at)
FROM pipeline_log
WHERE run_at > NOW() - INTERVAL '30 minutes'
GROUP BY stage ORDER BY stage;
```
Expect rows with `run_at` > deploy time. Any row confirms the fix.

---

### 2026-05-21 — Five protective pipeline fixes (Muçi/NVS audit findings)

**Decision**: Five additive gate/filter fixes deployed in single commit to address issues uncovered by Muçi article forensics, NVS audit (`docs/nvs-decision-points-audit-2026-05-21.md`), and reconciliation audit (`docs/reconciliation-audit-2026-05-20.md`). All changes are additive — no behavior changes for articles that already pass.

**Fix 1 — isSynth extended to cover template_transfer** (`src/publisher.js:687`):  
`template_transfer` added to `['rewrite', 'original_synthesis', 'template_transfer']`. Previously, template_transfer bodies bypassed the `MIN_BODY_CHARS=600` gate. Muçi article (134 chars, body-generating mode) saved and published despite being below floor.  
`template_injury` not added — it never persists with that mode; `writeArticles` overwrites it to `rss_summary` or `rewrite` before `saveArticles` runs. `synthesis`/`synthesis_generated` not added — saved directly from story-matcher.js, already have their own 600-char gate at `story-matcher.js:532`.  
**Verified-by**: `src/publisher.js:687` — `['rewrite', 'original_synthesis', 'template_transfer']`

**Fix 2 — publishThreshold default 30 → 50** (`worker-fetch-agent.js:5285`):  
Default was 30 but effective synthesis floor is 50 (NVS 30–49 would pass auto-publish gate then immediately be filtered as rss_summary by saveArticles). Aligns default with effective behavior. DB-configured per-site value still takes precedence; BJK site has `auto_publish_threshold=30` in DB and is unaffected.  
**Verified-by**: `worker-fetch-agent.js:5285` — `|| 50`

**Fix 3 — scored_low split into scored_low + synthesis_failed** (`worker-fetch-agent.js:5279`):  
Articles with `publish_mode=rss_summary` and `nvs >= 50` now log as `synthesis_failed` with `drop_detail=synthesis_cap_or_source_unavailable` instead of `scored_low`. The 50+ band passed the publish gate but synthesis didn't produce a body (cap hit or source unavailable). Previously invisible in pipeline_log — "passed gate then disappeared" pattern. Forward-only: existing rows keep current stage values.  
UI additions: filter button, plStageMeta label, PL_STAGE_LABELS, CSS badge, funnel+histogram counters updated to include both stages.  
**Verified-by**: `worker-fetch-agent.js:5279` — `_stage: (a.nvs || 0) >= 50 ? 'synthesis_failed' : 'scored_low'`

**Fix 4 — Live-blog URL pattern rejection** (`src/processor.js:26`):  
New Stage 1.5 in `preFilter` rejects URLs matching `/\/canli\//i`, `/\/live\//i`, `/\/live-blog\//i` before BJK keyword check. Live-blog URLs contain continuous scoring updates with no stable article body — they'd pass keyword filter and waste NVS scoring budget. Rejected with `_stage: live_blog_source`.  
UI: plStageMeta label + filter button added.  
**Verified-by**: `src/processor.js:26` — `LIVE_BLOG_PATTERNS` + `live_blog_source` rejection; `worker-fetch-agent.js:8349` — filter button

**Fix 5 — Strip markdown headers in bodyHtml** (`worker-fetch-agent.js:6546`):  
`l.trim().replace(/^#+\s*/, '')` applied before `<p>` wrap. LLM-generated bodies (template_transfer, rewrite) sometimes include `# Title` or `## Section` markdown. Previous renderer wrapped line as-is, producing literal `# Title` text in published article HTML.  
**Verified-by**: `worker-fetch-agent.js:6546` — `stripped = l.trim().replace(/^#+\s*/, '')`

**Deployed**: version `a7b84e0e-a008-4745-8477-e39fe2132cd5`

---

### 2026-05-21 — PARKED: publish_mode taxonomy consolidation

**Decision**: PARKED. Do not implement until AdSense outcome is known. Revisit after About page + byline + DECISIONS.md backfill are done. Likely target: post-v1.0 (v1.1 or Sprint M).

**Current state**: 10+ publish_modes mix three orthogonal concerns (source count, output structure, content category). This causes:
- Bugs where modes are forgotten in gates (synthesis missing from isSynth, template_transfer missing too — both caught retroactively this week)
- Inconsistent generation paths (transfer news goes through a template path that hallucinates because the story isn't actually template-shaped — Muçi case)
- Confusing labels in admin UI and pipeline_log

**Proposed future model**:
- `generation_strategy` field: `prose | structured | embed_only`
- `content_category` field: `transfer | match | injury | club | analysis` (display dimension only)
- Templates reserved for genuinely structured content (KAP statements, score cards, lineups). Prose generation handles all narrative content including transfers and injuries via a single consolidated path.

**Effort**: 1–2 days focused work. Includes DB migration, consolidating prose paths, updating gates, backfilling existing articles with new field.

**What would change our mind**: AdSense approved + v1.0 shipped + another gate-miss bug caused by publish_mode ambiguity.

**Verified-by**: NVS audit 2026-05-21 + Muçi/Aston Villa/Ünder forensics confirmed the symptoms.

---

### 2026-05-21 — Cache wipeout RCA completed and remediated

**Decision**: Root cause identified and fully fixed. Pool wipeout was a compounding failure across three points; all three addressed plus one defensive follow-up.

Root cause: emergency seed path (`worker-fetch-agent.js:4735`) pulled `rss_summary` articles from DB. These were 3–6h old at night; `rankAndEvict`'s `hardTtl=2h` immediately evicted them all, leaving pool at 0. The automatic Supabase rebuild ran but silently produced zero survivors.

Fixes deployed (commit `9d046b3`):
- `worker-fetch-agent.js:5323` — `seedModeExclude = ['rss_summary','copy_source']` so seed only pulls long-lived modes
- `src/publisher.js:1021` — `minPool:20` floor in `rankAndEvict` rescues highest-ranked sub-floor articles when pool would otherwise go below 20
- Heartbeat alarm threshold changed from `< 20` to `<= 20` (pool at exactly 20 is already at rescue floor — alarm at that point gives one cron cycle of lead time)

Follow-up (this commit):
- `src/publisher.js:1095` — `expirationTtl: 7200` → `14400` (2h → 4h). Adds 2h buffer over the 2h cron interval. Protects against single-cron-failure scenarios: worker exception, Claude API outage, deploy interruption. Low risk — stale content serves for up to 4h on a failed cron, vs pool going dark at 2h.

**minPool:20 stays permanent.** RCA confirms it is working as intended now that seeds exclude short-lived modes. It is a safety net, not a workaround — it prevents eviction below floor in any future partial-pool scenario (not just the seed bug).

**Verified-by**: `src/publisher.js:1095`, `worker-fetch-agent.js:5323–5325`, deploy `9d046b3` + follow-up commit. Full RCA at `docs/cache-wipeout-rca-2026-05-21.md`.

### 2026-05-20 — Attribution rendering corrected for all publish modes

**Decision**: Fixed 4 attribution failures identified in `docs/attribution-audit-2026-05-20.md`. All changes in `renderArticleHTML` (`worker-fetch-agent.js`) and the Rabona KV card builder (`src/publisher.js`).

- `isKartalix` flag no longer forces `true` for `youtube_embed` and `video_embed` modes. These modes now correctly expose the original source.
- New attrHtml branch for `youtube_embed`, `video_embed`, `rabona_digest`: renders "Video kaynağı: [Source] →" with working YouTube URL link.
- `synthesis` mode added alongside `original_synthesis` in the "Birden fazla kaynaktan…" branch — both modes now render generic multi-source attribution.
- All `attrHtml` blocks moved from bottom of article (after body) into `div.article-meta`, directly under the title. CSS contextual override `.article-meta .source-attr` handles layout (display:block, no border-top).
- Rabona digest KV card: `url` now set to specific video watch URL (single video) or channel URL (multi-video), preserving the link through to `renderArticleHTML`.

**Rewrite source gap — fixed 2026-05-20 (version `972583f6`):** `serveArticlePage` now falls back to `kvArticle.source_name` for rewrite articles when Supabase has `source_name='Kartalix'` and KV has a non-Kartalix value. This is minimal (Option A): reliable while KV is warm (cron every 30 min keeps TTL fresh); on rare KV drought + seed-from-DB, source name reverts to 'Kartalix' temporarily. Verified: rewrite article renders "Kaynak temel alınarak Kartalix editörleri tarafından üretildi: **NTV Spor** →" with correct href.

**Not fixed (deferred):** Multi-source synthesis listing contributing source names (requires `sources[]` field in article shape). Duhuliye upstream piercing.

**Deployed:** version `8a9d3172-6bea-40ab-aec7-dfa342b1ff3d`

### 2026-05-20 — off_topic URLs added to KV seen cache (Fix B)

**Decision**: Articles rejected at preFilter Stage 2 (off_topic) have their URL hashes saved to `seen:off_topic:{siteCode}` KV key with TTL equal to the lookback window. Incoming articles are filtered against this cache before preFilter runs.

**Why this one**: Same off_topic URLs were re-entering the pipeline across 4+ consecutive cron runs, each costing one RSS fetch slot, one preFilter pass, and one pipeline_log row. Fix eliminates re-evaluation entirely with zero Claude calls.

**Alternatives considered**:
- Merge with existing `seen:{siteCode}` hash-dedup cache — rejected because that cache uses content hash (title+summary) at Stage 3; off_topic uses URL hash at Stage 2; mixing would corrupt hash-dedup semantics and cause false-positive drops.

**Tradeoff**: Suppressed articles do not appear in pipeline_log on subsequent runs (filtered before reaching the rejection logger). Original rejection is preserved from first encounter. `off_topic count per source per day` queries will undercount re-encounters; acceptable because the original count is what matters.

**Cache parameters**: 200 entries per site (vs 50 for hash-dedup — off_topic volume is higher). TTL = `lookbackMs / 1000` seconds (matches the existing lookback window constant already in scope at call site).

**What would change our mind**: If a legitimate BJK article is permanently suppressed because it was previously off_topic (e.g., keyword expansion now covers it). In that case, clear `seen:off_topic:BJK` from KV to reset the cache.

**Related**: Fix A (preFilter uses BJK_KEYWORDS via bjkMatch) deployed 2026-05-19.

### 2026-05-20 — BJK_KEYWORDS cleanup: removed generic noise terms

**Decision**: Removed `'optik'`, `'optik baskan'`, and bare `'seba'` from BJK_KEYWORDS. `'süleyman seba'` and `'suleyman seba'` retained as full names. Final count: 164 entries.

**Why this one**: `'optik'` matches eyeglasses retailers, fiber optics companies; `'optik baskan'` has no clear BJK referent; bare `'seba'` overlaps with common names (Sebastian, Sebahattin) causing false positives on non-BJK content. Full-name forms of Süleyman Seba are unambiguous.

**What would change our mind**: Specific missed articles that would have been caught by the removed terms.

### 2026-05-20 — Pool drought fix: seed exclusion + minPool floor + composition chart

**Decision**: Three-part fix for recurring overnight pool-drought (pool hitting 0 across multiple cron runs):

1. **Seed exclusion**: `cacheToKV` seed-from-DB query now excludes `rss_summary` and `copy_source` modes via `publish_mode=not.in.(rss_summary,copy_source)`. Previously, a KV-empty seed pulled these short-lived articles, which `rankAndEvict` immediately re-evicted (hardTtl=2h, halfLife=0.5h), leaving the pool empty after the first eviction pass.

2. **`minPool: 20` floor**: `rankAndEvict` accepts a new `minPool` option. After normal eviction, if `survived.length < minPool`, it rescues the highest-ranked sub-floor articles to maintain a 20-article minimum. `cacheToKV` always passes `minPool: 20`.

3. **Pool composition time-series**: `cacheToKV` writes a snapshot to `pool_ts:BJK` (KV, TTL 3 days, max 576 entries = 2 days at 5-min cron). Snapshot tracks total and per-type counts (yz, video, template, rss, other). Report page `/admin` now includes a stacked area SVG chart (no external libraries) showing pool composition over time, with 10px/point x-axis density, overflow-x:auto scroll, hover tooltips, and auto-scroll to latest.

4. **Heartbeat alarm threshold**: changed from `< 20` to `<= 20` with message updated to `(≤ 20 — at minimum floor)`.

**Why this one**: The drought was a compounding failure — KV expiry caused seed, seed brought in short-TTL articles, eviction cleared them all, pool stayed empty. The fix closes all three failure modes: seed quality, eviction floor, and observability.

**What would change our mind**: If minPool=20 prevents eviction of genuinely stale content (NVS < 5 but still being served). Monitor pool skew in the composition chart; if yz% drops below 30% consistently, adjust floor logic to be quality-weighted.

**Related**: Pool composition endpoint at `/admin/pool-timeseries`.

### 2026-04-28 — Story-centric over article-centric architecture

**Decision**: Stories are the primary entity. Articles are generated outputs of stories at specific lifecycle states. Multiple source contributions about the same event aggregate into one story, producing one Kartalix article that evolves with the story state.

**Alternatives considered**:
- Article-centric (one article per source, dedupe afterwards) — rejected because it fragments narrative and over-publishes
- Hybrid (stories optional, articles primary) — rejected because optionality leads to inconsistency

**Why this one**: matches journalistic reality (stories develop over time across sources), enables intelligent generation triggers tied to confidence accumulation, naturally handles same-event-multiple-sources without duplicate publishing.

**What would change our mind**: if the story matching algorithm's accuracy is below 80% in production for 30+ days despite tuning, suggesting the conceptual model doesn't fit the news flow.

**Related**: SLICES.md Slice 2

---

### 2026-04-28 — Facts-extraction firewall is non-negotiable

**Decision**: P4 source text is destroyed post-extraction. Only structured facts persist. The Produce Agent never sees P4 source text under any circumstance.

**Alternatives considered**:
- Paraphrasing approach (Produce sees source, rewrites) — rejected as legally indefensible under FSEK Article 36
- Quote-attribution approach (Produce can quote with attribution) — rejected because attribution does not grant reuse rights under Turkish law

**Why this one**: only architecturally-enforced separation between source text and our writing creates defensible legal posture. Implementation enforcement is stronger than policy enforcement.

**What would change our mind**: a Turkish IP lawyer concluding that FSEK Article 36 permits broader reuse than our current interpretation.

**Related**: SLICES.md Slice 1, kartalix.com legal posture

---

### 2026-04-28 — Multi-tenant via JSONB config from day one

**Decision**: All club-specific configuration lives in Supabase JSONB per `site_id`. No hardcoded club references in code. Onboarding a new club = adding a config row.

**Alternatives considered**:
- Hardcoded for BJK, refactor later — rejected because refactoring multi-tenant after the fact is famously expensive
- Code-as-config per club — rejected because it doesn't scale

**Why this one**: Pitchos vision requires this from day one. The cost of doing it right initially is small; the cost of retrofitting is enormous.

**What would change our mind**: nothing — this is foundational.

**Related**: all slices

---

### 2026-04-28 — Three story types in v1 (Match-extended, Transfer, Injury)

**Decision**: Launch with three story types. Match story is one extended entity covering pre/live/post phases with sub-stories for non-routine events. Defer all other types to v2.

**Alternatives considered**:
- Match split into 3 types (preview/live/result) — rejected because it fragments the natural narrative arc
- Launch with all 10 types — rejected as scope explosion
- Launch with only general/untyped — rejected because type-aware behavior is core to the architecture

**Why this one**: 3 types covers ~80% of typical BJK news flow with minimum complexity. Match-as-extended-story matches journalistic reality. Can expand types iteratively after v1 ships.

**What would change our mind**: production data showing significant content categories that don't fit these three types and warrant their own treatment.

**Related**: SLICES.md Slice 3

---

### 2026-04-28 — Intelligent signal-driven match lifecycle

**Decision**: Match story open/close is signal-driven, not calendar-driven. Story opens on first match-related contribution, closes when activity decays AND a newer match story dominates.

**Alternatives considered**:
- Fixed window T-7d to T+3d — rejected as arbitrary
- Manual open/close — rejected as operational burden

**Why this one**: a controversial derby may stay alive 7+ days; a dull league match dies in 36 hours. Same-window treatment is wrong for both.

**What would change our mind**: nothing foundational; specific signal weights may tune.

**Related**: SLICES.md Slice 3

---

### 2026-04-28 — Sub-stories preserve context after parent archives

**Decision**: Sub-stories are first-class with `parent_story_id` and `ancestry_path`. They survive parent archive if they have their own active narrative.

**Alternatives considered**:
- Sub-stories as contributions only (die with parent) — rejected because controversies often outlive matches

**Why this one**: editorial reality. A VAR controversy from a match becomes its own ongoing story (disciplinary review, suspension hearing) that needs to live independently.

**Related**: SLICES.md Slice 2, Slice 3

---

### 2026-04-28 — User-addable sources via schema-first, UI-later

**Decision**: Sources live in a `sources` table with `adapter_template_id`. v1 = manage via Supabase dashboard manually. v2 = admin UI.

**Alternatives considered**:
- Hardcoded sources — rejected as anti-Pitchos
- Build admin UI in v1 — rejected as scope explosion

**Why this one**: schema-first means the right data model is locked in early; UI is sugar that can be added later without migration.

**Related**: SLICES.md v2 backlog

---

### 2026-04-28 — Trust score: auto / locked / hybrid modes

**Decision**: Source trust scores support three modes. Auto = Engage feedback adjusts. Locked = manual fixed value. Hybrid = bounded auto-adjust within a band.

**Why this one**: editorial judgment must be able to override learning. Hybrid lets the system learn within editorial guardrails.

**Related**: SLICES.md Slice 8

---

### 2026-04-28 — Editorial QA shows author first, then publisher

**Decision**: Two-stage approval flow. Author sees QA report and decides what to apply. Pre-final goes to publisher (you) for final approval. Bot proposes; bot never auto-applies.

**Alternatives considered**:
- Bot auto-applies typo fixes — rejected, even unambiguous fixes should remain author-controlled
- Single-stage publisher review (skip author) — rejected as disrespectful to author voice

**Why this one**: preserves author ownership of their work. Author's annotations on QA flags travel with submission so publisher sees reasoning.

**Related**: SLICES.md Slice 6

---

### 2026-04-28 — Image strategy: 6-tier with IT3 architecturally blocked

**Decision**: Images organized in 6 tiers (IT1–IT6). IT3 (wire/RSS images from P4) is blocked at the firewall, same as P4 text. v1 builds IT2 + IT6 only. IT1 deferred to v2. IT5 (AI-generated) limited to abstract/illustrative — no real people.

**Why this one**: IT6 (Kartalix-templated visual assets) gives 60%+ coverage at zero per-image cost and creates brand identity. IT2 (official) covers another 30%. IT3 use is the highest copyright-litigation risk in this space.

**Related**: SLICES.md Slice 5

---

### 2026-04-28 — Governance Layer (CLO + CFO) above pipeline, not within

**Decision**: CLO and CFO are oversight layers, not pipeline agents. Synchronous deterministic checks in v1, async LLM audit in v2.

**Alternatives considered**:
- CLO/CFO as pipeline agents — rejected because they'd add latency and cost to every article
- No governance layer — rejected because cross-cutting concerns scattered across agents become impossible to audit

**Why this one**: matches how real CLOs/CFOs operate (set policy, audit, escalate). Avoids agent inflation. Synchronous mode is cheap and high-value.

**Related**: SLICES.md Slice 7

---

### 2026-04-28 — Test discipline: golden fixtures for every architectural decision

**Decision**: Every architectural decision in this log gets a corresponding golden fixture in `fixtures/cases/`. Tests live in repo as Vitest suites with `dev test` workflow command.

**Why this one**: golden fixtures double as design documentation. When Claude Code makes a change and a fixture breaks, the failure tells future-us what design intent was violated.

**Related**: all slices

---

### 2026-04-28 — PM agent built in v0, before Slice 1

**Decision**: Build PM scaffold (Telegram-based, four conversations, drift detection) before starting Slice 1. PM agent runs in `@kartalix-pm` channel, separate from operational channels.

**Alternatives considered**:
- Build PM after first slice — rejected because the slice that needs the most discipline is the first one
- No PM, just tracking files — rejected because static files decay without external accountability

**Why this one**: 6–9 month build with COO duties cannot be sustained without external accountability function. PM cost is small; failure cost without it is project death.

**Related**: SLICES.md v0

---

### 2026-04-28 — Fact extraction scope: Names, Numbers, Dates only

**Decision**: The Facts Firewall extracts exactly three categories from P4 source text: named entities (people, clubs, competitions), numbers (fees, contract length, goals, minutes), and dates/timestamps. No other content from P4 source text is retained.

**Alternatives considered**:
- Broader "key claims" extraction — rejected because scope creep leads back to paraphrase, which is legally indefensible
- Sentence-level summarization — rejected for the same reason

**Why this one**: Turkish IP lawyer confirmed this is the correct scope. Entities are facts, not expression. Expression is what FSEK protects.

**What would change our mind**: Lawyer consultation outcome on appeal or updated FSEK interpretation.

**Related**: SLICES.md Slice 1, `2026-04-28 — Facts-extraction firewall is non-negotiable`

---

### 2026-04-28 — Source attribution: required for verbatim quotes only, editorial choice otherwise

**Decision**: Attribution ("Kaynak: [outlet]") is NOT required on Kartalix articles written as original prose from multiple sources. Attribution IS required when directly quoting a person or verbatim-reproducing specific content.

**Supersedes**: the original 2026-04-28 entry that declared attribution "mandatory on all derived articles." That was overly defensive.

**Why the original was wrong**: Facts are not copyrightable under FSEK or any copyright regime. Reading 3 sources and writing your own article is journalism, not derivation. Every news outlet operates this way — no attribution required for facts that are widely reported. The lawyer's concern was specifically about Hot News misappropriation (lifting one outlet's exclusive and publishing it immediately), which is already addressed by the 15-minute delay.

**When attribution IS required**:
- Direct verbatim quotes from a person (standard journalism practice — cite the speaker, not the outlet)
- When reproducing a protected creative work (photographs, graphic designs, lyrics) — cite the copyright holder
- When citing a specific data source (statistics, financial filings) — standard citation practice

**When attribution is NOT required**:
- Original prose synthesized from multiple sources — this is standard journalism
- Widely-reported facts (transfer fees, match results, injury news) — facts belong to nobody
- Paraphrases — if it's truly rewritten, it's yours

**Editorial note**: Kartalix publishes under its own editorial voice. No "Sabah Spor'a göre" or "NTV Spor haberine göre" language in article bodies. Attribution blocks are editorial choice, not legal obligation.

**What would change our mind**: Turkish IP lawyer explicitly ruling that synthesis from P4 sources requires attribution even for original prose — unlikely given established journalism practice.

**Related**: SLICES.md Slice 1, DECISIONS.md 2026-04-28 hot news delay, DECISIONS.md 2026-04-29 synthesis generation

---

### 2026-04-28 — Hot News delay: P4 sources must not publish within 15 minutes of source pubDate

**Decision**: Articles sourced from P4 outlets are held for a minimum of 15 minutes after the source's `pubDate` before being eligible for publication. This delay is applied in the publish routing logic, not at fetch time.

**Alternatives considered**:
- No delay — rejected; Turkish courts have recently protected "Exclusive News" under Unfair Competition law even when text is rewritten, if published within seconds of the original
- 30-minute delay — considered; 15 minutes chosen as the minimum defensible buffer, can be increased per source via config
- Delay only on transfer exclusives — rejected; too complex to classify at fetch time reliably

**Why this one**: Turkish IP lawyer explicitly warned about "Hot News" misappropriation claims. A documented delay mechanism is evidence of compliance intent.

**What would change our mind**: Lawyer providing a different specific threshold after reviewing case law.

**Related**: SLICES.md Slice 1, `decidePublishMode()` in src/publisher.js

---

### 2026-04-28 — PM agent and all agents built Kartalix-specific in v1, abstracted in v2

**Decision**: All agents (PM, Facts Firewall, Produce, Visual Asset, etc.) are built with Kartalix/BJK context in v1. No multi-team abstraction until the second club onboarding (v2).

**Alternatives considered**:
- Build team-independent from day one — rejected; premature abstraction produces the wrong interfaces before real variation is known
- Partial abstraction (config files per club) — rejected for v1; adds complexity before the shape of club-specific variation is understood from production use

**Why this one**: The diff between BJK and Juventus configs — discovered during actual v2 onboarding — tells you exactly what to parameterize. Guessing now produces abstractions that don't match reality. Data models are kept clean enough to extend (e.g. `pm_sessions` can accept `site_id` via migration).

**What would change our mind**: A second club onboarding opportunity arising before v1 ships — at which point a minimal config layer is justified.

**Related**: SLICES.md v2 backlog (Pitchos onboarding for second club)

---

### 2026-04-29 — No cap on source intake; frontend shows only Kartalix-generated articles

**Decision**: The pipeline ingests all source articles without volume caps. The frontend displays only Kartalix-generated articles. Source articles are never shown directly to readers.

**Alternatives considered**:
- Cap source intake at top-N by NVS score — rejected because it filters out potential story contributions before the story engine sees them; a low-scoring article may be the confirming contribution that triggers generation
- Show source articles on frontend as fallback — rejected because it blurs the product identity and reintroduces copyright risk

**Why this one**: The story engine needs the full input stream to detect patterns — capping it upstream defeats the purpose. The reader-facing product is Kartalix's voice, not a re-aggregation of source feeds. KV cache (for the frontend) holds only generated articles; Supabase `content_items` holds the full source intake for the story engine to query.

**Implications**:
- Current KV cache of scored source articles is temporary scaffolding — removed when Slice 2 ships
- NVS scoring of source articles is retained as a story engine input signal, not a display filter
- Source count and type are uncapped — RSS, Twitter, YouTube, official, journalist, all feed the same intake pipeline
- The "50 articles in cache" design is superseded by this decision

**What would change our mind**: If Supabase query costs at high source volume become prohibitive — at which point a time-window cap (e.g. last 48h only) is appropriate, not a score cap.

**Related**: SLICES.md Slice 2 (story engine), Slice 4 (source admin UI), 2026-04-28 story-centric architecture entry

---

### 2026-04-29 — Slice 2 schema: stories, contributions, state machine

**Decision**: Stories are open-typed, matched via two-stage Claude judgment, and stay open until explicitly resolved — no fixed time window for intake.

---

**Story types — open taxonomy, broad category for routing**

`story_type` is a free-text label assigned by Claude at ingestion time. No predefined list. Examples: "transfer", "injury", "financial_restructuring", "disciplinary", "stadium", "contract_extension" — whatever Claude determines fits.

`story_category` is a controlled broad bucket used only for template routing:
- `sporting` — transfers, injuries, matches, squad, performance
- `financial` — debt, FFP, sponsorship, budget
- `institutional` — board, ownership, legal, governance
- `other` — anything that doesn't fit above

Templates map to `story_category`, not `story_type`. This means no story is missed due to taxonomy gaps, and new story types require no schema change.

---

**Story matching — two-stage, no fixed rules**

Stage 1 (cheap, pure JS): Extract entity fingerprint from new article's facts (sorted player + club names). Query open stories for entity overlap. Returns 0–N candidate story IDs.

Stage 2 (Claude Haiku): Pass new article facts + candidate story summaries. Ask: "Does this article belong to one of these open stories, or is it a new story?" Returns a story_id or "new". Stage 2 runs even when Stage 1 returns zero candidates — it handles stories with no player/club entities (financial, institutional).

Cost: one Haiku call per ingested article. Acceptable at current volume.

---

**Story lifetime — open until resolved, no fixed window**

Stories accept contributions while in states: `emerging`, `developing`, `confirmed`, `active`.

Archival is time-based per category, not per article:
- `sporting`: archive after 3 days with no new contribution
- `financial` / `institutional`: archive after 30 days with no new contribution

A new contribution on an `archived` story reopens it to `developing` rather than creating a duplicate story. This handles slow-burn stories (season-long injury recovery, multi-month financial restructuring).

---

**State machine**

```
emerging   → developing    trigger: 2nd contribution arrives
developing → confirmed     trigger: confidence ≥ 60
confirmed  → active        trigger: Kartalix article generated and published
active     → resolved      trigger: manual (Slice 4 HITL) or story_type resolution signal
active     → developing    trigger: contradicting contribution (confidence drops below 60)
any        → archived      trigger: no contribution for N days (N per category, see above)
archived   → developing    trigger: new contribution arrives
any        → debunked      trigger: manual only
```

---

**Confidence scoring**

- First contribution: +30 (lands in `emerging`)
- Each confirming contribution: +20
- Updating contribution (new facts, same direction): +10
- Contradicting contribution: −10
- Auto-publish threshold: 60
- No human review gate until Slice 4 ships HITL

---

**Schema — key tables**

`stories`: id, site_id, story_type (text), story_category (sporting/financial/institutional/other), state, entities (jsonb), confidence (int 0–100), title (working title), parent_story_id, first_contribution_at, last_contribution_at, generation_count, published_at, resolved_at

`story_contributions`: id, story_id, content_item_id, facts_id, contribution_type (initial/confirming/contradicting/updating), confidence_delta, added_at

`story_state_transitions`: id, story_id, from_state, to_state, trigger (new_contribution/confidence_threshold/time_elapsed/manual), triggered_at, notes

**Alternatives considered**:
- Predefined story type taxonomy — rejected because it misses stories that don't fit the list (e.g. financial restructuring, fan boycott)
- Rule-based matching (entity overlap + fixed time window) — rejected because it fails for stories without named entities and creates false splits on slow-burn stories
- Embedding-based semantic similarity — deferred, too complex for v1; Claude Haiku judgment achieves similar result at lower implementation cost

**What would change our mind**: If Stage 2 Claude matching accuracy is below 85% in production after 30 days of tuning, we add embedding-based pre-filtering as a Stage 1.5.

**Related**: SLICES.md Slice 2, DECISIONS.md 2026-04-28 story-centric architecture, DECISIONS.md 2026-04-29 no cap on source intake

---

### 2026-04-29 — Every Kartalix article is story-linked; stories are universal

**Decision**: Every Kartalix-generated article belongs to a story. There are no story-less articles. A single one-off announcement still creates a story — it just has one contribution.

**Why this one**: Stories are the chronological spine of coverage. Linking every article to a story enables: article evolution over time, deduplication, confidence tracking, and the ability to surface related past coverage. Without this, the archive becomes a flat list with no memory.

**Implications**:
- `matchOrCreateStory` is called for every ingested article, not just multi-source stories
- Single-contribution stories at confidence 30 can still generate articles — generation threshold depends on source trust, not just contribution count
- Official sources (bjk.com.tr) get a higher initial confidence delta (60) so a single authoritative announcement immediately crosses the generation threshold
- Stories are the unit of deduplication — two articles about the same event produce one story, one Kartalix article

**What would change our mind**: If story creation overhead (Claude judge call per article) becomes cost-prohibitive at high volume. At that point, single-source low-trust articles skip story matching and go directly to a lightweight summary pipeline.

**Related**: SLICES.md Slice 2, DECISIONS.md 2026-04-28 story-centric architecture, DECISIONS.md 2026-04-29 no cap on source intake

---

### 2026-04-29 — Synthesis generation: source content is ephemeral research, not stored material

**Decision**: At story confirmation time, Kartalix fetches the full text of the top 1–3 contributing source articles, passes them to Claude as ephemeral research context, and generates an original full-length Kartalix article (300–600 words). Source text is never written to Supabase or KV. It is discarded immediately after the generation call returns.

**This supersedes the blanket "Produce Agent never sees P4 source text" rule** from the 2026-04-28 firewall entry. That rule was written to prevent storing and paraphrasing. It should not prevent Claude from reading sources the same way a journalist does. The legal constraint is on *republishing expression*, not on using source material as research input to write original prose.

**What doesn't change**:
- Source text is still never stored in the database
- Hot News 15-minute delay still applies
- IT3 image block still applies
- The Facts Firewall (entities/numbers/dates) is retained as structured metadata — it feeds story matching, not article generation

**What changes**:
- The Produce Agent receives: story entity summary + facts schema (structured) + full source texts (ephemeral)
- Claude's instruction is to write original Kartalix prose, not to paraphrase — framing matters
- Output target: 300–600 words in Kartalix editorial voice, no "according to X" language in the body
- Model: Claude Sonnet (not Haiku) for generation — article quality justifies the cost

**Alternatives considered**:
- Richer fact schema (extract more structured fields) — rejected because it still produces templated sentences, not real editorial prose. A journalist writes from context, not a schema.
- Paraphrasing with attribution — rejected; this is what the lawyer warned against. "According to Fotomaç, Rashica..." is paraphrasing + attribution, still derivative.
- Keep 1-sentence stubs, accept low quality — rejected; this is not a news platform.

**Why this one**: This is how all journalism works. Reuters reads AFP, writes their own article. AP reads local press, writes their own. The legal protection comes from writing originally — which requires actually reading the source. The previous architecture made the article *worse* (1-sentence) by trying to make it *safer*, when the safety comes from the writing, not from information deprivation.

**What would change our mind**: Turkish IP lawyer explicitly ruling that any use of P4 full text as generation input — even ephemerally — creates liability.

**Related**: SLICES.md Slice 3, DECISIONS.md 2026-04-28 facts-extraction firewall, DECISIONS.md 2026-04-29 attribution revised

---

### 2026-04-29 — Match template data source architecture

**Decision**: Match template groups use purpose-fit sources. API-Football (free tier) for structured match data. Existing RSS pipeline for press-driven content. YouTube RSS for video. No scraping, no paid APIs required for v1.

**Source map by template group**:

| Group | Templates | Primary Source | Notes |
|---|---|---|---|
| G1 Pre-match time-based | T01–T05 (Preview, H2H, Form, Team News, Lineup) | API-Football | Fixtures, standings, H2H, squad, lineups — all via REST |
| G2 Pre-match RSS-triggered | T06–T09 (Transfer Rumors, Injury Report, Press Conference, Manager Pre-Match) | RSS pipeline | Already running; add keyword filters per template type |
| G3 Live | T10 (Goal Flash) | API-Football polling | Poll every 5 min during match window only. Free tier: 100 req/day — a 2h match uses 24 requests. If over budget, defer to post-match and accept delay. |
| G4 Post-match | T11–T14 (Result Flash, Match Report, Man of Match, Manager Quotes) | API-Football (result/stats) + RSS (quotes) | Structured result from API; quotes from press RSS |
| G5 Next day | T15–T18 (Stats Deep Dive, Press Review, Reaction, Tactical) | RSS pipeline | Pure press content — RSS already covers this |
| G6 Video | T19–T24 (Highlights, Press Conference Video, Goals, Training, Fan, Archive) | YouTube RSS | `youtube.com/feeds/videos.xml?channel_id=X` — free, official, no auth |

**API-Football specifics**:
- Free tier: 100 requests/day
- Endpoints needed: fixtures (schedule), fixture by ID (live score + stats), H2H, standings, players (ratings)
- No API key stored in code — goes in Workers secret (`API_FOOTBALL_KEY`)
- Wrapper in `src/api-football.js`

**YouTube RSS specifics**:
- No auth, no quota
- BJK official channel ID: to be confirmed from `youtube.com/@bjk` URL
- Feed format: `https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL_ID}`
- Polled same cadence as RSS feeds (every 30 min)

**What is NOT changing**:
- RSS pipeline for press content — already stable at 38+ articles/run
- Story engine and matching — unchanged
- Source trust system — YouTube/official feeds get appropriate trust tier

**Alternatives considered**:
- football-data.org instead of API-Football — considered; API-Football has better coverage of Turkish Super Lig and more endpoints (lineups, ratings)
- Twitter/X API for live — rejected; $100+/month for Basic tier, no viable free option
- Live score scraping — rejected; fragile, legally gray, violates Terms of Service of most providers

**What would change our mind**: API-Football free tier running out of budget in production (100 req/day becomes insufficient). At that point, upgrade to paid tier (~$10/month) or reduce polling frequency.

**Related**: SLICES.md Slice 3

---

### 2026-04-30 — Stats API provider: SoccerData API preferred over API-Football

**Decision**: Switch primary structured match data provider from API-Football to SoccerData API ($14/mo), subject to two pre-conditions passing verification (see below). If either pre-condition fails, fall back to API-Football Starter with the modifications noted.

**Supersedes**: 2026-04-29 — Match template data source architecture. The source map table and API-Football-specific notes in that entry are superseded. The template group structure (G1–G6) and RSS/YouTube pipeline are unchanged.

**Why SoccerData**:
- 25,000 req/day vs ~500 on API-Football Starter — headroom for polling-intensive templates (T10 live goal flash, T11 result detection)
- Weather forecast endpoint — adds match-day weather context to T01 Match Preview natively
- Dedicated sidelined/injured players endpoint — more reliable than API-Football's injury data for Turkish league
- Player transfers endpoint — structured transfer data to enrich Transfer story entity matching
- Price comparable ($14 vs ~$12–15 for API-Football Starter)

**Pre-conditions — must verify before writing any Phase 3 template code**:
- A1: Süper Lig confirmed in SoccerData's covered leagues — blocks all Phase 3 templates if false
- A2: Post-match player ratings endpoint confirmed — blocks T13 (Man of the Match) if false

**Fallback if A1 fails**: stay on API-Football Starter; Track A PR is not merged.

**Fallback if A2 fails only**: dual-provider — SoccerData for all other endpoints, API-Football retained solely for post-match player ratings (T13). Single `src/stats-api.js` wrapper routes T13 calls to API-Football and all others to SoccerData.

**What is NOT changing**:
- Template group structure (G1–G6) and the RSS/YouTube pipeline — unchanged
- Story engine, matching, synthesis generation — unchanged
- IT3 block, hot-news delay, attribution rules — unchanged

**Alternatives considered**:
- API-Football Starter (~$12–15/mo) — already integrated, Süper Lig verified, player ratings confirmed. Rejected as primary because 500 req/day is marginal for live polling and lacks weather/injury/transfer endpoints.
- SportMonks (~$29–49/mo) — better data quality but 2–3× cost, no player ratings advantage, not worth it at current scale.
- football-data.org — does not cover Süper Lig on affordable plans. Rejected.

**What would change our mind**: A1 or A2 fail verification — see fallback rules above. Or SoccerData API reliability proves poor in production over 30 days.

**Related**: SLICES.md Slice 3 Phase 1 Track A, PR #1 slices/track-a-stats-pipeline

---

### 2026-04-30 — Match template set: keep, enhance, park, add

**Decision**: Revised template set based on API-Football Pro coverage verification (see docs/procurement/api-football-coverage-2026-04-30.md). Shot map templates parked. Five new data-driven templates added. T12 enhanced with structured stats in synthesis prompt.

**Keep as planned**: T01, T02, T05, T07, T11, T13 — all data confirmed.

**Keep and enhance**:
- T10 Goal Flash: tighten live polling to 2-min intervals (safe on Pro plan)
- T12 Match Report: synthesis prompt must include xG, possession %, pass accuracy from fixture stats — not just RSS text. This makes the article data-grounded, not press-derivative.
- T03 Form Guide: add as weekly template using standings + top scorers endpoints

**Parked**:
- Shot map visual: x/y coordinates absent from API-Football at all data levels. StatsBomb required for positional data. Park to v2.
- Per-player shot breakdown: shots.total is null per player in API-Football even when team had 20 shots. Not viable.

**New templates added**:
- T-xG (xG Delta): fires when |actual_goals − xG| > 1.2. xG is in every fixture response. High fan engagement on Turkish football social media.
- T-SUB (Suspension Watch): yellow accumulation tracker. Fires at 4 and 7 yellows (Süper Lig thresholds). Practical and highly read before matches.
- T-GK (Goalkeeper Spotlight): fires when goals_prevented > 0.8. Confirmed metric in golden fixture.
- T-FRM (Formation Change): compare formation string to previous match. Fires when manager changes shape. Tactical angle fans discuss.
- T-REF (Referee Profile): cards-per-match for assigned referee over season. Pre-match context piece. Data is in fixture events history.

**What would change our mind**: Production data showing T-xG/T-SUB/T-GK fire too frequently (noise) — add minimum threshold or cap to once per week per type.

**Related**: docs/procurement/api-football-coverage-2026-04-30.md, SLICES.md Slice 3 Phase 3

---

### 2026-04-30 — Weather in T01: Open-Meteo not API-Football

**Decision**: Match weather context in T01 Match Preview is sourced from Open-Meteo, not a stats API. Open-Meteo is free, requires no API key, supports lat/long queries, and works in Cloudflare Workers with a single fetch call.

**Why not SoccerData for weather**: SoccerData weather was an NFR4 argument for switching providers. Open-Meteo eliminates the need — weather is not a reason to switch stats providers.

**Implementation**: Add venue lat/long lookup map for Tüpraş Stadyumu and common away grounds. T01 template fetches `api.open-meteo.com/v1/forecast?latitude=X&longitude=Y&current=temperature_2m,weathercode,windspeed_10m`. One extra fetch call, zero cost, zero auth.

**Related**: SLICES.md Slice 3 Phase 3 T01, Track A provider decision

---

### 2026-05-01 — Remove Claude web search from fetchBeIN and fetchTwitterSources

**Decision**: Disable both Claude web-search-powered fetchers. Both now return empty arrays.

**Why**: Anthropic charges $0.01 per `web_search_20250305` tool call, separate from token costs. At the old `*/30` cron cadence that was $23.40/month combined. At the new `0 */2` cadence it was still $4.80/month. Neither source justifies the cost — beIN Sports TR has no RSS feed and its content is fully covered by existing RSS sources (Fotomaç, Duhuliye, Sporx); Twitter/X results were unreliable and often stale from Claude web search.

**Alternatives considered**:
- Keep with rate-limiting — still $2-5/month for marginal content
- Replace beIN with direct RSS — no RSS feed exists on beinsports.com.tr (confirmed 2026-05-01)
- Replace Twitter with Nitter RSS — viable future option, noted in Slice 4 backlog

**What would change our mind**: A confirmed working RSS feed for beIN Sports TR, or a free Nitter/RSS proxy for @Besiktas that survives long-term. Wire in Slice 4 when BJK official Twitter feed is confirmed.

**Related**: SLICES.md Slice 4 (Telegram/Twitter integration), fetchBeIN + fetchTwitterSources in src/fetcher.js

---

### 2026-05-01 — API-Football Pro subscription: stay on current provider

**Decision**: Continue with API-Football Pro ($19/month). Provider decision finalised — close PR #1 (Track A SoccerData evaluation).

**Why**: Free tier covered testing. Pro tier needed for live polling (`*/5` cron, `?live=all`, `/fixtures/events`). SoccerData evaluated as alternative — comparable data quality, higher price, migration cost not justified.

**What would change our mind**: API-Football reliability drops significantly, or a cheaper provider with equivalent live endpoints emerges.

**Related**: Track A PR #1, DECISIONS.md 2026-04-29 match template data source architecture

---

### 2026-05-01 — Sprint A event detection: hash-free seen_event_ids approach

**Decision**: Track processed in-match events via a `seen_event_ids` array in `match:BJK:live` KV state. Each event gets a composite ID: `${elapsed}_${extra}_${type}_${detail}_${player_id}`. On each watcher tick, scan all events, skip seen IDs, fire template for new ones.

**Why**: No unique event ID from API-Football. Composite ID is stable across ticks for the same event. Hash-of-whole-array approach rejected because it can't identify *which* event is new — need per-event granularity to avoid duplicate articles.

**Related**: matchWatcher Sprint A block, match:BJK:live KV schema

---

### 2026-05-01 — matchWatcher FT detection: fall back to getFixture() when getLiveFixture() returns null

**Decision**: When `getLiveFixture()` returns null post-kickoff and `result_published` is false in KV, the watcher falls back to `getFixture(fixture_id)` — a direct `/fixtures?id=X` query — to detect FT status.

**Why**: `getLiveFixture()` queries `/fixtures?live=all` which only returns fixtures with status `1H`, `HT`, `2H`, `ET`, `P`. Once a match reaches `FT`, API-Football removes it from that endpoint. Without the fallback, the watcher never sees `is_finished = true` and T11/T12/T13/T-XG never fire. Confirmed in Gaziantep FK vs Beşiktaş retrospective (2026-05-01): T10 fired but entire post-match suite was missed due to this gap.

**Alternatives considered**:
- Use `/fixtures?live=all&status=FT` — FT is not a "live" status, this endpoint ignores it
- Poll on a longer window — doesn't fix the root cause
- Use `getNextFixture` for FT detection — `?next=1` returns only future matches, also useless for FT

**What would change our mind**: API-Football changing their `?live=all` behavior to include FT matches.

**Related**: matchWatcher in worker-fetch-agent.js, api-football.js getFixture()

---

### 2026-05-02 — YouTube integration: embed-only in Sprint C, full pipeline after Slice 1

**Decision**: YouTube videos are added in two phases. Sprint C ships embed-only (iframe + 1-sentence title-based intro, keyword qualification, no captions). Full pipeline (captions → Facts Firewall → Produce branching) is deferred until after Slice 1 (Facts Firewall) ships.

**Sprint C scope**: Atom feed fetch (`youtube.com/feeds/videos.xml?channel_id=X`) → title keyword qualification (özet, highlights, basın toplantısı, röportaj, açıklama, maç sonu) → `generateVideoEmbed()` writes iframe + Haiku 1-sentence intro from title only → stored in `content_items` with `source_type='youtube'`. No captions fetched, no source text passed anywhere.

**Why embed-only is legally clean**: YouTube iframe embedding is standard web practice — YouTube explicitly provides and supports it. The 1-sentence intro is original writing derived solely from the video title, not from the video's content. No FSEK Article 36 concern applies because no content is reproduced.

**Why captions are deferred**: YouTube captions are the transcript of video content — third-party text that falls under the same FSEK Article 36 constraints as RSS body text. Passing captions to the Produce Agent without the Facts Firewall in place would be the same violation we protect against for P4 RSS. The firewall must be built first (Slice 1) before captions can flow.

**Full 9-step YouTube plan**: detailed implementation plan on file at `C:\Temp\planning-input.txt`. Steps 1–4 (fetch + proxy + register + intake) are covered by Sprint C. Steps 5–7 (Qualify treatment + caption facts + Produce branching) are Slice 1 extension scope. Steps 8–9 (dev.bat shortcuts + observability) fold into whatever sprint executes Steps 5–7.

**Alternatives considered**:
- Full pipeline now — rejected; depends on Facts Firewall (Slice 1) which isn't built yet
- Defer YouTube entirely to v2 — rejected; embed-only is safe, quick, and adds value (match summary videos, press conferences) without legal or architectural risk
- Use captions without the firewall — rejected; same FSEK risk as RSS body text

**What would change our mind**: Turkish IP lawyer ruling that video caption content has different legal treatment than RSS body text under FSEK Article 36 — at which point caption flow could be moved to Sprint C.

**Related**: SLICES.md Sprint C, DECISIONS.md 2026-04-29 match template data source architecture (G6), `C:\Temp\planning-input.txt`

---

### 2026-05-17 — No multi-step LLM agents: scheduled functions and single-prompt LLM calls only

**Decision**: Kartalix capability modules are implemented as cron-scheduled functions or single-prompt LLM calls with structured output. Multi-step autonomous agents — where the LLM decides its own investigation path and calls tools iteratively — are rejected for all pipeline and editorial work.

**Alternatives considered**:
- Multi-step editorial review agent (investigates a story, calls multiple tools) — rejected; the path is known at code-write time; richer prompt context achieves the same quality gain without the cost and unpredictability
- Autonomous source trust agent — rejected; trust is computed deterministically from journalist outcome data and source tier; no autonomy needed

**Why this one**: Multi-step agents are expensive, slow, and fail in ways that compound at cron frequency. Every module proposed in the capability roadmap (alarm framework, relevance bucket, situational awareness, KPI strip) has a fixed operation path — what varies is the *data*, not the *path*. Single-prompt calls with well-constructed context outperform agent loops for structured generation tasks. The one potential exception (a borderline-article editorial review calling 2–3 inspection tools) is explicitly deferred to post-v1.

**What would change our mind**: A specific use case where the investigation path is genuinely unknown at code-write time and the quality gain from agent autonomy justifies the cost. No such case exists in v1 scope.

**Related**: `docs/legacy/kartalix_modular_growth_proposal.txt` Part C, SLICES.md Capability Modules table

---

### 2026-05-17 — Alarm framework: checks registered in code, definitions stored as data

**Decision**: Alarm check logic is implemented as named JavaScript functions registered in `src/alarms/checks/index.js`. Alarm definitions (schedule, severity, params, thresholds, notification channels, enabled/disabled) are rows in Supabase `alarm_definitions`. Adding a new alarm = write a check function + insert a row. Arbitrary SQL or DSL strings editable in definition rows are explicitly rejected.

**Alternatives considered**:
- Pure data-driven (alarm check is a SQL query string stored in DB, executed by runner) — rejected; SQL injection risk, debugging is painful (logic scattered across DB rows), no version control on check behaviour
- Pure code-driven (all alarm config hardcoded) — rejected; can't add/disable alarms without a deploy

**Why this one**: Preserves the operational flexibility of data-driven alarms (enable/disable, threshold tuning, schedule changes without deploys) while keeping check logic in version-controlled, testable JavaScript. The security and maintainability tradeoffs are clearly in favour of code-registered checks.

**What would change our mind**: A strong need to add alarms without any code deploy — at which point a carefully sandboxed DSL could be evaluated.

**Related**: `docs/legacy/kartalix_pipeline_and_alarms_brief.txt`, `docs/sprint-l-analysis.md` Sprint L

---

### 2026-05-17 — KPI strip is read-only operational view, separate from Cockpit and Report

**Decision**: The `/admin/report` KPI strip (3-row: live state / today's activity / 14-day trend) is a read-only health snapshot. Config changes live in `/admin/cockpit`. Analytics and funnel charts live in `/admin/report` below the strip. The strip never gains an interactive config panel.

**Alternatives considered**:
- Merge KPI strip into Cockpit — rejected; the use cases are different: strip = "is it working now?", Cockpit = "change something". Mixing read + write in one view creates operational confusion.
- Merge KPI strip into existing Report charts — rejected; the strip answers a different time-horizon question (now + today) than the analytics charts (last 30 days). Physical separation at the top of the page reflects the priority difference.

**Why this one**: Operator mental models matter. The strip is opened for a 10-second scan; the cockpit is opened to make a change; the report is opened to analyse trends. Three distinct intents, three distinct UI zones.

**What would change our mind**: Nothing architectural — this is a UX principle. The strip could gain an "Edit thresholds" shortcut link to Cockpit, but not inline editing.

**Related**: `docs/legacy/kartalix_kpi_strip_prompt.txt`, `docs/legacy/kartalix_modular_growth_proposal.txt` Part B

### 2026-05-18 — Rewrite and synthesis articles generate Kartalix titles from the body; original RSS title preserved in DB

**Decision**: After body generation, a second Haiku call produces a clean Kartalix-style headline from the finished body. The generated title replaces the RSS title for `rewrite` and `original_synthesis` articles. The original RSS title is stored in `content_items.original_rss_title` for audit and A/B comparison. Slug is generated from the Kartalix title.

**Alternatives considered**:
- Keep RSS titles verbatim — rejected; RSS titles are clickbait, source-tagged, and mismatch the editorial voice of the Kartalix body.
- Generate title inside the body synthesis prompt — rejected; forces Claude to produce body + title in one call, increasing risk of format drift and making refusal detection harder.

**Why this one**: Separation of concerns. Body generation focuses on prose quality; title generation focuses on headline craft. Haiku is sufficient and cheap (~$0.001/day). Original title preserved for rollback and monitoring.

**What would change our mind**: If Haiku title quality proves worse than RSS titles over a statistically meaningful sample (A/B via `original_rss_title`), revert and accept RSS titles.

**Related**: `temp/title.txt`, `docs/migrations/0013_original_rss_title.sql`

---

### 2026-05-18 — Rewrite quality: transient fact extraction, not persistent

**Decision**: Generation-time fact extraction in `synthesizeArticle` is transient. A Haiku call extracts source claims as a bullet list from the full fetched source text, uses the list to constrain length and prohibit filler, then discards it. No DB write, no schema changes.

**Alternatives considered**:
- Reuse the existing `facts` table — rejected; the facts table is entities-only in production (transfer_fee, contract_years, dates are null across all 411 rows) because extraction runs on RSS title+summary (≤800 chars), not full source text. Redesigning the schema to capture numbers from full source text would require rebuilding extraction, validation, storage, and reuse logic — work not yet earned.
- Persist extracted bullets in a new `source_bullets` column — rejected; bullets are prompt scaffolding, not durable facts. Storing them adds migration cost and schema complexity with no consumer beyond the one prompt.
- Store in `story_contributions` as a generation hint — rejected; contributions are matched before synthesis fires, so hints would need a separate retrieval step with no guarantee the same source is used at generation time.

**Why this one**: The problem (filler padding) is a prompt calibration problem, not a data architecture problem. The fix belongs in the prompt layer. Transient extraction is high-leverage (one Haiku call), low-risk (graceful fail → empty bullets, unchanged path), and reversible without touching DB.

**What would change our mind**: If a cross-article use case emerges that requires durable structured facts — e.g., contradiction detection across sources, fact-density publish gates, or fact-based freshness scoring. At that point, extract from full source text and design proper schema. Not before.

**Related**: `docs/generation-paths-audit.md`, `temp/kartalix_rewrite_quality_fix_prompt.txt`

---

### 2026-05-18 — AdSense compliance: structural URL routing fix

**Root cause**: Cloudflare Pages was serving `index.html` as fallback for unknown URLs, loading the auto-ads AdSense script on pages with wrong or no content.

**Fix has three layers**:
1. `shouldShowAds()` conditional in worker (`renderArticleHTML`, `renderStaticPage`) — gates ad code by page type and body length.
2. `functions/[[catchall]].js` Pages Function — returns clean 404 for unknown URLs.
3. `_routes.json` — explicit Pages routing config that activates the catch-all and overrides Cloudflare's auto-generated routing (which was the actual root cause; without `_routes.json` the catch-all never fires).

**Lesson**: Any URL path that doesn't resolve to specific content is a compliance risk surface. The `_routes.json` exclude list must be audited regularly — any path in it that doesn't have a real handler will fall through to home page fallback.

---

### 2026-05-18 — Cloudflare Pages SPA-fallback overridden by catch-all Pages Function

**Decision**: Unknown URLs on kartalix.com return 404 (via `functions/[[catchall]].js` + `_routes.json`) instead of serving `index.html` with a 200. The Pages project had SPA-fallback active: any URL with no matching Worker route, Pages Function, or static file was served the home page — which contains the AdSense auto-ads script.

Two files are required together: (1) `functions/[[catchall]].js` returns 404; (2) `_routes.json` with `include: ["/*"]` and an explicit exclude list for known-good paths. Without `_routes.json`, Cloudflare auto-generates its own routes config that does not activate the catch-all for unknown paths — the SPA fallback wins. With `_routes.json`, Cloudflare invokes Functions for any path not in the exclude list, which hits the catch-all.

**Related**: `functions/[[catchall]].js`, `_routes.json`

---

### 2026-05-18 — Worker routes must claim both trailing-slash and non-trailing-slash variants

**Decision**: Every worker route that has a corresponding static asset in the Pages deployment must be registered in `wrangler.toml` for both `/path` and `/path/`. If only `/path` is registered, Cloudflare serves the static file for `/path/` as a Pages fallback — bypassing the worker entirely.

---

### 2026-05-18 — AdSense ad rendering gated on page type and content substance

**Decision**: AdSense auto-ads script renders only on article pages (`/haber/*`) with a minimum body length of 1200 characters (~200 words). All utility pages, error pages, flash-event templates, and the home page with a thin pool receive no ad script.

**Specifics**:
- Utility pages (`/hakkimizda`, `/iletisim`, `/gizlilik`, `/kaynak-atif`, `/editoryal-politika`): ad script removed from `renderStaticPage()` shared template.
- Article pages: `shouldShowAds()` function gates the script on `bodyLength >= 1200` AND `templateId` not in `['T10','T11','T-RED','T-VAR','T-OG','T-PEN','T-HT']` AND `publishMode !== 'rss_summary'`.
- Home page (`index.html`): script moved from `<head>` (unconditional) to a DOM-gated dynamic injection that fires only after `footballArticles.length >= 8` AND `#newsGrid .card` exists in the DOM.
- Static HTML files (`hakkimizda/`, `gizlilik/`, `iletisim/` variants): ad script removed; these are served at trailing-slash paths by Cloudflare Pages as fallback.
- `/impressum` route: removed from `wrangler.toml`; Cloudflare Pages now serves the complete static `impressum/index.html` directly (no ads, German legal content intact).

**Trigger**: Google AdSense compliance notification 2026-05-18 — "Google-served ads on screens without publisher-content."

**Alternatives considered**:
- Wrap individual `<ins>` ad slots — not applicable; no manual placements exist, only auto-ads global script.
- Configure "manual placements only" in AdSense console — rejected; requires AdSense console access and approval cycle. Code-side gating is immediate and does not depend on Google review.

**Why this one**: The auto-ads script triggers policy violation purely by existing on thin-content pages. Removing it from those pages is the only compliant fix. The `shouldShowAds()` guard is intentionally conservative (1200 chars) to stay well above the policy line.

**What would change our mind**: If average article body length drops significantly below 1200 chars despite the `MIN_BODY_CHARS = 600` floor — adjust threshold down, but not below 800.

**Related**: `temp/kartalix_adsense_compliance_fix_prompt.txt`

---

### 2026-05-19 — preFilter aligned with fetch-time keyword filter

**Decision**: Replace `BJK_REGEX` with `BJK_KEYWORDS` in `preFilter`'s off_topic check. Both gates now use the same 45-entry keyword list via case-insensitive substring match.

**Alternatives considered**:
- Keep BJK_REGEX and extend it with player/coach names — rejected because it duplicates the maintenance surface; BJK_KEYWORDS already tracks squad changes
- Remove preFilter off_topic check entirely and rely on fetch-time filter — rejected because preFilter runs on all sources including official ones that skip the fetch-time filter

**Why this one**: `BJK_REGEX` (4 club name variants) was narrower than `BJK_KEYWORDS` (45 entries including player and coach names), causing false-positive off_topic rejections on quote articles ("Sergen Yalçın: '...'"), player-focused stories (Orkun Kökçü, Cerny), and coach decisions where titles don't literally contain 'Beşiktaş'/'BJK'/'kartal'. The two gates must agree on what counts as BJK content. `BJK_REGEX` remains exported in `processor.js` for `fetcher.js`'s NTV HTML fallback path.

**What would change our mind**: If the wider keyword list causes non-BJK articles to pass preFilter in volume (e.g., a player transferred away still matching on their name). Monitor for a week and prune stale names from BJK_KEYWORDS if false negatives appear.

**Related**: `docs/pipeline-diagnostic-2026-05-19.md` — Extended Investigation 1; `src/processor.js` line 26; `src/utils.js` BJK_KEYWORDS

---

### 2026-05-19 — pipeline_log enhanced with trust_tier, source_body_len, drop_detail

**Decision**: Add three nullable columns to `pipeline_log` to enable diagnostic queries that previously required reading source code.

- `trust_tier TEXT` — source trust tier at pipeline event time; enables "what % of T1/T2 drops are false positives?" directly from CSV
- `source_body_len INTEGER` — `(summary + full_text).length` before any pipeline transformation; distinguishes tweet stubs (< 100) from real articles (> 500)
- `drop_detail TEXT` — per-stage rejection specifics: `no_match` for off_topic; winner URL for title_dedup; `seen previously` for url_seen; publish date for date_old; char count for too_short

**Why this one**: Several diagnostic questions became unanswerable from the export alone — most urgently, verifying whether title_dedup was keeping the higher-trust article. `drop_detail` on title_dedup rows now records the winning article's URL, making the planned trust-aware dedup refactor verifiable from CSV without code reading.

**What would change our mind**: Nothing structural; individual `drop_detail` values may be refined per stage as more diagnostic questions emerge.

**Related**: `temp/2.kartalix_pipeline_log_visibility_prompt.txt`, `docs/pipeline-diagnostic-2026-05-19.md`

---

### 2026-05-19 — synthesizeStory defensive gates aligned with synthesizeArticle

**Decision**: Add four gates to `synthesizeStory` in `src/story-matcher.js` — it previously had only a 200-char body length check while `synthesizeArticle` in `publisher.js` had a full suite of defenses.

Gates added:
- **C — BJK title gate**: `!BJK_REGEX.test(story.title)` returns null immediately. Prevents synthesizing stories whose cluster title drifted to a rival or off-topic subject during story matching.
- **D — Content-covers-title gate**: `checkContentCoversTitlePromise(story.title, combinedSources, env)` — same Haiku EVET/HAYIR check already used in `generateOriginalNews` and `synthesizeArticle`. Blocks synthesis when Strategy 3 keyword fallback fetches unrelated articles.
- **A — Refusal text detection**: `SYNTH_REFUSAL_SIGNALS` array (15 phrases, Turkish + English) checked against body before save. Extended phrase list includes `yayınlayamam`, `talimatları incelediğimde`, `haberi yazabilirim` — the exact phrases that leaked in the 2026-05-19 incident. Same phrase additions also applied to `REFUSAL_SIGNALS` in `synthesizeArticle` and `BODY_REFUSAL_SIGNALS` in `saveArticles`.
- **E — MIN_BODY_CHARS floor**: Raised from 200 to 600 chars, matching `MIN_BODY_CHARS` in `saveArticles`. The old 200-char gate was below the system-wide minimum and allowed refusal essays (which are typically 300–500 chars) to pass through.

**Why now**: A refusal essay was published to kartalix.com because SYNTH-D2 had none of these gates. The body opened with "talimatları incelediğimde bu haberi yayınlayamam" — not in any existing signal list — and was 400+ chars long. The article exposed internal editorial instructions verbatim to readers and was indexed by search engines before being archived.

**Alternatives considered**:
- Patch only the missing phrase: too narrow — the root cause was SYNTH-D2 having no gate suite at all. One missed phrase would repeat.
- Move synthesis into `synthesizeArticle`/`saveArticles` so gates apply automatically: larger refactor, cross-file state needed. Deferred to v1.1.

**What would change our mind**: If Gate D causes too many false-positive drops on legitimate stories (stories whose title is editorially rewritten by the story matcher away from source titles), we may relax it to a soft warning rather than a hard block.

**Related**: `temp/fix34.txt`, bad article slug `2026-05-19-fenerbahcede-teknik-direktor-arayisi-aziz-yildirimin-3-adayi-analiz` (archived), version `2d3e8a8d-371d-446c-9b03-9c04fab047d4`

---

### 2026-05-22 — Address top 2 volume bottlenecks from volume_deep_analysis.md

**Changes:**
1. `index.html` — `SHELF_LIFE` doubled across all categories: Match 24→48h, Transfer 72→96h, Injury 24→48h, Club 48→72h, European 48→72h, Other/default 24→48h
2. `src/processor.js:197` — `sharedStoryTokens` near-dupe threshold raised from `>= 1` to `>= 2`

**Why**: Both changes address top-2 bottlenecks identified in `docs/kartalix_volume_deep_analysis.md`.

- **SHELF_LIFE**: Articles were becoming invisible on the homepage before the next pipeline run could replace them. With a 2h cron and 24h default shelf life, a 25h-old article vanished even when there was nothing newer. The old thresholds were appropriate for a pipeline publishing every 30 minutes; at 2h cadence, doubling shelf life gives articles time to survive until the next successful run. The longer window also prevents the site going visually dark during minor pipeline delays (Claude 429/529 episodes).

- **sharedStoryTokens >= 2**: The `>= 1` threshold caused false-positive near-dupe drops. Any two articles sharing a single meaningful token (e.g. "Beşiktaş", "transfer", a player name) were collapsed. Raising to `>= 2` requires two distinct shared tokens, reducing false collapses while still catching genuine same-story duplicates. `after_story_dedup` in funnelStats expected to rise from ~30% to ~70–80% of `scored`.

**Alternatives considered**:
- Raise SHELF_LIFE only for Transfer (already highest at 72h): rejected — Match and Club articles also expired before the next cron, causing the same visual thinning.
- `sharedStoryTokens >= 3`: too permissive — would pass clear same-story pairs that differ only in headline framing.

**Verification**: After next cron — homepage visible count and `after_story_dedup` in fetch_logs.

---

### 2026-05-24 — YouTube thumbnails for youtube_embed articles

**Decision**: Populate `image_url` on all `youtube_embed` articles using `https://img.youtube.com/vi/{VIDEO_ID}/hqdefault.jpg`. Direct link to img.youtube.com — no proxying or caching through Kartalix CDN.

**Alternatives considered**:
- A: `maxresdefault.jpg` — rejected; only exists if uploader provided HD thumbnail, 404s on many videos
- B: Proxy/cache thumbnails through Cloudflare — rejected; unnecessary complexity, YouTube CDN already handles this globally

**Why this one**: Zero cost, zero API calls, legally clean (thumbnail display in context of embedded video is within YouTube TOS spirit), immediate visual improvement on homepage.

**Scope**: `generateVideoEmbed` and `generateMatchVideoEmbed` in `src/publisher.js`. Other publish_modes (`rewrite`, `template_transfer`, etc.) still have empty `image_url` — broader image strategy for non-YouTube articles is pending separate decision.

**Backfill**: Run once in Supabase SQL editor to update existing rows (see `docs/duhuliye-diagnosis-2026-05-24.md` for verification SQL pattern).

**What would change our mind**: YouTube changes TOS to prohibit direct thumbnail hotlinking — would then need to cache via Cloudflare Images or similar.

---

### 2026-05-26 — /rebuild-cache age-decay fix + codebase audit of fetched_at pattern

**Decision**: Fix `/rebuild-cache` Strategy 1 mapping to use `r.created_at` (Supabase insertion time) as `fetched_at` rather than `r.fetched_at` (RSS pubDate). Also audited the full codebase for the same broken pattern — 3 additional instances found and documented for a follow-up fix.

**What happened tonight**:
The user triggered `/rebuild-cache` after the `hqdefault → maxresdefault` image backfill to propagate new URLs into KV. `/rebuild-cache` ran Strategy 1 (Supabase read), mapping `fetched_at: r.fetched_at || r.created_at`. Because `r.fetched_at` in Supabase stores RSS pubDate (a legacy column misnomer documented in the 2026-05-25 KV diagnostic entry), articles pulled from Supabase carried old RSS dates as their age reference. `rankAndEvict` decayed everything: a May 10 article has age ≥ 15 days at halfLife=8h → score ≈ 0. KV reverted to the 18 pre-fix May 3–9 articles (the only non-rss_summary rows in Supabase's top-100 at the time). The cron self-healed KV within ~30 min by writing fresh processedAt-stamped articles; no manual intervention was needed.

**Root cause**: Same misordering as Change 2 of commit `50eb017` (drought seed mapping). Both bugs: `fetched_at: r.fetched_at || r.created_at` should be `fetched_at: r.created_at || r.fetched_at`.

**Fix** (`worker-fetch-agent.js:521-522`, commit after this entry):
```
// Before
published_at: r.published_at || r.fetched_at || r.created_at,
fetched_at:   r.fetched_at   || r.created_at,

// After
published_at: r.published_at || r.created_at || r.fetched_at,
fetched_at:   r.created_at   || r.fetched_at,
```
`r.created_at` = Supabase server-generated insertion timestamp (Kartalix processing time). `r.fetched_at` = RSS pubDate (legacy DB semantic). KV age decay must use processing time, not RSS pubDate.

**Natural recovery**: the cron (every 5 min) prepends `newKVItems` (stamped with `processedAt = new Date()`, age=0) to `latestKV` and calls `rankAndEvict`. New articles outrank the old ones and fill KV. No manual `/rebuild-cache` retrigger was needed after the 4-part fix deployed.

**Codebase audit** — additional instances of the broken `fetched_at: r.fetched_at || r.created_at` pattern (NOT yet fixed, pending a separate session):

| line | handler | risk |
|------|---------|------|
| `worker-fetch-agent.js:1590-1591` | `/admin/rewrite-article` (POST) — single-article manual rewrite | Low: one article at a time, not a bulk rebuild |
| `worker-fetch-agent.js:3344-3345` | `/admin/seed-kv` (POST) — explicit bulk KV seed from Supabase | **High**: same footgun as /rebuild-cache; will evict recent content if triggered |
| `worker-fetch-agent.js:4813-4814` | Inline auto-seed (fires when `kvCheck` is empty inside an unnamed GET handler) | **High**: same footgun; triggers automatically on empty KV, not just via admin |

`src/publisher.js:912` (`getArticleAge`: `article.fetched_at || article.published_at || article.created_at`) is **correct** — it reads from KV article objects where `fetched_at` = Kartalix processing time after the 4-part fix. Not a bug.

**What would change our mind**: If `fetched_at` in Supabase is ever corrected to store actual ingestion time (not RSS pubDate), the priority order would need to revert. Until then: always prefer `created_at` over `fetched_at` when mapping Supabase rows to KV age references.

**Deployed**: version `0d57a8c4-a5a5-4a13-90b3-73684bf93163`, `worker-fetch-agent.js:521-522`

---

### 2026-05-26 — fetched_at priority sweep: all Supabase→KV mappings patched

**Decision**: Applied the `r.created_at || r.fetched_at` fix to the 3 remaining instances of the broken `r.fetched_at || r.created_at` pattern found in the audit from the previous entry. All Supabase→KV mappings in the codebase now consistently use `created_at` (Kartalix insertion time) before `fetched_at` (RSS pubDate) as the age reference for KV decay.

**Locations fixed** (single commit, single deploy):

| line | handler | risk before fix |
|------|---------|----------------|
| `worker-fetch-agent.js:1590-1591` | `/admin/rewrite-article` POST | Low |
| `worker-fetch-agent.js:3344-3345` | `/admin/seed-kv` POST | High |
| `worker-fetch-agent.js:4813-4814` | Inline auto-seed (on empty KV) | High |

**Audit methodology**: `grep -n "r\.fetched_at\s*\|\|\s*r\.created_at" worker-fetch-agent.js src/publisher.js`. Post-fix grep returns zero matches. `src/publisher.js:912` (`getArticleAge`) uses `article.fetched_at || article.published_at` — correct, operates on KV article objects where `fetched_at` = Kartalix processing time, not Supabase DB rows.

**Complete fix inventory** — all 4 locations where `fetched_at` priority was corrected:
1. `worker-fetch-agent.js:521-522` — `/rebuild-cache` Strategy 1 (commit `4671d91`)
2. `worker-fetch-agent.js:1590-1591` — `/admin/rewrite-article` (this commit)
3. `worker-fetch-agent.js:3344-3345` — `/admin/seed-kv` (this commit)
4. `worker-fetch-agent.js:4813-4814` — inline auto-seed (this commit)
5. `worker-fetch-agent.js:5458-5459` — drought seed (commit `50eb017`, Change 2) — was already correct

**Deployed**: version `2007339d-242d-412f-bc3b-1a50ff157a8a`

**Post-deploy KV verification**: 32 articles, newest `2026-05-26T11:35:06Z`, 27 rewrite + 5 youtube_embed, 5 with `maxresdefault.jpg` image_url. KV unchanged by the deploy as expected (handler-only fix).

---

### 2026-05-25 — YouTube thumbnail resolution: hqdefault → maxresdefault

**Decision**: Switch `youtubeThumbnailUrl()` in `src/publisher.js` from `hqdefault` (480×360) to `maxresdefault` (1280×720). Applied globally to all `youtube_embed` articles via `generateVideoEmbed` and `generateMatchVideoEmbed`. Supersedes the 2026-05-24 entry which selected `hqdefault`.

**Why this reverses the 2026-05-24 decision**: The prior entry rejected `maxresdefault` as "only exists if uploader provided HD thumbnail, 404s on many videos." That assumption was based on general YouTube behaviour, not measured data. A 133-video probe across all 8 active YouTube channels (14-day window) showed 100% maxresdefault availability with zero 404s. The rejection premise was wrong.

**Data** (`docs/youtube-thumbnail-quality-analysis-2026-05-25.md`):
- 133 videos probed: A Spor (100), Vole (17), beIN SPORTS TR YT (7), Kartalix (3), Beşiktaş JK (2), Rabona Digital (2), TRT Spor (1), beIN SPORTS TR (1)
- maxresdefault: 133/133 (100%) — zero failures across all channels
- sddefault: 133/133 (100%)
- hqdefault: technically 100%, but 8/100 A Spor thumbnails under 10KB (blurry on retina displays); all 8 had healthy maxresdefault (45–69 KB)
- avg size: maxres 152 KB, sd 62 KB, hq 18 KB — 8.4× quality improvement

**Alternatives considered**:
- A: Keep hqdefault — rejected; 8% of A Spor thumbnails visually degraded (under 10KB)
- B: Per-video probe at save time with fallback — rejected; 100% coverage makes probe overhead unnecessary
- C: Switch to sddefault — valid safe option (100% coverage, 3.5× quality gain), but maxres available at zero extra cost

**Backfill**: `UPDATE content_items SET image_url = REPLACE(image_url, 'hqdefault.jpg', 'maxresdefault.jpg') WHERE site_id = '2b5cfe49-b69a-4143-8323-ca29fff6502e' AND publish_mode = 'youtube_embed' AND image_url LIKE '%hqdefault.jpg%'` — run in Supabase after deploy.

**Deployed**: version `b0e29cc1-46f4-453d-85a0-85ef845152ab`, `src/publisher.js:2270`

**What would change our mind**: Probe showing <95% maxresdefault coverage for a newly added channel, or YouTube TOS change prohibiting direct thumbnail hotlinking.

---

### 2026-05-25 — KV frozen at May 9: full diagnostic chain + four-part fix

**Decision**: Four targeted changes to `worker-fetch-agent.js` to restore live article flow from Supabase into KV. No behavior changes for correctly-functioning pipeline runs.

**Root cause chain** (each necessary, none individually sufficient):

1. **`published_at` missing from `saveArticles`** (fixed earlier in session, commit `d864504`): The Supabase row builder in `src/publisher.js:815` wrote `fetched_at` but omitted `published_at`. Every article inserted May 10–24 landed with `published_at = NULL` in Supabase.

2. **Drought recovery seed query filtered on `published_at`** (`worker-fetch-agent.js:5444`): When KV dropped below 10 articles (or expired overnight), drought recovery queried `published_at=gte.${cutoff}`. PostgreSQL silently excludes NULL rows on inequality filters. All 124 May 10–24 articles returned 0 rows. `latestKV` was never replaced — cron continued writing back the same stale May-9 articles via `minPool=20`.

3. **Age decay from RSS pubDate** (`worker-fetch-agent.js:4124`, `src/publisher.js:911`): `fetcher.js` never sets `fetched_at` on in-memory article objects. `saveArticles` writes `fetched_at = a.published_at` (RSS pubDate). `toKVShape` also falls back to `a.published_at`. So KV entries carry the original RSS publication date as their age reference. An article from a May 10 RSS feed processed today has age = 15 days → `rank = NVS × exp(-360/8) ≈ 0` → evicted by `rankAndEvict`. New in-memory articles were being added to KV but immediately decaying out.

4. **KV TTL (4h) shorter than overnight quiet period gap (8h)** (fixed earlier, commit `f30c7bc`): Preserved the broken state across the overnight gap. Fixed 4h → 12h, but this alone left KV frozen because the drought seed and age decay issues remained.

**Why earlier fixes were necessary but not sufficient**:
- TTL fix (f30c7bc): prevented nightly KV expiry, but drought seed still returned 0 rows → stale articles persisted via minPool.
- `published_at` field fix (d864504): fixed future Supabase inserts but drought seed still filtered on `published_at`; existing NULL rows still excluded.
- SQL backfill (`published_at = COALESCE(fetched_at, created_at)`): ran in an earlier session; confirmed with COUNT=0 before this deploy. Moot for the KV fix because `fetched_at` in Supabase = RSS pubDate anyway (same old date, still too old for rankAndEvict).

**Four changes deployed (commit `50eb017`, version `436fc6fd-ef70-4052-856a-66c1b495e1da`)**:

**Change 1 — Drought seed filter + order + select** (`worker-fetch-agent.js:5444`):  
`published_at=gte.${cutoff}` → `created_at=gte.${cutoff}`. `created_at` is the Supabase server-generated insertion timestamp, never null. Order changed to `created_at.desc` for consistent ordering. `created_at` and `image_url` added to select list.  
**Verified-by**: `worker-fetch-agent.js:5444-5445`

**Change 2 — Drought seed mapping** (`worker-fetch-agent.js:5458-5459`):  
`fetched_at: r.fetched_at || null` → `fetched_at: r.created_at || r.fetched_at || null`.  
`published_at: r.published_at` → `published_at: r.published_at || r.created_at`.  
Seeds `fetched_at` with Supabase insertion time so `getArticleAge` decays from when Kartalix processed the article, not when the source published. A May 10 RSS article inserted into Supabase on May 10 is 15 days old by RSS date; by Supabase insertion time it is also 15 days old — but articles inserted today by the current cron are 0h old and rank at the top.  
**Verified-by**: `worker-fetch-agent.js:5458-5459`

**Change 3 — `toKVShape` carries `fetched_at`** (`worker-fetch-agent.js:4125`):  
Added `fetched_at: a.fetched_at || null` to the KV shape output. Previously `fetched_at` was excluded (implicit whitelist). Without this, `fetched_at` stamped in Change 4 would be lost after the first write/read cycle. `getArticleAge` (`src/publisher.js:912`) checks `fetched_at` before `published_at` — this field must survive in the KV blob.  
**Verified-by**: `worker-fetch-agent.js:4125`

**Change 4 — Stamp Kartalix processing time on `newKVItems`** (`worker-fetch-agent.js:5472-5477`):  
`const processedAt = new Date().toISOString()` captured once per cron run. Each article in `confirmedArticles` gets `fetched_at: base.fetched_at || processedAt` before `toKVShape`. Since `fetcher.js` never sets `fetched_at`, `base.fetched_at` is always undefined → `processedAt` fires. Result: new articles enter KV with age = 0 and decay from processing time, not RSS pubDate. Sibling-recovered articles: `_used_sibling_source` is set but `fetched_at` is not → `processedAt` applies correctly.  
**Verified-by**: `worker-fetch-agent.js:5472-5477`

**Dual semantic of `fetched_at`** (non-obvious invariant):  
In **Supabase `content_items`**: `fetched_at` = RSS pubDate (the source's publication timestamp), written by `saveArticles` as `a.published_at || a.fetched_at || now`. This is by design — `fetched_at` in DB tracks when the story broke, used by `getRecentPublishedTitles` for title dedup lookback.  
In **KV articles**: `fetched_at` = Kartalix processing time (when this cron run wrote the article to KV). Used exclusively by `getArticleAge` for decay scoring. These two semantics diverge after Change 4.

**What would change our mind**: If we want display ordering in the article page to use source publication time rather than Kartalix processing time, the KV `fetched_at` field should be renamed to avoid confusion with the DB column. Acceptable debt until a field-naming audit is warranted.

**SQL backfill** (ran before this deploy, not part of this commit):  
`UPDATE content_items SET published_at = COALESCE(fetched_at, created_at) WHERE published_at IS NULL` — backfill confirmed COUNT=0 rows remaining before deploy. Supabase `published_at` is now correctly set for all articles; used by `/rebuild-cache` ordering and article page display.

**Deployed**: version `436fc6fd-ef70-4052-856a-66c1b495e1da`, commit `50eb017`

**Verification** (after `/rebuild-cache`):
- KV article count: expect 50+ (up from 18)
- Newest `fetched_at` in KV: expect near-current time (within last few hours)
- `/cache` endpoint: no articles with age > 30 days dominating the pool

**Rollback**: Revert `worker-fetch-agent.js` at lines 4125, 5444-5445, 5458-5459, 5472-5477 to prior state and redeploy. No schema changes, no KV key changes.

---

### 2026-05-26 — Video Hub Phase 1: video_type classification + DB column

**Decision**: Add `video_type TEXT` column to `content_items`, classify every `youtube_embed` article as `news`, `highlight`, or `interview` at save time using a keyword classifier in `src/publisher.js`.

**Classifier logic** (`src/publisher.js` — `classifyVideoType()`):
- Turkish title normalized via NFD decomposition + manual char map (`ı→i`, `ğ→g`, etc.)
- Order: interview check first (more specific), then highlight, then default `news`
- Interview keywords: `aciklamasi`, `mac sonu`
- Highlight keywords (word boundary): `gol`, `golu`; (substring): `highlights`, `ozet`, `bitiricilik`

**DB changes**:
- `ALTER TABLE content_items ADD COLUMN IF NOT EXISTS video_type TEXT`
- Index: `content_items_video_type_idx ON content_items (site_id, video_type, published_at DESC) WHERE publish_mode = 'youtube_embed'`
- Constraint: `CHECK (video_type IS NULL OR video_type IN ('highlight','interview','news'))`

**Backfill** (SQL, ran 2026-05-26): 153 rows classified — news: 136 (88.9%), highlight: 9 (5.9%), interview: 8 (5.2%). Within expected ranges.

**Integration**: `generateVideoEmbed()` (`src/publisher.js`) — `video_type` added to Supabase insert and fallback return shape.

**Alternatives considered**:
- A: Claude-based classification at save time — rejected; latency + cost per video not justified when keyword rules achieve sufficient accuracy
- B: Manual tagging via admin UI — rejected; 153 existing rows + ongoing backlog makes manual untenable

**Why this one**: Fast, deterministic, zero-cost per article. Accuracy sufficient for a display-filtering use case (occasional misclassification = minor UX issue, not data integrity risk).

**What would change our mind**: False positive rate >10% after monitoring real traffic; would trigger model-based fallback for borderline titles.

**Deployed**: version `7b2e7868-5fa6-4b7f-8b3b-9cd1486b2c58`

---

### 2026-05-26 — Video Hub Phase 2: /konu/videolar frontend redesign

**Decision**: Replace the client-rendered `/konu/videolar` topic page (which fetched from `/cache` and had no `video_type` awareness) with a server-rendered Video Hub: 3 sections (Haber Videoları, Maç Özetleri, Röportajlar), 4 filter tabs (Tümü/Haber/Maç Özetleri/Röportajlar), 2-col mobile / 4-col desktop grid, ad slot placeholders.

**Architecture**:
- Server-side render in `worker-fetch-agent.js` — new `renderVideoHubPage(tip, env)` async function
- Intercepts `/konu/videolar` before the generic `/konu/:slug` handler
- Fetches from Supabase directly (not from `/cache` KV), filters retention windows in JS
- Retention: news 30d, interview 90d, highlight 180d
- URL routing: `?tip=haber|mac|roportaj` — each tab = real server request = real pageview for ad impressions
- Empty section in Tümü view → section hidden entirely (off-season UX)
- CSS: inline `<style>` in template, consistent with rest of project

**Ad slots**: Empty placeholder `<div class="ad-slot">` elements sized to expected AdSense dimensions (320×100 mobile, 728×90 desktop). No actual ad code — waiting for AdSense approval.

**Alternatives considered**:
- A: Client-side rendering from `/cache` — rejected; `/cache` KV doesn't carry `video_type`, would require separate API endpoint; also no real pageviews per tab (bad for ad impressions)
- B: New `/api/videos` endpoint + client JS — rejected; two-request page load, worse SEO, no URL per tab

**Why this one**: Server render gives real URLs per tab (SEO + ad impression multiplier), uses the Phase 1 index for sub-10ms Supabase queries, and is consistent with how article pages are rendered.

**What would change our mind**: Supabase query latency >200ms at scale would push toward a KV-cached video list with `video_type` included.

**Deployed**: version `d7fdaa8e-6f89-497f-9e46-a8b814faf625`

---

### 2026-05-26 — Video Hub Fix Pack 1: classifier refinement + grid overflow fix

**Decision**: Two targeted fixes — (1) replace simple keyword classifier with pattern + exclusion classifier to eliminate known false positives, (2) add `min-width:0` and `overflow-x:hidden` to grid CSS to fix horizontal scroll on Haber Videoları section.

**Classifier changes** (`src/publisher.js`):
- Replaced flat keyword arrays with `HIGHLIGHT_PATTERNS`, `HIGHLIGHT_EXCLUDE`, `INTERVIEW_PATTERNS`, `INTERVIEW_EXCLUDE` regex arrays
- Key false positive fixes:
  - "Gol Kralı" (TV show) was matching highlight via `gol` word-boundary — now excluded by `HIGHLIGHT_EXCLUDE: /\bgol krali\b/`
  - "Maç Sonu Yorumu" (commentary, not interview) was matching interview via `mac sonu` — now blocked by `INTERVIEW_EXCLUDE: /\byorumu\b/`
- New patterns added: `basin toplantisi`, `roportaj`, `genis ozet`, `goller ve ozet`, `mac ozeti`, score pattern (`\d+-\d+\s+ozet`)
- Exclusions checked first; if excluded, falls through to next category or news

**CSS fix** (`worker-fetch-agent.js` — `renderVideoHubPage`):
- `.vh-card`: added `min-width:0` — prevents grid item from overflowing its column (grid items default to `min-width:auto` which allows content to force expansion)
- `.vh-grid`: added `width:100%;max-width:100%`
- `.vh-section`: added `overflow-x:hidden` as belt-and-suspenders

**Backfill SQL** (run in Supabase after deploy to reclassify existing rows with new logic):
```sql
UPDATE content_items SET video_type = CASE
  WHEN LOWER(TRANSLATE(title,'ığşçüöİĞŞÇÜÖ','igscuoIGSCUO')) !~ '\y(yorumu|yorumlari|degerlendirme|analiz)\y'
       AND LOWER(TRANSLATE(title,'ığşçüöİĞŞÇÜÖ','igscuoIGSCUO')) ~ '\y(aciklamasi|aciklamalari|basin toplantisi|ozel roportaj|konustu|demeci?|roportaj)\y'
  THEN 'interview'
  WHEN LOWER(TRANSLATE(title,'ığşçüöİĞŞÇÜÖ','igscuoIGSCUO')) !~ '\y(gol krali|sezon\w* ozeti|sezonun ozeti)\y'
       AND LOWER(TRANSLATE(title,'ığşçüöİĞŞÇÜÖ','igscuoIGSCUO')) ~ '\y(mac ozeti|macin ozeti|genis ozet|ozet ve goller|goller ve ozet|highlights|goller|gol pozisyon|bitiricilik)\y'
  THEN 'highlight'
  WHEN LOWER(TRANSLATE(title,'ığşçüöİĞŞÇÜÖ','igscuoIGSCUO')) !~ '\y(gol krali|sezon\w* ozeti|sezonun ozeti)\y'
       AND LOWER(TRANSLATE(title,'ığşçüöİĞŞÇÜÖ','igscuoIGSCUO')) ~ '\d+-\d+\s+ozet'
  THEN 'highlight'
  ELSE 'news'
END
WHERE site_id = '2b5cfe49-b69a-4143-8323-ca29fff6502e'
  AND publish_mode = 'youtube_embed';
```

**Alternatives considered**:
- A: Model-based classification — rejected; overkill for TV show name exclusion, adds latency + cost
- B: Manual correction of known bad rows — rejected; classifier runs on new articles too, so the fix must be in code

**What would change our mind**: If exclusion lists grow beyond 10 entries or accuracy drops below 90%, move to a scored/weighted approach or small classifier model.

**Deployed**: version `51d562ef-9d84-4775-93f7-dffe21a14970`

---

### 2026-05-26 — Video Hub: 7-type classifier (supersedes 3-type from same date)

**Decision**: Expand `video_type` from 3 values (`highlight`, `interview`, `news`) to 7: `match_highlight`, `generic_highlight`, `coach_interview`, `president_interview`, `player_interview`, `generic_interview`, `news`. Supersedes the Fix Pack 1 3-type classifier deployed earlier today.

**Why**: 3 types were too coarse to support future featured ranking logic — knowing a video is "an interview" is less useful than knowing it's a president announcement or a player interview. The subtype split costs nothing at classify time and enables per-type prioritisation later without a schema change.

**Type definitions**:
- `match_highlight` — actual match coverage: geniş özet, score+özet, highlights keyword
- `generic_highlight` — goal compilations, skill clips, bitiricilik (not match-specific)
- `coach_interview` — current coach by name (list intentionally empty — no active coach)
- `president_interview` — Serdal Adalı detected by name
- `player_interview` — current squad player detected by name (Tier 2 + recent Tier 4)
- `generic_interview` — interview pattern matched but speaker not identified
- `news` — default fallback

**Name detection**: Pre-normalised name lists checked at module load. Short names (≤6 chars, e.g. `cerny`, `jota`) use `\b` word boundary to prevent agglutination false-matches. `CURRENT_COACH_NAMES` is empty until new coach officially appointed — prevents premature coach classification during negotiation period.

**Frontend mapping** (`renderVideoHubPage`):
- Maç Özetleri tab: `match_highlight` ∪ `generic_highlight`
- Röportajlar tab: all four `*_interview` types
- Retention windows unchanged: highlight types 180d, interview types 90d, news 30d

**DB**: `video_type_check` constraint updated to 7 allowed values. Old constraint dropped separately (Supabase SQL editor wraps multi-statement blocks in a transaction — DROP + ADD must be run as separate statements to avoid rollback on ADD failure).

**Backfill**: 12/155 rows reclassified — 4 `highlight` → `match_highlight`/`generic_highlight`, 8 `interview` → `generic_interview`/`president_interview`.

**Alternatives considered**:
- A: Keep 3 types, add subtype as a separate column — rejected; two columns for the same semantic is unnecessary complexity
- B: Model-based speaker identification — rejected; name list lookup is deterministic and zero-cost; model adds latency and can hallucinate names

**What would change our mind**: Name list maintenance burden exceeds ~30 min/season (unlikely given squad size); would move to a `squad_members` table with automatic classifier sync (planned v1.1).

**Deployed**: version `5533e461-66fe-4248-8762-a3b4c4962217`, commit `946fbc4`

---

### 2026-05-27 — Video Hub Fix Pack 2: duplicate thumbnail + two-template architecture

**Decision**: For `youtube_embed` articles, suppress the static hero/thumbnail image in both the server-side template (`renderArticleHTML`) and the SPA template (`renderArticleView`). The video iframe is the visual anchor; showing the static image above it duplicates the thumbnail.

**Root cause of symptom**: Two independent templates render article detail:
1. **SPA** (`index.html:renderArticleView`) — client-side, used when clicking from the homepage. Renders a full-bleed `.av-hero` div with `background:url(image)` + title overlay.
2. **Worker** (`worker-fetch-agent.js:renderArticleHTML`) — server-side, used for all direct URL navigations including from `/konu/videolar`. Renders `<img class="article-img">` above the body.

Both templates show `image_url` unconditionally. For `youtube_embed` articles, `full_body` contains a YouTube iframe whose default poster is the same image → visible twice before play.

**Fixes**:
- Worker (`worker-fetch-agent.js:6959`): `${image && a.publish_mode !== 'youtube_embed' ? <img...> : ''}`
- SPA (`index.html:1282`): `const isVideoEmbed = a.publish_mode === 'youtube_embed'`; hero background image skipped when `isVideoEmbed` is true; falls back to `catGrad(a)` gradient

**`og:image` preserved**: The `<meta property="og:image">` in `renderArticleHTML` (line 6882) uses `image` directly and is NOT gated by `publish_mode` — social sharing previews still show the YouTube thumbnail.

**The two-template divergence is intentional and permanent**: SPA gives a richer in-app experience (hero, related articles, NVS bar, slide-in animations). Worker template is lean for direct URL access and SEO. Unifying them would add significant complexity for marginal gain.

**Deployed**: commits `22e5415` + `ea1331a`, CF version `3d2f73f1-92d3-49d8-b417-9f0648b3bb58`

---

### 2026-05-27 — Video Hub Fix Pack 2: grid track floor for native ad slots

**Decision**: Change `grid-template-columns` from `repeat(N,1fr)` to `repeat(N,minmax(0,1fr))` in `.vh-grid`, and add `min-width:0` to `.ad-native`.

**Root cause**: CSS Grid `1fr` = `minmax(auto, 1fr)`. The `auto` floor means each track is at least as wide as its widest item's minimum content size. In the `?tip=haber` tab, `injectAds=true` causes one `.ad-native` grid item injected every 10 cards (14 native ads for 143 Haber videos). `.ad-native` has `aspect-ratio:16/9` with no `min-width:0`. Despite `min-width:0` on `.vh-card`, the native ad slots' `aspect-ratio` constraint contributes a non-zero automatic minimum to the track, widening all 4 columns proportionally. Maç tab has 4 cards and 0 native ads → no bloat, correct 4-column layout.

**Why the earlier `.vh-title overflow-wrap:anywhere` fix (commit `ea1331a`) didn't help**: That fix targeted `-webkit-line-clamp` title text as the suspected bloat source. The actual source was the native ad grid items with `aspect-ratio:16/9`. The title fix is still worth keeping as belt-and-suspenders for other browsers.

**Fix**: `minmax(0,1fr)` hard-floors each track at exactly 0, bypassing all content-based minimum size contributions regardless of what's inside the grid item.

**Alternatives considered**:
- A: Remove `aspect-ratio:16/9` from `.ad-native` — rejected; the 16:9 placeholder is needed for when AdSense fills the slot (native video ad units are 16:9)
- B: Add `min-width:0` only to `.ad-native` — insufficient; `1fr` = `minmax(auto,1fr)` still drives from the auto floor even with `min-width:0` on items in some browsers; `minmax(0,1fr)` is the definitive fix

**Deployed**: commit `608db58`, CF version `15a8655d-dc53-45be-8dd4-8da3be8bbb37`

---

### 2026-05-27 — AdSense audit P0 fixes: robots.txt, author name, remove ai-generated meta

**Decision**: Ship three low-risk housekeeping fixes identified by the AdSense readiness audit (2026-05-27) while the Google review is in progress.

**Changes**:
1. `robots.txt` at project root — `_routes.json` excluded `/robots.txt` from the worker (expecting a static file), but no file existed there (only in `landing/`). Ali copied it to project root. Fix prevents 404 that Search Console flags.
2. Author name unified to "Ali Gencer" — JSON-LD structured data had `"Ali Genç"` (two occurrences: author field and article byline); About/Contact/Editorial Policy pages all say "Ali Gencer". Unified to the longer form for consistency across all surfaces.
3. Removed `<meta name="ai-generated" content="true"/>` from every article page — non-standard tag that explicitly flagged all content as AI-generated to crawlers. Editorial Policy and YZ badge already disclose AI assistance; the meta tag added unnecessary scrutiny with no benefit.

**Why not wait**: Review submitted 2026-05-18. Fixing while review is live reduces rejection probability without restarting the clock.

**Alternatives considered**:
- A: Wait until review completes before fixing — rejected; if reviewer encounters robots.txt 404 or notices author inconsistency, these are avoidable rejection signals
- B: Keep `ai-generated` meta — rejected; no upside, non-standard, no published spec for this attribute

---

### 2026-05-27 — AdSense Audit Pack 2: Terms page, cookie banner, static page meta/canonicals

**Decision**: Ship four remaining AdSense audit findings as a single deploy while the Google review is in progress (submitted 2026-05-18).

**Changes**:
1. `/kosullar` (Terms of Service) — new route + `renderTermsPage()`. Full Turkish ToS covering service scope, content/copyright, user conduct, liability disclaimers, third-party services, governing law. Added to footer (worker + SPA), sitemap, and `_routes.json`.
2. Cookie banner on all worker-rendered pages — extracted `siteCookieBanner()` function from `index.html`. Injected into `renderStaticPage()`, `renderArticleHTML()`, `/konu/videolar` template, and `renderTopicPage()`. Uses same `localStorage.cookies_accepted` key as SPA → cross-template consent persistence.
3. Meta descriptions and og:/twitter: tags on static pages — `renderStaticPage()` signature extended to accept `{ path, metaDescription }`. All 6 static pages (About, Contact, Privacy, Editorial, Attribution, Terms) now have unique 150-char Turkish meta descriptions and full og: tag set.
4. Canonical fix — static pages previously canonicalized to `BASE_URL` (homepage). Now canonicalize to `${BASE_URL}${path}` (own URL). Prevents Google treating all static pages as homepage duplicates.

**Audit reference**: `docs/adsense-readiness-audit-2026-05-27.md`
- B2 (Terms of Service): ✅ Resolved
- Q1 (Cookie banner on worker pages): ✅ Resolved
- Q2 (Static page meta descriptions): ✅ Resolved
- Q3 (Static page canonicals): ✅ Resolved

---

### 2026-05-27 — Match stats widget: tighten to halftime + post-match templates only

**Decision**: Replace the loose `if (a.template_id)` widget gate in the SPA and the too-broad `['T10','T11','T12','T-XG','T-HT','T-RED','T-VAR','T-PEN']` list in the worker with a single shared whitelist: `['T-HT','T11','T12','T13','T-XG']`.

**Root cause**: Two separate rendering paths existed with inconsistent conditions. The SPA (`renderArticleView` in `index.html`) fired the widget for any article with a non-null `template_id`, falling back to `current-match-stats` (most-recently-cached match) when the article had no own `fixture_id`. This caused analysis articles (e.g. T13 MOTM, synthesis articles with template IDs) to silently receive an unrelated match stats table from a completely different game. The worker path was stricter but included during-game event flash templates (T10, T-RED, T-VAR, T-OG, T-PEN) where a stats table is cluttered and out of place.

**New whitelist rationale**:
- `T-HT` (halftime report): stats mid-game are directly relevant to the article's content
- `T11` (result flash): FT score card — final stats confirm the result
- `T12` (match report): full post-match article — stats are a core component
- `T13` (MOTM analysis): post-match player analysis — stats ground the argument
- `T-XG` (xG delta): the article *is* a stats analysis — stats widget is essential

**Removed**:
- `T10` (goal flash): short live card; stats during play are partial and distracting
- `T-RED`, `T-VAR`, `T-OG`, `T-PEN`: single-event flashes; stats context is noise

**Files changed**: `index.html:1396,1489` (SPA), `worker-fetch-agent.js:7085` (worker)

**Deployed**: CF version `dea1d768-56cd-4a5f-bc1e-fa2054794d36`

**What would change our mind**: If user feedback shows readers want live stats during event flashes — add T10 back (but not the others). T-RED/VAR/OG/PEN are too short-lived to justify a stats table.

---

### 2026-05-27 — SPA article view sync: byline, badges, attribution, H2H widget

**Decision**: Align `renderArticleView()` in `index.html` with `renderArticleHTML()` in the worker across four areas that had drifted.

**Changes**:
1. **Author byline** — SPA now shows `"Kartalix Editöryel · Ali Gencer"` for Kartalix-origin articles (same `isKartalix` logic as worker). Previously showed raw `source` field or nothing. Closes AdSense P0.3 for homepage-path reads. (`index.html:1407`)
2. **Template badges** — Added `AV_BADGE_MAP` mirroring worker's `BADGE_MAP`. Hero pill now shows `Maç Önü`, `Gol`, `Sonuç`, `Maç Sonu`, `Analiz`, `Devre Arası`, `xG Analizi` etc. with matching colours (`#1d4ed8` match, `#f59e0b` live, `#0d9488` analysis). Previously showed raw category string. (`index.html:1298`)
3. **Source attribution** — 4-mode logic matching worker: video source, external source, rewrite ("Kaynak temel alınarak ... üretildi"), synthesis ("Birden fazla kaynaktan ... üretildi"). Previously one generic line regardless of publish_mode. (`index.html:1433`)
4. **H2H widget** — T02 (Maç Günü) articles now load the `api-sports` H2H widget via `/widgets/config` key + dynamic script injection. Previously absent from SPA path; only worker path showed it. (`index.html:1428, 1604`)

**Why these drifted**: The SPA was built as a lightweight homepage feed viewer. Worker article rendering was added later and grew richer over multiple sprints (badges in v0.95, attribution in v0.7, H2H in v0.4) without back-porting to the SPA. The root cause of the divergence is documented in ROADMAP.md cleanup backlog (SPA/worker template unification).

**Deployed**: Cloudflare Pages (git push `c7418ea`)

**Related**: See 2026-05-27 match stats widget whitelist entry (same discovery session).

---

### 2026-05-28 — Pipeline tuning: synthesis cap 6→18, cron 2h→3h, YouTube per-channel 2→3

**Decision**: Three coordinated parameter changes to improve daily article volume during the testing phase while controlling costs by reducing cron frequency.

**Changes**:
1. **Synthesis rewrite cap** (`src/publisher.js:736`): `rewritesSoFar < 6` → `rewritesSoFar < 18`. Per-run cap on successful AI rewrites. Overflow continues to queue to `rewrite:queue:BJK` for the next cycle.
2. **Main pipeline cron** (`wrangler.toml:18`): `0 */2 * * *` → `0 */3 * * *`. Full pipeline runs every 3 hours instead of 2 (8→8 runs/day→8 runs → ~8 per day unchanged, wait—actually 12 runs/day → 8 runs/day). Saves ~33% of pipeline cost.
3. **YouTube per-channel cap** (`worker-fetch-agent.js:4753`): `newVids.slice(0, 2)` → `newVids.slice(0, 3)`. One extra video embed per channel per run. Cost impact ~$0.10-0.20/month additional.

**Alternatives considered**:
- A: Cap 6→12 (moderate) — less drain on the overflow queue; chosen against because 18 still respects the drain queue pattern and the per-run Haiku cost at 18 rewrites is well within budget.
- B: Keep cron at 2h — rejected; the higher cap per run means each run does more work, so fewer runs achieve the same or higher daily volume at lower total cost.
- C: YouTube 2→4 — rejected; the homepage video dominance issue (belgeseller/unutulmazlar crowding out news) means adding more per-channel embeds too aggressively would worsen it before the featured_videos KV slot is built (see ROADMAP).

**Why this one**: Testing phase needs volume to observe quality/diversity at scale. Cap×frequency budget: 18 rewrites × 8 runs/day = up to 144 rewrites/day potential (subject to incoming NVS≥30 article supply). Estimated cost: ~$3.50–7/month — same or below the ~$5 baseline due to 33% fewer cron runs.

**What would change our mind**: If the overflow queue empties consistently (cap is never hit), or if cost spikes above $10/month, revisit the cap and cron balance. Once production-stable, cap may be lowered to a narrower value based on observed daily supply.

**Related**: Volume Optimization section in ROADMAP.md (VO5 updated); commit `33aa535` (published_at NULL fixes + rebuild-cache sort fix); `rewrite:queue:BJK` drain logic in `src/publisher.js:1072` (drain cap remains 8/run).

**Deployed**: version `58b4928f-12d1-4eb9-8e18-b7995cf9df94`

---

### 2026-05-30 — NVS Harmonization P2: core scoring shipped

**Decision**: Shipped config-driven scoring to replace ad-hoc constants across the pipeline.

Shipped: `SCORING_CONFIG_DEFAULTS` (exported constant, `src/publisher.js:1216`); `loadSiteConfig` (reads `config:BJK` KV, falls back to defaults); `getEffectiveNVS`, `getHalfLife`, `getTrustMultiplier`, `computeScore` (all exported); `rankAndEvict` updated to call these functions. `config:BJK` KV written with initial BJK values.

**Why**: Ad-hoc constants scattered across the codebase made per-site tuning impossible without a deploy. Config-driven scoring makes thresholds transparent and adjustable via KV without code changes.

**Alternatives considered**: Per-site code branches — rejected; doesn't scale to multi-tenant. Inline DB calls at rank time — rejected; latency concern inside `rankAndEvict`.

**What would change our mind**: If the KV round-trip in `loadSiteConfig` proves a bottleneck — cache the config object on the `stats` object and pass it through instead of reloading.

**Related**: `src/publisher.js` lines 1216–1438; `docs/nvs-harmonization-assessment-2026-05-30.md`

---

### 2026-05-30 — P4: video rail wiring shipped

**Decision**: Replace the `MOCK_VIDEOS` placeholder in the "Video Öne Çıkanlar" homepage rail with real data. `/cache` now returns `{ articles, rail_fallback }` — `rail_fallback` is a curated slug list drawn from `config.rail_fallback_video_slugs` in the site config.

**Why**: Homepage rail was showing hardcoded placeholder cards. Real rail data needed to unblock AdSense content quality audit and for accurate editorial measurement.

**Alternatives considered**: Compute featured videos dynamically at query time — deferred (VH4 in roadmap); KV-backed curated slug list is lower risk and zero-latency.

**What would change our mind**: VH4 featured ranking logic ships — at that point `rail_fallback` can be replaced with a real scoring query.

**Related**: `worker-fetch-agent.js` lines 398–418

---

### 2026-05-30 — P13: admin scoring visibility shipped

**Decision**: Add Rank / Entry NVS / Now Score / Exit ETA columns to `/admin/icerik` article list. `_exit_eta` is computed at score time: `computeScore` result at current age vs rank floor; pinned articles show "Pinned"; floor-eviction-imminent shows "imminent".

**Why**: Previously impossible to see why a specific article was evicted or how much runway it had left. Operators had to guess from publish timestamp + NVS alone.

**What would change our mind**: Nothing structural — this is observability. ETA formula may be refined as rank floor tuning happens.

**Related**: `worker-fetch-agent.js` lines 3155, 8066–8072

---

### 2026-05-31 — Cost tracking completeness: addUsagePhase on all Claude call sites

**Decision**: Wire `addUsagePhase(stats, usage, model, phase)` into every Claude call site across the pipeline. Sonnet rate updated to $3.00/$15.00 per M tokens. Cache token fields (`cache_creation_input_tokens`, `cache_read_input_tokens`) handled.

**Why**: Previously, only some call sites reported to cost stats. Monthly spend estimates were underestimates. `/admin/financials` UI requires complete data to be trustworthy.

**What would change our mind**: Anthropic rate change — update `MODEL_COSTS` in `src/utils.js`.

**Related**: `src/utils.js` `addUsagePhase`; `worker-fetch-agent.js` lines 5118–5774

---

### 2026-05-31 — Financials breakdown UI at /admin/financials

**Decision**: Add `/admin/financials` admin page: spend breakdown by phase (scout/synthesis/template/verify/embed), by model (Haiku/Sonnet), by template; time period selector (current month, past months); $/article economics tile. Monthly snapshots cached to KV (`financials:{month}`).

**Why**: Operating blind on costs. The cap was set at €30/month but no visibility into which phases drove spend made it hard to optimise.

**Alternatives considered**: Embed in `/admin/cost` — rejected; different audience (cost = current month snapshot, financials = historical breakdown). Supabase table for cost rows — rejected; KV is sufficient for monthly granularity and avoids schema migration.

**What would change our mind**: If cost snapshot granularity needs to drop to per-run rather than per-month, the KV approach would require redesign.

**Related**: `worker-fetch-agent.js` lines 1824–1881, 9181; commit `9c09a66`

---

### 2026-05-31 — Synthesis prompt caching enabled

**Decision**: Add `cache_control: { type: "ephemeral" }` to the static system-prefix parameter in all Sonnet synthesis calls. Enable `anthropic-beta: prompt-caching-2024-07-31` header on all Claude API requests.

**Why**: The system prompt (editorial rules, Turkish voice, prohibited phrases) is identical across all synthesis calls in a session. Caching the static prefix saves ~70% of system-prompt tokens on every repeated call within the 5-minute TTL window. Estimated cost reduction: 20–30% on synthesis-heavy pipeline runs.

**Alternatives considered**: Cache only on some call sites — rejected; the beta header and `cache_control` field are harmless on calls that don't benefit, so apply universally.

**What would change our mind**: Anthropic changes caching semantics or pricing in a way that makes ephemeral caching cost-neutral or negative.

**Related**: `src/utils.js` line 168; commit `4c85d19`

---

### 2026-06-01 — P9: Config admin Phase 1 read-only shipped

**Decision**: Add `/admin/config` route showing all current site config values in read-only form across 6 sections (Scoring, Thresholds, Video, Sources, Leagues, Season). Values read from `loadSiteConfig` (KV + `SCORING_CONFIG_DEFAULTS` fallback) and live Supabase `sites` row.

**Why**: Config values were only visible by reading source code. Operators needed a single place to verify what the running system believes its config is.

**Related**: `worker-fetch-agent.js` line 2863; commit `f634c74`

---

### 2026-06-01 — P10: Config admin Phase 2 editable fields shipped

**Decision**: `/admin/config/save` POST endpoint allows editing Supabase-backed site config fields (scoring thresholds, team/league/season identifiers). Each save: validates field types, applies to Supabase `sites` row, writes to audit log KV key `config_audit:{site_code}` (last 50 entries, timestamp + before/after values). Requires admin session cookie.

**Why**: P9 read-only was insufficient for operator tuning. Editable fields let BJK scoring parameters be adjusted without a code deploy.

**Alternatives considered**: Edit directly in Supabase dashboard — rejected; no audit trail, no validation, no access control for non-technical operators.

**What would change our mind**: If audit log grows beyond KV slot limits (50-entry cap mitigates this), move to Supabase `admin_activity` table (planned in Cockpit spec).

**Related**: `worker-fetch-agent.js` lines 2877–2925; commit `3cfaa59`

---

### 2026-06-01 — P8: Curated push-to-homepage shipped

**Decision**: Add `push_to_homepage`, `manual_nvs`, `manual_half_life`, `push_enabled_at` columns to `content_items`. In `getEffectiveNVS` and `getHalfLife`: if `push_to_homepage=true`, use `manual_nvs` (default 75) and `manual_half_life` (default 12h) instead of computed values. `/admin/curated-video` toggle wired. `push_enabled_at` anchors the article's age for decay — set at push time, not at original publish time, so pushed articles don't immediately decay out.

**Why**: Belgeseller/Unutulmazlar curated videos needed to surface on the homepage without dominating it. A simple boolean + manual NVS override lets an operator pin a video with controlled decay.

**Alternatives considered**: Separate KV list of pinned slugs — rejected; DB columns are queryable and survive KV wipes. Fixed-rank override (no decay) — rejected; creates permanent homepage lock-in even for outdated content.

**What would change our mind**: If `push_enabled_at` age anchor creates confusing editorial semantics — could switch to a fixed expiry datetime instead of a decay anchor.

**Related**: `worker-fetch-agent.js` lines 3351–3432, 1607; `src/publisher.js` `getEffectiveNVS`, `getHalfLife`; commits `37f114c`, `ff554fa`, `46c61e7`

---

### 2026-06-02 — P14: Dedup hardening shipped

**Decision**: Two changes: (1) within-batch dedup on generated article titles — after `generateVideoSynthesis` / `generateVideoEmbed` produce a card, check the generated title against all titles generated earlier in the same pipeline run; skip if similar title already published in this batch. (2) Duhuliye reclassified T3→T4 (aggregator tier) — consistent with its role as an aggregator, not an independent source.

**Why**: Without within-batch dedup, two videos from different channels covering the same match event could produce near-identical articles in the same run. Duhuliye T3 inflated its ranking score relative to actual journalism quality.

**What would change our mind**: (1) If within-batch dedup causes excessive drops of legitimately distinct articles — add a minimum similarity threshold. (2) Duhuliye T4 is a permanent reclassification unless its editorial independence improves substantially.

**Related**: `worker-fetch-agent.js`; commit `baa5b75`

---

### 2026-06-03 — Sprint 1 Task 1.2 descoped: no per-source-per-content-type NVS/lifetime config

**Decision**: Do **not** build a `source_overrides` (source × content-type → NVS/half-life) layer in `SCORING_CONFIG_DEFAULTS`. Task 1.2 is descoped. The existing scoring levers are sufficient.

**Alternatives considered**:
- A: `source_overrides` map keyed by `source_name` × content-type, deep-merged over the base per-type maps inside `getEffectiveNVS`/`getHalfLife` — rejected; over-engineered for current scale (~5 RSS + ~5 YouTube channels), duplicates the tier multiplier as a second "source quality" mechanism that can disagree with it, string-keyed by display name (silent breakage on source rename), and editable only as raw KV JSON until the deferred Phase 3 admin UI.
- B: Relax the `getTrustMultiplier` gate (publisher.js:1321) to also apply to video publish modes, reusing the tier already on the row (`trust_tier: video.channel_tier`) — held in reserve; cheap one-liner, but not applied now because no concrete video mis-ranking has been observed.

**Why this one**: The two axes Task 1.2 targets are already covered. **Source quality** is already applied to RSS rewrites/synthesis via the tier multiplier (T1 1.8× → T4 0.5×); **content lifetime** is already per-type via `video_half_life_by_type`, `template_half_life_by_id`, and `rewrite_half_life_by_category`. The only genuine gap is that video scoring ignores source (multiplier gated to rewrite/synthesis, so an official-channel highlight and a beIN highlight both score NVS 95×1.0). That gap is real but not currently painful — highlights are largely interchangeable footage — and if it ever bites, alternative B fixes it in one line without a new config surface to maintain.

**What would change our mind**: A concrete, observed mis-ranking — a specific source ranking too high or too low for a specific content type that the tier multiplier + per-type half-life cannot express. First response would be alternative B (relax the video multiplier gate) or a nudge to an existing per-type value; only a recurring need across many sources would justify the full `source_overrides` matrix.

**Related**: `src/publisher.js` `getEffectiveNVS` (1278), `getHalfLife` (1298), `getTrustMultiplier` (1320), `computeScore` (1326), `SCORING_CONFIG_DEFAULTS` (1216); `src/youtube.js` channel tiers; `worker-fetch-agent.js:4969` (video `trust_tier`); NEXT.md Sprint 1.

---

### 2026-06-05 — Method B: fact-based news generator as a shadow pipeline (design accepted)

**Decision**: Reframe the pipeline from "RSS-rewriter" to a **fact-based news generator** built on a topic-graph model (FACT → TOPIC → CLAIM-TRACK → PHASE → ARTICLE, with an EVENT/ACCRETIVE router). Build it as **Method B in a separate shadow worker** running in parallel to legacy, and **cut over via a blue/green KV pointer** when objective maturity gates pass. Full design in `docs/method-b-design.md` + diagram `docs/method-b-model.svg`.

**Alternatives considered**:
- A: Narrow fix — just re-score after fact extraction (original Sprint 1 Task 1.3) — rejected as too small; it patches NVS-on-blurb but leaves the "many stories, few articles" and "one article per story per day" problems untouched.
- B: Extend the existing story system in-place inside the current worker — rejected for the dev window; a buggy new pipeline co-located with homepage serving + the 5-min fetch tick risks the live site and shares the CPU/subrequest budget that forces `MAX_FACTS_EXTRACTS = 5`.
- C (chosen): Separate shadow worker, shared code/data, blue/green pointer cutover.

**Why this one**: The story/firewall/confidence subsystem already exists but is a throttled side-channel; promoting + widening it is mostly rewiring, not greenfield. A separate worker isolates *runtime* (cron, budget, failure domain, deploy lifecycle) while *reusing* `firewall.js`/`utils.js`/`story-matcher.js`/the `facts` table as shared libraries — reuse and isolation are orthogonal. The blue/green pointer (`pipeline:active`) + frozen KV schema contract + additive-only migrations make the swap a one-line, instantly-reversible KV write with no data move. Stress-tested against 10 Turkish archetypes: the model holds as a topic *graph* (trunk-default + `branch_of`/`sequel_of`/parallel claim-tracks/fan-out), not a linear story.

**What would change our mind**: If shadow-mode metrics (`/admin/pipeline`: volume, latency, quality, €/day) fail to beat legacy, or if dev-window cost can't be held near +20–40% (fact-reuse + sampling + Haiku judgments + rules-pre-filter-before-delta), Method B stays a side-channel and we fall back to the narrow Task 1.3 re-score. Delta-detection reliability is the make-or-break LLM-judgment piece.

**Related**: `docs/method-b-design.md`, `docs/method-b-model.svg`; `src/firewall.js`, `src/story-matcher.js`, `src/publisher.js` (`synthesizeStory`, `getCachedArticles`, `cacheToKV`), `src/utils.js` cost model; supersedes the scope of Sprint 1 Task 1.3.

---

*Add new entries above this line. Never delete. If a decision is reversed, write a new entry that references the superseded one.*
