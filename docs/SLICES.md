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
- [ ] Type classification in Qualify Agent (4th sub-judge)
- [ ] Per-type fact schemas (Transfer, Match, Injury)
- [ ] Per-type templates (3 templates)
- [ ] Intelligent match lifecycle (signal-driven open/close, no fixed window)
- [ ] Match story phase detection (pre/live/post)
- [ ] Sub-story spawning for non-routine match events
- [ ] Routine vs non-routine contribution classification
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

*Last updated: 2026-04-28 — update this every time you change anything above.*
