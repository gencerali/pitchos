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
**Start gate:** Weeks 1-2 are pipeline-only (quick wins to activate existing infrastructure).

---

### Week 1 — Pipeline Quick-Wins (no new features, just activation)

**Goal:** Activate the infrastructure that's already built but unwired.

**Tasks (Pipeline, Thu-Sat, ~8h):**
1. **Source configs wiring** (~2h): In `worker-fetch-agent.js`, `processSite()` — call `fetchSourceConfigs(site.id, env)` at top; if result non-empty, call `configsToRSSFeeds()` + `configsToYTChannels()` and use those instead of hardcoded arrays. Test with `/force-fetch?site=BJK`.
2. **Auth redirect fixes** (~1h): `gamification.js:557` + `profil.html:1247` → `window.location.origin + '/reset-password'`. CORS in `worker-fetch-agent.js:68` → dynamic from `getActiveSites()`.
3. **Fan journalist voice directive** (~2h): Add Turkish directive block (§5.6) to `synthesizeStory()` prompt and `generateOriginalNews()` prompt in `src/publisher.js`. Deploy and check one synthesized article.
4. **Source type normalization** (~1h): Update `classifyStoryType()` prompt enforcement (SLICES.md Sprint D2 backlog item — 35+ free-form types leaking from Claude). One-off SQL UPDATE to normalize existing rows.
5. **Story type normalization SQL** (~1h): `UPDATE stories SET story_type = 'transfer' WHERE story_type ILIKE '%transfer%'` etc. for all 6 controlled types.

**Done when:** Source configs load from DB; synthesis articles have fan-journalist voice; no free-form story types in DB.

---

### Week 2 — Attribution + Breaking

**Goal:** Attribution fields flow from source → article → KV. Breaking articles surface first.

**Tasks (Pipeline, ~10h):**
1. **Attribution rule on content_items** (~4h): Add `attribution_rule TEXT` + `attribution_name TEXT` columns to `content_items` (Supabase migration). In `synthesizeStory()`, read `attribution_rule` from story's contributing source_configs rows — write to saved row. In `generateVideoEmbed()`, write `attribution_rule: 'embed_summary'` + channel name as `attribution_name`.
2. **KV article shape additions** (~2h): Add `attribution_rule`, `attribution_name`, `article_type`, `source_count` to the article object written to KV in `cacheToKV()`. Source count = count of `story_contributions` rows used in synthesis.
3. **Breaking flag** (~4h): In `synthesizeStory()`, check if last contribution was < 30 min ago → set `breaking: true` on `content_items`. Add `breaking` field to KV article shape. In `rankAndEvict()` in `src/publisher.js`, boost `rank_score` to `9999` if `breaking` AND article < 90 min old.

**Done when:** A synthesized article in KV has `attribution_rule: 'none'`, `source_count: 3`, and a recent cluster sets `breaking: true`.

---

### Week 3 — NVS Post-Extraction (Part 1)

**Goal:** Understand and design the NVS refactor. Start the refactor.

**Why one week for analysis before cutting:** NVS scoring is tightly coupled to the main pipeline loop in `processor.js`. Moving it post-extraction changes the flow: currently `score → fetch → rewrite`. New flow: `pre-filter → fetch → extract → score → rewrite`. The pre-filter (BJK keyword match) stays; only NVS scoring moves.

**Tasks (Pipeline, ~10h):**
1. **Audit current pipeline order** (~2h): Read `processor.js` completely. Map the exact flow: where `scoreArticles()` is called, what inputs it takes (title + blurb only), and what subsequent steps depend on the score (rewrite threshold, discard threshold). Write findings as inline comments.
2. **Design new flow** (~2h): `processSite()` loop new order: (a) pre-filter by BJK keyword (unchanged), (b) fetch full content via Readability, (c) run `extractFactsForStory()`, (d) run `scoreArticles()` on extracted facts + title, (e) threshold gate → rewrite/discard. Design the input shape change for `scoreArticles()`.
3. **Implement pre-extraction fetch gate** (~4h): Before `extractFactsForStory()`, fetch full content for all pre-filter-passing articles. Respect existing proxy/rate limits. This is the prerequisite — NVS can't score content that hasn't been fetched.
4. **Unit test** (~2h): Write a test: inject an article with a clickbait title but thin content → confirm new NVS scores it lower than a plain-title article with rich fact content.

**Done when:** Full content is fetched before scoring for all BJK-matching articles. NVS scoring is not yet moved (that's Week 4).

---

### Week 4 — NVS Post-Extraction (Part 2)

**Goal:** NVS scoring moved to post-extraction. Verify with golden fixture.

**Tasks (Pipeline, ~8h):**
1. **Move `scoreArticles()` call** (~3h): In `processor.js`, move the NVS scoring call to after `extractFactsForStory()`. Update input shape: pass extracted `facts.entities` + title instead of just title+blurb. Update `scoreArticles()` to use entity richness (player count, club count, number count) as NVS signal.
2. **YouTube NVS fix** (~2h): YouTube videos currently bypass NVS via `nvs_hint`. After the refactor, score on transcript facts instead of video title. Update `videoToArticle()` to remove `nvs_hint` bypass for videos where transcripts are available.
3. **Golden fixture** (~3h): Add test: 5 articles with dramatic titles but thin facts → confirm none exceed NVS 50. 5 articles with plain titles but rich facts (player + fee + club + date all extracted) → confirm NVS ≥ 65.

**Done when:** `scoreArticles()` receives extracted facts. Clickbait titles no longer inflate NVS.

---

### Week 5 — YouTube `key_headlines[]` + Trust Badge Backend

**Goal:** YT embed+summary template complete. Trust badge data fully available in KV.

**Tasks (Pipeline, ~8h):**
1. **`key_headlines[]` extraction** (~4h): In `generateVideoEmbed()`, after generating the 1-sentence intro, add a second Haiku call: extract 3-5 key claims from the transcript or summary. Write `key_headlines: string[]` to `content_items` as JSONB column (add column via Supabase migration). Add to KV article shape.
2. **`video_url` in KV** (~1h): Add `video_url: string` to KV article shape for `article_type: 'youtube_embed_summary'` articles. Already stored in DB, just needs surfacing in KV write.
3. **`source_count` display** (~1h): `synthesizeStory()` already knows `validSources.length` — write it to `content_items.source_count` and add to KV shape.
4. **Trust badge fields confirmed** (~2h): Verify `nvs` + `breaking` + `article_type` + `source_count` are all in KV for a real article. Write integration test.

**Done when:** KV article shape contains all 7 seam fields from §6. Design track can start reading them.

---

### Week 6 — Design Start: Visual System + Trust Badge

**Goal:** Image strategy decided. Color system and category blocks implemented. Trust badge rendering live.

**Tasks (Design, Mon-Wed, ~8h):**
1. **Image strategy decision** (D-IMAGE): Confirm predefined visual system. No per-article images needed.
2. **Color system CSS** (~3h): Define CSS variables from §4.6 color palette. Add to `index.html` `<style>` block. Category color blocks: `<div class="kx-category-block kx-cat-transfer">` etc. — colored 80px div replacing hero image.
3. **Trust badge component** (~3h): CSS + HTML for four-tier badge. `<span class="kx-trust kx-trust-confirmed">Doğrulandı</span>` etc. Four classes with colors from §4.3. Add tooltip text.
4. **Son Dakika pulse** (~2h): CSS animation for `●` red pulse on `breaking: true` articles < 90 min old. Read `breaking` field from KV.

**Done when:** One article card on homepage shows the category color block + trust badge. Trust badge changes tier correctly based on `nvs` in KV.

---

### Weeks 7-9 — Homepage Redesign (Design)

Three weeks of focused Track 1 work.

**Week 7 — Layout skeleton (~10h):**
- Header + nav (Logo, Haberler, Tribün, Analiz, Profil)
- Mobile nav (bottom tab bar)
- Breaking strip (Son Dakika, 1-row pills of recent high-NVS articles)
- Hero article card (full-width, category block, trust badge, headline, summary, time + source count)

**Week 8 — Article grid (~10h):**
- 2-column card grid (Articles 4-10)
- Each card: category color block left edge, trust badge, headline, 2-line summary, time ago, comment count
- Quest banner (compact strip, existing gamification.js output, just restyled)
- League widget (compact, existing api-sports widget, restyled container)

**Week 9 — Mobile pass + polish (~10h):**
- Single-column layout at 375px
- All cards: touch-friendly tap targets (min 44px height)
- Breaking strip: scrollable horizontal pills on mobile
- Real device test (iPhone / Android)
- Performance: no blocking JS, lazy-load card images if any

**Done when:** Homepage looks like §4.2 layout. Mobile test passes on real device.

---

### Weeks 10-11 — Article Page Redesign (Design)

**Week 10 — Article page structure (~10h):**
- Category color block header (120px, category icon overlaid)
- Headline (large bold), deck line
- Byline: "Kartalix Editörü · [time]"
- Trust badge (expanded: Kartalix Skoru tier + "N kaynaktan derlendi" tooltip)
- Attribution block: source names + trust tiers in Turkish (for non-`none` articles)
- Article body: max-width 680px, serif or clean sans, 1.6 line-height
- YouTube embed template: embed at top, "Bu videoda öne çıkan başlıklar:" + bullet list from `key_headlines[]`

**Week 11 — Polish + extras (~8h):**
- Reactions bar (existing, restyled)
- Comments section (existing, restyled)
- Related articles (3 cards, same category, from KV — client-side filter)
- Social share buttons (native Web Share API on mobile, fallback Twitter/WhatsApp links)
- Mobile pass at 375px
- Breadcrumb: Haberler > [Category]

**Done when:** Article page matches §4.4 layout. Both standard and YouTube embed templates work. Mobile tested.

---

### Week 12 — Security + Integration + Final

**Goal:** Everything wired end-to-end. Security hardened. G2M criteria checklist.

**Tasks (~10h):**
1. **Security** (~4h): Cloudflare Access rule on `/admin/*` (dashboard, no code). `is_bot` RLS policy (Supabase dashboard). Comment moderation log table + log writes in moderation handler. Verify no Supabase service key in error responses.
2. **Integration seam test** (~3h): Publish a test synthesis article. Verify: `breaking` flag renders Son Dakika treatment. `source_count: 3` renders "3 kaynaktan". `attribution_rule: 'named_journalist'` renders journalist name in attribution block. YouTube embed article renders embed + bullets.
3. **G2M criteria sweep** (~3h): Run through all 12 success criteria from §10. For each failing criterion, file it as a bug and fix it before calling G2M.

**Done when:** All 12 success criteria pass. Ali sends the URL to a Beşiktaş fan friend without embarrassment.

---

### Timeline Summary

| Week | Focus | Track | Key Deliverable |
|------|-------|-------|----------------|
| 1 | Quick wins | Pipeline | Source configs wired, voice directive live |
| 2 | Attribution + breaking | Pipeline | KV shape complete, breaking articles rank first |
| 3 | NVS refactor design | Pipeline | Full content fetched before scoring |
| 4 | NVS scoring moved | Pipeline | Post-extraction NVS live, golden fixture |
| 5 | YT template + badge data | Pipeline | All seam fields in KV |
| 6 | Visual system + trust badge | Design | Badge renders, color system live |
| 7 | Homepage skeleton | Design | Hero + nav + breaking strip |
| 8 | Homepage card grid | Design | Full homepage layout |
| 9 | Homepage mobile | Design | Real-device pass |
| 10 | Article page | Design | Article layout + YT template |
| 11 | Article polish | Design | Related articles, reactions, mobile |
| 12 | Security + integration | Both | All criteria pass, G2M declared |

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
