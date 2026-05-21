# NEXT.md

**The single most underused founder tool. Read this every time you sit down.**

Update this at the END of every work session. Not the start — the end. Future-you walking in cold should know exactly what to do next without thinking.

---

## NEXT ACTION

**NEXT**: **Friday morning — run verification SQL for trust-aware dedup deploy (`04ec21f3`). Then About page copy.**

**Five protective fixes** ✅ DONE (2026-05-21, version `a7b84e0e-a008-4745-8477-e39fe2132cd5`):
- Fix 1: `isSynth` extended to include `template_transfer` — `src/publisher.js:687` — `['rewrite', 'original_synthesis', 'template_transfer']`
- Fix 2: `publishThreshold` default 30 → 50 — `worker-fetch-agent.js:5285` — `|| 50`
- Fix 3: `scored_low` split into `scored_low` / `synthesis_failed` — `worker-fetch-agent.js:5279` — stage `(a.nvs || 0) >= 50 ? 'synthesis_failed' : 'scored_low'`
- Fix 4: Live-blog URL rejection at preFilter Stage 1.5 — `src/processor.js:26` — `LIVE_BLOG_PATTERNS` + `_stage: 'live_blog_source'`; UI label at `worker-fetch-agent.js:8349`
- Fix 5: Markdown header strip in bodyHtml — `worker-fetch-agent.js:6546` — `l.trim().replace(/^#+\s*/, '')`

**Verify after next cron run**:
1. `SELECT stage, COUNT(*) FROM pipeline_log WHERE run_at > '2026-05-21T12:18:00Z' GROUP BY stage ORDER BY COUNT(*) DESC;` — should show `synthesis_failed` stage
2. `SELECT url, stage FROM pipeline_log WHERE stage = 'live_blog_source' ORDER BY run_at DESC LIMIT 10;` — may be empty on quiet runs
3. Visit Muçi article — `# Beşiktaş` should be gone from body

**Synthesis_failed seen-cache + template_transfer_thin pipeline_log** ✅ DONE (2026-05-21, version `9b3ada04-fbd7-4aca-ba39-0b5b9baf8624`):
- Fix 1: `getSynthesisFailedHashes`/`saveSynthesisFailedHashes` added — `src/processor.js:388,397`; load+filter at `worker-fetch-agent.js:4677`; save at `worker-fetch-agent.js:5315-5323`
- Fix 2: `thinDropped[]` captured in `saveArticles` — `src/publisher.js:679,690`; threaded through all 3 return paths at `src/publisher.js:696,764,776,779`; mapped to `template_transfer_thin` pipeline_log rows at `worker-fetch-agent.js:5303`; added to allEvents at `worker-fetch-agent.js:5449`

**Verify deploy `9b3ada04` — run when ready (≥2h post-deploy, i.e. after `2026-05-21 14:45:00+00`)**:

```sql
-- 1. Synthesis_failed cache (Item 1): each failing URL should appear at most once
SELECT url, COUNT(*) as attempts
FROM pipeline_log
WHERE stage IN ('synthesis_failed', 'scored_low')
  AND run_at > '2026-05-21 14:45:00+00'
GROUP BY url
HAVING COUNT(*) > 1
ORDER BY attempts DESC;
-- Expected: empty. Non-empty = cache not catching repeats.

-- 2. Template_transfer_thin (Item 2): new stage visible
SELECT stage, COUNT(*)
FROM pipeline_log
WHERE run_at > '2026-05-21 14:45:00+00'
GROUP BY stage
ORDER BY COUNT(*) DESC;
-- Expected: template_transfer_thin row appears if any template_transfer
-- attempt produced a thin body. May be absent on quiet windows — that's fine.

-- 3. Sanity check: overall publish rate vs 16% pre-deploy baseline
SELECT
  COUNT(*) FILTER (WHERE nvs_score >= 50) as eligible,
  COUNT(*) FILTER (WHERE nvs_score >= 50 AND stage = 'published') as published,
  COUNT(*) FILTER (WHERE stage = 'synthesis_failed') as failed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE stage = 'published')
        / NULLIF(COUNT(*) FILTER (WHERE nvs_score >= 50), 0)) as publish_pct
FROM pipeline_log
WHERE run_at > '2026-05-21 14:45:00+00';
-- Expected: publish_pct similar to or better than 16% (3/19 pre-deploy baseline).
-- Significant drop = investigate unintended re-fetch suppression.
```

After running: update DECISIONS.md entry for `9b3ada04` with verified-by evidence (query results).

**Fotomaç + Google News BJK source diagnostic** ✅ DONE (2026-05-21, doc at `docs/source-config-audit-2026-05-21.md`):
- Fotomaç: NOT 403-blocked. Proxy works warm (HTTP 200, 1011 chars). RSS has 50+ current articles. Root cause unknown — requires SQL 1.1 (source_configs row) + 1.2 (pipeline stage breakdown) to distinguish config bug from F-D (off_topic/dedup).
- Google News BJK: Redirect URLs → proxy returns Readability error. Cannot extract article body. Template_transfer (title+description only) may still work — SQL 2.2 determines whether to keep (G-D) or disable (G-C).
- bjk.com.tr: all RSS paths HTTP 403, homepage Cloudflare JS challenge, allorigins.win error 522. No accessible feed.

**Run these 4 SQL queries in Supabase dashboard before acting on recommendations:**

```sql
-- 1.1 Fotomaç source config
SELECT name, url, is_active, trust_tier, bjk_filter, polling_interval_minutes, max_per_run, custom_config, created_at, updated_at
FROM source_configs WHERE name ILIKE '%fotomac%' OR url ILIKE '%fotomac%';

-- 1.2 Fotomaç pipeline breakdown (48h)
SELECT stage, COUNT(*), MIN(run_at) as earliest, MAX(run_at) as latest, ROUND(AVG(nvs_score)) as avg_nvs
FROM pipeline_log WHERE source_name = 'Fotomaç' AND run_at > NOW() - INTERVAL '48 hours'
GROUP BY stage ORDER BY COUNT(*) DESC;

-- 2.1 Google News source configs
SELECT name, url, is_active, trust_tier, bjk_filter, polling_interval_minutes, max_per_run, custom_config
FROM source_configs WHERE name ILIKE '%google news%' OR url ILIKE '%news.google%';

-- 2.2 Google News pipeline breakdown (48h)
SELECT stage, COUNT(*), ROUND(AVG(nvs_score)) as avg_nvs
FROM pipeline_log WHERE source_name LIKE '%Google News%' AND run_at > NOW() - INTERVAL '48 hours'
GROUP BY source_name, stage ORDER BY source_name, COUNT(*) DESC;
```

SQL results analyzed 2026-05-21. Verdicts:
- **Google News (G-C)** ✅ DONE — all 3 feeds disabled (Google News T2, Google News BJK Transfer, BJK Resmi T1). 90%+ title_dedup, 1 article published in 48h. T1 on BJK Resmi was actively blocking real articles. DECISIONS.md entry written.
- **Fotomaç (F-D confirmed, structural)** — `dedupeByTitle` is first-come-first-served (no trust-tier tiebreaking). Fotomaç lost 6 dedup contests because competing articles arrived first in the array, not because of T3 tier. More pressing: **zero Fotomaç items today (2026-05-21)** — source config was last updated 22:15 on 2026-05-20. Unknown if that change broke fetch. Options: (a) accept low yield and leave as-is, (b) investigate what changed at 22:15, (c) implement trust-aware dedup so Fotomaç at least wins when it's first to a story.

**Duhuliye JSON-LD direct fetch investigation** (new, ~35 min):  
Test Cloudflare worker direct fetch + JSON-LD parsing for Duhuliye. Hypothesis: Cloudflare worker egress IP is not blocked by Duhuliye (only Render proxy IPs are). If confirmed, implement a Duhuliye-specific fetcher in the worker that fetches the page HTML directly, extracts `articleBody` from the JSON-LD `<script type="application/ld+json">` tag, and passes it to `synthesizeArticle` as `sourceText` — bypassing Render proxy entirely. Estimated: 5 min to test, 30–50 lines to implement if test succeeds. Test: `fetch('https://www.duhuliye.com/futbol/onder-ozen-besiktasta-3639')` from a Cloudflare worker and check HTTP status + whether JSON-LD articleBody is present.

**Investigate template_transfer prompt and source-context handling** (pending, ~2h):  
Root cause hypothesis: the template_transfer prompt may not pass the full source body text, causing the LLM to hallucinate from the title alone. The Muçi article generated "Beşiktaş acquired Muçi" when the source said "Trabzonspor bought him from Beşiktaş." This is a prompt-quality bug, not a gate bug. Find the template_transfer generation code in `src/firewall.js`, audit what context it passes to the LLM, propose prompt revision. Defer until after the 5 fixes settle.

**Cache wipeout** ✅ DONE (2026-05-21, RCA at `docs/cache-wipeout-rca-2026-05-21.md`):  
- Root cause: seed path pulled `rss_summary` articles evicted by hardTtl=2h immediately
- `seedModeExclude` fix at `worker-fetch-agent.js:5323` — no more short-lived seed articles
- `minPool:20` floor permanent — safety net confirmed working, not a workaround
- `articles:BJK` TTL extended 7200s → 14400s — 2h buffer against single missed cron
- Alarm at `<= 20` (was `< 20`)

**Attribution rendering** ✅ DONE (2026-05-20):  
youtube/video/rabona articles show "Video kaynağı: [Source] →". rewrite articles show real source name derived from URL hostname (not "Kartalix"). synthesis shows "Birden fazla kaynaktan…". All attribution above the fold in `article-meta`.

**Pool composition chart** ✅ DONE (2026-05-20):  
Stacked area SVG chart in `/admin` report page. Scrollable, 576-entry history (48h at 5-min cron).

**Rewrite attribution gap** ✅ DONE (2026-05-20):  
KV fallback + URL-hostname derivation. Verified: "Kaynak temel alınarak … **NTV Spor** →" renders with correct href.

**Fix B verification** — check pipeline_log after next 2 cron runs:
- Pick 5 URLs marked `off_topic` in the last run before deploy
- Verify they do NOT appear in runs N+1, N+2 — if they do, `seen:off_topic:BJK` KV key not persisting

**Parallel (Ali only — no code needed):**
- About page + byline copy — AdSense P0.3 (highest remaining AdSense risk)
- Read top 20 published articles critically, improve weakest 5 — AdSense P1.1

**Pipeline calibration** (pending data, no code yet):  
auto_publish_threshold likely too strict (NVS 68 Sabah article needed manual override). Arda Turan dedup false-match. Altay Bayındır keyword gap. Below-threshold re-scoring cost. Diagnose from pipeline_log CSV before changing thresholds.

**Sprint M — Transfer Tracker** (PARKED — concept accepted, not started):  
Public `/transfer-takip` page showing structured transfer claims extracted from scored articles. v1 (watch list), v1.5 (multi-source grouping), v2 (outcome tracking), v2.5 (journalist accuracy, joins Sprint I3 `journalist_claims` table).  
Full concept + honest concerns in `temp/16kartalix_transfer_tracker_concept.txt` + DECISIONS.md parking entry 2026-05-21.

**Trigger to start**: (1) AdSense review settles + (2) 2-day extraction PoC clears >80% correct extraction on player/from_club/to_club from 20–30 real Kartalix articles.

**Roadmap positioning** (3 open questions answered):

1. **Ships before Sprint M** (in order):
   - About page copy — Ali-only, AdSense P0.3 (highest risk remaining item, no code)
   - Sprint I2 source seeding — admin UI only, ~2h
   - Sprint J Match Highlights (v0.96) → Sprint K Situational Awareness (v0.97) → Sprint L Alarms (v0.98) → **v1.0 ship**
   - THEN Sprint M
   - Tension: summer transfer window peaks July–August. v1.0 realistically ships ~late June. Tight but achievable: Sprint M v1 by early July, v1.5 by mid-July, v2 by August. Missing this window means waiting for January transfer window.
   - If AdSense approves before v1.0 is ready, the 2-day PoC can run in parallel while Sprint J/K/L are in flight — no code conflict, offline test only.

2. **2-day extraction PoC** (run before committing to schema):  
   Pull 20–30 recent published transfer articles from Supabase (`category ILIKE '%transfer%' OR title ILIKE '%transfer%'`, NVS ≥ 50). Run a focused extraction prompt (player, from_club, to_club, status, fee) against the full_body. No deployment needed — direct API call or `/force-transfer-extraction?validate=1` endpoint. Measure: % correct fields, % hallucinated, % ambiguous. Go/no-go threshold: >80% correct on player + clubs.

3. **Architectural conflicts**:
   - Sprint I3 `journalist_claims` / `journalist_outcomes`: already designed in SLICES.md. Transfer Tracker v2.5 journalist accuracy layer MUST join these — do not build separate journalist tracking tables. Design `transfer_claims` after Sprint I3 spec is finalized.
   - Squad Intelligence v1.1 (`squad_members` table): Transfer Tracker `transfer_claims` should have a nullable FK to `squad_members.id`. Design these together or leave FK for v1.5.
   - v2 "Transfer Radar board" + "Kartalix Pro €3.99/mo": Sprint M IS this feature. Pro tier comes after v1.0 + revenue justifies it.

**Trust-aware dedup pre-sort** ✅ DONE (2026-05-21, version `04ec21f3-333f-4273-9890-f50bf394f54f`):
- `worker-fetch-agent.js:4683–4684` — `TRUST_RANK` constant + `allFetched.sort()` before `preFilter`
- Combined with Duhuliye T4 SQL downgrade (same session)
- Full RCA in `docs/dedup-deep-dive-2026-05-21.md`

**Verify deploy `04ec21f3` — run Friday morning (≥4h post-deploy, i.e. after ~2026-05-22 02:00 UTC):**

```sql
-- Q1: Dedup winners shifted?
SELECT source_name,
  COUNT(*) FILTER (WHERE stage = 'title_dedup') as lost_dedup,
  COUNT(*) FILTER (WHERE stage = 'published') as published,
  trust_tier
FROM pipeline_log
WHERE run_at > '2026-05-21 22:00:00+00'
GROUP BY source_name, trust_tier
ORDER BY trust_tier, source_name;
-- Expected: Fotomaç shows fewer title_dedup losses, new published rows; Duhuliye loses more dedup contests

-- Q2: Overall publish rate
SELECT
  COUNT(*) FILTER (WHERE nvs_score >= 50) as eligible,
  COUNT(*) FILTER (WHERE stage = 'published') as published,
  ROUND(100.0 * COUNT(*) FILTER (WHERE stage = 'published')
        / NULLIF(COUNT(*) FILTER (WHERE nvs_score >= 50), 0)) as pct
FROM pipeline_log
WHERE run_at > '2026-05-21 22:00:00+00';
-- Expected: pct above 16% baseline; target 30–40%+

-- Q3: Fotomaç specifically
SELECT stage, COUNT(*)
FROM pipeline_log
WHERE source_name = 'Fotomaç' AND run_at > '2026-05-21 22:00:00+00'
GROUP BY stage ORDER BY COUNT(*) DESC;
-- Expected: title_dedup drops sharply; synthesis_failed or published rows appear
```

After running: update DECISIONS.md entry for `04ec21f3` with verified-by evidence.

**Then**: seed sources → Kartalix title generation → Sprint J.

**Kartalix title generation** (queued, not started):  
Stop using verbatim RSS titles for rewrite/synthesis articles. After body generation, add a Haiku call to produce a clean Kartalix title from the body. Rules: 50–75 chars, no clickbait words (flaş/bomba/şok/sürpriz unless body justifies), subject name early. Preserve original RSS title as `original_rss_title` in DB for audit. Cost: ~$0.001/day at current volumes. Apply to synthesis + rewrite flows only (not templates, video, official). Details in `temp/title.txt` (now deleted — prompt archived here).

---

**Session 2026-05-18 (3)** ✅ DONE — AdSense review submitted:
- All 10 utility URLs verified clean (no googlesyndication)
- Unknown URLs return 404 (catch-all Function + _routes.json)
- Editoryal-politika live as real page
- Dead /article/* and /landing/* exclusions removed
- AdSense review requested in console 2026-05-18

**Session 2026-05-18 (2)** ✅ DONE — AdSense compliance fix:
- Phase 1 investigation: 6 ad script instances across 5 files, all auto-ads (no manual slots)
- `shouldShowAds()` + `ADSENSE_SCRIPT` constant added to `worker-fetch-agent.js`
- `renderStaticPage()`: ad script removed (utility pages)
- `renderArticleHTML()`: ad script conditional on `shouldShowAds()` (templateId, publishMode, bodyLength ≥ 1200)
- `index.html`: script removed from `<head>`, DOM-gated dynamic injection after `renderGrid` (≥8 articles + `.card` in DOM)
- Static HTML files `hakkimizda/`, `gizlilik/`, `iletisim/`: ad script removed
- `wrangler.toml`: `/impressum` route removed — Pages now serves `impressum/index.html` (German legal content, no ads)
- DECISIONS.md entry written

**Session 2026-05-18** ✅ DONE — Rewrite quality fix:
- `docs/generation-paths-audit.md` produced — full inventory of 21 generation paths
- Facts table queried: entities-only in production (transfer_fee/contract_years/dates all null across 411 rows)
- `extractFactsFromSource()` added to `src/publisher.js` (Haiku, transient, no DB write)
- `synthesizeArticle` extended: parallel fact extraction, `targetWords` tiers (150-200 / 200-300 / 300-400 based on bullet count), `factsBlock` injected into prompt, Kurallar replaced with explicit filler prohibitions
- DECISIONS.md entry: transient vs persistent facts rationale
- ROADMAP.md: persistent facts architecture added to deferred backlog

**Session 2026-05-20 (2)** ✅ DONE — Attribution rendering fix (Fixes A–D):
- Fix A: `isKartalix` no longer forces true for youtube_embed/video_embed — A Spor/beIN now correctly identified as external source (`worker-fetch-agent.js:6428-6430`)
- Fix A: New "Video kaynağı: [Source] →" attrHtml branch for youtube_embed/video_embed/rabona_digest (`worker-fetch-agent.js:6472-6474`)
- Fix B: `synthesis` mode added to "Birden fazla kaynaktan…" branch alongside `original_synthesis` (`worker-fetch-agent.js:6481`)
- Fix C: `attrHtml` moved from bottom of article into `div.article-meta` — above the fold (`worker-fetch-agent.js:6589`); CSS override added (`worker-fetch-agent.js:6559`)
- Fix D: Rabona digest KV card `url` now derived from `videos[0].video_id` or channel URL (`src/publisher.js:2697`)
- verified-by: PowerShell check — youtube_embed "Video kaynagi: YES", synthesis "Birden fazla: YES", rewrite "Kaynak temel: YES" (all 4 test URLs passed pattern match)
- Deployed: version `8a9d3172-6bea-40ab-aec7-dfa342b1ff3d`
- Known gap found: rewrite articles show "Kartalix" as link text instead of source name ("NTV Spor") — pre-existing issue in `saveArticles:728` which overwrites `source_name` to 'Kartalix' for all isSynthesized modes; Supabase data takes precedence over KV in `serveArticlePage`; NOT auto-fixed per instruction

**Session 2026-05-20** ✅ DONE — Fix B (off_topic seen cache) + BJK_KEYWORDS cleanup:
- Fix B: `getOffTopicHashes` / `saveOffTopicHashes` added to `src/processor.js` (lines 371-395)
- Fix B: import updated in `worker-fetch-agent.js` (line 14)
- Fix B: preFilter call site wrapped — load before, collect+save after (`worker-fetch-agent.js:4648-4665`)
- Fix B: verified-by: `grep getOffTopicHashes src/processor.js → line 371`; `grep seen:off_topic worker-fetch-agent.js → line 4665`
- BJK_KEYWORDS: removed `'optik'`, `'optik baskan'`, bare `'seba'` — false positive noise terms
- BJK_KEYWORDS: `'süleyman seba'` / `'suleyman seba'` retained as full names
- BJK_KEYWORDS: verified-by: `node -e "import('./src/utils.js').then(m => console.log(m.BJK_KEYWORDS.length))"` → 164
- admin/index.js: added `functions/admin/index.js` to fix `/admin` routing to homepage (Pages catch-all gap)
- Reconciliation audit: `docs/reconciliation-audit-2026-05-19.md` produced — 10 items audited, 2 NOT SHIPPED found
- Deployed: version `6ba0e504-7137-4e03-bae2-3daaeec5329b`

**Session 2026-05-19 (2)** ✅ DONE — SYNTH-D2 defensive gates + audit (fix34):
- Bad article archived + KV cleared (slug: `2026-05-19-fenerbahcede-teknik-direktor-arayisi-aziz-yildirimin-3-adayi-analiz`)
- Gate C: BJK title regex check at top of `synthesizeStory` — kills non-BJK story clusters before any DB queries
- Gate D: `checkContentCoversTitlePromise` added — same Haiku gate as `generateOriginalNews`; blocks when Strategy 3 keyword fallback retrieves wrong articles
- Gate A: SYNTH_REFUSAL_SIGNALS (15 phrases) added including `yayınlayamam`, `talimatları incelediğimde`, `haberi yazabilirim`
- Gate E: body length floor 200→600 to match MIN_BODY_CHARS system-wide
- publisher.js: `REFUSAL_SIGNALS` + `BODY_REFUSAL_SIGNALS` both extended with same new phrases
- `checkContentCoversTitlePromise` exported from publisher.js
- Audit: 4 bad SYNTH-D2 articles found and archived (3x refusal essay, 1x Fenerbahçe); 1 legitimate article from Session 18 left published
- Version: `2d3e8a8d-371d-446c-9b03-9c04fab047d4`

**Session 2026-05-19** ✅ DONE — pipeline_log enrichment + DB cleanup:
- pipeline_log: `trust_tier`, `source_body_len`, `drop_detail` columns added (SQL migration run in Supabase)
- All 4 event sites in worker-fetch-agent.js updated to populate new columns
- `dedupeByTitle` now returns `{ kept, dupeWinnerMap }` — title_dedup rows show winner URL in drop_detail
- CSV export cols/labels updated to include new columns
- BJK_KEYWORDS syntax error fixed (missing comma after 'serdal' before Tier 4)
- DB cleanup: 117 duplicate content_items rows cleared (table clean at 1077 rows)

---

**Session 2026-05-17** ✅ DONE — Pipeline quality fixes (version deployed same day):
- Refusal text detection in `synthesizeArticle()` — `REFUSAL_SIGNALS` list catches Claude rejection messages before they publish as article body
- Pre-synthesis title/content gate — `checkContentCoversTitlePromise()` Haiku call (EVET/HAYIR) blocks synthesis when source doesn't cover the title's promise; wired into both `synthesizeArticle()` and `generateOriginalNews()`
- Cross-run dedup in `saveArticles()` — queries Supabase for last 24h published titles, filters new articles against them via `titleSimilarity ≥ 0.25` or shared story token; prevents same story publishing across separate cron runs
- In-run dedup improvements in `processor.js` — Turkish morphological token matching (prefix comparison), stopwords for `beşiktaş/bjk/siyahbeyaz`, threshold lowered to shared ≥ 1 token, `sharedStoryTokens` exported and wired into both `dedupeByTitle` and `dedupeByStory`
- Minimum body length raised to 600 chars across all synthesis paths (`MIN_BODY_CHARS = 600`); `writeArticles` and `generateOriginalNews` thresholds also raised from 150/200 to 600

**Audit pre-work** ✅ ALL DONE (2026-05-15–16):
- Remove hardcoded PIN fallback *(2026-05-15)*
- Migration 0008 created and run *(2026-05-15)*
- Auth guard on all force-* routes — 20 routes, version 5567db5a *(2026-05-15)*
- Sprint I DB migrations run (`trust_tier`, `source_family`, `trust_score`) *(2026-05-15)*
- Session cookie upgrade to crypto.randomUUID() + KV store + HttpOnly/Secure/SameSite *(2026-05-16)*

**Sprint I1** ✅ DONE (2026-05-15, version 5c40f7e8):
- `tierToTrustScore()` mapping: T1→90, T2→70, T3→50, T4→25
- `rankAndEvict`: `trustMultiplier = trust_score/50` applied (clamped 0.2–2.0)
- `saveArticles`: `trust_score` stored on `content_items`
- Sources admin UI: T1/T2/T3/T4 dropdown + `source_family` text column

**NEXT (after DB cleanup): Seed sources** — Go to `/admin/sources/ui` and set T1–T4 tier + source_family for all 17+ sources. Guide:
- **T1** (official, 90pts): BJK official, TRT Haber → family: `bjk`, `trt`
- **T2** (reputable broadcast/press, 70pts): NTV Spor, A Haber, Hürriyet, Sabah, A Spor → family: `ntv`, `turkuvaz`, `demiroren`, `turkuvaz`, `turkuvaz`
- **T3** (standard sports press, 50pts): Fotomaç, Habertürk, Fanatik → family: `demiroren`, `bloomberg_ht`, `demiroren`
- **T4** (aggregators/digital, 25pts): Duhuliye, Google News feeds → family: `aggregator`, `google`
- YouTube channels → T2 (beIN Sports, TRT Spor) or T3 (others), family: `bein`, `trt`, `independent`

After seeding: Sprint I2 (source_family diversity check in synthesis gate).

**Sprint I1** — Wire `trust_multiplier = trust_score/50` into `rankAndEvict`. Seed all 17+ existing sources in `/admin/sources/ui` with T1–T4 tier + source_family. Full spec in SLICES.md Sprint I.

**Homepage konu nav tabs** ✅ DONE (2026-05-14) — `.cat-nav` bar with 4 tabs: Tümü | Transfer | Maç | Videolar. Filter by `publish_mode` (video), `template_id` (maç), `category` (transfer). Pages Functions added for `/konu/` and `/cache` proxy. Deployed.

**Sprint J (Maç Özetleri)** — PARKED. Full spec in `docs/SLICES.md` Sprint J section and `temp/kartalix_match_highlights_prompt.txt`. Start after Sprint I.

**Sitemap `/konu/*`** — extend `serveSitemap()` in worker to include `/konu/transfer`, `/konu/mac`, `/konu/sakat`, `/konu/kulup`, `/konu/analiz`.

**Session 21** ✅ DONE (2026-05-14):
- Answered: most "yayında" articles do reach KV (pushed in every `cacheToKV` call), but some skip it — articles evicted by `rankAndEvict` (score < floor or past hard TTL) remain `status=published` in DB but are no longer on homepage. Admin already shows these via `live=1` vs `yayinda=1` filters.
- Added `kv:timeline:${siteCode}` KV key (90-day TTL) tracking per-slug: `published_at` (first time in KV), `last_seen` (most recent cron), `removed_at` (first cron after eviction). Stored in `src/publisher.js` `cacheToKV` by diffing old KV list vs new.
- `content-data` handler fetches `kv:timeline:BJK` and merges `homepage_published_at` / `homepage_removed_at` into all three response paths (live, yayinda, default).
- Admin İçerik article rows now show: 🏠 DD.MM HH:MM (green = still on homepage) or 🏠 DD.MM → DD.MM (amber = evicted). Articles with no timeline entry = never reached homepage.
- Note: timeline data only accumulates from this deploy forward — historical articles will have no timestamps until the next cron runs.

**Session 20** ✅ DONE (2026-05-14):
- Fixed stale article reappearance bug: old `copy_source` DB articles with null `published_at` were being reseeded to KV on TTL expiry. `toKVShape` falls back to `new Date().toISOString()` when `published_at` is null, so these articles appeared as fresh content with today-dated slugs.
- Fix 1 (worker-fetch-agent.js): DB seed query now requires `published_at=not.is.null` and `published_at=gte.{30daysAgo}`. Old null-date or very old articles no longer enter KV on reseed.
- Fix 2 (src/publisher.js): Removed `copy_source` return from `decidePublishMode`. It was already overridden to `rss_summary` by `writeArticles` else-block; removing it prevents any future code path from accidentally saving new `copy_source` articles to DB.
- Stale TRT Haber article in current KV will self-evict via `copy_source` hard TTL (12h). To clear immediately: hit `kartalix.com/clear-cache`.
- Version: `37ec56dc-29e7-42c5-b458-f1c2908bcb99`

**Session 19** ✅ DONE (2026-05-14):
- Sprint H1 (Persistent Rewrite Queue): `enqueueForRewrite` + `drainRewriteQueue` in `src/publisher.js`. When per-run cap (6) is hit, overflow articles queued to `rewrite:queue:BJK` KV (200 max, 48h TTL). Drain runs after main pipeline on each hourly cron (top 8 by NVS, retry failures). `/admin/rewrite-queue` inspect endpoint added.
- Sprint H3 (Quick-publish): `/admin/content-publish` POST endpoint (auth-gated). "Yayınla ↑" button added to every pending article row in admin list — one-click, no editor needed. Tested live: pending article published + appeared in KV immediately.
- Sprint H4 (Topic pages): `renderTopicPage(slug)` + 6 routes (`/konu/transfer`, `/konu/mac`, `/konu/sakat`, `/konu/kulup`, `/konu/analiz`, `/konu/milli`). Full HTML pages fetching `/cache` and filtering by category client-side. `kartalix.com/konu/*` route in wrangler.toml. All tested: 200, correct title/grid.
- Sprint H5 marked fully done (was completed in Session 18 but logged here).
- All Sprint H items now done. Sprint I is next.
- Version: `ed103be5-6e9c-4bb1-8a5e-727562c46499`

**Session 18** ✅ DONE (2026-05-14):
- Sprint H5 fully working end-to-end. Fixed `maxNvs is not defined` bug in `checkH5SynthGate` (variables were block-scoped inside `if` but referenced outside). Gate correctly gates on ≥3 total contributions, ≥2 in last 6h, NVS≥60 + 2 distinct sources (when linked items exist), dedup-today check.
- Fixed `synthesizeStory` strategy 3 keyword search: was searching story title (English) against Turkish article titles → always 0 results. Now tries entity name → 2-word title phrase → single first word, breaking on first hit with ≥2 results.
- Full synthesis test: story "Beşiktaş departures and transfers on agenda" (72 contribs, 6 recent) → gate passed → synthesis fired → article published. Story correctly flipped to ineligible after synthesis (dedup key + newly linked Kartalix article = 1 source only).
- Disk space issue encountered (C: 100% full) — cleared `npm cache` + `AppData\Local\Temp` to free 1.1 GB. Deployments working normally again.
- Version deployed: `51342a6c-dda2-43f0-b4d4-86707427f55f`

**Session 17** ✅ DONE (2026-05-14):
- Sprint H2 fully implemented: `rankAndEvict(articles, limit=200, opts)` added to `src/publisher.js` with exponential decay (`rank_score = nvs × e^(-age/halfLife) × storyBoost`), hard TTL eviction, floor=5 eviction, and dedup. Half-lives: event flashes 0.5h, rewrites 8h, copy_source 3h, manual 96h. `cacheToKV` now calls `rankAndEvict` internally. All 35 call sites updated (100→300 pool limit). Re-rank pass on quiet cron runs. `rankAndEvict` exported and imported in worker.
- Trust architecture designed (3 layers: source tier, story independence, synthesis gate) + journalist accuracy tracking (journalist_claims → journalist_outcomes → true_ratio feedback loop). NVS keeps as fan/editorial score; `trust_score` (new) = factual reliability, used as ranking multiplier (`trust_multiplier = trust_score/50`) and synthesis gate (`trust_score >= 50` on ≥2 contributions).
- SLICES.md: H2 marked done, H5 spec updated with quality/recency gates, Sprint I (Trust Architecture) added with 4 sub-sprints (I1 source tiers, I2 independence hardening, I3 journalist tracking, I4 feedback loop).
- ROADMAP.md: v0.9 H2 marked done, H5 spec updated; v0.95 added (Sprint I trust layer, before v1.0); v1.0 freeze criteria updated (trust gate required, hard TTL check added).
- NEXT.md: next action updated to H5 synthesis trigger wiring.

**Feed quality hotfix** ✅ DONE (2026-05-13): Old articles + irrelevant news caused by two new feeds added in session 12. Fixed: proxy path now applies 72h date cutoff (was completely missing); undated articles fall back to URL date extraction then treat-as-now; Google News Transfer changed to `keywordFilter: true`; NTV Spor and TRT Haber (broad football feeds) also got `keywordFilter: true`. Old flood is one-time — URLs now in Supabase dedup.

**Session 16** ✅ DONE (2026-05-13):
- `template_matchday` / `template_postmatch` routing bug fixed in `src/publisher.js` `decidePublishMode()` — these two branches were firing on any RSS article with `category:match` + `content_type:fact`, overwriting the body with an empty match-day template while keeping the original title. Removed both branches (match watcher generates T05 independently).
- `cleanTitle()` added to `src/fetcher.js` — strips source domain suffixes (e.g. `- bjk.com.tr`) from RSS titles appended by Google News aggregators.
- Admin `/releases` page fully rewritten: collapsible release rows, version badges (shipped/current/next/planned/blocked), v1.0 freeze criteria checklist, backup/rollback commands, full v0.1–v0.9 history, post-launch backlog v1.1–v1.6.
- `docs/ROADMAP.md` created: single canonical roadmap with release model, Sprint H scope, freeze procedure, post-launch backlog, blocked items.
- Admin İçerik page — mini dashboard strip: 5 clickable stat pills (Canlı/Yayında/Beklemede/Arşiv/Silindi) with live counts from `/admin/content-counts` endpoint (Supabase `count=exact` + KV parse). Counts refresh after every save/delete/archive.
- İçerik filters: mode filter replaced (YZ/YZ+/Şablon/Video/Manuel/Kaynak/RSS matching badge labels); NVS range filter added (75+ / 60–74 / <60); "Silindi" added to status dropdown.
- All filters AND each other — live/yayinda handlers now apply mode/nvs/q on top of their base filter. Dashboard pills toggle (click active pill → back to all). Dropdown ↔ pill highlight stays in sync.
- Yayında filter: uses `slug=not.in.(kvSlugs)` at Supabase level; client-side belt-and-suspenders strips liveSlugSet matches after load.

**Sessions 14–15** ✅ DONE (2026-05-13):
- Widget CORS: all 5 widget endpoints changed to `'*'` wildcard + `Cache-Control: no-store` — fixes subdomains (app. / www.) and prevents CDN caching collision
- Wrangler cron Sunday: `0 2 * * 0` → `0 2 * * 7` (Cloudflare rejects 0 as day-of-week)
- Duplicate `opponent_id` key removed from admin /next-match object literal
- Rewrite RSS fallback in `synthesizeArticle`: if proxy returns empty, falls back to RSS summary (≥100 chars) as source text — prevents Render.com cold-start from silently skipping rewrites
- Rewrite cap raised 4 → 6 per cron run
- Kaydet (Save) now reads `eStatus` dropdown and sends `status` to backend; backend applies status in PATCH + updates KV feed accordingly (prepend if promoted to published, filter out if set to pending)
- Badge labels consolidated: `badgeLabel()` / `badgeClass()` — YZ, YZ+, Ş:xxx, Video, Manuel, Kaynak, RSS
- Sprint H added to SLICES.md: H1 Persistent Rewrite Queue, H2 Pool 60, H3 Manual Publish, H4 Topic Pages, H5 Multi-Source Rewrite
- Admin /releases page updated: full roadmap overview (done vs in-plan), sessions 14–15 changelog, full backlog section

**Session 14 (prev log)** ✅ DONE (2026-05-13):
- Next match self-caching: `match:BJK:next` KV — matchWatcher reads KV before falling back to hardcoded constant; backgroundWork writes to KV after every successful API fetch
- `/admin/tools` page + "Araçlar" nav tab: next match refresh, archive legacy, voice patterns trigger, story synthesis
- `/admin/archive-legacy`: preview count + batch execute (archives pre-firewall/rss_summary articles)
- `/admin/next-match` GET/POST: view current fixture state or force-refresh from API
- Voice Phase 2 (Slice 3.9): `runVoicePatternExtraction` (Sunday 02:00 cron), `editorial:voice_patterns` KV (30-pattern cap, NVS-weighted), style examples injected into all Claude generation prompts via `getEditorialNotes`
- Releases page: sessions 9–13 changelogs added

**Slice 2 close-out** ✅ DONE (2026-05-10): All golden fixtures verified against live production data via `/admin/golden-fixtures`. 130 stories in DB, 42 active, top story has 46 contributions. State machine transitions logged for 46 stories (emerging→developing→confirmed→active). `all_pass: true`.

**rss_summary KV leak fix** ✅ DONE (2026-05-09): `rss_summary` articles were written to KV cache before `saveArticles()` filter ran, giving them public slugs at `/haber/*`. Fixed by filtering `publish_mode !== 'rss_summary'` from both `top100` and `existing` before the immediate KV write. Stray article `2026-05-09-yonetimden-istifa-aciklamasi` evicted from KV cache (worker returns 404; edge CDN will expire shortly).

**AdSense** ✅ DONE (2026-05-09): Snippet added to all public pages (homepage, /haber/*, static pages). `ads.txt` created and pushed. Site submitted for review — awaiting Google approval.

**Synthesis quality fix** ✅ DONE (2026-05-09): `extractKeyEntities()` Haiku pre-call extracts named people/event/details from source; injected as ZORUNLU BİLGİLER block into synthesis prompt. Synthesis model upgraded Haiku → Sonnet (MODEL_GENERATE). First-sentence rule now explicitly requires KİŞİLER + OLAY. Both initial synthesis and verify-retry use Sonnet. `/force-synthesis` endpoint added for manual testing.

**DB migrations + cleanup** ✅ DONE (2026-05-09): 0003/0004/0005 migrations run. `content_items_source_type_check` constraint expanded to include `kartalix`+`youtube`. Source cleanup UPDATE run. Season notes set (Konyaspor cup elimination, UEL target). Verifier passing.

**Slice 1.5 — Truth Layer** ✅ ALL PHASES DONE (2026-05-09):
- Phase 1: grounding context injected into all synthesis prompts
- Phase 2: interpretation guard editorial rule active
- Phase 3: `verifyArticle()` + retry logic + `needs_review` flag + admin ⚠️ badge + multi-tenant `getLeagueContext()` + `league_european_spots` table
- Competition labels in grounding: `(outcome/SL)` / `(outcome/Kupa)` — prevents false Cup vs League verification failures
- 3 migrations written, pending Supabase run (see above)

**Domain migration** ✅ DONE (2026-05-09): canonical domain is now `kartalix.com`. All wrangler.toml routes + BASE_URL + CORS origins updated. `app.kartalix.com` still works as alias. DB tables (`stories`, `story_contributions`, `story_state_transitions`) already exist from earlier work; story matcher is live. Remaining: run DB migration if tables are missing, verify story matching end-to-end, golden fixtures.

**Slice 1 — Facts Firewall** ✅ DONE (2026-05-09): facts + fact_lineage tables live, extraction wired for all story types, source text destruction confirmed, /haber/* public. Two minor golden fixtures deferred.

**Sprint F — Source Intelligence Layer** ✅ DONE (2026-05-09): DB migration run, 17 sources seeded, `/admin/sources/ui` live. Slice 1.5 Phase 1 grounding live in synthesis prompts; Phase 2 interpretation guard added to editorial notes.

**Admin UI consolidation** ✅ DONE (2026-05-07): Report page moved from standalone `report.html` (own login) into `/admin/report` worker route with unified cookie auth. Roadmap and Releases added as `/admin/roadmap` and `/admin/releases` tabs. `adminNav()` now has 6 tabs. Login redirects back to originally requested page. `report.html` deleted.

**Sprint E — Source Expansion** ✅ DONE (2026-05-04):
1. ✅ Scorer updated: national team + multi-sport BJK scoring bands added
2. ✅ Synthesis prompt: national team / other-sport context injection
3. ✅ Step 1: Fanatik/Milliyet/Sporx/Ajansspor covered by existing Google News BJK feed
4. ✅ Step 2: Transfermarkt already live in feed list
5. ✅ Step 3: RSS cron moved to hourly (was 2-hourly)
6. ❌ Step 4: Twitter blocked — X API free tier has no search; Nitter dead; $100/month Basic needed. Parked until revenue.

**Sprint F — Source Intelligence Layer** (planned, starts after Sprint E):
- ✅ F1: Source independence gate — press-only cite chains can't reach "confirmed" (~2h)
- ✅ F2: YouTube into unified pipeline — story matching + nvs_hint scoring (~6h)
- F3: Lightweight source config — `source_configs` Supabase table + `/admin/sources` edit UI (~7h)
- Full scope and rationale: SLICES.md Sprint F section

**Sprint D — Original News Synthesis** ✅ DONE (2026-05-02)
- Raw RSS/P4 articles removed from KV frontend feed — only templates + original synthesis appear
- `generateOriginalNews(sources, site, env)` in publisher.js: multi-source, no attribution, 300–400 word Kartalix voice
- Synthesis loop in backgroundWork: top P4 stories (NVS≥55), cap 3/run, skip match_result/squad
- Dedup key: `synth:{hash}:{date}` in KV — prevents same story being re-synthesized same day
- Multi-source context: collects related P4 articles via titleSimilarity(>0.25) for richer Claude input
- `/force-synthesis?publish=1` debug endpoint added (tests with top recent Supabase P4 articles)

**Sprint C — YouTube Embed** ✅ DONE (2026-05-02)
- 5 channels live: Beşiktaş JK, beIN SPORTS TR, A Spor, Rabona Digital, TRT Spor
- Keyword qualification + archive season filter working
- 3 videos published on first run (Sergen Yalçın basın toplantısı, Josef/Guedes alumni return, BJK 2-1 Eyüpspor full match)
- Match-specific templates live: T-VID-HLT, T-VID-GOL, T-VID-BP, T-VID-INT, T-VID-REF (Süper Lig only)
- `classifyMatchVideo` routes to match templates; falls back to generic T-VID outside Süper Lig context
- `/force-yt` now shows `match_type` per video and uses match templates when `?publish=1`

**Backlog (done)**:
- Sprint A ✅ — T-HT, T-RED, T-VAR, T-OG, T-PEN deployed (d6bb2e0d)
- PR #1 — close (SoccerData evaluation, stay on API-Football Pro)

---

## CONTEXT IF NEEDED

**Currently in flight**: Slice 3 complete (Phase 1 + Phase 2 + Phase 3)
**Session 7 status (2026-05-01)**:
- API key rotated ✅
- Editorial feedback system: article comments → distill → editorial:notes → injected into all generation
- Reference article paste: admin panel, style learning from other channels, feeds redistill
- Weekly redistill cron (Monday 03:00) — consolidates and deduplicates rules
- Reactions restored to Supabase with idempotency fix; admin news list fixed
- Template set COMPLETE (9 of 9): T01, T02, T03, T07, T10, T11, T12, T13, T-XG
  - Pre-match: T03 Form Guide (72h), T02 H2H (72h), T07 Injury Report (48h), T01 Preview (48h)
  - Live: T10 Goal Flash
  - Post-match: T11 Result Flash, T13 Man of the Match, T12 Match Report + xG, T-XG Delta (|goals−xG| > 1.2)
- Injury API fix: fixture-scoped query, client-side dedup, no Kartalix articles in RSS context

**Provider decision**: API-Football Pro confirmed ✅ — close PR #1
**Open PRs**: #1 slices/track-a-stats-pipeline (close), #2 slices/track-b-v2-backlog (merge after retrospective)
**Slice 3 Phase 3 remaining templates**: T02 H2H History, T05 Lineup Announcement, T07 Injury/Suspension, T13 Man of the Match, T12 Match Report (with xG), T-xG Delta, T-SUB Suspension Watch, T-GK Goalkeeper Spotlight, T-FRM Formation Change, T-REF Referee Profile
**Key finding**: Shot x/y coordinates absent from API-Football — shot map visuals parked to v2
**Key finding**: xG is in every fixture response — T-xG Delta article is zero-cost to add
**Editorial system KV keys**: editorial:notes (active rules), editorial:raw_feedback (unprocessed comments), editorial:references (pasted example articles)

---

## RULES

- One next action. Not three. Not "various things."
- Concrete, not abstract. Bad: "work on Facts Firewall." Good: "Add migration for `fact_lineage` table in `migrations/0042_fact_lineage.sql`."
- If you finish a session without knowing the next action, the session wasn't really done. Take 2 minutes to figure it out before closing the laptop.
- The PM agent reads this and references it in Friday close messages.

---

**API migration + T-REF — DONE (session 7)**:
- T05: RSS injury extraction → `getInjuries(env, fixture_id)` (same API as T07)
- T09: RSS keyword scan + Haiku extraction → `getFixtureLineup(fixtureId, env)` (API-Football `/fixtures/lineups`)
- T08b: stays RSS — API has no probable lineups
- `getFixtureLineup` added to api-football.js — returns null if lineup not yet submitted
- `referee` field added to nextMatch builder from API data
- T-REF Referee Profile: new template, API-driven, fires 24–48h pre-match, computes BJK W/D/L record under that referee from recent fixtures
- `/force-tref?referee=Name` debug endpoint added

**Slice 3 Phase 2 (story type classification) — DONE**:
- `classifyStoryType()` in firewall.js: Haiku call → transfer/injury/disciplinary/contract/match_result/squad/institutional/other
- Per-type schemas: transfer (existing), injury/disciplinary, contract, generic
- `extractFactsForStory()` replaces `extractFacts` in story intake — two-step: classify then extract
- match_result + squad filtered from story system (`SKIP_STORY_TYPES`) — handled by templates
- story-matcher: judge prompt includes pre-classified type hint; createStory uses it as fallback

*Last updated: 2026-05-09 (session 13 — Slice 1.5 all phases done; 3 DB migrations pending Supabase run; AdSense application next after migrations)*
