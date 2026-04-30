# SLICES.md — Kartalix v1 Build Tracker

**How to use this file**: Read the top section every time you sit down to work. Update statuses when you finish anything material. The PM agent reads this to surface drift.

**Statuses**: `not-started` · `in-progress` · `blocked` · `done`

---

## CURRENTLY IN FLIGHT

**Slice 3 — Story Type Narrow Set**
Started: 2026-04-29
Estimated: 3–4 weeks
Status: `in-progress`
Next action: Phase 0 — synthesis generation (fix 1-sentence article stubs, see NEXT.md)

---

## v0 — BUILD SCAFFOLD (do first, before any slice)

**Goal**: ship the PM agent and the four tracking files before starting Slice 1.

- [x] Four tracking files in `docs/` (SLICES, DECISIONS, NEXT, AUDIT, BUILD-DISCIPLINE)
- [x] Turkish IP lawyer consultation completed — feedback received, architecture adjusted
- [x] 48-hour legal compliance actions done (IT3 block, enrich cron disabled, hot-news delay, source attribution)
- [x] Telegram channel `@kartalix-pm` created (using bot DM for now, channel optional)
- [x] PM agent Cloudflare Worker scaffold — deployed 2026-04-28
- [x] Monday kickoff message wired
- [x] Friday close message wired
- [x] End-of-session logger wired
- [x] Drift detector daily cron wired
- [x] Pause command implemented

**Done when**: Monday morning, you receive a kickoff message in Telegram with your committed deliverables for the week.

---

## SLICE 1 — Facts Extraction Firewall

**Why first**: legal core. Every other piece depends on this being real. Without it, you're shipping copyright violations.

**Estimated**: 2–4 weeks (could stretch to 6 if evenings only)

**Deliverables**:
- [x] Fact schema for Transfer story type — entities/numbers/dates, defined in `src/firewall.js`
- [x] Firewall extraction logic — `extractFacts()` in `src/firewall.js`
- [x] Source text destruction post-extraction — `fact_lineage.destruction_confirmed_at`, source text never stored
- [x] `facts` and `fact_lineage` tables migration — `supabase-migration-facts.sql`
- [x] Wire firewall between Readability output and Produce Agent — `template_transfer` in `src/publisher.js`
- [ ] Golden fixture: `rashica_transfer_5_contribs` — deferred to Slice 2 (needs story matching)
- [x] Golden fixture: `fotomac_403` — 6/6 tests passing (2026-04-29)
- [x] Golden fixture: `firewall_destroys_source_text` — 9/9 tests passing
- [x] Lawyer consultation outcome reviewed and architecture adjusted ✅ done 2026-04-28
- [x] Hot News delay (15 min for P4) — implemented 2026-04-28
- [x] Source attribution mandatory on all derived articles — implemented 2026-04-28
- [x] All scraped images stripped — image_url: '' for all sources until Slice 5 IT-tier ships (2026-04-29)
- [x] Remove Cloudflare Access gate from `/haber/*` — done 2026-04-29, site publicly accessible

**Done when**: a P4 article goes through the pipeline and the published Kartalix article is provably non-derivative. You can show this to a lawyer. Article pages are publicly accessible.

**Status**: `done` — completed 2026-04-29

**Blockers**:
- ~~Turkish IP lawyer consultation pending~~ ✅ resolved 2026-04-28

---

## SLICE 2 — Story-Centric Foundation

**Why second**: replaces article-centric thinking with story-centric data model. Slices 3+ depend on this.

**Estimated**: 2–3 weeks

**Deliverables**:

**Phase 1 — Volume first (do before story model, story matching needs input)**
- [x] Audit fetch-log: articles per source per cron run — baseline ~9, now ~38 unique/run (2026-04-29)
- [x] Add Duhuliye RSS feed — reclassified as P4 press, 88 articles/run (2026-04-29)
- [x] Add TRT Haber, Hürriyet, Sabah Spor, Habertürk Spor — all active (2026-04-29)
- [x] Remove dead feeds: Milliyet Spor, Sporx, Ajansspor, Sky Sports, Transfermarkt — URLs unconfirmed/broken
- [ ] Confirm bjk.com.tr official feed URL — currently returning 0, URL unverified
- [ ] Confirm Fanatik RSS feed URL — currently returning 0, URL unverified
- [ ] Find working URLs for Milliyet Spor, Sporx, Ajansspor if available
- [x] Re-audit fetch-log after additions — ~38 unique/run confirmed (2026-04-29)

**Phase 2 — Story model**
- [x] `stories`, `story_contributions`, `story_state_transitions` tables + migration (2026-04-29)
- [x] Story matching: entity fingerprint (Stage 1) + Claude Haiku judge (Stage 2) (2026-04-29)
- [x] State machine: emerging → developing → confirmed → active (cascade in one step) (2026-04-29)
- [x] Generation trigger: fires on transition to `confirmed`, saves to content_items (2026-04-29)
- [x] `getOpenStories` fetched once per cron run, passed through to avoid N×Supabase reads (2026-04-29)
- [x] Story matching capped at 5 articles/run — cron every 30min covers full volume (2026-04-29)
- [x] `Workers Paid` plan ($5/mo) + `subrequests = 1000` in wrangler.toml (2026-04-29)
- [x] Confidence scoring math: DELTA {initial:30, confirming:20, updating:10, contradicting:-10} (2026-04-29)
- [x] OFFICIAL_INITIAL_DELTA = 60 — bjk.com.tr crosses generation threshold on first contribution (2026-04-29)
- [x] Archival logic: `archiveStaleStories()` implemented (sporting:3d, financial:30d, other:7d) (2026-04-29)
- [x] Golden fixture: `story_matching_entity_overlap` — 10/10 tests passing (2026-04-29)
- [x] Wire `archiveStaleStories` to a daily cron trigger — 04:00 UTC, event.cron dispatch (2026-04-29)
- [x] `debunked` state — contradicting contribution driving confidence < 15 closes story as false (2026-04-29)
- [ ] Sub-story lineage (parent_story_id, ancestry_path) — deferred, not yet needed
- [x] Golden fixture: `story_state_transitions` — 12/12 tests passing (2026-04-29)
- [x] Golden fixture: `confidence_scoring` — 11/11 tests passing (2026-04-29)
- [x] Golden fixture: `rashica_transfer_5_contribs` — 10/10 tests passing, Slice 2 done-when criterion met (2026-04-29)

**Done when**: 5 contributions about Rashica produce one Kartalix article that evolves, not five articles.

---

## SLICE 3 — Story Type Narrow Set

**Why third**: ships the 3-type taxonomy (Match-extended, Transfer, Injury). Generation triggers, templates, and HITL all branch from type.

**Estimated**: 3–4 weeks

**Deliverables**:

**Phase 0 — Synthesis generation (prerequisite, fixes 1-sentence stubs)**
- [x] Synthesis generation in Produce Agent: fetch full source text at generation time, pass ephemerally to Claude Sonnet, write 300–500 word original Kartalix article (2026-04-29)
- [x] Article body: original prose in Kartalix voice, no "according to X" language
- [x] Source text discarded immediately after generation (never written to DB or KV)

**Phase 1 — Structured match data (stats API)**
- [x] `src/api-football.js` wrapper — getNextFixture, getLiveFixture, getFixture, getH2H, getStandings, getBJKStanding, getFixturePlayers (2026-04-29)
- [x] `getNextFixture()` replaces hardcoded NEXT_MATCH config in template pipeline (2026-04-29)
- [x] Verified: BJK team ID = 549, Süper Lig ID = 203 (2026-04-29)
- ~~[ ] `API_FOOTBALL_KEY` wired as Workers secret~~ — superseded by Track A (2026-04-30)
- ~~[x] Upgraded API-Football to Starter plan~~ — superseded by Track A (2026-04-30)

**Track A — Primary stats provider: SoccerData API ($14/mo)**

_Decision_: Switch from API-Football to SoccerData API. Price comparable; 25,000 req/day vs ~500 on Starter, weather endpoint for T01, sidelined/injured players for T07, player transfers feed for Transfer story enrichment. Supersedes DECISIONS.md 2026-04-29 — match template data source architecture (API-Football entry). A new DECISIONS entry is required before templates are built.

**Acceptance criteria — all five NFRs must be verified before Phase 3 template code begins:**
- [ ] NFR1 — Request capacity: provider delivers ≥25,000 API requests/day (locked: 25,000/day per soccerdataapi.com plan as of 2026-04-30)
- [ ] NFR2 — League coverage: Süper Lig (Turkish top-flight) confirmed in covered league set — blocks all Phase 3 templates if false
- [ ] NFR3 — Player ratings: post-match per-player rating/stats endpoint confirmed — blocks T13 MOTM if false; fallback: retain API-Football for ratings only (dual-provider)
- [ ] NFR4 — Weather: match venue weather forecast endpoint confirmed — required for T01 Match Preview
- [ ] NFR5 — Injury/suspension data: sidelined and suspended players endpoint confirmed — required for T07 Injury Report

- [ ] Rewrite `src/api-football.js` as `src/stats-api.js` with SoccerData endpoints (after all NFRs pass)
- [ ] `STATS_API_KEY` wired as Workers secret (`npx wrangler secret put STATS_API_KEY`)
- [ ] Wire weather endpoint → T01 Match Preview context
- [ ] Wire sidelined/injured players endpoint → T07 Injury Report
- [ ] Wire player transfers endpoint → Transfer story entity enrichment
- [ ] Venue coords: verify if SoccerData provides; otherwise keep fallback coords map in worker

**Phase 2 — Story type classification + match lifecycle**
- [ ] Type classification in Qualify Agent (4th sub-judge)
- [ ] Per-type fact schemas (Transfer, Match, Injury)
- [ ] Intelligent match lifecycle (signal-driven open/close, no fixed window)
- [ ] Match story phase detection (pre/live/post) stored on story entity
- [ ] Sub-story spawning for non-routine match events
- [ ] Routine vs non-routine contribution classification

**Phase 3 — Match templates (focus for Slice 3)**
- [ ] T01 Match Preview (pre-match, time-based, stats API + weather)
- [ ] T02 H2H History (pre-match, stats API)
- [ ] T05 Lineup Announcement (pre-match, stats API lineups)
- [ ] T11 Result Flash (post-match, stats API result)
- [ ] T12 Match Report (post-match, RSS press synthesis)
- [ ] T07 Injury & Suspension Report (pre-match, stats API sidelined endpoint + RSS)
- [ ] T08 Press Conference Quotes (pre/post, RSS-triggered)
- [ ] YouTube RSS feed for G6 video templates wired (channel ID confirmed)

**Phase 4 — Golden fixtures**
- [ ] Golden fixture: `match_lifecycle_signal_driven`
- [ ] Golden fixture: `juventus_false_positive` (siyah-beyaz case)
- [ ] Golden fixture: `transfer_state_progression`
- [ ] Golden fixture: `synthesis_generation_full_article` (verifies 300+ word output, no paraphrase markers)

**Transfer and Injury templates**: scoped for Slice 3 fact schemas, templates deferred to after match template set is stable.

**Done when**: a match story runs end-to-end — fixture detected, Preview article published pre-match, Result Flash published post-match, both as full-length original Kartalix articles.

---

## SLICE 4 — Operational Control (HITL + Telegram)

**Why fourth**: gets you out of the loop on routine, in the loop on sensitive. Without this, you're either drowning in alerts or missing critical issues.

**Estimated**: 2 weeks

**Deliverables**:
- [ ] Single `@kartalix_bot` setup
- [ ] Three operational channels: `@kartalix-ops`, `@kartalix-alerts`, `@kartalix-decisions`
- [ ] Inline keyboard buttons everywhere
- [ ] HITL Gate C only (financial, disciplinary, injury severity, P5-only transfers)
- [ ] Auto-hold on 60min SLA timeout
- [ ] Quiet hours (23:00–07:00 Europe/Istanbul)
- [ ] Daily digest at 09:00
- [ ] Held stories surface in morning digest
- [ ] Source admin UI — add/edit/disable sources per team without touching code (moved from v2 backlog)

**Done when**: you go a week without manually checking the system, and it just works.

---

## SLICE 5 — Visual Asset Agent (IT2 + IT6)

**Why fifth**: every published article needs a defensible image. Without this, the platform looks unfinished. With it, the brand starts to feel real.

**Estimated**: 2–3 weeks

**Deliverables**:
- [ ] Visual Asset Agent
- [ ] IT6 templates: match result card, transfer status card, generic story card
- [ ] IT2 caching for BJK official media
- [ ] IT2 social embeds (iframe pattern)
- [ ] IT3 explicit block at firewall
- [ ] IT5 limited use (abstract only, no real people)
- [ ] `images` and `image_templates` tables
- [ ] Golden fixture: `visual_tier_selection`
- [ ] Golden fixture: `it3_blocked`

**Done when**: 100 articles published, 100 images attached, 0 copyright concerns.

**Deferred to v2**: IT1 (AA subscription)

---

## SLICE 6 — Editorial QA + Author Flow

**Why sixth**: enables guest authors with two-stage approval. Lower priority than legal/visual core, but unlocks editorial scaling.

**Estimated**: 2–3 weeks

**Deliverables**:
- [ ] Editorial QA Agent
- [ ] `authors` and `guest_submissions` tables
- [ ] `@kartalix-editorial-author` Telegram channel
- [ ] Two-stage approval: QA → author review → author approve → publisher (you) review
- [ ] "Request changes" loop
- [ ] Author identity via invite-token
- [ ] Plagiarism overlap detection (P4 source comparison)
- [ ] Sensitive content flagging
- [ ] Image rights check on guest submissions

**Done when**: you publish your first guest article via Telegram approval.

---

## SLICE 7 — Governance Layer (CLO + CFO)

**Why seventh**: top-down oversight. Less urgent than core pipeline, but critical for sustainable operation.

**Estimated**: 2 weeks

**Deliverables**:
- [ ] CLO synchronous mode: FSEK rule engine, image-rights checker, quote-length checker, IT3-leak detector
- [ ] CFO synchronous mode: cost ledger, budget caps, anomaly alerts
- [ ] Per-`site_id` legal profiles
- [ ] Per-agent and per-source cost attribution
- [ ] Weekly reports to `@kartalix-ops`
- [ ] Hard-stop on runaway token spend
- [ ] Golden fixture: `clo_blocks_quote_overflow`
- [ ] Golden fixture: `cfo_alerts_on_spike`

**Done when**: you have a weekly view of legal posture and unit economics.

**Deferred to v2**: async LLM audit modes for both

---

## SLICE 8 — Self-Learning Loops

**Why last**: the system gets sharper without manual tuning. Lowest urgency because the system can run without it; highest leverage long-term.

**Estimated**: 3 weeks

**Deliverables**:
- [ ] `agent_signals`, `agent_learnings` tables
- [ ] Engage → Qualify (relevance threshold tuning)
- [ ] Engage → Produce (template priority weights)
- [ ] Distribute → Intake (source trust adjustment)
- [ ] Trust score modes (auto / locked / hybrid with bands)
- [ ] Human-override learning signals (highest weight)
- [ ] Type-aware learning (per story type baselines)

**Done when**: a known-bad source's trust score drops over time without you touching it.

---

## v2 BACKLOG — DO NOT TOUCH UNTIL v1 SHIPS

**This is the "no" list.** When new ideas arrive during v1, they go here, not into v1 scope.

- IT1 licensed photography (AA subscription integration)
- Async LLM audit modes for CLO/CFO
- Source addition admin UI (currently Supabase dashboard manual)
- Story type expansion: Disciplinary, Financial, Management, Commentary, Editorial
- Cultural/fan story type
- Infrastructure/stadium/academy/women's team coverage
- AI-generated images (IT5) per-story integration
- QIA (Quality Intelligence Agent) full-site scanner
- Pitchos onboarding for second club (Juventus)
- Pitchos onboarding admin UI
- Web-based author submission form
- Web admin dashboard
- Multi-language content (English, Italian)

---

## SLICES SUMMARY TABLE

| # | Slice | Estimate | Status |
|---|-------|----------|--------|
| 0 | Build Scaffold + PM | 1–2 wks | done |
| 1 | Facts Firewall | 2–4 wks | done |
| 2 | Story-Centric Foundation | 2–3 wks | done |
| 3 | Story Types Narrow Set | 3–4 wks | in-progress |
| 4 | Operational Control | 2 wks | not-started |
| 5 | Visual Asset Agent | 2–3 wks | not-started |
| 6 | Editorial QA + Authors | 2–3 wks | not-started |
| 7 | Governance Layer | 2 wks | not-started |
| 8 | Self-Learning Loops | 3 wks | not-started |

**Total v1 estimate**: 19–26 weeks of focused work.
**Realistic calendar with COO duties**: 6–9 months.

---

*Last updated: 2026-04-29 (session 3)*
