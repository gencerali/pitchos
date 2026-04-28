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

*Add new entries above this line. Never delete. If a decision is reversed, write a new entry that references the superseded one.*
