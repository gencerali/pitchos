# Kartalix — Go-to-Market Project Plan
> Created: 2026-06-21 | Status: Living document | Owner: Ali

---

## What G2M Means for Kartalix

G2M is not a feature release. It is a condition:

> **A Beşiktaş fan lands on Kartalix, reads 3+ articles, bookmarks the site, and comes back tomorrow without being told to.**

Everything in this plan serves that condition. Three gates must pass before G2M is declared:

| Gate | Criterion | Current Status |
|------|-----------|---------------|
| **Content Gate** | Fan reads article and does not notice AI | ❌ Failing — obvious RSS rewrite |
| **Experience Gate** | Mobile design feels premium; gamification feels rewarding | ⚠️ Partial — functional but not premium |
| **Monetization Gate** | AdSense approved OR first paying revenue event | ❌ Blocked — AdSense rejected |

This plan is sequenced to open all three gates. Traffic and revenue follow gates, not the other way around.

---

## Methodology: The Challenge Sprint

Each week has ONE primary challenge. You do not move to the next challenge until the current one passes its gate. No exceptions.

```
[Challenge N] → Gate test → Pass → [Challenge N+1]
                           → Fail → Fix → Re-test (same week)
```

After G2M:
```
[Post-G2M Challenge] → [Traffic Challenge] → [Revenue Challenge] → ...
```

This prevents the most common G2M failure: shipping 10 half-done things instead of 3 finished ones. Every sprint ends with a yes/no gate answer, not a percentage.

**Weekly rhythm:**
- Monday: declare the week's challenge and its gate criterion
- Friday: test the gate — pass or fail; no partial credit
- Saturday (if fail): root cause + fix plan for next week
- Sunday: update this plan

---

## Priority Stack

Ordered strictly. Do not start a lower item while a higher item is incomplete.

```
P0 — Method B: Content Pipeline Replacement         ← opens Content Gate
P1 — Trust Score Display (NVS as reader-facing UI)  ← part of Content Gate
P2 — Design: Choose + Implement                     ← opens Experience Gate
P3 — Gamification: B3.1 Shareable Card              ← amplifies both gates
P4 — Security Hardening                             ← prerequisite for traffic
P5 — AdSense Resubmission                          ← opens Monetization Gate
P6 — Analytics (Analiz Page)                        ← post-G2M or parallel if no API cost
P7 — Worker Refactor                                ← schedule during P0 (natural timing)
P8 — Multi-tenancy Quick Fixes                      ← 1 day; do it during P2 setup
P9 — B3.2 Heatmap + B3.3 Email Digest              ← post-G2M retention
```

---

## P0 — Method B: Content Pipeline Replacement

**Why this is first:** The biggest single lever for the Content Gate. The current pipeline is an RSS rewriter. Method B makes Kartalix a fact-based news generator that writes original articles from multiple sources. This is the difference between "AI blog" and "editorial platform."

**Reference:** `docs/method-b-design.md` has a complete technical design. Build from that document. Do not redesign — execute it.

### Implementation Plan

**Stage 0 — Foundation (Challenge 1, Week 1)**

Gate: Method B worker runs in shadow mode, writes to `articles:BJK:methodb` KV key, without touching production. Zero disruption to live site.

- [ ] Add `pipeline` column to `content_items` (`legacy | methodb`) — additive migration
- [ ] Add `topics`, `topic_edges`, `phases` tables from `docs/method-b-design.md §3`
- [ ] Add `topic_id`, `phase_id` columns to `content_items` — additive, nullable
- [ ] Set up blue/green KV keys: `articles:{site}:legacy` (existing), `articles:{site}:methodb` (new)
- [ ] Wire `getCachedArticles` to read from `articles:{site}:{pipeline:active}` (one config flag)
- [ ] Set `pipeline:active = legacy` — no behavior change yet
- [ ] Deploy updated story worker writing only to `:methodb` key

**Stage 1 — Event Router (Challenge 2, Week 2)**

Gate: Official club announcements (transfers, injuries, lineup) publish as articles within 5 minutes of source appearance. No synthesis required for these — template-direct.

- [ ] Implement `news_mode` classifier at ingest: `event` vs `accretive`
- [ ] EVENT path: trust ≥ official tier → mint phase → fire template article immediately
- [ ] ACCRETIVE path: correlate to existing topic via entity fingerprint; update claim-track
- [ ] Implement entity fingerprint matching (player name, club, competition normalization)
- [ ] Rules pre-filter before any LLM delta call (see `docs/method-b-design.md §6.3`)
- [ ] Cost tag: `pipeline = methodb` on all `addUsagePhase` calls

**Stage 2 — Accretive Synthesis (Challenge 3, Week 3)**

Gate: A transfer story with 3+ sources produces one synthesized article combining all sources, clearly better than any single-source rewrite.

- [ ] `claim-track` delta detection (Haiku): compare new fact vs current track state
- [ ] Phase trigger: material delta → new phase → synthesis call (Sonnet, compact facts)
- [ ] Dedup key: `synth:{topic}:{phase}:{entity}`
- [ ] Fan-out: single phase → N articles by entity where applicable
- [ ] Synthesis gate check (`checkH5SynthGate`): 3+ contributions, 2+ source families, max NVS ≥ 60
- [ ] Conflict detection: flag contradictions (fee €15M vs €20M) → queue for review, don't pick one silently

**Stage 3 — Quality Gate (Challenge 4, Week 4)**

Gate: 10 consecutive Method B articles reviewed by you pass the "real editor" test — no AI tells, no hallucinated facts, correct timing.

- [ ] Post-synthesis readability check (Haiku) before advancing state to `confirmed`
- [ ] Fact-grounding verification: synthesized article does not contradict extracted facts
- [ ] Scandal/şike topic: require official/court-level confirmation; never fire on aggregator rumor (see `docs/method-b-design.md §8`)
- [ ] Admin panel: `/admin/pipeline` showing `articles:BJK:legacy` vs `articles:BJK:methodb` side by side
- [ ] Quality metrics: volume · latency · €/article · dedup-thrash rate

**Stage 4 — Cutover (Challenge 5, Week 5)**

Gate: `pipeline:active = methodb` set in production. Live site reads Method B articles. No 404s. No regression.

- [ ] Cold-start gate: only allow flip when ≥ 20 fresh Method B articles in pool
- [ ] Edge cache purge wired to the flip handler (current ~12h TTL must not delay visible swap)
- [ ] URL persistence verified: old article slugs still resolve (Supabase by slug, not KV)
- [ ] Rollback: `PUT pipeline:active = legacy` (< 1 min, no deploy needed)
- [ ] Legacy continues writing to `:legacy` for 2 weeks as warm rollback insurance
- [ ] After 2 weeks stable: disable legacy LLM work (keep fetch + pre-filter for feed health)

### Decisions Needed Before Building

1. **Do you activate `branch_of` / `sequel_of` topic edges in v1?** Recommendation: no. Trunk-only first (simplest path, still dramatically better than legacy). Add branch machinery in v2.
2. **Event-driven (Cloudflare Queues) or polling for Stage 4?** Recommendation: polling cursor (`facts_extracted_at IS NULL`) for v1; upgrade to Queues post-G2M.
3. **Shadow run duration before cutover?** Recommendation: minimum 2 weeks, with 10-article human review every 3 days.

---

## P1 — Trust Score Display (NVS as Reader-Facing UI)

**Why this matters:** Requirement #3 — rumors on homepage with a visible trust indicator. This turns a potential weakness (AI-generated, uncertain sourcing) into a feature (honest editorial transparency).

**Design decision needed:** What do we call the score? Options:
- **"Güvenilirlik"** (Reliability) — clear but dry
- **"Kartalix Skoru"** — branded, mysterious but fun
- **"Haber Gücü"** (News Power) — energetic
- **"KX"** — minimal, badge-style

**Implementation:**

- [ ] Surface NVS on article cards as a visual indicator (not a raw number)
  - NVS 80–100 → ✓ "Doğrulandı" (dark badge)
  - NVS 60–79 → ● "Güvenilir" (medium badge)
  - NVS 40–59 → ◑ "İddia" / rumor (yellow badge)
  - NVS 0–39 → ○ "Spekülasyon" (faint badge)
- [ ] Rumor articles shown on homepage with visual rumor tag — not hidden
- [ ] Tooltip or info modal: "Bu skor nasıl hesaplanır?" (brief explanation)
- [ ] Article page: show contributing source count + trust tier breakdown for Method B articles

**Decision needed:** Show NVS on homepage cards (visible trust signal) or only on article page (less noise)? Recommendation: homepage card — it differentiates Kartalix from generic news aggregators.

---

## P2 — Design: Selection + Implementation

**Context:** Three mockup directions exist:
- `mockups/a-broadcast/` — Broadcast style
- `mockups/b-editorial/` — Editorial style
- `mockups/c-magazine/` — Magazine style

**My recommendation without seeing them:** For a news platform targeting Google traffic + AdSense, **editorial style** (b-editorial) typically performs best:
- Higher content density → more articles above fold → better crawlability
- Editorial typography signals credibility to both humans and Google
- Magazine style is beautiful but slow to load and hard to SEO
- Broadcast style is great for live scores but weak for article depth

**You must make the selection.** Once selected, execute fully on that direction — no hybrid.

**Scope of redesign:**

- [ ] **Homepage** — article card grid, trust badge integration, hero layout, video rail placement
- [ ] **Article page** — typography, reading width, source attribution block, gamification overlays
- [ ] **Tribün page** — prediction card, quest banner, league widget layout
- [ ] **Profil page** — badge grid, XP feed, prediction history tabs
- [ ] **Mobile-first throughout** — target 375px as primary design width; test on real iPhone
- [ ] **Logo revision** — open question; if changing, do it before AdSense resubmission

**Things NOT AI-looking:**
- Real editorial serif/sans-serif font pairing (not system fonts)
- Photographer credit + image attribution on every article
- Human-feeling timestamps ("3 saat önce" not "2026-06-21T14:32:00Z")
- Comment count + reaction count visible on cards (social proof signals)
- "Son dakika" (breaking news) label with proper styling — not a colored dot

**Multi-tenancy quick fixes (do during P2 setup — 1 day):**
- [ ] `gamification.js:557` → `window.location.origin + '/reset-password'`
- [ ] `profil.html:1247` → same fix
- [ ] `worker-fetch-agent.js:68` → dynamic CORS from `getActiveSites()` or domain wildcard
- [ ] Wire `source_configs` table into `fetchRSSArticles()` (function already exists, never called)

---

## P3 — Gamification: B3.1 Shareable Result Card

**Why now:** This is the single highest-ROI backlog item. After a prediction resolves, a user who predicted the exact score gets a shareable card. They post it on Twitter/Instagram. This is organic acquisition — every share is a Kartalix impression.

**Why before other B3/B4 items:** All other B3/B4 items are retention (email, heatmap, push). Shareable card is the only acquisition mechanic in the entire backlog. Acquisition before retention.

**Implementation:**
- [ ] Canvas-based card generator (HTML Canvas → PNG via `toDataURL`)
- [ ] Card shows: user avatar/name · predicted score · actual score · accuracy badge · Kartalix logo
- [ ] Trigger: prediction evaluation cron marks `exact_score_bonus` → frontend checks on next load
- [ ] Share button on Tribün page → Web Share API (mobile) with PNG fallback (desktop copy)
- [ ] Dynamic OG image generated server-side for social preview (Cloudflare Worker → Satori or Canvas)
- [ ] XP award for sharing the card (`share_prediction_card` action, 10 XP, daily cap 1)

**Service worker (prerequisite for push notifications):**
- [ ] `service-worker.js` — offline cache + push subscription handler
- [ ] `navigator.serviceWorker.register('/sw.js')` in all HTML pages
- [ ] Push subscription stored in `profiles.push_subscription` (JSON)
- This unblocks B2.3 and B4.3 match alerts without requiring a separate session

---

## P4 — Security Hardening

**Do before any traffic increase. Non-negotiable.**

From the audit, priority order:

**Do immediately (1 day):**
- [ ] Admin endpoints (`/admin/*`) → add Cloudflare Access rule (Zero Trust, free tier); no code change required
- [ ] `is_bot` column → make admin-only write in Supabase RLS policy (currently user-writable)
- [ ] Comment moderation fail-open → log all AI verdicts to `moderation_log` table; never silent

**Do before launch:**
- [ ] IP-based rate limiting on XP endpoints → Cloudflare WAF rate limit rule (no code change)
- [ ] Cloudflare Turnstile on check-in and comment submission (bot protection)
- [ ] Internal cron secret → rotate to short-lived HMAC (see audit H4)
- [ ] Audit log columns on `xp_events`: add `ip_hash`, `user_agent_hash` (hashed, not raw, for GDPR)
- [ ] Prediction evaluation cron: add retry on partial failure + idempotency guard

**Do after launch:**
- [ ] KV-based rate limiting replacing SQL COUNT queries (see audit H2)
- [ ] League tier configurations in DB (see audit H5)

---

## P5 — AdSense Resubmission

**Context:** Previously rejected for "valuable inventory." Root cause was video dominance on homepage and thin content. NVS Harmonization addressed homepage cleanup. Method B will address content quality.

**Checklist before resubmitting:**
- [ ] Method B live and producing ≥ 20 quality articles/day
- [ ] Homepage: article content dominant, video rail secondary
- [ ] All article pages have proper attribution, author (can be "Kartalix Editörü"), and published date
- [ ] Privacy policy updated and linked in footer
- [ ] About page (`/hakkimizda`) complete and credible
- [ ] No thin pages (< 300 words) in sitemap
- [ ] `ads.txt` confirmed correct and accessible at `/ads.txt`
- [ ] Minimum 90 days of consistent content (check your domain age vs application date)

**Other monetization (parallel to AdSense):**
- Affiliate: Beşiktaş shop links (club affiliate program if available)
- Premium: prediction accuracy badge — "Kartalix Pro" early concept (post-G2M)
- Sponsorship: local sports equipment brands for banner placement

---

## P6 — Analytics (Analiz Page)

**Decision needed:** Do you buy a data API before G2M?

**Current state:** API-Football already integrated (`src/api-football.js`). Mockups exist at `mockups/*/analiz.html`. Three design directions already have analiz pages designed.

**Recommendation — do not buy premium data API before G2M:**
- You have zero traffic; the API cost is pure overhead with no return yet
- API-Football free tier covers: standings, results, upcoming fixtures, squad data
- Build the Analiz page using what you already have; it can go live before G2M
- Post-G2M, once you have 1K+ daily users, evaluate Opta or StatsBomb for premium stats

**Analiz page scope (with free API-Football):**
- [ ] Season standings with BJK highlighted
- [ ] Last 5 results with scorers
- [ ] Next fixture countdown
- [ ] Squad list with positions
- [ ] Form chart (W/D/L last 10)
- [ ] Goal stats (scored/conceded per game)

**Lock the templates (`mockups/*/analiz.html`) first, then build.** All three mockups have this page — once design direction is chosen, the template exists.

---

## P7 — Worker Refactor

**Context:** `worker-fetch-agent.js` is 864KB / 14,768 lines. This is a maintenance and debugging hazard but not a runtime hazard (Cloudflare Workers has a 1MB bundle limit; you have headroom).

**Right time to refactor:** During Method B implementation, not before and not after.

**Why during Method B:**
- Method B already lives in a separate worker (`worker-story-agent.js`)
- The refactor is partly happening naturally: synthesis/intelligence moves to Method B worker
- What remains in `worker-fetch-agent.js` after cutover: RSS fetch, pre-filter, NVS scoring, KV writes
- That residual is roughly 40% of current size — no surgery needed, just natural decomposition

**Approach:**
1. Do NOT refactor `worker-fetch-agent.js` before Method B cutover — destabilizing
2. After Method B Stage 4 cutover, `worker-fetch-agent.js` loses: `synthesizeArticle()`, `generateOriginalNews()`, `story-matcher` calls, all `topics/phases` writes
3. What remains after cutover is the correct split: fetch agent = ingest only; story agent = intelligence
4. At that point, evaluate if the remaining 6K lines need module splitting — probably they don't

**If bundle size becomes a Cloudflare issue before Method B (unlikely):** Move `src/*.js` to separate modules and use `export/import` — Cloudflare Workers supports ES modules natively.

---

## P8 — Multi-Tenancy Quick Fixes

**Philosophy:** Multi-tenancy is not P1 for G2M. Kartalix needs one great site before two mediocre ones. But 4 quick fixes prevent future pain at near-zero cost.

All in one PR, ~1 day:

| Fix | File | Change |
|-----|------|--------|
| Auth redirect | `gamification.js:557` | `window.location.origin + '/reset-password'` |
| Auth redirect | `profil.html:1247` | Same |
| CORS origins | `worker-fetch-agent.js:68` | Dynamic from `getActiveSites()` or owned-domain wildcard |
| Source configs | `src/fetcher.js` | Call `fetchSourceConfigs()` at top of fetch loop; fall back to static list |

Everything else in the multi-tenancy audit: defer until second site is confirmed and paying.

---

## P9 — Post-G2M Retention (B3/B4)

Do not start these before G2M. Build them once you have real users to retain.

**In order of impact after G2M:**

1. **B3.3 Email Digest** — Monday morning re-engagement email is the cheapest retention lever. Resend SDK, 1 Cloudflare Worker, 1 template. ~3 days work.
2. **Service Worker + Push** (if not done in P3) — match-day reminder + streak-break warning
3. **B3.2 Community Heatmap** — score distribution after lock; requires ≥ 100 real predictions to look meaningful
4. **B4.1 Seasonal Events** — double XP for derbies; requires match calendar integration with XP multiplier
5. **B4.3 Match Alerts** — WhatsApp/Telegram channel opt-in; ops cost but high retention value

**Bot decay (do 3 months post-G2M):**
- Add `bot_expires_at` column; weekly cron reduces bot XP by 5% preventing permanent dominance
- Seasonal reset for bots so real users can crack top 100

---

## Descoped Items

These are explicitly out of scope for G2M. Re-evaluate after first revenue.

| Item | Reason |
|------|--------|
| AI Poll Generator (Phase 7.A) | No traffic = no poll engagement; manual polls sufficient |
| Weekly Email Digest before launch | No users to email |
| Match Alerts (WhatsApp/Telegram) | Ops overhead; post-G2M |
| A/B testing infrastructure | Need 1K+ DAU before experiments are statistically valid |
| Multi-sport / second sport support | One sport, one club, one quality site first |
| Full `branch_of`/`sequel_of` topic edges (Method B v2) | Trunk-only for v1 cutover |
| Opta/StatsBomb data API | No traffic = no ROI on data cost |
| Separate Supabase projects per tenant | Massive ops complexity; no second tenant yet |
| B4.2 Accuracy Leaderboard Tab | B1.2 endpoint exists; add UI tab post-G2M |

---

## Things You Missed (or Haven't Explicitly Planned)

**SEO — you have no SEO strategy documented anywhere:**
- [ ] Turkish sports news SEO is highly competitive. Kartalix's edge: AI-generated original synthesis (if detected by Google = penalty; if genuinely original = advantage)
- [ ] Every article needs: unique `<title>`, `<meta description>`, canonical URL, proper `<h1>`
- [ ] Structured data: `NewsArticle` schema markup on article pages → rich results in Google
- [ ] Sitemap freshness: ensure `sitemap.xml` updates within 5 minutes of new article publish
- [ ] Internal linking: "related articles" section on every article page (already partially done)
- [ ] Decision needed: Does Kartalix want Google to know articles are AI-synthesized? (Site-level `ai-content` declaration in robots meta)

**Social sharing mechanics (beyond shareable card):**
- Twitter/X share button on every article with pre-filled text including Kartalix URL
- WhatsApp share button (critical for Turkish mobile users)
- Open Graph tags on all article pages with article-specific image (currently generic)

**Content calendar / editorial strategy:**
- Before match: lineup speculation + predictions
- Match day: live score updates (even simple text-based is fine)
- After match: result synthesis (first Method B article type to nail)
- Mid-week: transfer rumors + injury updates
- Method B naturally handles this if the event router is correctly tuned

**Competitor analysis not documented:**
- What does NTV Spor do that Kartalix should match?
- What does Fanatik do that Kartalix should avoid?
- Where is the gap Kartalix actually fills?
- Decision: Is Kartalix positioning as faster than press (breaking news) or deeper than press (analysis)?

**Legal compliance ongoing:**
- Turkish IP lawyer consultation is done (2026-04-28) — keep the outcome documented
- AI-generated content disclosure: Turkish law is evolving; monitor
- Method B articles should include "Kartalix AI Editörü" byline — do not hide AI authorship

**Monetization beyond AdSense:**
- Once 5K+ daily users: direct sponsorship from sports equipment brands is faster money than AdSense
- "Kartalix Pro" membership (prediction accuracy history, advanced stats, no ads) — concept only, post-G2M

---

## Sprint Calendar (Suggested)

| Week | Challenge | Gate |
|------|-----------|------|
| 1 | Method B Stage 0: shadow worker + KV blue/green | Shadow worker writes articles to `:methodb` key; zero production impact |
| 2 | Method B Stage 1: event router + official announcements | Transfer announcement publishes within 5 min of source |
| 3 | Method B Stage 2: accretive synthesis | Transfer story from 3 sources → one synthesized article |
| 4 | Method B Stage 3: quality gate + admin panel | 10 consecutive articles pass human "real editor" test |
| 5 | Method B Stage 4: cutover + trust score display | `pipeline:active = methodb`; trust badge on all cards |
| 6 | Design decision + P2 implementation starts | Mockup chosen; homepage redesigned in chosen direction |
| 7 | Design P2 continued + multi-tenancy quick fixes | All pages redesigned; quick fixes merged |
| 8 | Security hardening (P4) | All P4 items checked off; Cloudflare Access on admin |
| 9 | B3.1 Shareable Prediction Card | Card generates + shares successfully on mobile |
| 10 | Service worker + AdSense prep | SW registered; all AdSense checklist items green |
| 11 | AdSense resubmission | Application submitted |
| 12 | Buffer / quality pass | Manual QA across all pages; fix anything that feels wrong |

**G2M declaration:** When AdSense approved (or first ad revenue event) + Content Gate + Experience Gate all pass simultaneously.

---

## Open Decisions Log

These require your input before building can proceed.

| # | Decision | Options | My Recommendation |
|---|----------|---------|-------------------|
| D1 | Method B: activate branch/sequel edges in v1? | Yes / No (trunk only) | **No — trunk first** |
| D2 | Trust score UI name | Kartalix Skoru / Güvenilirlik / Haber Gücü / KX | **Kartalix Skoru** |
| D3 | Trust score location | Homepage card / Article page only | **Homepage card** |
| D4 | Design direction | a-broadcast / b-editorial / c-magazine | **b-editorial** (recommendation; your call) |
| D5 | Logo change before G2M? | Yes / No / After G2M | Decide after D4 |
| D6 | Analiz page before G2M? | Yes (free API-Football data) / No / After | **Yes — free tier only** |
| D7 | AI content disclosure | "Kartalix AI Editörü" byline / No byline / Footer disclaimer | **Byline on all Method B articles** |
| D8 | G2M primary metric | AdSense approval / 1K DAU / 3-day retention ≥ 20% | **AdSense approval** (clearest signal) |
| D9 | Method B shadow mode duration | 1 week / 2 weeks / 3 weeks | **2 weeks minimum** |
| D10 | Analiz page data API purchase | Free API-Football only / Buy Opta or similar | **Free only pre-G2M** |

---

*Next action: Review open decisions D1–D10. Reply with your choices and sprint starts immediately.*
