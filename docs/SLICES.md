# SLICES.md — Kartalix v1 Build Tracker

**How to use this file**: Read the top section every time you sit down to work. Update statuses when you finish anything material. The PM agent reads this to surface drift.

**Statuses**: `not-started` · `in-progress` · `blocked` · `done`

---

## CURRENTLY IN FLIGHT

**Slice 0 — Build Scaffold + PM Agent**
Started: 2026-04-28
Estimated: 1–2 weeks
Status: `in-progress`

---

## v0 — BUILD SCAFFOLD (do first, before any slice)

**Goal**: ship the PM agent and the four tracking files before starting Slice 1.

- [x] Four tracking files in `docs/` (SLICES, DECISIONS, NEXT, AUDIT, BUILD-DISCIPLINE)
- [x] Turkish IP lawyer consultation completed — feedback received, architecture adjusted
- [x] 48-hour legal compliance actions done (IT3 block, enrich cron disabled, hot-news delay, source attribution)
- [ ] Telegram channel `@kartalix-pm` created
- [ ] PM agent Cloudflare Worker scaffold
- [ ] Monday kickoff message wired
- [ ] Friday close message wired
- [ ] End-of-session logger wired
- [ ] Drift detector daily cron wired
- [ ] Pause command implemented

**Done when**: Monday morning, you receive a kickoff message in Telegram with your committed deliverables for the week.

---

## SLICE 1 — Facts Extraction Firewall

**Why first**: legal core. Every other piece depends on this being real. Without it, you're shipping copyright violations.

**Estimated**: 2–4 weeks (could stretch to 6 if evenings only)

**Deliverables**:
- [ ] Fact schema for Transfer story type (start narrow)
- [ ] Firewall extraction logic
- [ ] Source text destruction post-extraction (with audit log)
- [ ] `facts` and `fact_lineage` tables migration
- [ ] Wire firewall between Readability output and Produce Agent
- [ ] Golden fixture: `rashica_transfer_5_contribs`
- [ ] Golden fixture: `fotomac_403`
- [ ] Golden fixture: `firewall_destroys_source_text` (legal core test)
- [ ] Lawyer consultation outcome reviewed and architecture adjusted if needed ✅ done 2026-04-28
- [ ] Hot News delay (15 min for P4) — implemented 2026-04-28, golden fixture still needed
- [ ] Source attribution mandatory on all derived articles — implemented 2026-04-28
- [ ] Remove Cloudflare Access gate from `/haber/*` (open article pages to public when firewall ships)

**Done when**: a P4 article goes through the pipeline and the published Kartalix article is provably non-derivative. You can show this to a lawyer. Article pages are publicly accessible.

**Blockers**:
- ~~Turkish IP lawyer consultation pending~~ ✅ resolved 2026-04-28

---

## SLICE 2 — Story-Centric Foundation

**Why second**: replaces article-centric thinking with story-centric data model. Slices 3+ depend on this.

**Estimated**: 2–3 weeks

**Deliverables**:
- [ ] `stories`, `story_contributions`, `story_state_transitions` tables
- [ ] Story matching algorithm (entity overlap + event type + temporal + semantic)
- [ ] Story state machine (emerging → developing → confirmed → active → resolved → archived → debunked)
- [ ] Generation triggers tied to state transitions
- [ ] Sub-story lineage (parent_story_id, ancestry_path)
- [ ] Confidence scoring math
- [ ] Golden fixture: `story_matching_entity_overlap`
- [ ] Golden fixture: `story_state_transitions`
- [ ] Golden fixture: `confidence_scoring`

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

**Track A — Stats provider procurement results (2026-04-30)**

API-Football Pro ($19/mo) verified against all five NFRs. SoccerData not yet verified.

| NFR | Requirement | API-Football Pro | Status |
|-----|-------------|-----------------|--------|
| NFR1 | Request capacity | 7,500/day (locked NFR was 25,000 for SoccerData) | ⚠️ see note |
| NFR2 | Süper Lig coverage | Confirmed — ID 203, all 12 coverage flags true | ✅ |
| NFR3 | Player ratings | Confirmed — ratings in every fixture player record | ✅ |
| NFR4 | Weather endpoint | Absent — use Open-Meteo (free, no auth, Workers-compatible) | ⚠️ workaround |
| NFR5 | Injury/suspension data | Confirmed — injuries flag true for Süper Lig 2025 | ✅ |

NFR1 note: 7,500/day is 25× estimated peak production volume (~300 calls/day on match days). The 25,000 figure was locked to SoccerData's plan, not to an actual business need. Recommend revising NFR1 to ≥2,000/day and accepting API-Football Pro as the provider. **User decision required before PR #1 can merge or be closed.**

NFR4 note: Open-Meteo (`api.open-meteo.com`) is free, no key, covers any lat/long, works in Cloudflare Workers. One additional fetch call per T01 Preview. Venue coords map already planned as fallback.

- [ ] **Provider decision**: stay on API-Football Pro (close PR #1) OR proceed with SoccerData verification
- [ ] `API_FOOTBALL_KEY` wired as Workers secret (`npx wrangler secret put API_FOOTBALL_KEY`) — rotate key first (exposed in session 4)
- [ ] Add Open-Meteo call to T01 Match Preview for weather context
- [ ] Venue coords map: add lat/long for BJK home ground + common away grounds

**Phase 2 — Story type classification + match lifecycle**
- [x] Type classification in Qualify Agent: `classifyStoryType()` in firewall.js — Haiku call, 80 tokens (2026-05-01)
- [x] Per-type fact schemas: Transfer, Injury, Disciplinary, Contract, Generic (2026-05-01)
- [x] `extractFactsForStory()` — two-step (classify → schema-appropriate extract) (2026-05-01)
- [x] match_result + squad filtered from story system via `SKIP_STORY_TYPES` (2026-05-01)
- [x] Story-matcher judge includes pre-classified type hint (2026-05-01)
- [ ] Intelligent match lifecycle (signal-driven open/close, no fixed window) — deferred
- [ ] Match story phase detection (pre/live/post) stored on story entity — deferred
- [ ] Sub-story spawning for non-routine match events — deferred

**Phase 3 — Match templates** ✅ COMPLETE

_Template set revised 2026-04-30 after API-Football Pro coverage verification. All 12 templates shipped 2026-05-01._

Core pre-match (all API-driven):
- [x] T01 Match Preview (fixture + H2H + standings + weather) (2026-04-30)
- [x] T02 H2H History (2026-05-01)
- [x] T03 Form Guide (2026-05-01)
- [x] T05 Match Day Card (API injuries, not RSS) (2026-05-01)
- [x] T07 Injury & Suspension Report (fixture-scoped API) (2026-05-01)
- [x] T09 Confirmed Lineup (API `/fixtures/lineups`, returns null until submitted) (2026-05-01)
- [x] T-REF Referee Profile (API last-10 fixtures, 24–48h window) (2026-05-01)

Live + post-match:
- [x] T10 Goal Flash (live, BJK goal detected from score delta + events API) (2026-04-30)
- [x] T11 Result Flash (FT detection) (2026-04-30)
- [x] T12 Match Report (xG + stats + ratings) (2026-05-01)
- [x] T13 Man of the Match (player ratings from API) (2026-05-01)
- [x] T-XG xG Delta (fires when |goals − xG| > 1.2) (2026-05-01)

Infrastructure:
- [x] Match Watcher: `*/5 * * * *` cron, active 3h before to 2h after kickoff (2026-05-01)
- [x] `/watcher` debug endpoint (2026-05-01)
- [x] `/admin/kv-remove` — remove test/stale articles from production KV by template_id or slug (2026-05-01)
- [x] Force endpoints: `/force-t09`, `/force-tref`, `/force-txgdelta` (2026-05-01)

Parked — data gap confirmed:
- ~~Shot map visual~~ — x/y coordinates absent at all levels; StatsBomb required; v2
- ~~Per-player shot breakdown~~ — shots.total null per player; not viable
- T08 Press Conference Quotes — RSS-only pipeline (no structured data source)

**Phase 3.5 — In-match event flash templates (Sprint A)** ← NEXT SPRINT

_All events available from single endpoint: `/fixtures/events?fixture={id}`. Watcher already polls this for goals. Extend to other event types._

- [ ] T-RED Red Card Flash — `type:"Card", detail:"Red Card"` or `"Second Yellow Card"` — high fan engagement, tactical context ("10 kişi kaldı")
- [ ] T-VAR VAR Decision Flash — `type:"Var"` — highest controversy events, fans demand instant reaction
- [ ] T-OG Own Goal Alert — `type:"Goal", detail:"Own Goal"` — distinct from goal flash (opponent own goal = good news)
- [ ] T-PEN Missed Penalty — `type:"Chance Missed"` on a penalty minute — emotional flash
- [ ] T-HT Halftime Report — status `"HT"` detected, mini first-half summary (stats from `/fixtures/statistics`)

Implementation notes:
- Extend `match:BJK:live` KV state to include `last_event_hash` — fingerprint of all events seen so far
- On each watcher tick, compare event list hash vs stored; if changed, classify new events and fire appropriate template
- All event types polled with ONE additional API call to `/fixtures/events` per tick (already done for goals via `fetchGoalEvents`)

**Phase 3.6 — Widgets (Sprint B)** ← AFTER SPRINT A

_Zero backend changes. Pure frontend embeds via api-sports.io widget JS. Host a Turkish `tr.json` translation file._

Widgets available:
1. `fixture` — live match score + events + stats + lineups (best for match articles)
2. `standings` — league table (always-on in sidebar/home)
3. `h2h` — head-to-head history (embed on T02 articles)
4. `league` — schedule by round + standings (good for season overview page)
5. `team` — squad + stats (good for About Beşiktaş page)
6. `game` — expandable match card (lightweight inline embed)

Recommended widgets for Kartalix (priority order):
1. **`standings`** — sidebar/home page, always relevant, shows BJK table position in real time
2. **`fixture`** — inject into match-day article pages (T01, T05, T09, T10, T11, T12), shows live score
3. **`h2h`** — auto-inject on T02 H2H articles
4. **`game`** — lightweight match card in RSS feed / article previews

Turkish localization:
- Host `tr.json` at `https://app.kartalix.com/widgets/tr.json`
- Use `data-custom-lang="..."` attribute on all widgets
- Override keys for: match statuses, player positions, tab labels, time labels

Deliverables:
- [ ] `tr.json` Turkish translation file (covering fixture, standings, h2h, team widgets)
- [ ] `/widgets/tr.json` endpoint in worker (static JSON response)
- [ ] Standings widget on home page and article sidebar
- [ ] Fixture widget auto-injected on match-day articles (T01, T05, T09–T13 by template_id)
- [ ] H2H widget on T02 articles
- [ ] DECISION: use `data-key` = same API_FOOTBALL_KEY or obtain a separate widgets key

**Phase 4 — Golden fixtures**
>>>>>>> Stashed changes
- [ ] Golden fixture: `match_lifecycle_signal_driven`
- [ ] Golden fixture: `juventus_false_positive` (siyah-beyaz case)
- [ ] Golden fixture: `transfer_state_progression`

**Done when**: each of the three types runs end-to-end with appropriate templates and triggers.

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

## SLICE 3.7 — Cost Guard (lightweight, do before Sprint A)

**Why now**: before adding more Claude calls (Sprint A event flash templates, widgets), we need a hard safety net. A runaway cron or a new template looping unexpectedly should not silently burn $50. This is the minimum viable CFO — no Telegram, no per-agent attribution, just a spend accumulator and a kill switch.

**Estimated**: 2–3 hours

**How it works**:
- Every `callClaude` call already returns `usage.input_tokens` + `usage.output_tokens` + model name
- `addUsagePhase` already accumulates these into `stats` per cron run
- `logFetch` already writes them to `fetch_logs` in Supabase
- Missing piece: a **running monthly total in KV** that every Claude call checks against a cap

**Deliverables**:
- [ ] KV key `cost:YYYY-MM` — running USD total for current month, updated after every cron run
- [ ] Hard cap check at start of `runAllSites` and `matchWatcher` — if monthly spend > `MONTHLY_CLAUDE_CAP` (default $8), skip all Claude calls and log `COST GUARD: monthly cap reached`
- [ ] `addCost(env, usd)` helper in utils.js — atomic KV increment (read → add → write)
- [ ] `/admin/cost` endpoint — show current month spend, daily breakdown from fetch_logs, and cap status
- [ ] Cap configurable via Workers env var `MONTHLY_CLAUDE_CAP` (set in wrangler.toml vars, override via Cloudflare dashboard)
- [ ] Warning log at 80% of cap: `COST GUARD: 80% of monthly cap used ($X of $Y)`

**Done when**: you can set a $10 Claude budget and trust the system will stop before exceeding it.

**Full CFO** (per-agent attribution, Telegram alerts, weekly reports) stays in Slice 7.

---

## SLICE 7 — Governance Layer (CLO + CFO)

**Why seventh**: top-down oversight. Less urgent than core pipeline, but critical for sustainable operation.

**Estimated**: 2 weeks

**Deliverables**:
- [ ] CLO synchronous mode: FSEK rule engine, image-rights checker, quote-length checker, IT3-leak detector
- [ ] CFO full mode: per-agent and per-source cost attribution, Telegram weekly reports
- [ ] Per-`site_id` legal profiles
- [ ] Weekly cost + legal report to `@kartalix-ops`
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
| 0 | Build Scaffold + PM | 1–2 wks | not-started |
| 1 | Facts Firewall | 2–4 wks | not-started |
| 2 | Story-Centric Foundation | 2–3 wks | not-started |
| 3 | Story Types Narrow Set | 3–4 wks | not-started |
| 4 | Operational Control | 2 wks | not-started |
| 5 | Visual Asset Agent | 2–3 wks | not-started |
| 6 | Editorial QA + Authors | 2–3 wks | not-started |
| 7 | Governance Layer | 2 wks | not-started |
| 8 | Self-Learning Loops | 3 wks | not-started |

**Total v1 estimate**: 19–26 weeks of focused work.
**Realistic calendar with COO duties**: 6–9 months.

---

*Last updated: 2026-05-01 (session 7 — Phase 3 complete, Phase 3.5/3.6 planned)*
