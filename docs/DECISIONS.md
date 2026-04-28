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

### 2026-04-28 — Source attribution is mandatory on all derived articles

**Decision**: Every Kartalix article derived from P4 source material must display a visible "Kaynak: [Outlet name]" attribution with a hyperlink to the original article. This applies to the article page, the KV cache shape, and the Supabase row.

**Alternatives considered**:
- Attribution optional / editorial discretion — rejected on legal advice
- Attribution without hyperlink — rejected; hyperlink is what builds the Good Faith defense under Turkish Commercial Code

**Why this one**: Turkish IP lawyer explicitly recommended this as a Good Faith defense. It also serves editorial transparency.

**What would change our mind**: Nothing — this is now a legal requirement, not a design preference.

**Related**: SLICES.md Slice 1, article page template in worker-fetch-agent.js

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

*Add new entries above this line. Never delete. If a decision is reversed, write a new entry that references the superseded one.*
