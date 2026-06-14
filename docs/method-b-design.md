# Method B — Fact-Based News Generator (design)

**Status:** design / pre-build. Nothing here is shipped yet.
**Owner:** Ali. **Date:** 2026-06-05.
**Companion diagram:** `./method-b-model.svg`

---

## 1. Problem & goal

Today's pipeline is an **RSS-rewriter**: it scores an article from its headline+blurb,
fetches that one source, and rewrites it. Two structural consequences:

- **NVS reflects the blurb, not the substance** — scoring runs *before* fact extraction
  (`scoreArticles` at `worker-fetch-agent.js:5229`, facts extracted later in synthesis).
- **The DB fills with stories but few become articles** — the story system exists
  (`src/story-matcher.js`, `src/firewall.js`) but is a throttled side-channel: P4-only,
  `MAX_FACTS_EXTRACTS = 5`/run, fires only at ≥3 contributions, one synthesis per story
  **per day** (`synth:{id}:{date}`).

**Goal:** reframe the product as a **fact-based news generator** — ingest from *any*
source as structured facts, correlate them into topics, and synthesize **impactful,
correctly-timed** original news. Build it **in parallel** (a shadow worker) and **swap
seamlessly** when mature.

---

## 2. The model

```
FACT  →  ROUTER  →  { EVENT (fire now) | TOPIC }  →  CLAIM-TRACK(s)  →  PHASE  →  ARTICLE(s)
atomic   news_mode?   one-shot vs accretive          current truth     delta     1..N
```

See `./method-b-model.svg` for the visual (meta-flow + 3 Turkish branch topologies +
national-newspaper mapping).

### 2.1 Layers (why "story" was over-coupled)

The current `stories` table does **three jobs at once** — correlation, confidence, and
publication — which is the root cause of "many stories, few articles." Method B splits them:

| Layer | Job | Today |
|---|---|---|
| **Fact** | one claim, one source, one timestamp, one trust tier | `facts` table ✅ reused |
| **Topic** | durable correlation anchor (entities) | `stories` — the *correct* part |
| **Claim-track** | current best-known value per attribute `{status, fee, dates, confidence}` | **new** (was a single story-level confidence) |
| **Phase** | a newsworthy *delta* → licenses article(s) | **new** (was `synth:{id}:{date}`) |
| **Article** | synthesis tied to (topic, phase) | `content_items` ✅ reused |

### 2.2 The EVENT / ACCRETIVE router

Not all news is accretive. At ingest, classify each fact's **news_mode**:

- **EVENT / punctual** (goal, red card, official club announcement): a single high-trust
  source = **publish immediately** (template or fast synthesis). Generalizes today's
  `SKIP_STORY_TYPES` + template path — but events become **seeds**, not dead-ends:
  a controversy born inside a match can `branch_of` the match topic.
- **ACCRETIVE / developing** (rumors, reports): accumulate, publish on a phase delta.

### 2.3 Topic graph (trunk-default + 3 edges)

Stress-testing against 10 Turkish archetypes (derbi, şike, transfer, hoca krizi, kongre,
mali/FFP, sakatlık, çok-spor…) showed a linear model breaks on real branching. Reality is
a **DAG — mostly trunks**, with three sanctioned edges:

- **`child_of`** — an ordinary sub-beat of a topic.
- **`branch_of`** — a substory that **detaches and changes type** and may outlive its
  parent (derbi VAR call → TFF/şike soruşturması). Branches are **first-class topics**,
  not nested rows, so they can become front-page in their own right.
- **`sequel_of`** — a topic that **begets a successor** (hoca kovuldu → yeni hoca arayışı).
- **Parallel claim-tracks** — one topic can hold *multiple* named tracks
  (`{"to_BJK": {...}, "to_FB": {...}}`) for competing narratives; delta is computed
  per-track so contradictions don't overwrite each other (no thrash).
- **Multi-parent** — `parent_topic_ids[]` array (injury ∈ player ∩ match). A column, not
  a graph engine.
- **Fan-out** — a single phase → **1..N articles**, fanned by entity (a verdict →
  per-club pieces), deduped `synth:{topic}:{phase}:{entity}`.

**Build the cheap trunk path first; engage branch/track machinery only for the minority
that needs it.**

---

## 3. Schema (additive — legacy tables untouched)

> Illustrative DDL. **Additive only**: no destructive changes to `content_items`,
> `stories`, or `facts`, so legacy keeps running and rollback needs no DB downgrade.

```sql
-- Durable correlation anchor (supersedes the publication/confidence roles of `stories`)
create table topics (
  id uuid primary key default gen_random_uuid(),
  site_id int not null,
  story_type text not null,             -- transfer/injury/disciplinary/contract/institutional/match/other
  news_mode text not null,              -- 'event' | 'accretive'
  entities jsonb not null default '{}',
  importance int not null default 50,   -- editorial weight → publish threshold & ranking
  parent_topic_ids uuid[] default '{}', -- multi-parent DAG
  claim_tracks jsonb not null default '{}', -- { track_key: {status, fee, dates, confidence} }
  state text not null default 'open',   -- open | dormant | closed
  created_at timestamptz default now(),
  last_event_at timestamptz default now()
);

-- Typed edges between topics (the graph)
create table topic_edges (
  id uuid primary key default gen_random_uuid(),
  from_topic_id uuid not null references topics(id),
  to_topic_id   uuid not null references topics(id),
  edge_type text not null,              -- 'child_of' | 'branch_of' | 'sequel_of'
  created_at timestamptz default now()
);

-- A newsworthy delta on a topic/track → licenses article(s)
create table phases (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references topics(id),
  track_key text,                       -- which claim-track moved (null = whole topic)
  seq int not null,                     -- phase number within topic
  trigger text not null,                -- 'initial' | 'update' | 'contradiction' | 'event'
  delta jsonb,                          -- what changed
  opened_by_fact_id uuid,               -- references facts(id)
  opened_at timestamptz default now()
);

-- Articles already exist; add linkage + the pipeline cost/serve tag
alter table content_items add column if not exists topic_id  uuid;
alter table content_items add column if not exists phase_id  uuid;
alter table content_items add column if not exists pipeline  text default 'legacy'; -- legacy | methodb
```

---

## 4. Article-creation logic

```
fact lands
  └─ router: news_mode?
       EVENT + trust ≥ official → mint phase, fire article now (template or fast synth)
       ACCRETIVE                → correlate to topic (entity fingerprint + judge)
                                  update the matching claim-track (trust-weighted)
                                  delta = diff(fact, prior track state)   ← see §6 cost gate
                                    material + confidence ≥ threshold → new phase → synthesize
                                                                        (chronological:
                                                                         lede = the delta,
                                                                         body = prior facts)
                                    confirmation only                 → bump confidence, no article
  └─ dedup key = synth:{topic}:{phase}:{entity}     (per development, not per day)
```

Synthesis writes **from stored structured facts** (compact), not by re-fetching 10K chars
of source text — this is both a quality and a **cost** lever (§6).

---

## 5. Worker isolation — reuse vs isolation are orthogonal

Method B runs in a **separate Cloudflare Worker** (`pitchos-story-agent`,
`wrangler-story.toml`, `main = worker-story-agent.js`) that **imports the same `./src/*.js`
modules** as legacy. Sharing code ≠ sharing runtime.

- **Shared (code & data):** `utils.js`, `firewall.js`, `story-matcher.js`, the `facts` and
  `content_items` tables, the KV namespace + article schema, Supabase. **No duplication.**
- **Isolated (runtime):**
  1. **Cron rhythm** — legacy polls every 5 min for freshness; Method B runs hourly / off a
     queue.
  2. **CPU + subrequest budget** — own ~1000-subrequest ceiling per invocation → lifts the
     `MAX_FACTS_EXTRACTS = 5` throttle (which only exists to fit the shared tick).
  3. **Failure firewall** — a buggy Method B (it will be, during dev) cannot take down
     homepage serving or legacy.
  4. **Deploy/rollback lifecycle** — redeploy Method B dozens of times/day without touching
     production.

Not a cost/perf play (Workers compute ≈ free; Claude bill identical). The **reader/serving
code stays in the existing worker** — Method B is only a *producer* writing KV behind the
pointer (§7). Isolation is most valuable during the dual-run window; re-merging post-cutover
is optional.

**Fetch worker → story worker coordination (v1):** story worker polls `content_items` for
rows needing processing (cursor: `facts_extracted_at IS NULL` / `pipeline` flag). **v2:**
Cloudflare Queues — fetch worker enqueues new item IDs, story worker consumes.

---

## 6. Cost

**Pricing** (`src/utils.js:8`): Haiku €0.80/€4.00, Sonnet €3.00/€15.00 per 1M in/out.
**Cap: €16/mo** (`MONTHLY_CLAUDE_CAP`) ≈ €0.53/day. **Workers compute ≈ €0** — 100% of cost
is Claude tokens. The big rock is **Sonnet synthesis**; legacy feeds ~10K chars of source
text in per article.

| | Sonnet input | output | ~€/article |
|---|---|---|---|
| Legacy (source-text in) | ~4,000 tok | ~800 tok | ~€0.024 |
| Method B (compact facts in) | ~1,200 tok | ~800 tok | ~€0.016 (~⅓ cheaper) |

### 6.1 During development (both pipelines run)

Naively ~2× → **breaches the €16 cap**. Required mitigations:

1. **Share fact extraction** — Method B **reads existing `facts` rows**, never re-extracts.
2. **Lower shadow frequency / sample** — process N topics/run hourly, ~20% sample.
3. **Haiku for all new judgments** (delta, branch, match); Sonnet only for final synthesis.
4. **Hard-cap shadow synthesis** (~5/run) during dev.
5. **Prompt caching** already on (`cache_control: ephemeral`).
6. Temporarily raise the cap for the dev window if needed (one config value).

Realistic added spend with mitigations: **~+20–40%**, not +100%.

### 6.2 After switch (steady state)

- ⬇️ synthesis input ~⅓ cheaper (facts ≪ source text)
- ⬇️ confirmations free (Haiku confidence bump, no Sonnet)
- ⬆️ volume rises (per-phase + fan-out) — the point
- ⚠️ **new recurring cost: per-fact delta detection** — Haiku diff on every fact ≈
  €0.002/fact; at ~100 facts/day ≈ **€0.20/day (~38% of budget)**.

**Net:** better €/newsworthy-article; total spend flat-to-up depending on how far volume
grows. The cap stays the governor.

### 6.3 Cost guardrails to build in

- **`pipeline` cost tag.** Extend `addUsagePhase` / `flushCostStats` (`src/utils.js:409/472`)
  with a `pipeline = legacy | methodb` dimension so `/admin/pipeline` shows **€/day and
  €/article side by side**. "≤ budget" becomes a measured cutover gate.
- **Rules-pre-filter before the delta LLM.** Never call Haiku for a pure `confirming`
  repeat. Only invoke the LLM diff when a cheap JS heuristic flags a *possible* delta:
  - a status keyword changed (`görüşme`→`anlaşma`→`imza`, `sakat`→`döndü`),
  - a new number or date appeared vs the track's current values,
  - contradiction markers present (`yalanladı`, `iptal`, `vazgeçti`, `bitti`).
  This keeps the new cost center small.

---

## 7. Seamless cutover

The site renders the homepage from one KV key via `getCachedArticles`. The swap =
**change which producer fills the key the reader reads — never a deploy, never a data move.**

**Three seams, built into Method B from commit #1:**

1. **Freeze the KV article schema as the contract.** Method B emits exactly the `toKVShape`
   shape; a validator runs before write. The renderer stays pipeline-agnostic.
2. **Blue/green keys + one pointer:**
   ```
   legacy   → articles:{site}:legacy
   methodb  → articles:{site}:methodb
   getCachedArticles reads articles:{site}:{pipeline:active}   ← one per-site KV flag
   ```
   Cutover = `PUT pipeline:active = methodb` (one write). Rollback = set it back. Instant.
   Only `getCachedArticles` changes.
3. **Additive-only migrations** (§3) → legacy unaffected, rollback needs no DB downgrade.

**Gotchas that decide "seamless":**

- **Edge cache** — the flip handler must purge / short-TTL the page cache (you have a ~12h
  cache TTL) or the swap won't show.
- **Cold-start gate** — only allow the flip when `articles:{site}:methodb` holds ≥ minPool
  (~20) fresh articles.
- **URL persistence** — article pages render from Supabase by slug, independent of the
  homepage KV, so swapping the producer does **not** 404 old articles. Never delete legacy
  rows at cutover; reuse the slug space.
- **No double-publish** — pre-cutover, legacy owns `:legacy`, Method B owns `:methodb`;
  separate Supabase rows via the `pipeline` column.

**"Mature" = an objective gate** (shown on `/admin/pipeline`, held K consecutive days):
volume in band · latency ≤ legacy · quality ≥ legacy · €/day ≤ budget · no dedup thrash ·
no defamation-gate breach · zero pipeline errors. Pointer is **per-site → canary** (BJK
first, then the rest).

**Grace + decommission:** keep legacy running into `:legacy` for 1–2 weeks as warm rollback
insurance; then disable its LLM work; then delete in a dedicated commit. Keep the pointer +
schema contract — permanent infra that makes future swaps free.

---

## 8. Scandal legal gate

Scandal/şike topics carry real defamation risk (Turkish press law). A national paper uses
lawyers; here the publish decision is an LLM judge. **Scandal topics must carry a stricter
publish gate** — require official/court-level confirmation, never fire on aggregator rumor.
Bake this into the trust threshold; do not let the model free-fire allegations.

---

## 9. Build order (each stage independently useful)

1. **Trunk + event-router core** (shadow worker, shadow KV, `pipeline` cost tag, rules
   pre-filter) — prove volume & timing improve.
2. **`branch_of` / `sequel_of` edges** — derbi → skandal, hoca krizi.
3. **Parallel claim-tracks** — rakip-kulüp transfers.
4. **Fan-out** (1 phase → N articles).
5. **`/admin/pipeline` compare + acceptance gates**, then **per-site canary cutover**.
6. **Grace window → decommission legacy.**

---

## 10. Open questions / risks

- Delta detection reliability (the hardest LLM-judgment piece) — tune in shadow against real
  `facts`/`stories` before trusting.
- Branch/sequel over-eagerness (topic spam) vs under-eagerness (buried scandals).
- Entity-poor topics (mali/FFP) correlate weakly — the matcher is player-centric.
- Multi-sport / non-football grounding is football-shaped today.
- Dev-window budget breach if mitigations (§6.1) slip.
