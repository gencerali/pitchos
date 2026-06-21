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

### Must-Have (nothing ships until these pass)

| # | Item | Track | Estimated Effort |
|---|------|-------|-----------------|
| M1 | Image strategy resolved + visual system built | Design | Week 1 decision, 1-2 weeks implementation |
| M2 | Dedup fix — one story, one article on homepage | Pipeline | 2-3 weeks |
| M3 | Freshness retuning — homepage feels alive | Pipeline | 1-2 weeks |
| M4 | Article voice — passionate fan journalist prompts | Pipeline | 1 week |
| M5 | Trust badge on every article card (NVS visual) | Both | 1 week |
| M6 | Homepage redesign — article-first, mobile-first | Design | 4-5 weeks |
| M7 | Article page redesign — readable, credible | Design | 2-3 weeks |
| M8 | Source attribution visible on every article | Pipeline | 0.5 weeks |
| M9 | Security basics (admin gate, is_bot fix, comment log) | Pipeline | 1 week |

**Total estimate at 8-12 hrs/week: 14-18 weeks via parallel tracks**

### Postponable (after G2M replan)

- Full Method B 5-stage pipeline (pipeline fixes get to G2M; Method B is v1.1 quality upgrade)
- B3.1 Shareable prediction card
- Analytics / Analiz page with paid data API
- Email digest (Resend)
- Push notifications + service worker
- Worker refactor (864KB file — not blocking)
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

## 5. Track 2 — Pipeline Spec

### 5.1 Dedup Fix — One Story, One Article

**Problem:** Transfer story covered by 5 sources → 5 articles on homepage.
**Root cause:** `story-matcher.js` clusters exist but throttled (`MAX_FACTS_EXTRACTS = 5`/run, `synth:{id}:{date}` daily dedup key).
**Fix:**

1. **Loosen `MAX_FACTS_EXTRACTS`** from 5 → 15 per run (story worker has its own CPU budget)
2. **Strengthen title similarity threshold** in pre-filter dedup — current threshold may be too loose, letting near-identical titles through
3. **Story gate on homepage:** if `topic_id` is set on multiple articles, homepage shows only the highest-NVS article per topic per 6-hour window
4. **"Story updated" indicator:** when a story has multiple contributions, show "3 kaynaktan derlendi" on the card rather than hiding the others

**Success test:** A transfer announced by the club, covered by NTV Spor, Habertürk, and Fanatik → exactly ONE article appears on homepage combining all three. Not three separate articles.

### 5.2 Freshness Retuning

**Problem:** Homepage feels stale. Articles from 3 hours ago rank above breaking items.
**Root cause:** Half-life decay curve not aggressive enough for fast-moving sports news.

**Changes:**

1. **Decrease half-life for all content types** — current values in `src/publisher.js` (config-driven after NVS harmonization). Reduce by ~30% across the board.
2. **Freshness bonus for < 2-hour articles** — add +10 to effective NVS for articles published in last 2 hours. Disappears after 2 hours. Creates visible "new" clustering at top of feed.
3. **"Son Dakika" strip** — homepage shows a horizontal strip of the last 3 articles published in < 1 hour with NVS ≥ 60. Updates on every page load.
4. **Admin visibility** — `/admin/pipeline` should show "articles published in last 2 hours: N". If N = 0 for more than 2 hours between 08:00-22:00, something is broken.

**Success test:** A match ends at 21:00. By 21:15, the result article is visible at the top of the homepage with "Son Dakika" treatment.

### 5.3 Article Voice — Passionate Fan Journalist

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

### 5.4 Source Attribution

**Problem:** Readers can't see where information comes from. Hurts trust.
**Fix:**

1. **Article page:** Add "Kaynaklar" block after article body. List source names (not URLs) and their trust tier in Turkish: "Resmi Açıklama", "Yayın Kuruluşu", "Spor Basını"
2. **Article card on homepage:** Show "N kaynaktan" if multi-source, "Kaynak: [Name]" if single
3. **Implementation:** `source_names[]` already in article KV shape — surface it in rendering

### 5.5 Security Must-Haves

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

The two tracks meet at two seams:

**Seam 1 — Trust badge:**
Pipeline outputs `nvs` on every article in KV shape → design reads `nvs` and renders the four-tier badge. No API change needed; `nvs` already in KV.

**Seam 2 — Source attribution:**
Pipeline outputs `source_names[]` on articles → design renders "Kaynaklar" block. Verify `source_names` is populated in KV article shape; add it if not.

Both seams are read-only from the design side. No circular dependency.

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

- [ ] Homepage refreshes with new top content at least every 2 hours between 08:00-23:00
- [ ] No story appears more than once in the visible feed (dedup working)
- [ ] Every article card has a visible trust badge
- [ ] Article voice passes the "knowledgeable friend" test on 10 consecutive articles
- [ ] Source attribution visible on every article page
- [ ] Homepage and article page redesign complete and mobile-tested on real device
- [ ] Admin panel protected by Cloudflare Access
- [ ] Ali would send the URL to a Beşiktaş fan friend without embarrassment

---

*Spec approved by Ali, 2026-06-21. Next step: writing-plans skill to generate week-by-week implementation plan.*
