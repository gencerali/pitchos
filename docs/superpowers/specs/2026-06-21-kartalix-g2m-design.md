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

| # | Item | Track | Estimated Effort |
|---|------|-------|-----------------|
| M1 | Image strategy resolved + visual system built | Design | Week 1 decision, 1-2 weeks build |
| M2 | Method B core: source abstraction + fact extraction (RSS + YT) | Pipeline | 3-4 weeks |
| M3 | Story clustering: one story → one article, no duplicates | Pipeline | 2-3 weeks |
| M4 | Synthesis without attribution (RSS) + attribution rules (Official/YT) | Pipeline | 1-2 weeks |
| M5 | YouTube templates: embed+summary AND fact extraction | Pipeline | 1-2 weeks |
| M6 | NVS computed post-extraction (on facts, not title) | Pipeline | 1 week |
| M7 | Article voice — passionate fan journalist prompts | Pipeline | 0.5 weeks |
| M8 | Trust badge on every article card (NVS visual) | Both | 1 week |
| M9 | Homepage redesign — article-first, mobile-first | Design | 4-5 weeks |
| M10 | Article page redesign — readable, credible | Design | 2-3 weeks |
| M11 | Security basics (admin gate, is_bot fix, comment log) | Pipeline | 1 week |

**Total estimate at 8-12 hrs/week: 18-22 weeks via parallel tracks**

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

## 9. Success Criteria for G2M Declaration

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
