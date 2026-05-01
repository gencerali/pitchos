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

*Add new entries above this line. Never delete. If a decision is reversed, write a new entry that references the superseded one.*
