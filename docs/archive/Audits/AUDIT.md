# AUDIT.md — Kartalix Codebase Audit
**Date**: 2026-04-28
**Auditor**: Claude Code
**Scope**: What exists, what must change, what must be built from scratch, before Slice 0 begins.

---

## 1. WHAT EXISTS

### 1.1 Repos

| Repo | Description |
|------|-------------|
| `/c/Git/pitchos` | Main Cloudflare Worker — fetch + score + write pipeline |
| `/c/Git/pitchos-proxy` | Render.com Express proxy — RSS bypass + Readability extraction |

### 1.2 Source Files

| File | Lines | Role |
|------|-------|------|
| `worker-fetch-agent.js` | 975 | Main orchestrator. Cron + HTTP routes. |
| `src/fetcher.js` | 471 | RSS fetch, proxy fetch, beIN (Claude web search), Twitter (Claude web search) |
| `src/processor.js` | 250 | Pre-filter, NVS scoring via Claude Haiku, story dedup |
| `src/publisher.js` | 726 | Publish mode routing, templates 05/08b/09, Supabase save, KV cache |
| `src/utils.js` | 164 | Claude API, Supabase helper, models, cost tracking, slug, hash |
| `pitchos-proxy/index.js` | 136 | `/rss`, `/article` (Readability), auto-enrich cron |

### 1.3 Database Schema (live in Supabase)

Tables confirmed present: `sites`, `sources`, `social_accounts`, `site_social_accounts`,
`content_items`, `fetch_logs`, `api_costs_daily`, `feature_flags`, `comments`,
`alert_rules`, `alert_events`, `analytics_events`, `article_reactions`, `article_comments`.

---

## 2. WHAT THE CURRENT SYSTEM DOES

The current system is a working prototype that:
1. Fetches RSS from P1–P5 sources (real feeds running in production)
2. Applies keyword/date/hash/title pre-filter (pure JS)
3. Scores articles with Claude Haiku (NVS 0–100)
4. Routes: auto-publish if NVS ≥ site threshold, queue if ≥ review threshold, discard otherwise
5. Writes to Supabase `content_items` and KV cache
6. Serves article pages at `app.kartalix.com/haber/<slug>`
7. Has three Kartalix-original templates (05 match preview, 08b muhtemel 11, 09 confirmed lineup)

**The system is live and serving real traffic.**

---

## 3. CRITICAL VIOLATIONS — MUST FIX AT OR BEFORE SLICE 1

These are the code paths that violate the Facts Firewall architecture. They are active in production today.

### 3.1 P4 source text reaches Claude and KV (HIGHEST RISK)

**`src/fetcher.js` lines 183–189**: For P4 feeds, `full_text` is assembled from `content:encoded` (up to 3000 chars of raw P4 article body) and stored on the article object.

**`src/publisher.js` `fetchViaReadability()` (lines 68–92)**: Calls `pitchos-proxy.onrender.com/article?url=<P4-url>` and receives the full article text via Mozilla Readability. This text is stored as `full_body` in KV and Supabase.

**`pitchos-proxy/index.js` auto-enrich cron (lines 101–135)**: Runs every 10 minutes. For every cached article without a `full_body`, calls Readability on the original URL (including P4 URLs) and pushes full source text back to KV via `/update-cache`.

**`src/publisher.js` `cleanRSS()` (lines 25–42)**: Cleans P4 RSS text and uses it as article content — this is the `rss_summary` publish mode.

**`src/publisher.js` `decidePublishMode()` (line 20)**: At NVS ≥ 55 with a valid URL → `copy_source`. This is a direct content copy from P4 source.

**`src/publisher.js` `saveArticles()` (line 175)**: Stores `full_body` (which may be P4 source text) into Supabase `content_items.full_body`.

### 3.2 IT3 images flow through (MODERATE RISK)

**`src/fetcher.js` `getImageUrl()` (lines 441–452)**: Extracts `<enclosure>`, `<media:content>`, and `<img>` tags from RSS items — for P4 feeds, these are P4 outlet images (IT3). No source-based filter exists.

**`src/publisher.js` `saveArticles()` line 181**: `image_url: a.image_url || ''` — stores IT3 image URLs in Supabase without any tier check.

**`src/publisher.js` `toKVShape` (worker line 509)**: `image_url: a.image_url || ''` — serves IT3 URLs to the frontend.

### 3.3 Publish mode `copy_source` is structurally incompatible

`decidePublishMode()` returns `copy_source` for NVS ≥ 55 articles with a valid URL. For P4 articles, this means the "published" Kartalix article IS the source article content. This mode has no place in the post-Slice 1 architecture. It either needs to be removed entirely or restricted to P1/P2/P6 only.

---

## 4. WHAT CAN BE REUSED (WITH CHANGES NOTED)

### 4.1 `src/utils.js` — **KEEP, minor changes**
- Claude API call pattern: reusable. ⚠ Add prompt caching headers (Slice 1+).
- Supabase helper: reusable.
- Cost tracking: reusable.
- `BJK_KEYWORDS`: reusable for keyword pre-filter.
- `generateSlug`, `simpleHash`, `relativeTime`: reusable.
- **Change needed**: `callClaude()` should route P4 source text only to the Facts Firewall, never to Produce.

### 4.2 `src/fetcher.js` — **KEEP, P4 changes required**
- RSS fetch infrastructure, XML parsing, CDATA extraction: all reusable.
- Render proxy integration for P4 403-blocked feeds: reusable.
- beIN Sports (Claude web search) + Twitter sources: reusable.
- `fetchNTVSporFromHTML` HTML fallback: reusable.
- **Change needed for Slice 1**: P4 sources must NOT populate `full_text` or `image_url`. IT3 images must be stripped. Source-tier tagging (P1–P6) must be added; current `trust` field uses string labels (`broadcast`, `press`, `official`) not the P1–P6 model. ⚠ See uncertainty §6.1.
- **Change needed for Slice 1**: `fetchFullArticle()` output for P4 URLs must route to Facts Firewall, not directly to publisher.

### 4.3 `src/processor.js` — **KEEP, scoring prompt needs P4 source text removed**
- `preFilter()` (date, keyword, hash, title dedup): reusable as-is.
- `dedupeByTitle()`, `dedupeByStory()`, `titleSimilarity()`: reusable.
- `scoreArticles()`: reusable but currently sends `full_text` (potentially P4 source) to Claude for scoring. Post-Slice 1, scoring input must be limited to title + summary (max 200 chars), never full source text.
- `getSeenHashes`, `saveSeenHashes`, `getSeenUrls`: reusable.

### 4.4 `src/publisher.js` — **PARTIAL KEEP**
- Templates 05 (match preview), 08b (muhtemel 11), 09 (confirmed lineup): **reusable**. These are data-driven, not derivative of P4 source text. They extract structured facts (opponent, date, players) which is the right pattern.
- `saveArticles()`, `cacheToKV()`, `getCachedArticles()`, `mergeAndDedupe()`, `logFetch()`: **reusable**.
- `generateSlug`, KV shape helper: **reusable**.
- **DELETE**: `copy_source` publish mode (or restrict to P1/P2/P6 only).
- **DELETE**: `cleanRSS()` — or keep ONLY for rss_summary mode on P1/P2/P3 sources.
- **DELETE**: `fetchViaReadability()` — or move to Facts Firewall as input-only (text destroyed after extraction).
- **DELETE**: `fetchOGImage()` — or restrict to P1/P2/P3 sources.

### 4.5 `worker-fetch-agent.js` — **KEEP SHAPE, needs Facts Firewall insertion**
- Orchestration pattern (cron → fetch → filter → score → write → cache): correct shape.
- HTTP routes (`/cache`, `/run`, `/status`, `/report`, `/rss`, `/sitemap.xml`, `/haber/*`): reusable.
- `/enrich` route: currently feeds P4 full text to KV — needs to be removed or gated behind Facts Firewall.
- Comment and reaction endpoints (`/react`, `/comment`, `/comments`): reusable.
- `renderArticleHTML()`, `serveRSSFeed()`, `serveSitemap()`: reusable.
- **`NEXT_MATCH` hardcoded config** (lines 18–35): must move to Supabase. ⚠ See uncertainty §6.2.
- **Hardcoded site UUID** in `buildReport()` (line 599): must come from `getActiveSites()`.

### 4.6 `pitchos-proxy/index.js` — **KEEP `/rss`, CHANGE `/article`**
- `/rss` endpoint: **keep** — needed to bypass P4 403 blocks.
- `/article` (Readability): **keep** — but its output must flow into the Facts Firewall only. Proxy itself is neutral; the problem is how the caller uses the response.
- `/health`: **keep**.
- **Auto-enrich cron (lines 101–135)**: **DISABLE immediately** — this cron bypasses any future Facts Firewall and stores P4 full text in KV on a 10-minute loop. It will undermine Slice 1 completely. ⚠ See uncertainty §6.3.

### 4.7 Supabase schema — **KEEP all existing tables, add new**
- All 10+ existing tables: keep.
- `content_items.full_body` currently stores P4 source text. Post-Slice 1, this column should only contain Kartalix-original content. ⚠ See uncertainty §6.4.
- Missing tables needed (Slice 1+): `facts`, `fact_lineage`.
- Missing tables needed (Slice 2+): `stories`, `story_contributions`, `story_state_transitions`.
- Missing tables needed (Slice 5+): `images`, `image_templates`.
- Missing tables needed (Slice 6+): `authors`, `guest_submissions`.
- Missing tables needed (Slice 8+): `agent_signals`, `agent_learnings`.
- Missing tables needed (Slice 0): `pm_sessions`.

---

## 5. WHAT MUST BE BUILT FROM SCRATCH

### Slice 0 — PM Agent
- Cloudflare Worker (or Supabase Edge Function) for Telegram bot
- `pm_sessions` Supabase table
- Monday 09:00 kickoff, Friday 17:00 close, daily drift detector, on-demand session logger
- "PM, pause for N weeks" command
- Reads `SLICES.md`, `DECISIONS.md`, `NEXT.md` (or DB state) to compose messages

### Slice 1 — Facts Firewall
- Facts Firewall agent: takes Readability output → extracts atomic facts → returns structured JSON → destroys source text
- Fact schema for Transfer story type (start here)
- `facts` table migration
- `fact_lineage` table migration (audit trail: what source, when, what was extracted, destruction timestamp)
- Wire firewall between Readability output and Produce Agent — Produce Agent must never receive source text
- Golden fixtures: `rashica_transfer_5_contribs`, `fotomac_403`, `firewall_destroys_source_text`

### Slice 2+ (not yet)
- Story-centric data model, story matching, state machine, sub-story lineage
- Governance Layer (CLO/CFO)
- HITL + Telegram operational channels
- Visual Asset Agent (IT6 SVG templates)
- Editorial QA + author flow
- Self-learning loops

---

## 6. UNCERTAINTIES (flagged for resolution, not assumed)

### 6.1 Trust tier mapping
Current code uses string labels (`broadcast`, `press`, `official`, `journalist`, `international`). Architecture uses P1–P6. The mapping is not 1:1 — e.g. `broadcast` covers both NTV Spor (effectively P4 commercial media) and TRT (P1 official). **Resolution needed before Slice 1**: either add a `tier` field to `sources` table (P1–P6) and use it for firewall routing, or add a `site_id`-keyed mapping in JSONB config.

### 6.2 NEXT_MATCH hardcoded in worker
`NEXT_MATCH` object (worker lines 18–35) is hardcoded with specific match data (Antalyaspor, 2026-04-10). Template generation (05, 08b, 09) depends on this. Needs to move to Supabase before the next match cycle. Uncertain if a `fixtures` or `matches` table already exists in Supabase (not visible in schema files read). **Resolution**: check Supabase dashboard for a fixtures table, or add one in Slice 2.

### 6.3 Auto-enrich cron disable — timing
The `pitchos-proxy` auto-enrich cron (every 10 minutes) is currently keeping the frontend content-rich. Disabling it immediately would degrade the live site (articles show only RSS summary text, no full body). **Resolution needed**: decide whether to disable the cron now (accepting content degradation) or at Slice 1 time (when Facts Firewall replaces it). This is a production-impact decision, not a code decision — flagging for the founder.

### 6.4 `content_items.full_body` remediation
The live `content_items` table contains rows where `full_body` = P4 source text (from `copy_source` and `readability` publish modes). Post-Slice 1, this column should only contain Kartalix-original content. **Resolution needed**: define whether existing rows are (a) left as-is with a `source_text_destroyed_at` timestamp added, (b) wiped, or (c) marked with a `pre_firewall` flag. This is a legal question as much as a technical one — depends on the Turkish IP lawyer consultation outcome.

### 6.5 `check.py`, `ROADMAP.md`, loose files
Several files in the root (`check.py`, `ROADMAP.md`, `cache.txt`, `console.html`, `report.html`, `template05.txt`, etc.) were not fully read. Not clear if any are part of the active pipeline. **Resolution**: quick review to confirm they are all dev tooling / diagnostics and not hot-path code.

### 6.6 `supabase-launch-waitlist.sql` not read
This file exists in the repo root. Unknown if it contains tables relevant to the architecture. **Resolution**: read before Slice 1 schema work begins.

### 6.7 Multi-tenant config completeness
`sites` table has `feed_config` and `keyword_config` JSONB fields referenced in `fetcher.js` (`site.feed_config?.feeds`, `site.keyword_config?.keywords`). These columns are not in the schema SQL files read. Either they were added via Supabase dashboard directly, or they are in a migration not yet read. **Resolution**: confirm these columns exist and their expected shape before Slice 0 work.

### 6.8 Kartalix landing vs. app.kartalix.com
The `landing/` directory contains static HTML (`index.html`, `gizlilik.html`, `iletisim.html`, `kunye.html`) which appear to be the public-facing kartalix.com site. The worker serves `app.kartalix.com`. The relationship between these two is not clear from the code. **Resolution**: not blocking for Slice 0, but relevant for Slice 4 (Distribute agent).

---

## 7. SLICE 0 READINESS SUMMARY

Before writing a single line of PM agent code, the following must be true:

| Item | Status | Action |
|------|--------|--------|
| Four tracking files in `docs/` | ✅ Done (this session) | — |
| Date-stamp DECISIONS.md entries | ⚠ Pending | Fill `[DATE]` with `2026-04-28` |
| Date-stamp SLICES.md | ⚠ Pending | Fill `[DATE]` |
| Date-stamp NEXT.md | ⚠ Pending | Fill `[DATE]` |
| Book Turkish IP lawyer | ⚠ Not done | Highest external dependency |
| Telegram `@kartalix-pm` channel created | ⚠ Not done | Required before first PM message |
| `pm_sessions` table in Supabase | ⚠ Not done | Slice 0 schema work |
| PM agent Cloudflare Worker scaffold | ⚠ Not done | Slice 0 build |
| Decision on auto-enrich cron disable | ⚠ Unclear | §6.3 above — needs founder decision |
| DECISIONS.md entry for PM agent decision | ✅ Written | `2026-04-XX` entry exists |

---

## 8. LEGAL POSTURE RIGHT NOW (pre-Slice 1)

The current live system is **not compliant with the Facts Firewall architecture**. Specifically:

- P4 source text is stored in Supabase `content_items.full_body`
- P4 source text is served in KV cache to the frontend
- IT3 images from P4 feeds are stored and served
- `copy_source` publish mode produces Kartalix articles that are content-copies of P4 source articles

This is the pre-firewall prototype state. The Turkish IP lawyer consultation is meant to determine how urgently this must change and whether the current state creates liability. **Slice 1 cannot ship until that consultation completes, per SLICES.md.**

---

*Audit completed: 2026-04-28. No code was changed. All findings are observations only.*
