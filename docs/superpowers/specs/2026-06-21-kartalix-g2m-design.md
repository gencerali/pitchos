# Kartalix G2M — Design Spec
**Date:** 2026-06-21
**Status:** Approved by Ali
**G2M Signal:** Content flows like a real newsroom + gut pride test ("I'd recommend this to a Beşiktaş fan friend")

---

## 1. What We're Building

A Beşiktaş fan platform with three USPs delivered in priority order:

1. **Trust** — every article carries a visible trust signal (confirmed vs rumor); reader always knows what they're reading
2. **Engagement** — predictions, quests, leagues woven into the reading experience; fans come back to play, not just read
3. **Depth** — analytics for the serious fan (post-G2M or parallel if no API cost)

**Homepage contract:** News leads. Gamification is visible but secondary. Analytics is a clear nav destination.
**Article voice:** Passionate fan journalist — factual backbone, Beşiktaş heart. Reads like a knowledgeable friend who supports the club. Never cold, never generic.
**Rumor policy:** Rumors appear in the main feed, clearly labeled with trust badge. Not hidden. The badge does the work.

---

## 2. G2M Scope

### Scope Revision (2026-06-21)

Original plan assumed M2 (dedup) and M3 (freshness) could be fixed by tuning the existing pipeline. **This is wrong.** The current architecture has structural problems that tuning cannot solve:

- NVS scored on title/blurb *before* content is fetched — scores the packaging, not the story
- One source → one article → duplication is baked in, not a config issue
- No source abstraction — adding YouTube or Twitter requires invasive changes
- Single-reference rewrites are the output by design — not an edge case

**Decision:** Method B core is a G2M must-have. Not a quality upgrade — the content foundation. The pipeline track builds the minimal Method B needed to produce distilled, multi-source, original articles from RSS + YouTube. Twitter is post-G2M.

### Attribution Rules (locked)

| Source Type | Attribution Rule |
|-------------|-----------------|
| RSS / press feeds | None — synthesize as Kartalix original |
| Official club / TFF / league | State as fact or attribute to institution |
| Named journalist exclusive (e.g., Günayer) | Named attribution — "Günayer'e göre" |
| Named journalist + multiple signals combined | Synthesize without naming — facts are reused |
| YouTube — primary source breaking news | Embed video + 1-2 paragraph key headlines |
| YouTube — general content | Extract facts → store in `facts` table → reusable in future articles |
| Tweet confirmation (post-G2M) | Named attribution — "X transferi doğruladı" |
| Facts extracted from any source | Reusable in future articles without re-citing origin |

### Must-Have (nothing ships until these pass)

| # | Item | Track | Build Status | Remaining Effort |
|---|------|-------|-------------|-----------------|
| M1 | Image strategy resolved + visual system built | Design | Not started | Week 1 decision, 1-2 weeks build |
| M2 | Source abstraction + fact extraction (RSS + YT) | Pipeline | ✅ DONE | 2h activation only |
| M3 | Story clustering: one story → one article | Pipeline | ✅ DONE | 0h remaining |
| M4 | Synthesis attribution rules (fields + prompt routing) | Pipeline | Partial | 6h |
| M5 | YouTube embed+summary: `key_headlines[]` in KV | Pipeline | Partial | 4h |
| M6 | NVS computed post-extraction (on facts, not title) | Pipeline | Not started | 1 week |
| M7 | Article voice — fan journalist prompt directive | Pipeline | Partial | 2h |
| M8 | Trust badge on every article card (NVS visual) | Design | Not started | 1-2 days |
| M9 | Homepage redesign — article-first, mobile-first | Design | Not started | 4-5 weeks |
| M10 | Article page redesign — readable, credible | Design | Not started | 2-3 weeks |
| M11 | Security basics (admin gate, is_bot fix, auth redirect) | Pipeline | Not started | 2-3 days |

**Revised total at 8-12 hrs/week: 11-13 weeks** (down from 18-22 because Method B core is already built)

### Postponable (after G2M replan)

- Twitter source type (post-G2M addition to source abstraction layer — 1-2 weeks when ready)
- Full Method B topic graph (branch_of, sequel_of, parallel claim-tracks)
- Fan-out (1 phase → N articles by entity)
- /admin/pipeline comparison view (legacy vs Method B side by side)
- B3.1 Shareable prediction card
- Analytics / Analiz page with paid data API
- Email digest (Resend)
- Push notifications + service worker
- Worker refactor (864KB file — natural timing is post-cutover when legacy shrinks)
- Multi-tenancy beyond 4 quick fixes
- AI poll generator
- Bot decay logic
- League tier configurations in DB

---

## 2.5 Implementation State — What's Already Built

The original spec assumed Method B was greenfield. It is not. A significant portion of the pipeline was built in Slices 1–3 (2026-05) and is running in production. This section maps each must-have to the existing codebase so we don't rebuild what exists.

### Primary Reference Files

Before starting any implementation work, read these in order:

| File | What it contains |
|------|-----------------|
| `docs/method-b-design.md` | Full Method B design: model layers, schema DDL, cost analysis, cutover plan, build order — Ali's own design thinking |
| `docs/method-b-model.svg` | Visual model: meta-flow + 3 Turkish branch topologies + national-newspaper mapping |
| `docs/migrations/0014_method_b.sql` | Schema already written: `topics`, `topic_edges`, `phases` tables + `content_items` linkage columns |
| `worker-story-agent.js` | Shadow worker: Step 2 core already built — `correlateToTopic`, `rulesPreFilterDelta`, `detectDeltaLLM`, `synthesizePhase`, `/admin/pipeline` compare page, blue/green cutover seam |
| `docs/NEXT.md` | The active action list — next action is deploy the shadow worker, not build it |
| `docs/SLICES.md` | Full sprint tracker showing what's done in the main pipeline |

### ✅ Fully Complete — Zero Build Work Needed

**M2: Source abstraction + fact extraction**
- `source_configs` table exists (`docs/migrations/0001_source_configs.sql` run 2026-05-05)
- `fetchSourceConfigs(siteId, env)` in `src/fetcher.js:92` — reads DB, falls back to hardcoded
- `configsToRSSFeeds(configs)` in `src/fetcher.js:104` — maps to RSS_FEEDS shape
- `configsToYTChannels(configs)` in `src/fetcher.js:119` — maps to YOUTUBE_CHANNELS shape
- Admin UI at `/admin/sources/ui` — inline edit, activate/deactivate any source
- Remaining: wire `fetchSourceConfigs()` into `processSite()` in worker (~2h, known location)

**M3: Story clustering (one story → one article)**
- `stories`, `story_contributions`, `story_state_transitions` tables live in Supabase
- `matchOrCreateStory()` in `src/story-matcher.js:574` — entity fingerprint → Claude judge → create/match
- `synthesizeStory()` in `src/story-matcher.js:363` — multi-source synthesis (Sprint D2, 2026-05-13)
  - Gates: ≥3 contributions, BJK keyword, ≥2 sources with real text, content-covers-title check
  - Dedup: one synthesis per story per day via KV `synth:{id}:{date}`
- State machine: emerging → developing → confirmed → active → archived/debunked
- Source independence gate: press-only stories cap at `developing` (Sprint F1)
- Production state: 130 stories ingested, 42 active, full state transitions logged
- **This is the spec's entity-fingerprint approach — already running**

**Fact extraction (M2 prerequisite)**
- `extractFacts()` in `src/firewall.js:131` — transfer fact schema
- `extractFactsForStory()` in `src/firewall.js:247` — classify then extract (5 schemas: transfer, injury, disciplinary, contract, generic)
- `classifyStoryType()` in `src/firewall.js:26` — Haiku call, 8 controlled types
- `facts` + `fact_lineage` tables with destruction audit trail (Slice 1, 2026-05-09)

**YouTube unified pipeline (M5 base)**
- Sprint C (2026-05-02): `generateVideoEmbed()` in `publisher.js`, 5 channels, `qualifyYouTubeVideo()`
- Sprint F2 (2026-05-05): `videoToArticle()` normalizes video → article shape; unified into story system
- YouTube videos flow through `extractFactsForStory()` + `matchOrCreateStory()` — same pipeline as RSS
- Rabona Digital (Fırat Günayer): Supadata transcript → synthesis already working

**Voice patterns (M7 base)**
- Voice Agent Phase 2 (2026-05-13): `runVoicePatternExtraction()`, 13 Turkish voice rules seeded
- `editorial:voice_patterns` KV: 30-pattern cap, weighted by NVS, rotated per generation
- `getEditorialNotes()` injects 3 random style examples into all generation prompts
- Grounding context: `buildGroundingContext()` injects verified API-Football data into every synthesis

**Method B shadow worker (further advanced than spec assumed)**
- `worker-story-agent.js` + `wrangler-story.toml`: separate Cloudflare Worker already scaffolded
- **Step 2 core is DONE** (per `NEXT.md` 2026-06-06): correlate → `rulesPreFilterDelta` (cheap JS heuristic before LLM) → `detectDeltaLLM` (Haiku delta judge) → `synthesizePhase` (Sonnet from facts, not source text)
- Cost management: `SHADOW_SYNTH_CAP` per-run cap, `methodb-only` cost counter, shared with global `MONTHLY_CLAUDE_CAP`
- `/admin/pipeline` compare page: legacy vs methodb side-by-side, last-run tally, methodb cost
- Blue/green cutover seam: `getServedArticles` reads `pipeline:active` KV pointer; `/admin/config` toggle → `/admin/pipeline/flip` endpoint; instant, reversible, safe-by-default
- Schema: `0014_method_b.sql` — `topics`, `topic_edges`, `phases` tables + `content_items.topic_id/phase_id/pipeline` columns (additive, legacy tables untouched)
- **Next action (from NEXT.md):** apply `0014_method_b.sql` → `wrangler deploy -c wrangler-story.toml` → `methodb:enabled = 1` → observe `/admin/pipeline` for a few days → tune `rulesPreFilterDelta` + `detectDeltaLLM` + `synthesizePhase` voice

### ⚠️ Partial — Real Delta Work Needed

**Source configs activation (M2 completion)**
- Code is done; the main `processSite()` in `worker-fetch-agent.js` still reads from hardcoded `RSS_FEEDS` constant
- Fix: at start of `processSite()`, call `fetchSourceConfigs(site.id, env)`; if result non-empty, use `configsToRSSFeeds()` + `configsToYTChannels()` instead of hardcoded arrays
- Estimated: 2 hours. Known location, straightforward wiring.

**Attribution fields in KV article shape (M4)**
- `source_configs` has `treatment` column (`embed`, `synthesize`, `embed_and_synthesize`) and `trust_tier`
- These need to flow from source → synthesis → KV article shape as `attribution_rule` + `attribution_name`
- `synthesizeStory()` and `generateVideoEmbed()` need to write these fields on the saved `content_items` row
- Estimated: 4 hours after source_configs activated

**Fan journalist voice directive (M7 completion)**
- Voice patterns exist but the synthesis prompt in `synthesizeStory()` and `generateOriginalNews()` lacks the explicit fan-journalist directive from §5.6
- Fix: add the Turkish directive block to the `prompt` string in both functions
- Estimated: 2 hours

**YouTube `key_headlines[]` in KV (M5 completion)**
- `generateVideoEmbed()` creates embed+summary but doesn't populate `key_headlines: string[]`
- The embed+summary template in §5.4 requires a bullet list of extracted claims
- Fix: add Haiku call in `generateVideoEmbed()` to extract 3-5 key claims → write to `content_items.key_headlines` JSONB
- Estimated: 4 hours

**`breaking` flag (M3 extension)**
- When `synthesizeStory()` fires on a cluster updated in last 30 min → set `breaking: true` + expiry
- `rankAndEvict()` in publisher.js needs to read `breaking` flag and pin to top
- Estimated: 4 hours

### 🔴 Not Started — Full Build Needed

**M6: NVS post-extraction** — The single largest pipeline task remaining. NVS is currently scored in `processor.js` on title+blurb before content fetch. Moving it to post-extraction means: (1) fetch all content upfront, (2) run fact extraction, (3) score NVS on extracted facts instead of title. This changes the pipeline order. Estimated 1 week.

**M8: Trust badge frontend** — NVS is already in KV. Just needs CSS + JS to render the four-tier badge on article cards. Estimated 1-2 days.

**M9: Homepage redesign** — Full Track 1 work. 4-5 weeks.

**M10: Article page redesign** — 2-3 weeks.

**M11: Security basics** — Cloudflare Access on `/admin/*`, `is_bot` RLS, comment moderation log, auth redirect fixes. 2-3 days.

**`source_count` in KV** — Add `source_count: number` field when writing article from `synthesizeStory()`. 2 hours.

---

## 2.6 Testing Strategy — Automation First

**The problem:** Most Kartalix features involve LLM calls, RSS feeds, cron timing, and Supabase writes. Traditional unit tests don't work well — you can't mock a Haiku synthesis call and still know if your prompt is right. Manual testing requires waiting for cron runs, having live transfer news, and reading articles. This is the biggest time sink in the dev cycle.

**Solution: The Fixture Pattern — already in use, needs to be mandatory**

The codebase has two mechanisms that already cover 80% of testing needs:
- `/admin/golden-fixtures` — returns `all_pass: bool` + per-fixture results. Already covers story matching, state transitions, confidence scoring.
- `/force-*` endpoints — trigger specific pipeline stages on demand without waiting for cron.

Every new feature from Week 2 onward **must** add one golden fixture assertion to `/admin/golden-fixtures`. By Week 12, it will have ~20 automated checks running on every deploy.

### Three Test Tiers

**Tier 1 — Instant (< 30 seconds, run after every deploy, zero manual effort)**

```bash
# CI checks — all must return 200 + expected body
GET /health                          → { status: "ok" }
GET /admin/golden-fixtures           → { all_pass: true }
GET /cache?site=BJK                  → JSON array with ≥ 1 article
```

**Tier 2 — Integration (< 5 minutes, run after every pipeline change)**

```bash
# Trigger pipeline stages, verify DB output
POST /force-h5?fire=1               → new content_items row with publish_mode='synthesis' in last 60s
POST /force-synthesis?site=BJK      → new KV article with publish_mode='synthesis_generated'
GET  /admin/golden-fixtures          → all_pass: true (includes any new fixtures from this week)
```

**Tier 3 — Manual (once per feature, before marking done)**

Run these yourself in under 10 minutes:
- Read 3 synthesized articles → fan-journalist voice check (not robotic, Beşiktaş heart)
- Open homepage on mobile (375px) → trust badge visible on every card
- Check article page → attribution block correct for each attribution_rule type

### GitHub Actions CI

Add `.github/workflows/golden-fixtures.yml`:

```yaml
name: Golden Fixtures
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Health check
        run: curl -sf https://app.kartalix.com/health
      - name: Golden fixtures
        run: |
          RESULT=$(curl -sf https://app.kartalix.com/admin/golden-fixtures)
          echo $RESULT | jq '.all_pass' | grep -q 'true'
```

This runs on every push and fails the build if any golden fixture breaks. Zero maintenance once set up.

### Golden Fixture Pattern — One per Feature

Each week's done-when criteria includes writing a golden fixture:

```javascript
// In worker-fetch-agent.js /admin/golden-fixtures handler — add one check per feature:
const checks = {
  // existing checks (story_matching, state_transitions, confidence_scoring)...
  attribution_fields_in_kv:   checkAttributionInKV(env),   // Week 2
  breaking_flag_pins_article: checkBreakingRankBoost(env), // Week 2
  nvs_post_extraction:        checkNvsOnFacts(env),        // Week 4
  key_headlines_populated:    checkKeyHeadlines(env),      // Week 5
  source_count_in_kv:        checkSourceCount(env),        // Week 5
};
```

Each check function hits Supabase or KV, confirms the expected state, returns `{ pass: bool, detail: string }`.

**Time savings:** Manual testing per feature: ~2-3h. With golden fixtures + Tier 2 scripts: ~20 min per feature. The `writing-plans` weekly discipline is: write the fixture first, implement the feature, watch CI go green.

---

## 3. Build Approach — Parallel Tracks

Two independent tracks running simultaneously. No cross-dependencies until final integration week.

```
TRACK 1 — DESIGN (Mon-Wed evenings)
Frontend only: HTML, CSS, JS in index.html, tribun.html, profil.html, liderlik.html
No backend changes. Independent of pipeline work.

TRACK 2 — PIPELINE (Thu-Sat evenings)
Backend only: src/*.js, worker-fetch-agent.js, functions/api/*
No design changes. Independent of design work.

INTEGRATION (final 1-2 weeks)
Trust badge: pipeline outputs NVS → design reads and displays it
Source attribution: pipeline attaches sources → design renders them
```

Weekly discipline: one design challenge + one pipeline challenge per week. Claude executes tasks you define; you review decisions.

---

## 4. Track 1 — Design Spec

### 4.1 Image Strategy (Decision required Week 1)

**Recommended approach: Predefined Visual System**

Do not rely on per-article images. Build a one-time visual language that replaces photography permanently:

- **Category color blocks** — each content category has a strong color (Transfer: gold, Match: dark blue, Injury: red-orange, Club: black, Rumor: muted yellow)
- **Category icons** — single SVG icon per category, displayed prominently on card
- **Score cards** — for match articles: styled score display replaces a hero image
- **Stat visualizations** — small in-line data (form bar, standings snippet) as visual anchor
- **BJK identity** — eagle motif, club colors as texture/accent; not photos

This approach is:
- Legal (zero copyright risk)
- Faster to implement than per-article image pipeline
- Consistent (every card looks designed, not random)
- More premium than generic stock photos on Turkish sports sites

**Alternative options (if predefined system feels too minimal):**
- AI-generated atmospheric football images (stadium, silhouettes, abstract) — not player photos (likeness risk)
- Stock photo subscription (Shutterstock ~€30/mo) — generic sports imagery, no player shots
- Official BJK press release photos only — very limited volume, requires monitoring

**Decision to make before Week 2:** Which approach? The spec assumes predefined visual system unless overridden.

### 4.2 Homepage Layout

```
┌─────────────────────────────────────┐
│  HEADER: Logo + Nav (Haberler / Tribün / Analiz / Profil)    │
│  Mobile: hamburger menu             │
├─────────────────────────────────────┤
│  BREAKING / SON DAKİKA strip        │  ← high-NVS articles < 1hr old
│  [●] Confirmed  [◑] Rumor          │  ← badge legend, one-time tooltip
├─────────────────────────────────────┤
│  HERO ARTICLE (largest card)        │  ← top NVS article
│  [Category badge] [Trust badge]     │
│  Headline — bold, Turkish editorial │
│  3-line summary                     │
│  Time ago · Source count            │
├──────────────────┬──────────────────┤
│  ARTICLE 2       │  ARTICLE 3       │
│  [Cat] [Trust]   │  [Cat] [Trust]   │
│  Headline        │  Headline        │
│  2-line summary  │  2-line summary  │
│  Time · Sources  │  Time · Sources  │
├──────────────────┴──────────────────┤
│  QUEST BANNER (gamification strip)  │  ← daily quest; compact, not intrusive
├─────────────────────────────────────┤
│  ARTICLES 4-10 (2-col card grid)    │
│  Each: [Cat color] [Trust] Headline │
│  Time ago · Comment count           │
├─────────────────────────────────────┤
│  LEAGUE WIDGET (compact)            │  ← current league standing
├─────────────────────────────────────┤
│  ARTICLES 11-20                     │
├─────────────────────────────────────┤
│  FOOTER                             │
└─────────────────────────────────────┘
```

**Mobile (375px primary):**
- Single column throughout
- Breaking strip collapses to pill badges
- Hero card full width with category color block replacing image
- Quest banner stays — it's compact enough
- Nav: bottom tab bar (Haberler / Tribün / Profil)

### 4.3 Trust Badge System

**Display name:** "Kartalix Skoru" (branded, not a raw number)

**Four tiers, visual only (no raw NVS number shown to readers):**

| NVS Range | Display | Color | Label |
|-----------|---------|-------|-------|
| 80-100 | ✓ solid dot | Dark green | Doğrulandı |
| 60-79 | ● filled dot | Blue-grey | Güvenilir |
| 40-59 | ◑ half dot | Amber | İddia |
| 0-39 | ○ empty dot | Muted grey | Spekülasyon |

**Placement:** top-left of every article card. Small but unmissable.
**Tooltip on hover/tap:** "Bu haber [kaynak sayısı] kaynaktan derlendi. Kartalix Skoru güvenilirlik göstergesidir."
**Article page:** expanded breakdown — source names + trust tiers listed.

**"Son Dakika" treatment:** Articles < 30 min old with NVS ≥ 70 get a "● CANLI" red pulse indicator instead of the standard badge. Disappears after 30 min.

### 4.4 Article Page Layout

```
┌─────────────────────────────────┐
│  HEADER (same as homepage)      │
├─────────────────────────────────┤
│  Breadcrumb: Haberler > Transfer│
├─────────────────────────────────┤
│  [CATEGORY COLOR BLOCK]         │  ← full-width, 120px, category color
│  [Category icon + name]         │  ← overlaid on color block
├─────────────────────────────────┤
│  HEADLINE (large, bold)         │
│  Alt-başlık / deck (if any)     │
│  ──────────────────────────     │
│  Kartalix Editörü · 14:32       │
│  [Kartalix Skoru: Güvenilir ●]  │
│  Kaynaklar: NTV Spor, Habertürk │
├─────────────────────────────────┤
│  ARTICLE BODY                   │
│  Editorial serif/sans-serif     │
│  22px line-height, max 680px    │
│  width for readability          │
├─────────────────────────────────┤
│  REACTIONS (emotion bar)        │
│  COMMENTS                       │
├─────────────────────────────────┤
│  RELATED ARTICLES (3 cards)     │
└─────────────────────────────────┘
```

### 4.5 Typography Direction

- **Headline font:** Strong sans-serif with Turkish character support — Inter, Plus Jakarta Sans, or Geist. Bold weight. Not system font.
- **Body font:** Readable serif or clean sans — Merriweather, Lora, or IBM Plex Serif for body; signals editorial seriousness
- **Size scale:** 14/16/20/28/36/48px — no intermediate sizes
- **Line height:** 1.6 for body, 1.2 for headlines
- **Max reading width:** 680px on article pages — forces comfortable column, not full-browser-width sprawl

### 4.6 Color System

```
Primary:   #1A1A2E (near-black, Beşiktaş dark)
Accent:    #E8B84B (gold — Beşiktaş second color)
Surface:   #F7F7F8 (off-white — not pure white)
Border:    #E2E2E6

Category colors:
Transfer:  #E8B84B (gold)
Match:     #1A1A2E (dark)
Injury:    #E05A2B (red-orange)
Club:      #6B46C1 (purple)
Rumor:     #94A3B8 (muted slate)
Analysis:  #0EA5E9 (info blue)

Trust badge colors:
Confirmed: #16A34A (green)
Reliable:  #3B82F6 (blue)
Claim:     #D97706 (amber)
Specul.:   #94A3B8 (muted)
```

### 4.7 Multi-Tenancy Quick Fixes (1 day, do in Track 1 Week 1)

- `gamification.js:557` → `window.location.origin + '/reset-password'`
- `profil.html:1247` → same
- `worker-fetch-agent.js:68` → dynamic CORS from `getActiveSites()`
- Wire `fetchSourceConfigs()` into `fetchRSSArticles()` (function exists, never called)

---

## 5. Track 2 — Pipeline Spec (Minimal Method B)

### Architecture Overview

The pipeline track builds the minimal Method B needed for G2M. This is not the full 5-stage Method B from `docs/method-b-design.md` — it is the trunk that makes distilled, non-duplicated, source-agnostic articles possible. Full topic graph, claim tracks, and fan-out are post-G2M.

```
SOURCE LAYER          FACT LAYER              STORY LAYER         ARTICLE LAYER
─────────────         ──────────              ───────────         ─────────────
RSS feeds    ──┐                              ┌─ cluster by       ┌─ synthesize
YT transcripts ┤→ extract_facts() ──→ facts ─┤  entity/topic  ──┤  (no source ref
YT embed+sum ──┘                              └─ dedup         └─  for RSS)
                                                                   voice: fan journalist
                                                                   NVS: post-extraction
```

**Key principle:** Facts are the unit of truth. Articles are disposable. A fact extracted from a Günayer video today can seed an article next week without re-citing Günayer.

### 5.1 Source Abstraction Layer (M2 foundation)

**Goal:** RSS and YouTube become interchangeable inputs. Adding Twitter later is a new adapter, not a rewrite.

```javascript
// Common interface — all sources output this shape
{
  source_id: string,
  source_type: 'rss' | 'youtube_transcript' | 'youtube_embed',
  trust_tier: 'official' | 'broadcast' | 'press' | 'journalist' | 'aggregator',
  attribution_rule: 'none' | 'institution' | 'named_journalist' | 'embed_summary',
  raw_content: string,    // article text OR YT transcript
  metadata: { url, title, published_at, author }
}
```

**RSS adapter:** Already exists in `src/fetcher.js` — wrap in common interface, add `attribution_rule: 'none'` for all RSS sources.

**YouTube adapter (new):**
- **Transcript mode:** Use YouTube transcript API (or Whisper if unavailable) → extract facts → `attribution_rule: 'none'` for general content, `'named_journalist'` if journalist is the primary source breaking unique news
- **Embed+summary mode:** Triggered when: single primary source (Günayer etc.) + NVS ≥ 80 + no RSS coverage of same story → embed video in article + 2-paragraph summary
- **Detection:** `youtube_embed` type flagged in `source_configs` per channel; trust tier set per channel

**YouTube channel config (in `sites` table or `source_configs`):**
```json
{
  "channel_id": "UCxxxxx",
  "channel_name": "Fırat Günayer",
  "trust_tier": "journalist",
  "attribution_rule": "named_journalist",
  "embed_threshold_nvs": 75
}
```

### 5.2 Story Clustering (M3 — one story, one article)

**Goal:** 5 RSS sources cover the same transfer → ONE synthesized article, not five rewrites.

**Approach:** Entity fingerprint matching (simpler than full topic graph for v1)

```javascript
// Entity fingerprint = normalized set of: player names + club names + story type
// Two facts with fingerprint overlap > 0.6 → same story
fingerprint('Rashica', 'Beşiktaş', 'transfer') matches
fingerprint('Rashica', 'BJK', 'transfer söylentisi')
```

**Clustering rules:**
1. Collect all facts from current run window (last 2 hours)
2. Group by entity fingerprint similarity
3. Per cluster: if 2+ facts → synthesize ONE article from all facts combined
4. If 1 fact: check against existing `topics` table for ongoing story → add as contribution OR publish as brief if NVS ≥ 70
5. Dedup key: `synth:{topic_id}:{date}:{hour}` — max one synthesis per story per hour

**"Son Dakika" freshness (replaces decay retuning):**
- When synthesis fires on a cluster updated in last 30 min → flag article as `breaking: true`
- Breaking articles surface at top of homepage feed regardless of NVS rank
- Breaking flag expires after 90 min
- This replaces half-life tuning — freshness is now a semantic signal, not a time decay hack

**Success test:** Beşiktaş announces a transfer. Club's official post + NTV Spor + Habertürk + Fanatik cover it within 1 hour → homepage shows ONE article combining all four, with "Son Dakika" treatment. No duplicates.

### 5.3 Attribution-Aware Synthesis (M4)

**Synthesis prompt routing based on `attribution_rule`:**

```
attribution_rule = 'none' (RSS):
→ Write as Kartalix original. No "NTV Spor'a göre." Facts presented directly.
→ Voice: passionate fan journalist

attribution_rule = 'institution' (official):
→ "Kulübün resmi açıklamasına göre..." or state as fact.
→ Can name the institution (BJK, TFF, UEFA)

attribution_rule = 'named_journalist':
→ "[Journalist]'e göre..." for the key claim.
→ Supporting facts from other sources woven in without attribution.

attribution_rule = 'embed_summary':
→ Video embed block at top.
→ 2-paragraph summary: "Bu videoda öne çıkan başlıklar:"
→ Bullet list of 3-5 key claims. No synthesis beyond what was said.
```

**Fact reuse:** All facts extracted from any source are stored in `facts` table with `source_id` lineage. A future article can query facts by entity/topic and synthesize from them. The synthesis never re-cites the original source unless `attribution_rule` requires it.

### 5.4 YouTube Templates (M5)

**Template A — Embed + Summary** (for journalist exclusives / club channels)
```
[VIDEO EMBED — full width]
[Thumbnail fallback if embed fails]

**Bu videoda öne çıkan başlıklar:**
• [Key claim 1]
• [Key claim 2]
• [Key claim 3]

[1-paragraph context from existing facts table — no source citation]

[Trust badge: Kartalix Skoru + journalist name if named_journalist]
```

**Template B — Fact Extraction** (for general YT content)
- Run transcript through fact extraction
- Store facts in `facts` table with `source_id: youtube:{channel}:{video_id}`
- No article published immediately — facts become fuel for story cluster synthesis
- IF facts contribute to an existing high-NVS story → trigger re-synthesis of that story

**YT transcript acquisition (in order of cost/reliability):**
1. YouTube's own transcript API (free, available for captioned videos)
2. `yt-dlp` subtitle extraction (free, requires Worker with subprocess or external service)
3. Whisper transcription (Claude-adjacent cost; use only for high-value sources)

### 5.5 NVS Post-Extraction (M6)

**Current problem:** NVS scored on RSS title + blurb before fetching content. Scores the packaging, not the story.

**Fix:** NVS scoring moves to after fact extraction.

```
BEFORE: fetch title → NVS score → decide to fetch full content
AFTER:  fetch all content → extract facts → NVS score facts → route to publish/discard
```

**Impact:**
- Transfer rumor with dramatic title but thin content → correctly low NVS
- Match injury buried in bland headline → correctly high NVS
- YT video with important facts → NVS reflects actual news value
- Cost: more full-content fetches before scoring → mitigate with pre-filter rule: only fetch full content for `bjkMatch()` passing articles (same gate as now, just NVS moves later)

### 5.6 Article Voice — Passionate Fan Journalist (M7)

Add to synthesis system prompt in all `synthesizeArticle()` and `generateOriginalNews()` calls:

```
Sen Kartalix için yazan bir spor gazetecisisin. Beşiktaş taraftarısın —
taraflı değil, ama kalbinde siyah-beyaz var.

KURALLAR:
1. Gerçekler birinci. Doğrulanmamış bilgiyi asla kesin gibi sunma.
2. Ses tonu: bilgili bir arkadaş gibi yaz. Ne soğuk muhabir, ne çılgın fanatik.
3. Uzunluk: 180-280 kelime. Dolgu cümle yok.
4. İlk paragraf: tek başına yeterli olmalı (ne oldu, kim, nerede, ne zaman).
5. Kaynak belirtme: RSS haberler için hiçbir zaman kaynak adı verme.
   Resmi açıklamalar için kurumu belirtebilirsin.
6. Rumor dili: "iddia ediliyor", "öne sürülüyor" — kesinlikle "kesinleşti" değil.
7. Kartal ruhu: önemli bir an olduğunu hissettir, ama dramatize etme.
```

### 5.7 Security Must-Haves (M11)

**Problem:** Articles feel generic AI. No Beşiktaş heart.
**Fix:** Rewrite synthesis system prompt in `src/publisher.js` (synthesizeArticle and generateOriginalNews).

**New voice directive (add to synthesis prompt):**
```
Sen Kartalix için yazan bir spor gazetecisisin. Beşiktaş taraftarısın — taraflı değil,
ama kalbinde siyah-beyaz var. Haberlerini şu kurallara göre yaz:

1. Gerçekler birinci: doğrulanmamış bilgiyi hiçbir zaman doğrulanmış gibi sunma
2. Ses tonu: bilgili bir arkadaş gibi yaz — ne soğuk muhabir, ne çılgın fanatik
3. Başlık: güçlü, spesifik, tıklatılası — ama asla clickbait değil
4. Uzunluk: 180-280 kelime. Özlü. Dolgu yok.
5. Paragraf yapısı: ilk paragraf tek başına yeterli olmalı (5W1H)
6. Kartal ruhu: takımın önemli bir kararda olduğunu hissettir ama dramatize etme
7. Transfer haberleri: kaynağı belirt ("NTV Spor'a göre", "kulüp açıkladı")
8. Rumorlar: "iddia ediliyor", "öne sürülüyor" gibi ifadeler — hiçbir zaman kesin gibi
```

**Success test:** Take any current Kartalix article and the rewritten version. Show both to a Beşiktaş fan. The new one should feel like a knowledgeable fan wrote it. The old one should feel like a bot.

### 5.8 Source Attribution (visible to reader)

**Problem:** Readers can't see where information comes from. Hurts trust.
**Fix:**

1. **Article page:** Add "Kaynaklar" block after article body. List source names (not URLs) and their trust tier in Turkish: "Resmi Açıklama", "Yayın Kuruluşu", "Spor Basını"
2. **Article card on homepage:** Show "N kaynaktan" if multi-source, "Kaynak: [Name]" if single
3. **Implementation:** `source_names[]` already in article KV shape — surface it in rendering

### 5.9 Security Must-Haves (M11)

All required before any traffic increase.

| Item | File/Location | Change |
|------|--------------|--------|
| Admin gate | Cloudflare dashboard | Add Cloudflare Access rule on `/admin/*` — Zero Trust free tier, no code change |
| `is_bot` write protection | Supabase dashboard | Add RLS policy: `is_bot` column writable only by service role, not user JWT |
| Comment moderation log | `worker-fetch-agent.js` | Log every AI moderation verdict to `moderation_log` table — verdict, confidence, content hash |
| Auth redirects | `gamification.js:557`, `profil.html:1247` | `window.location.origin + '/reset-password'` |
| CORS fix | `worker-fetch-agent.js:68` | Dynamic from `getActiveSites()` |

---

## 6. Integration Points (final weeks)

The two tracks meet at three seams. All are read-only from the design side — no circular dependency.

**Seam 1 — Trust badge:**
Pipeline outputs `nvs` (post-extraction score) + `breaking: bool` on every article in KV shape → design reads both and renders the four-tier badge + Son Dakika pulse.

**Seam 2 — Attribution block:**
Pipeline outputs `attribution_rule` + `attribution_name` (journalist name if named_journalist) on each article → design renders: nothing for `none`, institution name for `institution`, journalist name for `named_journalist`, video embed for `embed_summary`.

**Seam 3 — YouTube embed template:**
Pipeline flags `article_type: 'youtube_embed_summary'` + `video_url` + `key_headlines[]` → design renders embed + bullet summary template instead of standard article layout.

**KV article shape additions needed:**
```javascript
{
  // existing fields...
  nvs: number,               // now post-extraction (was pre-extraction)
  breaking: boolean,         // new — triggers Son Dakika treatment
  attribution_rule: string,  // new — 'none'|'institution'|'named_journalist'|'embed_summary'
  attribution_name: string,  // new — institution or journalist name if applicable
  article_type: string,      // new — 'standard'|'youtube_embed_summary'
  video_url: string,         // new — for embed_summary type
  key_headlines: string[],   // new — for embed_summary type
  source_count: number,      // new — "N kaynaktan" display
}
```

---

## 7. Open Decisions

| # | Decision | Options | Recommendation | Owner |
|---|----------|---------|----------------|-------|
| D-IMAGE | Image strategy | Predefined visual system / AI-gen / Stock / None | Predefined visual system | Ali — Week 1 |
| D-ANALIZ | Analytics page before G2M? | Yes (free API-Football) / After | Yes, free tier only | Ali |
| D-LOGO | Logo change? | Keep / Revise / Full redesign | Decide after design direction locked | Ali |
| D-BYLINE | AI authorship disclosure | "Kartalix Editörü" / "Kartalix AI" / None | "Kartalix Editörü" — honest but not alarming | Ali |

---

## 8. Post-G2M Replan Topics

These are NOT forgotten — they are deliberately deferred. At G2M, replan with:

1. **Method B full activation** — now that pipeline fixes are in place, the gap to Method B is smaller
2. **B3.1 Shareable prediction card** — first acquisition mechanic
3. **Analytics/Analiz page** — with paid data API decision
4. **Email digest** — you now have users to email
5. **Worker refactor** — right time is when Method B replaces legacy fetch
6. **Second site** — only after Kartalix earns

---

## 9. Weekly Development Roadmap

**Rhythm:** Mon-Wed = Design track. Thu-Sat = Pipeline track. Sunday = review + plan next week.
**Capacity:** 8-12 hrs/week solo. Each week below is scoped to ~10 hrs of real work.
**Testing rule:** Every pipeline feature ships with one new golden fixture assertion. CI runs `/admin/golden-fixtures` on every push.

---

### Week 1 — Method B Orientation + Shadow Worker Deployment

**Goal:** Read the existing design, verify the shadow worker's current state, arm it in observe-only mode, and produce a revised Week 2-12 plan based on what you see in `/admin/pipeline`.

**Why not pure analysis:** The shadow worker (`worker-story-agent.js`) has Step 2 core already built per `NEXT.md`. The schema migration is written. The `/admin/pipeline` compare page exists. The design is documented in `docs/method-b-design.md` with a visual in `docs/method-b-model.svg`. The fastest path to an accurate plan is to deploy, observe real output for 2-3 days, and plan from evidence.

**Pre-reading (Sunday before Week 1 starts, ~3h):**
1. Read `docs/method-b-design.md` completely — all 10 sections. Pay special attention to §2 (model layers), §6 (cost), §7 (cutover), §9 (build order).
2. View `docs/method-b-model.svg` — the visual meta-flow and 3 Turkish branch topologies.
3. Read `docs/NEXT.md` — the current action list. The "NEXT ACTION" section is the entry point.
4. Scan `docs/migrations/0014_method_b.sql` — confirm schema for `topics`, `topic_edges`, `phases`.

**Week 1 tasks (~8h, Thu-Sat):**

1. **Read `worker-story-agent.js`** (~2h): understand what Step 2 core contains. Key functions to find: `correlateToTopic`, `rulesPreFilterDelta`, `detectDeltaLLM`, `synthesizePhase`, the shadow KV write path, `SHADOW_SYNTH_CAP`. Note any gaps vs `docs/method-b-design.md` §9 build order.

2. **Apply migration + deploy shadow worker** (~1h):
   - Apply `0014_method_b.sql` in Supabase SQL editor (additive — no legacy impact)
   - `npx wrangler deploy -c wrangler-story.toml`
   - Add secrets if first deploy: `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`

3. **Arm and verify** (~1h):
   - `wrangler kv key put --namespace-id=<id> methodb:enabled 1`
   - Verify `/admin/config` shows "Pipeline (serving)" toggle
   - Verify `/admin/pipeline` compare page loads with legacy + methodb columns

4. **Observe for 2-3 days** — do not skip this. Watch `/admin/pipeline`:
   - Is `topics` table filling? How many per day?
   - Are phases being created? What triggers them?
   - Are synthesis articles appearing in the methodb shadow pool?
   - What is the `€/day` for methodb vs legacy?
   - Are there errors? What kind?

5. **Map Sprint I (Trust Architecture) against Method B trust tiers** (~1h): Sprint I (SLICES.md) plans `trust_tier` + `source_family` on `source_configs`. Method B uses trust tier in the EVENT router and delta gate. Confirm: can Sprint I's trust fields satisfy Method B's needs, or does Method B need its own trust model? Decision goes into the plan.

6. **Write `docs/superpowers/specs/method-b-implementation-plan.md`** (~3h): Based on observation + reading, produce a precise task list for Weeks 2-12. Key questions to answer:
   - Is the shadow worker producing output? If yes: what needs tuning? If no: what's blocking?
   - What does `rulesPreFilterDelta` catch vs miss in real RSS + YouTube input?
   - How does `detectDeltaLLM` perform on real facts? False positive rate?
   - What is the actual article volume (methodb articles/day) vs target (10-15)?
   - Does the NVS refactor need to happen before or after Method B cutover?
   - Are `source_configs` needed before Method B works correctly? (Yes — source trust tier flows into the EVENT router)

**Testing setup tasks (~2h, any day):**
1. Survey `/admin/golden-fixtures` endpoint — list current checks and pass rate
2. Create `.github/workflows/golden-fixtures.yml` (§2.6 CI template)
3. Create `scripts/test-tier2.sh` — curl `/force-h5`, `/force-synthesis`, check Supabase for new rows

**Done when:**
- Shadow worker deployed and armed (`methodb:enabled = 1`)
- `/admin/pipeline` shows methodb activity (even if imperfect)
- `docs/superpowers/specs/method-b-implementation-plan.md` exists with revised Week 2-12 plan
- GitHub Actions CI is green

---

### Week 2 — Source Configs Activation + Quick Fixes

**Goal:** Activate infrastructure already built but unwired. Zero new features — just wiring.

**Tasks (Pipeline, ~8h):**

1. **Source configs wiring** (~2h): In `worker-fetch-agent.js` `processSite()`, call `fetchSourceConfigs(site.id, env)` at top. If result non-empty, use `configsToRSSFeeds()` + `configsToYTChannels()` instead of hardcoded arrays. Fall back to hardcoded if DB returns empty (already built into `fetchSourceConfigs`).
   - Verify: `/admin/sources/ui` shows all sources; POST `/admin/sources/seed` to populate if table is empty
   - Test: `/force-fetch?site=BJK` → logs show "loaded N sources from DB"

2. **Auth redirect fixes** (~1h): `gamification.js:557` + `profil.html:1247` → `window.location.origin + '/reset-password'`. CORS in `worker-fetch-agent.js:68` → dynamic from `getActiveSites()`.

3. **Fan journalist voice directive** (~2h): Add Turkish directive block (§5.6) to `synthesizeStory()` prompt in `src/story-matcher.js` and `generateOriginalNews()` in `src/publisher.js`. Read 3 synthesized articles to confirm voice changed.

4. **Story type normalization** (~1h): Fix `classifyStoryType()` to enforce 8 controlled types strictly. Run SQL to normalize existing rows (`UPDATE stories SET story_type = 'transfer' WHERE story_type ILIKE '%transfer%'` etc.).

5. **Attribution rule on content_items** (~2h): Add `attribution_rule TEXT` + `attribution_name TEXT` columns to `content_items` (Supabase migration). In `synthesizeStory()`, write `attribution_rule: 'none'`. In `generateVideoEmbed()`, write `attribution_rule: 'embed_summary'` + channel name as `attribution_name`. Add to KV shape.

**Golden fixture added:**
```javascript
source_configs_active: async (env) => {
  const configs = await fetchSourceConfigs(SITE_ID, env);
  return { pass: configs.length > 0, detail: `${configs.length} sources from DB` };
}
```

**Done when:** Source configs load from DB. Synthesis articles have fan-journalist voice (read 3, confirm). Golden fixture green.

---

### Week 3 — Breaking Flag + KV Shape + PHASE Layer Design

**Goal:** Breaking articles surface first. All KV seam fields populated. PHASE layer designed (from Week 1 findings).

**Tasks (Pipeline, ~10h):**

1. **Breaking flag** (~3h): In `synthesizeStory()`, check `last_contribution_at` against now — if < 30 min, set `breaking: true` on saved `content_items` row. Add `breaking` + `source_count` + `video_url` to KV article shape in `cacheToKV()`. In `rankAndEvict()`, boost `rank_score` to `9999 × decay` if `breaking` AND age < 90 min.

2. **`source_count` in KV** (~1h): `synthesizeStory()` already has `validSources.length` — write to `content_items.source_count` (add column if not exists). Surface in KV.

3. **PHASE layer design** (~4h): Based on Week 1 findings, design the minimal PHASE implementation.
   - Current throttle: `synth:{id}:{date}` = 1 synthesis/story/day. This is why active stories generate so few articles.
   - Method B PHASE fires on a *delta* (new confidence tier, new claim, new source family). Design the delta detector: what events trigger a new phase? (a) story confidence crosses 60 (emerging→confirmed), (b) new `source_family` joins (press + official now = confirmed), (c) first contribution of the day from a T1 source.
   - Change dedup key from `synth:{id}:{date}` to `synth:{id}:{phase_id}` — where `phase_id` is computed from the triggering event type.
   - Goal: a transfer story confirmed by the club should generate 3 articles (initial rumor synthesis, confirmation synthesis, post-confirmation context synthesis) not 1.

4. **YT `key_headlines[]`** (~2h): In `generateVideoEmbed()`, add Haiku call to extract 3-5 key claims from transcript/summary. Write to `content_items.key_headlines` (JSONB column). Add to KV shape.

**Golden fixtures added:**
```javascript
breaking_flag_pins_article: async (env) => { /* check a recent synthesis has breaking:true in KV */ },
source_count_populated:     async (env) => { /* check source_count ≥ 1 on recent synthesis article */ },
key_headlines_populated:    async (env) => { /* check a YT article has key_headlines.length ≥ 2 */ },
```

**Done when:** Golden fixtures green. KV shape has all 7 seam fields. PHASE design doc written as comments in story-matcher.js.

---

### Week 4 — PHASE Layer Implementation

**Goal:** Story synthesis fires on confidence delta, not once/day. Article output should increase measurably (target: 2× current synthesis volume).

**Tasks (Pipeline, ~10h):**

1. **Phase ID computation** (~3h): In `matchOrCreateStory()`, after `applyContribution()`, compute `phase_id` from triggering event. Replace `synth:{id}:{date}` with `synth:{id}:{phase_id}`. Phase IDs:
   - `initial` — first contribution (confidence 30)
   - `developing` — confidence crosses 40 with ≥2 contributions
   - `confirmed:{source_family}` — first T1/T2 source confirms (replaces quality gate)
   - `active:{date}` — once confirmed, one per day (to prevent flood)

2. **Synthesis trigger expansion** (~3h): Currently `synthesizeStory()` fires only at ≥3 total contributions. With PHASE layer, fire on any new phase event, even at 2 contributions if one is T1. Update the gate in `matchOrCreateStory()`:
   ```javascript
   if (newPhaseId && newPhaseId !== currentPhaseId) {
     synthesizeStory(updated, siteId, env, siteCode).catch(...)
   }
   ```

3. **Volume measurement** (~2h): Add to `/admin/golden-fixtures` a check: count synthesis articles created in last 7 days. Before deploy: record baseline. After: confirm count increased by ≥ 30%.

4. **Safeguard: synthesis rate cap** (~2h): Prevent a single high-activity story from flooding the feed. Cap: max 3 synthesis articles per story per 24h. KV key `synth:cap:{id}:{date}` with counter.

**Golden fixture added:**
```javascript
phase_layer_firing: async (env) => {
  // count content_items with publish_mode='synthesis' in last 7 days
  // pass if count ≥ baseline × 1.3
}
```

**Done when:** Synthesis volume up ≥30%. No story floods feed. Golden fixture green.

---

### Week 5 — NVS Post-Extraction (Part 1 — Design + Fetch Gate)

**Goal:** Full content fetched before NVS scoring. Design the score-on-facts approach.

**Why two weeks:** NVS is deeply wired into `processor.js`. The change order is: (1) fetch full content upfront, (2) extract facts, (3) score on facts. Steps 1 and 2 are this week. Step 3 is Week 6. This split avoids a big-bang deploy.

**Tasks (Pipeline, ~10h):**

1. **Audit `processor.js` pipeline order** (~2h): Find every call to `scoreArticles()`. Map inputs and what downstream steps read the score. Document as inline comments. Confirm: score runs on `title + summary`, not full content.

2. **Pre-extraction fetch gate** (~5h): After BJK keyword filter (unchanged) and before NVS scoring, fetch full content via Readability proxy for all qualifying articles. Cap at 10 fetches/run (cost guard). Store full content in-memory only (not in DB). Log cost: `FETCH_GATE: N articles, M ms`.

3. **Design score-on-facts** (~2h): Update `scoreArticles()` signature to accept `facts` object (entities, numbers, dates). Entity richness scoring: `entityScore = players.length × 15 + clubs.length × 5 + numbers.transfer_fee ? 10 : 0`. Draft the new prompt that combines title context + entity richness.

4. **Unit test (write first)** (~1h): Write golden fixture that will pass only after Week 6: two articles with identical NVS titles but one has 3 entities and a fee, the other has 0. Confirm they score differently after the change.

**Done when:** Full content fetched before scoring (log confirms). NVS still runs on old inputs (not yet changed — that's Week 6). Unit test written, currently failing (expected).

---

### Week 6 — NVS Post-Extraction (Part 2) + Design Start

**Pipeline goal:** NVS scoring moved to post-extraction. Unit test from Week 5 now passes.

**Design goal:** Visual system CSS live. Trust badge rendering on homepage.

**Pipeline tasks (~5h, Thu-Sat):**

1. **Move `scoreArticles()` call** (~3h): In `processor.js`, move call to after `extractFactsForStory()`. Pass extracted `facts` as additional input. Update the scoring Haiku prompt to include entity richness. Update `videoToArticle()` to remove `nvs_hint` bypass.

2. **Golden fixture — NVS post-extraction** (~2h): Run the unit test from Week 5. Two articles: clickbait title, 0 entities → confirm NVS < 50. Plain title, 3 entities + fee + date → confirm NVS ≥ 65.

**Design tasks (~5h, Mon-Wed):**

3. **Image strategy confirm** (D-IMAGE): Confirm predefined visual system.

4. **Color system CSS** (~3h): CSS variables from §4.6. Category color blocks. Add to `index.html`.

5. **Trust badge component** (~2h): Four-tier badge CSS + HTML. Tooltip text. Son Dakika pulse animation.

**Golden fixture added:**
```javascript
nvs_post_extraction: async (env) => {
  // query last 20 synthesis articles — check avg nvs of multi-entity articles > single-entity
}
```

**Done when:** Unit test from Week 5 passes. Trust badge renders on homepage with correct tier from KV `nvs` field.

---

### Weeks 7-9 — Homepage Redesign (Design)

Three weeks of Track 1 work. Pipeline track: minor fixes and golden fixture maintenance only.

**Week 7 — Layout skeleton (~10h):**
- Header + nav (Logo, Haberler, Tribün, Analiz, Profil)
- Mobile nav (bottom tab bar at 375px)
- Son Dakika breaking strip (pills of `breaking: true` articles < 90 min old)
- Hero article card: category color block, trust badge, headline, 3-line summary, "N kaynaktan · X dakika önce"

**Week 8 — Article card grid (~10h):**
- 2-column grid (Articles 4-10), each card: color block left edge, trust badge, headline, 2-line summary, time ago
- Quest banner: compact strip, existing gamification.js output, restyled container
- League widget: compact, existing api-sports widget, restyled

**Week 9 — Mobile + polish + frontend test (~10h):**
- Single-column at 375px, touch-friendly tap targets
- Breaking strip: horizontal scroll pills
- `gstack` headless browser test: navigate homepage, confirm trust badge present on ≥5 cards, confirm article cards are clickable
- Real device test (iPhone or Android)

**Done when:** Homepage matches §4.2 layout. `gstack` test passes. Mobile tested on real device.

---

### Weeks 10-11 — Article Page Redesign (Design)

**Week 10 — Article page structure (~10h):**
- Category color block header (120px), category icon overlaid
- Headline (large bold), deck line, byline ("Kartalix Editörü · 14:32")
- Trust badge expanded: "Kartalix Skoru: Güvenilir ●" + tooltip "N kaynaktan derlendi"
- Attribution block (non-`none` articles): source names + trust tiers in Turkish
- Article body: max-width 680px, 1.6 line-height
- YouTube embed template: embed at top + "Bu videoda öne çıkan başlıklar:" + `key_headlines[]` bullet list

**Week 11 — Polish + extras (~8h):**
- Reactions bar (existing, restyled)
- Comments section (existing, restyled)
- Related articles: 3 cards same category, client-side filter from KV
- Web Share API on mobile (fallback: WhatsApp + copy link)
- Mobile pass at 375px
- `gstack` test: open article, confirm trust badge, attribution block, body text all render

**Done when:** Article page matches §4.4. Standard + YouTube embed templates both work. `gstack` passes.

---

### Week 12 — Security + Integration + G2M Sweep

**Goal:** Everything wired end-to-end. Security hardened. All 11 success criteria green.

**Tasks (~10h):**

1. **Security** (~4h):
   - Cloudflare Access on `/admin/*` (dashboard only, no code change)
   - Supabase RLS: `is_bot` column writable by service role only — add policy in Supabase dashboard
   - Comment moderation log: add `moderation_log` table, write verdict + hash on every AI moderation call
   - Verify: no Supabase service key appears in Worker error responses

2. **Integration seam smoke test** (~3h): Push a test article with each attribution_rule type through the pipeline. Verify rendering for each:
   - `attribution_rule: 'none'` → no attribution block shown
   - `attribution_rule: 'institution'` → "Kulübün resmi açıklamasına göre" in attribution block
   - `attribution_rule: 'named_journalist'` → journalist name shown
   - `attribution_rule: 'embed_summary'` → YouTube embed + bullet list renders

3. **G2M criteria sweep** (~3h): Run all 11 criteria from §11. File bug for each that fails. Fix before calling G2M.

4. **Final golden fixtures run** (~0h): CI should already be green. Confirm all ~15 fixtures pass.

**Done when:** All 11 success criteria pass. CI is green. Ali sends URL to a Beşiktaş fan friend.

---

### Timeline Summary

| Week | Focus | Track | Key Deliverable | Automated Test |
|------|-------|-------|----------------|---------------|
| 1 | Method B orientation + deploy | Analysis + Deploy | Shadow worker live, `method-b-implementation-plan.md`, CI setup | CI setup, Tier 2 script |
| 2 | Source configs + quick fixes | Pipeline | Sources from DB, voice directive live | `source_configs_active` fixture |
| 3 | Breaking flag + KV shape + Phase design | Pipeline | All KV seam fields, PHASE layer designed | 3 new fixtures |
| 4 | PHASE layer implementation | Pipeline | Synthesis volume +30% | `phase_layer_firing` fixture |
| 5 | NVS refactor design + fetch gate | Pipeline | Full content fetched before scoring | Unit test written (failing) |
| 6 | NVS scoring moved + design start | Both | Post-extraction NVS, trust badge CSS live | `nvs_post_extraction` fixture |
| 7 | Homepage skeleton | Design | Hero + nav + breaking strip | `gstack` homepage smoke |
| 8 | Homepage card grid | Design | Full homepage layout | `gstack` card count check |
| 9 | Homepage mobile | Design | Real-device pass | `gstack` + real device |
| 10 | Article page | Design | Article layout + YT template | `gstack` article page |
| 11 | Article polish | Design | Related articles, reactions, mobile | `gstack` full article |
| 12 | Security + integration + sweep | Both | All 11 criteria pass, G2M | All ~15 fixtures green |

**12 weeks at 8-12 hrs/week = 3 months realistic calendar (starts 2026-06-21)**
**Target G2M date: 2026-09-21**

---

## 11. Success Criteria for G2M Declaration

The following must all be true simultaneously:

- [ ] Homepage refreshes with at least 3 new articles between 08:00-23:00 during any 2-hour window
- [ ] No story appears more than once in the visible feed (clustering working)
- [ ] Zero single-source rewrites in feed — every article synthesizes ≥ 2 sources OR is official/YT embed
- [ ] NVS scored on extracted facts, not title — high-NVS articles have real substance
- [ ] Breaking news surfaces with Son Dakika treatment within 30 min of cluster trigger
- [ ] Every article card has a visible trust badge (Kartalix Skoru)
- [ ] No RSS source ever named in article body — Kartalix voice throughout
- [ ] YouTube embed+summary template working for at least one test video
- [ ] Article voice passes the "knowledgeable friend" test on 10 consecutive articles
- [ ] Homepage and article page redesign complete and mobile-tested on real device (375px)
- [ ] Admin panel protected by Cloudflare Access
- [ ] Ali would send the URL to a Beşiktaş fan friend without embarrassment

---

*Spec approved by Ali, 2026-06-21. Next step: writing-plans skill to generate week-by-week implementation plan.*
