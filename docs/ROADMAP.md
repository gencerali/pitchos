# Kartalix Platform — Release Roadmap

**Active plan. One truth. Updated every release.**

---

## Release Model

| Track | Meaning |
|---|---|
| `v0.x` | Pre-launch iterations. Continuous deploy. No freeze required. |
| `v1.0` | **Public launch freeze.** Full test + backup before deploy. |
| `v1.x` | Post-launch features. Freeze per release. |

**Frozen release** = git tag + Cloudflare worker version noted + KV snapshot + Supabase backup. Procedure is in the [Freeze Procedure](#freeze-procedure) section.

---

## Current State: v0.95 (shipped 2026-05-18)

---

## Parallel Workstreams

These run alongside the sprint sequence. Each is independent unless noted.

---

### ⚡ AdSense Readiness *(compliance review submitted 2026-05-18 — awaiting Google response)*

Goal: improve from estimated 60-70% to 85%+ approval probability before reviewer scrutiny. Full spec: `temp/kartalix_adsense_readiness_brief.txt`.

**Compliance fix shipped 2026-05-18:** Structural URL routing fix — all ad-rendering pages now gated on real content. `shouldShowAds()` gates articles by template and body length. Utility pages serve no ads. Unknown URLs return 404 (catch-all Pages Function + `_routes.json`). Trailing-slash variants all handled. Review submitted same day.

**P0 — must land in first week of review window:**
- [x] **P0.1** Audit thin-content indexing: `noindex` on T10/T11 flash cards, `rss_summary` articles excluded from ads and sitemap; `shouldShowAds()` blocks ad rendering on flash templates
- [x] **P0.2** Rewrite trust pages with real substance: Editorial Policy live at `/editoryal-politika`, About/Contact/Privacy all live — **copy must be Ali's own writing** *(About page content reviewed and approved 2026-05-26)*
- [ ] **P0.3** Add consistent byline on every article: "Kartalix Editorial · Ali [Surname]" or equivalent; add visible publication date

**P1 — within 2 weeks:**
- [ ] **P1.1** Read top 20 published articles critically; improve weakest 5 for substance and depth
- [x] **P1.2** Content-type visual badges live on all articles (Maç Önü · Maç Günü · Canlı · Sonuç · Analiz · Transfer · Haber)
- [x] **P1.3** Source attribution visible on every article (credit + link to original)

**P2 — when possible:**
- [ ] **P2.1** Sitemap: exclude rss_summary articles, T10/T11 cards older than 24h, archived articles
- [x] **P2.2** `/ads.txt` live with correct AdSense publisher ID (`ca-pub-5282305686231853`), served as `text/plain`
- [ ] **P2.3** Lighthouse: LCP <2.5s, CLS <0.1, INP <200ms mobile
- [ ] **P2.4** Mobile usability pass — no horizontal scroll, tap targets adequate

**Constraint:** No new article types or sources during review window. About / Editorial Policy copy must be in Ali's own voice — do not use AI-polished boilerplate.
**Owner:** Ali (all copy). Claude Code (code changes). **Estimated effort:** P0 ≈ 2 days code + Ali writing time. P1 ≈ 2-3 days. P2 ≈ 1 day.

---

### Worker Split *(Phase 1 before v0.97; Phases 2-3 before v1.0)*

Goal: break `worker-fetch-agent.js` (10k lines) into focused ESM modules. Benefit: AI dev sessions load 5-15k tokens instead of 50k, cutting direct API cost per session by ~70%. Full spec: `temp/kartalix_modular_growth_proposal.txt` Part A.

**Phase 1 — Extract report dashboard (1-2 days)** ← *prerequisite noted in v0.97*
- [ ] Move `renderAdminReportPage` + `reportDashboardJs` + `analyticsJs` + KPI strip → `routes/admin-report.js`
- [ ] Move `buildReport` + `buildMatchStats` → `domain/report-builder.js`
- [ ] Verification: `/admin/report` 200, "Pipeline Flow" visible, KPI strip loads

**Phase 2 — Extract force-triggers (1 day)** ← *prerequisite for Cockpit*
- [ ] Move all `/force-*` endpoints → `routes/force-triggers.js` with shared `requireOps()` helper
- [ ] Side benefit: reveals any endpoints missing auth guard

**Phase 3 — Extract pipeline domain (2 days)** ← *aim before v0.98*
- [ ] `processSite`, `runAlarmChecks`, `checkH5SynthGate` → `domain/process-site.js` + `domain/alarm-checks.js`
- [ ] `matchWatcher` → `jobs/match-watcher.js`; `scheduled()` routing → `jobs/cron-handler.js`
- [ ] Verification: one full pipeline run completes via `/admin/run-pipeline`

**Phase 4 — Extract render layer (1 day)** ← *do when convenient, lowest priority*
- [ ] Static pages, nav, article HTML, topic page → `render/`

**Phase 5 — Stop.** Other admin pages (sources, cost, content) extract opportunistically only.

---

### Video Hub *(active — VH7 shipped 2026-05-28)*

Goal: `/konu/videolar` redesigned as a classified video hub with tabbed sections, retention filtering, and ad slot structure. Curated sections (Belgeseller + Unutulmazlar) now fully operational; featured ranking is the next active item.

| # | Item | Status | Effort | Notes |
|---|------|--------|--------|-------|
| VH1 | Phase 1: `video_type` DB column + 7-type classifier | ✅ Done | S | `match_highlight`, `generic_highlight`, `coach_interview`, `president_interview`, `player_interview`, `generic_interview`, `news` |
| VH2 | Phase 2: `/konu/videolar` redesign (tabs, sections, grid, ad slots) | ✅ Done | L | Server-rendered; 4 tabs + ?tip= URL routing; retention windows; 2-col mobile / 4-col desktop |
| VH3 | Fix Pack 1: CSS grid overflow + classifier refinement | ✅ Done | S | `min-width:0` on cards; pattern+exclusion classifier replacing simple keywords |
| VH7 | Curated video sections (Belgeseller + Unutulmazlar) | ✅ Done | M | `category` column as discriminator (no schema migration); `/admin/curated-video` with oEmbed, inline edit, drag-and-drop sort (KV order), all 5 sections in dropdown; reveal-next-12; Tümü includes curated; min-12 backfill per tab; ads hidden until reveal; YouTube iframe auto-injected on article pages; İlgili Videolar via Supabase |
| VH4 | Featured Ranking Logic | 🔲 Not started | M | Tier hierarchy scoring: match_highlight 100 → news 50×NVS; 24h decay for premium types; `featured_rank` numeric column; compute at query time |
| VH5 | Homepage Video Filter | 🔲 Not started | S | Top 3 youtube_embed by `featured_rank` on homepage; non-video articles unaffected. *Depends on VH4* |
| VH6 | Admin override for featured | 🔲 Deferred | S | `featured_until` + `featured_blocked` columns for manual pin/hide. *Defer until VH4 auto-logic proven* |
| VH8 | Video search + filtering | 🔲 Not started | M | Search box in /konu/videolar header; server-side `ILIKE '%query%'` across title; respects active tab filter; mobile-friendly with clear button. Can ship independently of VH4 |

**Decisions needed:**
- Coach name list (`CURRENT_COACH_NAMES` in `src/publisher.js`) is empty — populate when new coach officially signed.

**Future:** `squad_members` table (v1.1) replaces hardcoded `CURRENT_PLAYER_NAMES` in classifier. See Post-Launch Backlog.

---

### Volume Optimization *(observational — NVS 30 shipped 2026-05-26)*

Goal: increase daily publish volume to ~10 articles/day without quality regression. Observational window ongoing; decisions gated on data.

| # | Item | Status | Effort | Notes |
|---|------|--------|--------|-------|
| VO1 | NVS threshold 50→30 impact monitoring | 🟡 Observational | — | Window: 5–7 days. Verify volume ↑ without quality regression |
| VO2 | `thin_body_blocked` data analysis | 🟡 Observational | XS | 48h of logs needed. Output: length distribution by source. Informs MIN_BODY_CHARS |
| VO3 | MIN_BODY_CHARS decision (keep 600 / lower to 500 / lower to 400) | 🔲 Awaiting VO2 | XS | **Decision: Ali** based on VO2 data |
| VO4 | Facts extraction cap 5 → 16 | 🔲 Not started | XS | +€0.07/day. Low risk. Likely improves story dedup quality |
| VO5 | Rewrite cap 6→18 + cron 2h→3h + YouTube 2→3 | ✅ Shipped 2026-05-28 | XS | Cap 6→18 per run; pipeline runs every 3h (was 2h); YT per-channel 2→3. Net cost neutral or ↓ due to fewer runs. DECISIONS.md 2026-05-28. |
| VO6 | `light_news` mode for NVS 30–49 | 🔲 Designed, not started | M | Only build if VO1 + VO5 don't reach ~10/day volume target. *Depends on VO1 data* |
| VO7 | KV health monitoring post-deploys | 🟡 Ongoing | — | Daily check: homepage shows fresh articles. Watch 4 fixed KV locations |

---

### Cockpit Page *(depends on Worker Split Phase 2; target pre-v1.0)*

Goal: `/admin/cockpit` — single control room for all operational levers (triggers, config, maintenance, activity log). Replaces curl-only force-triggers and scattered hardcoded config. Full spec: `temp/kartalix_modular_growth_proposal.txt` Part B.

**Phase 0 — Config migration (1 day):** *(do first, required for Section 3 to be functional)*
- [ ] Move hardcoded pipeline params into `sites.config` JSONB with fallback defaults in code:
  `pool_max_size`, `pool_rank_floor`, `pool_alarm_floor`, `auto_publish_threshold`, `synthesis_min_contributions`, `synthesis_min_recent_hours`, `synthesis_min_nvs`, `synthesis_min_families`, `half_life_rewrite_h`, `half_life_synthesis_h`, `half_life_video_h`, `half_life_match_result_h`, `story_boost_max`, `fetch_lookback_hours`, `fetch_age_cap_hours`

**Phase 1 — Cockpit UI (3-4 days):** *(after Worker Split Phase 2 + Phase 0)*
- [ ] `routes/admin-cockpit.js` — four collapsible sections
- [ ] Section 1: read-only system state tiles (pipeline, pool, alarms, cost) — reads existing endpoints
- [ ] Section 2: manual triggers with UI — run pipeline, drain rewrites, template dropdown (T01-T13), story synthesis, H5 gate test
- [ ] Section 3: editable config panel — each param with current value, new-value input, per-field Save, description
- [ ] Section 4: maintenance actions (archive, find-dupes, cleanup-orphans, KV remove, etc.) — red-zone with confirm dialogs
- [ ] Activity log: `admin_activity` table (actor, action_type, action_name, before/after jsonb, result, duration_ms) + scrollable log at page bottom

**Dependencies:** Worker Split Phase 2, Config Phase 0. **Estimated effort:** ~5 days total.

---

### Capability Modules *(long-running; prioritized below)*

Goal: grow pipeline reliability (Goal 1) and editorial quality (Goal 2) through focused single-purpose modules. Architecture principle: scheduled functions and single-prompt LLM calls — not multi-step autonomous agents. Full spec: `temp/kartalix_modular_growth_proposal.txt` Part C.

| # | Module | Goal | Where | Est. | Status |
|---|--------|------|--------|------|--------|
| 1 | 1.3 Alarm framework | Pipeline | v0.98 Sprint L | 5d | in roadmap |
| 2 | 1.2 Relevance bucket | Pipeline | v0.98 Sprint L | 5d | in roadmap |
| 3 | 2.1 Situational awareness | Editorial | v0.97 Sprint K | 8d | in roadmap |
| 4 | 1.1 Source health module | Pipeline | post-v0.98 | 2d | **new** — per-source pass rates, daily anomaly report, auto-disable after 3 consecutive zero days |
| 5 | 2.2 Voice patterns extension | Editorial | post-v0.98 | 3d | **new** — add content_type dimension + curated model articles as references |
| 6 | 1.4 Template firing audit | Pipeline | post-v0.98 | 2d | **new** — hourly check during match windows; detects missed T01/T02/T09/T03/T11 |
| 7 | 1.5 Story coverage audit | Pipeline | post-v0.98 | 2d | **new** — surface stories stalled by family-diversity gate |
| 8 | 2.6 Editorial sample queue | Editorial | post-v0.98 | 1d | **new** — 3 random articles/day sampled for operator 1-5 rating |
| 9 | 2.4 Fan engagement signals | Editorial | v1.6 | 3d | **new** — weekly few-shot examples from top-engagement articles injected into prompts |
| 10 | 2.3 Grammar firewall | Editorial | v1.4 | 3d | **new** — Haiku post-generation pass; fail → editor queue; optional toggle in cockpit |
| 11 | 1.6 Cost ceiling module | Pipeline | post-v1.0 | 2d | **new** — daily cap enforcement, monthly budget trajectory alarm |
| 12 | 2.5 Analytical depth | Editorial | post-v1.0 | 4d | **new** — long-form depth pass for NVS≥70 articles using Claude Sonnet |

Modules 4-8 (~10 days) grouped into v1.1-v1.2 cycle. Total across all 12: ~40 days.

---

## Releases

### v1.0 — Public Launch *(planned, target: July 2026)*

**The milestone that matters.** Site is publicly promoted, security is hardened, and a clean rollback exists.

**Requires:**
- [x] Sprint H complete (news pool, rewrite queue, topic pages, multi-source synthesis)
- [ ] Audit pre-work complete (P0 security fixes + DB migrations — see v0.91)
- [ ] Sprint I complete (trust layer — synthesis gated on source quality)
- [ ] Sprint J complete (match highlights pipeline)
- [ ] Sprint K complete (situational awareness engine)
- [ ] Sprint L complete (self-maintaining pipeline + alarm framework)
- [ ] Security hardened (no unauthenticated trigger endpoints, no forgeable session)
- [ ] Telegram ops alert wired (Claude cap hit + zero-article run → message) — delivered by Sprint L
- [ ] Legal sign-off re-confirmed (lawyer review after Sprint H ships)
- [ ] All freeze criteria below pass

**Freeze criteria for v1.0:**
- [ ] `/run`, `/force-*` endpoints require auth — no unauthenticated pipeline triggers
- [x] Admin session cookie is server-generated token (not static `kx-editor=1`)
- [ ] `ADMIN_PIN` secret set in Wrangler — no hardcoded fallback in code
- [ ] Homepage loads <2s on mobile (4G throttled)
- [ ] 40+ articles visible without manual intervention for 3 consecutive days
- [ ] Widget loads on kartalix.com, app.kartalix.com, www.kartalix.com — all three
- [ ] Kaydet (save) tested: beklemede → yayında promotes to KV within one cron tick
- [ ] Admin at /admin/cost shows current month spend is within cap
- [ ] Rewrite articles: at least 3 per day for 3 consecutive days (proxy + RSS fallback both exercised)
- [ ] No article older than its content-type hard TTL visible on homepage
- [ ] At least one synthesis blocked by trust gate (logged in console)
- [ ] Situational context block present in at least one synthesis article
- [ ] git tag v1.0.0, Cloudflare version ID noted, KV export saved, Supabase backup downloaded

---

### v0.9 — News Pool & Publish Queue ✅ *shipped 2026-05-14*

Sprint H all complete: persistent rewrite queue, decay engine, quick-publish, topic pages, multi-source synthesis trigger.

| What | Detail |
|---|---|
| H1 | Persistent rewrite queue — NVS≥60 overflow queued to KV; drain runs each hourly cron (top 8 by NVS) |
| H2 | `rankAndEvict` — `rank_score = nvs × e^(-age/halfLife) × storyBoost`; pool 200; re-rank every tick |
| H3 | Quick-publish "Yayınla ↑" button — POST `/admin/content-publish`; one-click from pending list |
| H4 | Topic pages — `/konu/transfer`, `/konu/mac`, `/konu/sakat`, `/konu/kulup`, `/konu/analiz`, `/konu/milli` |
| H5 | Multi-source synthesis gate — ≥3 contributions, ≥2 in 6h, NVS≥60, ≥2 distinct sources |
| Homepage nav | `.cat-nav` tabs: Tümü / Transfer / Maç / Videolar; `/konu/*` Pages Functions |

---

### v0.91 — Audit Pre-work *(immediate — do before writing Sprint I code)*

**Goal:** Close P0 security gaps and run prerequisite DB migrations so Sprint I can proceed safely.

**Scope — from architecture audit 2026-05-15:**
- [x] **P0-2** Remove `|| 'kartalix2026'` fallback from admin login handler — fails hard if ADMIN_PIN secret unset *(done 2026-05-15)*
- [x] **P0-1** Add `requireOps()` auth guard to all `force-*`, `/run`, `/clear-cache`, `/rebuild-cache` handlers (20 routes) *(done 2026-05-15, version 5567db5a)*
- [x] **P1-4** `docs/migrations/0008_sites_editorial_context.sql` created and run *(done 2026-05-15)*
- [x] **P1-2** Sprint I DB migrations run: `trust_tier`, `source_family` on `source_configs`; `trust_score` on `content_items` *(done 2026-05-15)*
- [x] **P2-5** `pitchos-proxy` auto-enrich cron confirmed disabled (removed 2026-04-28, not running on Render)
- [x] **P1-1** Upgrade session cookie: generate `crypto.randomUUID()` on login, store in KV (`admin:session:{token}`, 7-day TTL), verify on each admin request; add `HttpOnly; Secure; SameSite=Lax` flags *(done 2026-05-16)*

**Effort remaining:** P1-1 is M (~1 day). Can defer to later in v0.91 and start Sprint I1 now.

---

### v0.95 — Trust Layer + AdSense Compliance ✅ *shipped 2026-05-18*

Sprint I all complete. AdSense structural fix deployed; compliance review submitted.

| What | Detail |
|---|---|
| I1 | `trust_multiplier = trust_score/50` in `rankAndEvict`; T1→90, T2→70, T3→50, T4→25; sources admin UI |
| I2 | Synthesis gate uses `source_family` diversity — Turkuvaz papers count as one family |
| I3/I4 | Deferred to v1.6 (needs Twitter + YT transcript data — see v1.6) |
| AdSense fix | `shouldShowAds()` gates articles by template + body length; utility pages ad-free; `_routes.json` + catch-all 404 Function eliminates SPA fallback serving ads; trailing-slash variants all handled |
| Rewrite quality | `extractFactsFromSource()` (Haiku, transient) injected into synthesis prompts; filler prohibitions added; `targetWords` tiers by bullet count |
| Cron | Hourly pipeline → 2-hourly (`0 */2 * * *`) |

---

### v0.96 — Match Highlights *(after v0.95)*

**Goal:** Match highlight clips fetched and embedded automatically around BJK fixtures. Match article quality increases substantially on match days.

**Prerequisites:** Fix `NEXT_MATCH` hardcoded constant before starting — Sprint J uses `fixture_id` for event API calls; stale ID produces silent wrong content. Make `match:BJK:next` KV the single source of truth (remove hardcoded fallback in worker line 26–45).

**Scope — Sprint J:** Full spec in `docs/SLICES.md` Sprint J and `temp/kartalix_match_highlights_prompt.txt`. Start after Sprint I.

---

### v0.97 — Situational Awareness Engine *(after v0.96)*

**Goal:** Every synthesis article has a factually-grounded situational context block (league position, mathematical locks, European path, rival analysis, editorial narrative arc). Fabricated "kritik viraj" framing eliminated.

**Prerequisites:** Migration 0008 (`sites.editorial_context`) must be run before K4 begins.

**Scope — Sprint K:** Three-layer architecture in new `src/situation.js` (~300 lines). Full spec in `docs/sprint-k-analysis.md`.

- [ ] **K4 first** — `sites.editorial_context` schema + admin form + BJK seed data *(half day; do this first)*
- [ ] **K1** — Layer 1 gap-fill: remaining fixtures, cache invalidation after result flash
- [ ] **K2** — Mathematical locks + rival threat index + GD tiebreaker flag
- [ ] **K3** — European qualification tree (rules + cascade + drop-down + unit tests)
- [ ] **K5** — `src/situation.js` glue + `formatForPrompt()` + integration into synthesize / preview generators

**Worker refactor prerequisite:** Worker Split Phase 1 (see Parallel Workstreams) must complete before K5 begins — extracts report dashboard into `routes/admin-report.js` + `domain/report-builder.js`. Target: worker under 6,000 lines before K5 adds the situation module.

**Freeze criteria:**
- [ ] At least one published synthesis article contains situational context block
- [ ] `computeMathLocks()` + `computeEuropeanPath()` unit tests pass for edge cases
- [ ] Layer 3 admin form: BJK editorial context seeded and visible in `/admin`

---

### v0.98 — Self-Maintaining Pipeline + Alarm Framework *(after v0.97)*

**Goal:** Eliminate manual keyword/entity maintenance from the news pipeline. Add automated observability so anomalies are caught without Ali noticing them manually.

**Full spec**: `docs/sprint-l-analysis.md`

**Scope — Sprint L:**

*Pipeline self-maintenance:*
- [ ] **L1** Unify filter paths: new `src/relevance.js` with `classifyRelevance()`, TEAM_CORE_REGEX + entity matching; retire `BJK_KEYWORDS` + `BJK_REGEX`
- [ ] **L2** `team_entities` table + API-Football weekly sync (Sunday 03:00 TRT); KV cache `entities:BJK`
- [ ] **L3** Confidence bucket pre-screen: HIGH (club name) / MEDIUM (entity only) / NONE (drop); MEDIUM flag passed to NVS prompt
- [ ] **L4** 7-day parallel run (old + new paths); cutover after ≥95% coverage parity confirmed; remove `keyword_config` code path

*Alarm framework:*
- [ ] **L5** DB schema: `alarm_definitions`, `alarm_states`, `alarm_events`, `system_heartbeat`
- [ ] **L6** Alarm runner: CF cron, state machine (clear/firing/acknowledged), event logging, per-check error handling
- [ ] **L7** Telegram bot notifications (P0/P1); in-app badge counter on /admin/rapor; Resend email fallback for P0
- [ ] **L8** /admin/rapor alarm UI: active alarms, history (7-day), definitions panel, Ack + Manual Clear buttons
- [ ] **L9** First three alarms registered: `pipeline.zero_articles_window` (P1, every 30 min), `pipeline.drop_rate_spike` (P2, hourly), `pipeline.nvs_distribution_drift` (P2, daily)
- [ ] **L10** Heartbeat self-monitoring: `/health/alarm-runner` endpoint + UptimeRobot external watch

**Why before v1.0:** Delivers the "Telegram ops alert" required by v1.0 freeze criteria. Pipeline filter unification removes the keyword maintenance gap that causes silent article misses. Without observability, the system runs autonomously but no one notices when it drifts.

**Estimated effort:** 8–9 dev days active + 7 calendar days parallel run (~3 weeks elapsed).

**Freeze criteria:**
- [ ] `classifyRelevance()` parallel run shows ≥95% coverage parity with old keyword_config path
- [ ] Telegram alert fires within 5 minutes of a zero-article 6-hour window (tested)
- [ ] `/admin/rapor` shows active alarms with Acknowledge + Manual Clear working
- [ ] `team_entities` populated with full BJK squad from API-Football; sync runs Sunday without errors
- [ ] `/health/alarm-runner` returns 200 and is registered with UptimeRobot

---

### v0.8 — Operational Fixes ✅ *shipped 2026-05-13*

Widget CORS wildcard, rewrite RSS fallback, Kaydet status fix, badge label cleanup, Sprint H spec.

| What | Detail |
|---|---|
| Widget CORS | All 5 widget endpoints → `*` wildcard + `Cache-Control: no-store`. Fixes app./www. subdomains. |
| Cron fix | Sunday cron `0 2 * * 0` → `0 2 * * 7` (Cloudflare rejects 0) |
| Rewrite RSS fallback | If proxy times out, use RSS summary (≥100 chars) as source — prevents Render cold-start silently killing rewrites |
| Rewrite cap | Raised 4 → 6 per run |
| Kaydet status | Admin Save now reads eStatus dropdown; backend applies status + updates KV feed |
| Badge labels | Consolidated: YZ, YZ+, Ş:xxx, Video, Manuel, Kaynak, RSS |

**Backup:** git commit `b8dd716` on `main`. Cloudflare worker version `0fbe6b4e`.

---

### v0.7 — Truth & Voice ✅ *shipped 2026-05-13*

Facts Firewall, Truth Layer, Story Foundation, Voice Agent Phase 2.

| What | Detail |
|---|---|
| Slice 1 | Facts Firewall — facts + fact_lineage tables; source text destruction |
| Slice 1.5 | Truth Layer — grounding context, verifyArticle, needs_review |
| Slice 2 | Story-Centric Foundation — 130 stories in DB, state machine, 46 stories with transitions |
| Slice 3.9 | Voice Agent Phase 2 — 13 Turkish rules seeded; weekly DNA extraction; voice_patterns KV; style injection into all prompts |
| Admin | /admin/tools page; /admin/archive-legacy; next match self-caching; Sunday 02:00 cron |

---

### v0.6 — Source Intelligence ✅ *shipped 2026-05-05*

Sprint E source expansion + Sprint F source intelligence layer + Sprint G sentiment judge.

| What | Detail |
|---|---|
| Sprint E | Fotospor, Transfermarkt, Google News Transfer feeds; hourly cron; keywordFilter hotfix |
| Sprint F | F1 independence gate (press-only can't reach confirmed); F2 YouTube into unified pipeline; F3 source_configs DB + admin UI |
| Sprint G | Rival-pov −25 NVS cap integrated into scoreArticles |

---

### v0.5 — Content Rewrite ✅ *shipped 2026-05-02*

YouTube embed, single-source rewrite, multi-source synthesis, H2H widget.

| What | Detail |
|---|---|
| Sprint C | 5 YouTube channels; match video templates (T-VID-HLT, T-VID-GOL, etc.) |
| Sprint D | synthesizeArticle — single-source rewrite via proxy + RSS fallback |
| Sprint D2 | synthesizeStory — true multi-source synthesis (≥3 contributions) |
| Sprint B+ | tr.json Turkish translation; H2H widget on T02 articles |

---

### v0.4 — Match Intelligence ✅ *shipped 2026-05-01*

All 12 match templates + Sprint A event flashes + Sprint B widgets.

| What | Detail |
|---|---|
| Slice 3 Phase 3 | 12 match templates (T01–T13, T-XG, T-REF); match watcher */5 cron |
| Sprint A | Event flash templates: T-RED, T-VAR, T-OG, T-PEN, T-HT; seen_event_ids dedup |
| Sprint B | Standings + fixtures + team widgets on homepage; fixture widget on match articles |

---

### v0.3 — Pipeline Reliability ✅ *shipped 2026-04-17*

KV ceiling, Supabase dedup, age penalty, 7-band NVS, story dedup.

---

### v0.2 — Content Quality ✅ *shipped 2026-04-06*

12 RSS sources, NVS scoring, hero carousel, Transfer Radar, Render proxy.

---

### v0.1 — Live Pipeline ✅ *shipped March 2026*

Cloudflare Worker live, Claude API connected, KV cache, cron trigger, Supabase logging.

---

## Post-Launch Backlog (v1.1+)

Ordered by value/dependency. Do not start until v1.0 ships.

| # | Release | Scope | Est. |
|---|---------|-------|------|
| v1.1 | Squad Intelligence | squad_members DB, dynamic keywords, auto-rebuild on squad change. Also replaces hardcoded `CURRENT_PLAYER_NAMES` in video classifier. | 1–2 wks |
| v1.1b | API-Football Webhooks | Register webhook URL with API-Football; `POST /api-football-event` route receives goal/card/HT/FT payloads and fires templates immediately — replaces 5-min poll latency with ~2–4 min end-to-end. Keep cron watcher as fallback. | ½ day |
| v1.2 | Distribution | Distribute Agent, push notifications (NVS≥80), distribution_log | 1–2 wks |
| v1.3 | Visual Assets | Visual Asset Agent, IT6 templates, image pipeline. Includes placeholder pool for non-YouTube articles (12–15 CC0 images, hash-based assignment). Flash pool trigger: fires when `publish_mode=template_official` OR `NVS≥75` AND urgent title keywords (XS effort, design ready). **Blocked on lawyer consultation** for Wikimedia + AI-generated images. | 2–3 wks |
| v1.3 | Special Day Templates | Auto-firing date-aware homepage overlays for Turkish national days (30 Ağustos Zafer Bayramı, 19 Mayıs Atatürk'ü Anma, 23 Nisan Ulusal Egemenlik, 10 Kasım Atatürk'ü Anma, 24 Kasım Öğretmenler Günü) and Bayrams (Kurban Bayramı, Ramazan Bayramı — Hijri dates computed annually). Midnight TRT cron checks calendar date; fires a dedicated template with curated commemorative content. Implemented as a new pipeline trigger alongside match watcher; no manual intervention needed. | S |
| v1.4 | Editorial QA | Editorial QA Agent, guest submissions, Telegram author channel | 2–3 wks |
| v1.5 | Governance | CLO (FSEK rule engine), CFO full (per-agent cost attribution, weekly report) | 2 wks |
| v1.6 | Self-Learning | Engagement signals → scoring; source performance table; journalist accuracy tracker (I3/I4 — needs Twitter + YT transcript data first) | 3–4 wks |
| v1.7 | Multi-Dimensional Trust | Full trust model — 4 dimensions wired together (see below) | 3–4 wks |
| v2.0 | Multi-team | Pitchos onboarding for Team 2; cross-team learning propagation. **Decision: business priority + timing — Beşiktaş site success first.** | TBD |

### Decisions blocking Post-Launch items

| Decision | Blocks | Owner |
|---|---|---|
| Lawyer consultation (~€300–500, 1h) — Wikimedia Commons, personality rights, attribution | v1.3 Wikimedia photos + AI-generated images | Ali |
| Multi-team business priority + timing | v2.0 | Ali |
| Placeholder image sourcing (12–15 CC0 images from Unsplash/Pixabay) | v1.3 placeholder pool | Ali |

### Cleanup backlog *(do opportunistically, not blocking)*

- [ ] `fetchBeIN` stub returns empty array — delete or implement
- [ ] `fetchTwitterSources` early-returns — delete or restore when X API budget available (~$100/mo)
- [x] `fetched_at` semantic audit — 4 locations of `r.fetched_at || r.created_at` priority inversion fixed 2026-05-24 (worker lines 521, 1590, 3344, 4813 + `src/publisher.js` in-memory path); verify no further instances
- [x] Related articles widget at bottom of article pages — shipped 2026-05-28; same-section Supabase query, 3 cards, applies to all youtube_embed articles including curated
- [ ] Architectural: unify SPA (`index.html renderArticleView`) + worker server-rendered (`renderArticleHTML`) article templates — two independent templates currently; affects SEO (crawlers see server version, users see SPA). Identified 2026-05-26 by Pack 2 diagnostic. Not urgent, but a known long-term concern. *Partial mitigation: match stats widget whitelist now in sync across both paths (2026-05-27)*
- [ ] DECISIONS.md ongoing entries — keep adding entries for: KV bug fixes (done), classifier work (done), YouTube maxresdefault (done), Pack 2 visual fixes (done), grid root-cause (done)

---

### v1.7 — Multi-Dimensional Trust Engine *(deep work, post-launch)*

**Context:** Sprint I wires Dimension 1 (source tier). This release completes the full trust model. Do not start until Sprint I3/I4 (journalist tracking) has been running in production for at least 4–6 weeks — the data needs to accumulate before the signals are meaningful.

**The full rank formula:**
```
rank = nvs × decay × storyBoost × tierMultiplier × contentTypeMultiplier × journalistMultiplier
```

Currently live: `tierMultiplier` only. This release adds the remaining three.

**Dimension 2 — Content-type signal** (`contentTypeMultiplier`)

The NVS scorer already classifies every article as `fact | rumor | analysis`. This dimension surfaces that as a ranking multiplier:
- `fact` → 1.0× (neutral)
- `analysis` → 0.9× (opinion, not ground truth)
- `rumor` → 0.8× (unverified)

A T3 rumour from Fotomaç: 0.5 (tier) × 0.8 (rumour) = 0.4× final rank. A T1 confirmed fact: 1.8 (tier) × 1.0 = 1.8×. Implementation: single line in `rankAndEvict`, `content_type` already lives on the article.

**Dimension 3 — Corroboration score** (upgrading `storyBoost`)

Currently `storyBoost` rewards recency of contributions, not source independence. This dimension replaces it with a proper corroboration signal:
- Count distinct `source_family` values among contributions in the last 6h
- 1 family = no boost; 2 families = 1.2×; 3+ independent families = 1.5×
- This is "news storm" detection: the story is real because independent outlets are all reporting it simultaneously
- Requires `source_family` to be seeded (Sprint I1) and `story_contributions` to carry `source_family` (Sprint I2)

**Dimension 4 — Journalist accuracy** (`journalistMultiplier`)

Planned in Sprint I3/I4 but only surfaced in ranking here. Per-journalist accuracy score (0–100) derived from `journalist_claims` → `journalist_outcomes` feedback loop:
- Accuracy ≥ 80% → 1.3× multiplier
- Accuracy 60–79% → 1.0× (neutral)
- Accuracy < 60% → 0.7×
- Unknown journalist (no history yet) → 1.0× (neutral, not penalised)

Requires I3/I4 data to have accumulated. Do not build before 6 weeks of journalist tracking data exists.

**Pre-requisites before starting v1.7:**
- Sprint I2 complete (source_family flowing through story_contributions)
- Sprint I3/I4 complete and running ≥6 weeks in production
- At least 500 `journalist_claims` rows with resolved outcomes

**Estimated effort:** 3–4 weeks (Dimension 2 is S; Dimension 3 is M; Dimension 4 is L including data validation)

**Blocked items (not in any release until unblocked):**
- Twitter/X auto-post — $100/mo X API Basic. Unblocks when ad revenue covers it.
- bjk.com.tr content — CAPTCHA-protected. Unblocks with ScrapingBee ($49/mo) or residential proxy.
- Fixed egress IP for widget API caching — needs a cheap VPS. Unblocks at ~333 page loads/day.

---

## Freeze Procedure

Run these steps for every frozen release (v1.0+):

### 1. Git tag
```bash
git tag v1.0.0
git push origin v1.0.0
```

### 2. Note Cloudflare Worker version
After `npx wrangler deploy`, the output includes:
```
Current Version ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```
Record this in the release row above.

To roll back to a previous worker version:
```bash
npx wrangler rollback [version-id]
```

### 3. KV snapshot
```bash
npx wrangler kv bulk get --binding=PITCHOS_CACHE > backups/kv-v1.0.0.json
```
Store the JSON file in `backups/` (gitignored — it contains article content).

### 4. Supabase backup
Supabase Dashboard → Project → Settings → Backups → Download latest.
File: `backups/supabase-v1.0.0.sql.gz`

### 5. Verify rollback path
- Cloudflare: `wrangler rollback [version-id]` restores the worker instantly
- KV: `wrangler kv bulk put --binding=PITCHOS_CACHE backups/kv-v1.0.0.json` restores article cache
- Supabase: restore via pg_restore to a fresh Supabase project (last resort)

---

## Deferred (v2 backlog)

Full list in [SLICES.md v2 BACKLOG section](SLICES.md#v2-backlog--do-not-touch-until-v1-ships).

Summary: live match blog, polls, Transfer Radar board, Fan Pulse dashboard, WhatsApp channel, multi-language, IT1 licensed photography, WebSub real-time push, subscription tier.

**Persistent facts architecture** (deferred). Design when a cross-article use case earns the storage work — e.g., contradiction detection across sources, fact-density publish gates, fact-based freshness scoring. Until then, transient generation-time extraction (one Haiku call per rewrite) is sufficient. See DECISIONS.md 2026-05-18.
