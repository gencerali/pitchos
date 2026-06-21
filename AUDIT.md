# Pitchos — Structured Code Audit & Method Analysis
> Generated: 2026-06-21 | Branch: claude/pitch-dev-resources-n3yb3e | Commit: e7df628

---

## Table of Contents

1. [Architecture Snapshot](#1-architecture-snapshot)
2. [Multi-Tenancy Assessment](#2-multi-tenancy-assessment)
3. [Urgent Changes Required](#3-urgent-changes-required)
4. [Tech Debt Inventory](#4-tech-debt-inventory)
5. [Security Assessment](#5-security-assessment)
6. [Phase B Gamification — Independent Analysis](#6-phase-b-gamification--independent-analysis)
7. [Method B (Story Agent) — Independent Analysis](#7-method-b-story-agent--independent-analysis)
8. [Reusable Audit Prompts](#8-reusable-audit-prompts)

---

## 1. Architecture Snapshot

### Layers

| Layer | Technology | Files |
|-------|-----------|-------|
| Frontend | Cloudflare Pages + Vanilla JS (no framework) | `index.html`, `tribun.html`, `profil.html`, `liderlik.html` |
| Gamification Engine | Browser JS + Supabase Auth | `gamification.js` (48KB, central) |
| API Functions | Cloudflare Pages Functions | `functions/api/**` (~20 endpoints) |
| Content Pipeline (A) | Cloudflare Worker + Cron | `worker-fetch-agent.js` (864KB) |
| Content Pipeline (B) | Cloudflare Worker + Cron | `worker-story-agent.js` (18KB, **disabled**) |
| Database | Supabase PostgreSQL (RLS + Auth) | — |
| PM Automation | Telegram bot Worker | `pm-agent/` |

### Data Flow

```
RSS + APIs → worker-fetch-agent → score/classify → content_items table + KV cache
                                                                  ↓
                                            [Method B, if enabled]
                                    worker-story-agent → cluster → synthesize → topics table
                                                                  ↓
Frontend HTML ← /api/* (Pages Functions) ← Supabase (profiles, xp_events, badges, predictions...)
```

### Architectural Decisions (from git history)

| Decision | When | File | Rationale |
|----------|------|------|-----------|
| Multi-tenant `sites` table with per-domain lookup | Early 2024 | `_shared/site.js` | Single deployment for multiple fan sites |
| Story Worker isolated from Fetch Worker | 2025 | `wrangler-story.toml` | Avoid CPU limits during hourly synthesis |
| Method B disabled via KV flag | 2025 | `methodb:enabled` = 0 | Quality/cost concern; activation plan not documented |
| Bot seeding (2000 synthetic users) | 2025 | — | Bootstrap leaderboard before real user base |
| Dynamic `source_configs` table created | 2025 | `src/fetcher.js:92-117` | Per-site RSS overrides — **never wired into main fetcher** |
| Weekly Monday UTC reset for leagues | B2.2 | `league/index.js` | Consistent weekly cycle across timezones |

---

## 2. Multi-Tenancy Assessment

### Summary Verdict

> **API + Gamification layer: production multi-tenant ready.**
> **Content pipeline: single-club only. Requires refactor for second sport or club.**

### What Works (API Layer)

Every `/api/*` endpoint calls `getSiteId(request, env)` via `_shared/site.js`. This resolves the site from the HTTP hostname against the `sites` table — no hardcoded IDs anywhere in the function code.

All critical tables scoped correctly:
- `xp_events`, `profiles`, `user_badges` → `site_id` filter on every query
- `score_predictions`, `starting_elevens`, `poll_votes` → site-scoped
- `leaderboard_*` views → site-scoped
- `article_comments`, `article_reactions` → `site_id` column present and used

### What Breaks (Content Pipeline)

| Issue | File | Line | Impact |
|-------|------|------|--------|
| `BJK_KEYWORDS` hardcoded (81-line list) | `src/utils.js` | 25–106 | Cannot filter content for any other club |
| RSS_FEEDS static list of 13 Turkish sports sources | `src/fetcher.js` | 54–87 | No per-site source selection despite `source_configs` table existing |
| `bjkMatch()` function checks club-specific player names and stadiums | `src/fetcher.js` | 27 | Misclassifies non-BJK content as relevant |
| Sports templates baked in (injury, transfer, match day) | `worker-fetch-agent.js` | 360–480 | Template language and structure are football/Turkish-specific |
| Turkish-only moderation blocklist | `worker-fetch-agent.js` | 104–144 | Comments in other languages bypass moderation entirely |
| Auth redirect hardcoded to `kartalix.com` | `gamification.js:557`, `profil.html:1247` | — | Password reset goes to wrong domain for second-tenant sites |
| `ALLOWED_ORIGINS` list | `worker-fetch-agent.js` | 68 | Blocks CORS for any domain not in the list |

### Multi-Tenancy Fix Priority

**Do now (1-day fixes):**
1. Replace `emailRedirectTo: 'https://kartalix.com'` → `window.location.origin` in `gamification.js:557` and `profil.html:1247`
2. Add `kartalix.com/*` wildcard or dynamic origin to `ALLOWED_ORIGINS`
3. Wire `source_configs` table into `fetchRSSArticles()` — the read function already exists at `fetcher.js:92-117`, it just isn't called

**Do next sprint:**
4. Move `BJK_KEYWORDS` to `sites.keyword_config` JSON column; fall back to hardcoded list if null
5. Parameterize `bjkMatch()` to accept site-specific keyword config
6. Add `site.moderation_language` config; pass to moderation worker

**Long-term (before second club):**
7. Plugin architecture for sports templates
8. `sites.sport_type` column (`football|basketball|volleyball`) to route template selection

---

## 3. Urgent Changes Required

### CRITICAL — Fix Before Any New Tenant Goes Live

**C1. Auth Redirect URLs Hardcoded**
- Files: `gamification.js:557`, `profil.html:1247`
- Issue: `emailRedirectTo: 'https://kartalix.com'` — second-site users get wrong redirect on password reset
- Fix: `window.location.origin + '/reset-password'`
- Effort: 5 minutes

**C2. CORS Breaks for New Domains**
- File: `worker-fetch-agent.js:68`
- Issue: `ALLOWED_ORIGINS` is a hardcoded array; adding a second domain requires redeploy
- Fix: Dynamic CORS check from `getActiveSites()` sites table, or wildcard for owned domains
- Effort: 2 hours

**C3. Method B Inert — KV Cost Without Value**
- File: `worker-story-agent.js`, `wrangler-story.toml`
- Issue: Worker deployed and running hourly cron allocations but `methodb:enabled = 0` means nothing is produced; Cloudflare CPU time wasted for months
- Fix: Either activate it with a plan (see Chapter 7) or undeploy until ready
- Effort: Decision needed; 30 min to undeploy

**C4. `source_configs` Table Never Queried**
- File: `src/fetcher.js:92-117`
- Issue: Functions `fetchSourceConfigs()` and `configsToRSSFeeds()` are implemented and exported but never called; per-site RSS overrides silently don't work
- Fix: Add `const dynamicFeeds = await fetchSourceConfigs(supabase, siteId); const feeds = dynamicFeeds.length ? dynamicFeeds : RSS_FEEDS;` at top of fetch loop
- Effort: 1 hour

### HIGH — Fix Within Next Sprint

**H1. No A/B Testing Infrastructure**
- League thresholds, XP caps, multipliers all hardcoded
- Cannot measure if changing daily checkin from 50 XP to 30 XP improves retention
- Fix: `xp_configurations` table with start/end dates; admin UI to create experiments

**H2. Rate Limiting — SQL Count Query Per Request**
- `xp.js:isRateLimited()` runs `SELECT COUNT(*)` from `xp_events` on every XP award
- Estimated load: 5K DAU × 10 checks/day = 50K extra Supabase queries/day
- Fix: Redis/KV-based sliding window counter keyed by `user_id:action:day`

**H3. XP Events Not Auditable**
- `xp_events` has no `ip_address`, `user_agent`, or `admin_note` columns
- Cannot investigate XP farming or exploits retroactively
- Fix: Add columns; log at award time

**H4. Internal Secret Has No Rotation Mechanism**
- `/api/xp/evaluate-predictions` uses `X-Internal-Secret` header
- Single value in env vars, no expiry, no rotation plan
- Fix: Short-lived HMAC tokens with 15-min TTL; rotate via cron

**H5. League Thresholds Seasonal — Hardcoded**
- `league/index.js:6-12` — `TIERS` array never changes between seasons
- End-of-season reset has no mechanism; just weekly XP window
- Fix: `league_seasons` table with tier configs and start/end dates

### WATCH — Flag for Future Planning

- PWA has manifest but no service worker (push notifications will not work without it)
- Bot seeding without seasonal decay (bots will dominate 3-year-old leaderboard positions)
- Prediction evaluation cron has no retry on partial failure
- Comment likes award XP to comment author asynchronously — no dedup guard if like is toggled multiple times rapidly

---

## 4. Tech Debt Inventory

| Item | Severity | File | Notes |
|------|----------|------|-------|
| `index.html` is 5000+ lines inline CSS + JS | High | `index.html` | 196KB on every load; untestable; single SPA file is an architectural constraint |
| `BJK_KEYWORDS` 81-line hardcoded list | High | `src/utils.js:25-106` | Must move to DB config |
| Dead RSS feed (Fanatik, 404) | Low | `src/fetcher.js:66-67` | Commented out; remove entirely |
| `NEXT_MATCH` fixture hardcoded for BJK vs Gaziantep | Low | `worker-fetch-agent.js:47-66` | Demo data; remove before launch |
| Accuracy leaderboard endpoint exists but not wired to UI | Medium | `/api/leaderboard/accuracy` | Full `/liderlik` tab is missing |
| PWA manifest present, service worker absent | High | `manifest.json` | PWA install works; push notifications do not |
| Sound config inline in `gamification.js` | Low | `gamification.js:105-189` | 85 lines; extract to config object |
| AI poll generator (Phase 7.A) documented but not started | Low | `NEXT.md` | Long-term; needs Haiku integration |
| Email digest (B3.3) documented but infrastructure absent | Medium | `NEXT.md` | Needs Resend SDK + template |
| Magic scoring thresholds in `publisher.js` | Medium | `publisher.js:114,140` | `nvs >= 70`, `15 * 60 * 1000` etc. — move to config |
| Timezone handling inconsistent across XP chain | Medium | `_shared/xp.js:98-111` | Local day start passed as param vs UTC midnight comparison |
| No semantic versioning | Low | `deploy.sh` | Commit-hash tags work but no changelog automation |

---

## 5. Security Assessment

### Strengths

- RLS on all Supabase tables; frontend can only read user's own data
- Service role key strictly backend; never exposed to client
- Rate limiting on `/api/xp/react` and `/api/xp/comment` via DB sliding window
- AI (Haiku) toxicity check on comment submission
- Shadow ban mechanism implemented
- Secrets not in git (env vars in wrangler.toml, not committed)
- HMAC token for article-read/video-watch XP prevents replay

### Gaps

| Gap | File | Risk | Fix |
|-----|------|------|-----|
| No IP-based rate limiting | `xp.js` | VPN rotation bypasses time-window limits | Cloudflare WAF rate limiting by IP + Turnstile on high-value XP actions |
| Comment moderation fail-open | `worker-fetch-agent.js:205-233` | AI errors approve borderline content | Log all verdicts; queue flagged-but-approved for human review |
| Admin panel protected by session cookie only | `/admin/*` | Hijacked session = full admin access | Add Cloudflare Access or 2FA for admin routes |
| No moderation audit trail | — | Cannot investigate false positives/negatives | Log every AI moderation decision: content hash, verdict, confidence |
| Prediction cron uses single internal secret | `evaluate-predictions.js` | Secret exposure = mass XP award | HMAC with expiry (see H4 above) |
| `is_bot` column self-declared on profile | `profiles` | User can self-flag as bot to escape leaderboard | Make `is_bot` admin-only write |

---

## 6. Phase B Gamification — Independent Analysis

> This chapter is an independent critique of the B-series gamification boost plan (B1–B4). It assesses the methodology, not just the implementation.

### 6.1 What the B-Series Gets Right

**The progression architecture is sound.**
B1 (quick wins) → B2 (retention loop) → B3 (social/viral) → B4 (depth/seasonal) is a textbook engagement funnel. You don't start with viral features because you have no users yet. You start with features that make existing users feel more invested, then give them reasons to bring friends. The sequencing is correct.

**Weekly leagues are the strongest feature.**
Leagues create a recurring urgency that daily check-ins alone cannot. The Monday reset means every week is a fresh race. The 5-tier system (Bronz → Elmas) gives players a long-term aspiration. Promotion/relegation zones create real stakes without punishing casual users. This is well-designed.

**Quest rotation is clever because it shapes content consumption.**
Rotating 7 quest sets by day-of-week means the platform can steer engagement toward specific features on specific days without the user noticing they're being steered. This is architecturally flexible — changing a quest set changes user behavior for that weekday.

**Streak revival is a psychologically honest feature.**
Spending 100 XP to revive a streak is a real cost-benefit decision. It keeps streaks meaningful (they can break) while giving invested users a safety valve. The 7-day cooldown prevents it from becoming trivial. The negative XP ledger row is transparent — the transaction is visible to the user.

**The B2.S/B3.S/B4.S sound design sidecars are the right idea badly executed.**
Attaching a sound design component to each phase was wise — audio feedback dramatically increases perceived reward. The execution (iOS still broken) reveals a platform assumption problem: this product runs in mobile web browsers where the audio model is adversarial by design.

### 6.2 What the B-Series Gets Wrong

**The XP economy is unbalanced and unmeasured.**
Daily check-in: 50 XP. Read 10 articles: 50 XP. Watch 5 videos: 50 XP. Comment 5 times: 25 XP. The economy treats all engagement as roughly equivalent, but article reading drives content discovery and commenting drives community. No data was used to set these values and no mechanism exists to change them via experiment. The numbers are educated guesses published as law.

**B3 (social/viral) is 0% done and it's the phase that unlocks growth.**
B1 and B2 improve retention of existing users. B3 is the growth engine. Shareable result cards after predictions resolve would be the single highest-ROI feature in the entire roadmap — a user sharing "I predicted the exact score" is organic acquisition. It has been documented for months and not started. This is the correct feature to prioritize next.

**The league system assumes enough real users to function.**
"Top 20% promoted, bottom 20% relegated" only works with enough humans in each tier to make the races meaningful. With ~2000 bots and an unknown real user count, the competition may be mostly bots racing bots. The system needs a real-user floor before leagues feel competitive.

**Bots seeded but never deprecated.**
2000 synthetic users bootstrap the leaderboard, which is the right decision early. But bots accumulate stale positions. A real user who joins 6 months from now will never crack the top 100 if bots have compounded XP since launch. Bots need seasonal reset or expiry logic.

**No data layer to validate any assumption.**
There is no analytics layer recording cohort retention, feature adoption, or XP distribution curves. The B-series is designed on product intuition — good intuition, but untested. Without measurement, B3 and B4 will be built on the same intuition with no way to learn from B1 and B2's outcomes.

**B4 Seasonal Events require calendar coordination not yet infrastructure.**
Double XP windows "tied to derby fixtures" need match scheduling data integrated into the XP engine. Upcoming match API exists but the link between fixture calendar and XP multiplier activation does not.

### 6.3 Missing Pieces

| Gap | Why It Matters |
|-----|----------------|
| Analytics / funnel visibility | Cannot know if B1/B2 actually improved retention |
| Notification layer | Push, in-app, email all absent or incomplete; features go unnoticed |
| Email digest (B3.3) | Monday morning re-engagement email is the cheapest retention lever; still not started |
| Service worker | PWA install works; push notification opt-in does not |
| League health monitoring | No admin visibility into whether leagues have enough real participants |
| XP economy experiments | No way to test changing any threshold without a code deploy |

### 6.4 Scaling Risks

- **Leaderboard query cost** grows linearly with users; materialized views help but need scheduled refresh
- **Quest progress computation** re-queries `xp_events` on every `/api/quests` call; no caching
- **Rate limit check** runs a `COUNT(*)` SQL query per XP award; will not survive 50K+ DAU
- **Badge evaluation** re-checks all 21+ badge conditions on every XP event; quadratic at high frequency

### 6.5 Independent Verdict

Phase B is the right roadmap in roughly the right order. The implementation quality is high — the badge progress bars, streak revival flow, and league tier system are all genuinely well-built. The methodology shows clear product thinking.

The critical gap is measurement. Every decision in B1 and B2 was based on prior art (Duolingo, Robinhood, sports apps) rather than pitchos-specific data. That's acceptable for a zero-to-one product. But B3 and B4 should not be built the same way. Before starting B3, instrument retention curves for users who engage with leagues vs. those who don't. That data will tell you whether B3 should be shareable cards, push notifications, or something entirely different.

**Priority recommendation:** B3.1 Shareable Result Card is the single highest-ROI item in the entire backlog. Implement it before anything in B4.

---

## 7. Method B (Story Agent) — Independent Analysis

> Method B refers to `worker-story-agent.js` — a separate Cloudflare Worker that clusters raw articles from multiple sources into narrative stories using Claude Sonnet. It has been deployed but disabled (`methodb:enabled = 0` in KV) for several months with no documented activation plan.

### 7.1 What Method B Is

Method B is a **story correlation and synthesis pipeline** layered on top of the raw article feed:

1. **Cluster:** Groups recent `content_items` (last 24h) by shared topic using `sharedStoryTokens()` — a simple TF-IDF token-overlap algorithm
2. **Gate:** Only proceeds with synthesis if a story meets all four criteria:
   - 3+ contributing articles
   - 2+ articles within the last 6 hours
   - Max NVS score ≥ 60 from an external (non-official) source
   - 2+ distinct source families (prevents single-source recap)
3. **Extract:** Calls Claude Haiku to pull structured facts (date, key figures, key events) from each article to prevent hallucination in the synthesis step
4. **Synthesize:** Calls Claude Sonnet with the extracted facts (not raw article text) to generate a coherent narrative combining all sources
5. **Publish:** Stores in `topics` + `topic_edges` tables, drives a state machine: `draft → confirmed → published`

### 7.2 Independent Opinion

**The synthesis gate is the best design decision in the entire codebase.**

Requiring 2+ distinct source families before synthesis prevents the most common failure mode of automated journalism: one source writes something, other sources copy it, a model synthesizes the copies and presents it as multi-source confirmation. The gate catches this. It's genuinely novel safeguarding against hallucination-by-laundering.

**The fact-extraction step (Haiku before Sonnet) is also correct.**

Feeding extracted facts rather than raw article text to the synthesis model is the right architecture. Raw article text contains opinion, irrelevant context, and promotional language. Facts are structured, verifiable, and smaller — reducing both cost and hallucination risk in the synthesis step.

**TF-IDF token overlap for story clustering is the significant weakness.**

`sharedStoryTokens()` works by matching keywords between articles. This fails in predictable ways:
- Two articles about different matches both mention "Beşiktaş" and "goal" — incorrectly clustered
- An injury report and a match preview both mention a player's name — incorrectly clustered
- Articles in different languages (Turkish and English sources) with translation-mismatched keywords — not clustered when they should be

The correct approach is embedding-based semantic clustering (Supabase has `pgvector`; Cloudflare Workers AI has embedding models). Token overlap is a bootstrap that is now the production architecture.

**The hourly cron is too slow for breaking news.**

A goal is scored. Fifteen sources publish within 5 minutes. An hour later, Method B synthesizes them into a story that is now stale. For breaking sports news, synthesis needs to run within 10 minutes of the triggering event. This requires event-driven invocation (Supabase `NOTIFY`, Cloudflare Queue, or a webhook from the fetch agent) rather than hourly polling.

**The state machine is well-designed but lacks an editorial step.**

`draft → confirmed → published` assumes the model's output is publishable after crossing the synthesis gate. There is no step for human review, confidence scoring on synthesis quality, or rejection path. High-traffic sports news is high-stakes — a hallucinated injury claim or incorrect transfer report would damage credibility instantly.

**Why it has been disabled for months is the real question.**

The code is functional. The architecture is sound. The fact it has been sitting at `methodb:enabled = 0` for multiple months suggests one of:
- Quality of output wasn't meeting bar (synthesis quality below threshold)
- Cost concern (Sonnet synthesis per story × hourly runs)
- Activation blockers not documented anywhere
- It was deployed speculatively and never prioritized

This is a significant organizational debt: a 18KB worker running hourly cron allocations, representing weeks of engineering effort, producing nothing.

### 7.3 How Method B Would Handle Article & News Creation from Multiple Resources

This is Method B's primary purpose. Here is an honest evaluation of how well the current design handles multi-resource content creation:

**What it does well:**

- **Source diversity requirement** (2+ source families) forces the synthesized output to genuinely integrate multiple perspectives rather than paraphrasing one source
- **Trust tier weighting** (`trust_tier: official > broadcast > press > journalist > aggregator`) correctly privileges club announcements over press speculation
- **Fact extraction before synthesis** means the final story is grounded in verifiable claims from the original sources, not model-generated additions
- **The topics + topic_edges schema** maintains a traceable link from story back to contributing articles — this is the foundation of honest sourcing/citation

**What it does poorly:**

- **Conflict resolution is absent.** If Source A says the transfer fee is €15M and Source B says €20M, Method B has no mechanism to surface the conflict. The synthesis model will likely pick one or average them, neither of which is journalistically correct. The synthesis step needs a conflict-detection prompt that flags contradictions for human review.

- **No temporal updating.** A story is synthesized at 14:00. At 16:00, new articles arrive contradicting the 14:00 synthesis. Method B has no "update story" flow — it would create a new story or ignore the new articles if they cluster with the already-published story. Stories need version history and update triggers.

- **Recency scoring vs. trust scoring are not reconciled.** A breaking report from a low-trust Twitter journalist (high recency, low trust) vs. a confirmed official club statement from 2 hours ago (lower recency, high trust) — the synthesis gate prioritizes recency in its "2+ recent contributions" check without weighting trust. An official club statement should always override speculative reports regardless of timing.

- **No failure mode for synthesis quality.** If Claude Sonnet produces a synthesis that is incoherent or factually garbled, the state machine still advances it toward `published`. There is no quality gate after synthesis — no readability check, no fact-check against extracted inputs, no confidence score.

**How Method B should handle multi-resource article creation — recommendations:**

```
RECOMMENDED FLOW:
1. Trigger: Event-driven (new article arrives matching existing story cluster)
   NOT: Hourly cron

2. Cluster: pgvector semantic embedding similarity
   NOT: TF-IDF token overlap

3. Conflict detection: Compare extracted facts across sources; flag contradictions
   NEW STEP (not currently implemented)

4. Trust-weighted synthesis: Weight Sonnet prompt by source trust tier
   Partially done: trust_tier exists but synthesis prompt weighting unclear

5. Quality gate: Post-synthesis readability + fact-grounding check
   NEW STEP (not currently implemented)

6. Editorial review: Queue for human check if conflict score > threshold
   NEW STEP (not currently implemented)

7. Publish with citations: Link contributing articles in published story
   Done: topic_edges schema supports this

8. Update path: Trigger story update when new high-trust sources arrive
   NOT currently implemented
```

**On cost:** Sonnet synthesis per story + Haiku extraction per article is the correct model pairing. At 50 stories/day × (5 Haiku extractions + 1 Sonnet synthesis) ≈ 300 API calls/day. At current pricing, roughly €3-5/day. Manageable. The hourly cron running even when `enabled = 0` wastes Worker CPU time but not LLM cost (no calls made). The real cost risk is activation without a quality gate — a bug causing duplicate synthesis could spike cost rapidly.

### 7.4 Method B Activation Plan

If the decision is to activate Method B:

1. **Add conflict detection** — Before synthesis, compare extracted facts and flag contradictions
2. **Switch to event-driven trigger** — Pub/sub from fetch agent via Cloudflare Queue
3. **Add post-synthesis quality gate** — Confidence score check before advancing state
4. **Set a cost circuit breaker** — Max N synthesis calls/hour; log and alert on excess
5. **Add editorial queue view** — Admin UI showing `draft` stories awaiting human review
6. **Run in shadow mode first** — `methodb:enabled = 1` but `methodb:publish = 0` to generate stories without publishing; review quality for 2 weeks before activating publish

If the decision is not to activate it, undeploy the worker to stop burning cron allocations. The code is good enough to pick up again.

---

## 8. Reusable Audit Prompts

These prompts can be pasted into any future Claude Code session to regenerate or extend specific sections of this audit. Each prompt is self-contained.

---

### Prompt 1 — Multi-Tenancy Deep Scan

```
You are auditing the pitchos codebase at /home/user/pitchos for multi-tenancy readiness.

Context: The project is a Beşiktaş fan sports app (kartalix.com) built on Cloudflare Pages + Supabase. 
The goal is to support multiple sports team fan sites from one codebase.
site_id resolution: functions/api/_shared/site.js (hostname → Supabase sites table lookup)

Audit tasks:
1. Search for every hardcoded domain (kartalix.com), team reference (BJK, Beşiktaş), or 
   magic ID that would break a second tenant
2. List all /api/* endpoints; verify each calls getSiteId() before any data query
3. Check src/fetcher.js and src/utils.js for BJK_KEYWORDS, RSS_FEEDS, bjkMatch() — 
   are these per-site configurable or hardcoded?
4. Check gamification.js and profil.html for auth redirects — are they dynamic (window.location.origin) 
   or hardcoded URLs?
5. Check ALLOWED_ORIGINS in worker-fetch-agent.js — hardcoded or dynamic?
6. Check wrangler.toml and wrangler-story.toml for hardcoded values

Output: A table of all findings with file, line number, issue description, 
fix effort (5min/1hr/1day), and fix suggestion.
```

---

### Prompt 2 — Future-Proofing & Magic Values Scan

```
You are auditing the pitchos codebase at /home/user/pitchos for future-proofing issues.

Context: The project is a sports gamification platform with ~20 Cloudflare Pages Functions, 
a content pipeline worker, and a story synthesis worker. Stack: Cloudflare + Supabase + Vanilla JS.

Audit tasks:
1. Find all magic numbers and string literals that should be in config/DB:
   - XP amounts, daily caps, multipliers in functions/api/_shared/xp.js
   - League tier thresholds in functions/api/league/index.js
   - Scoring thresholds in src/publisher.js
   - Time constants (delay_ms, window durations)
2. Find all hardcoded external URLs that should be environment variables
3. Find all SQL queries without pagination or row limits
4. Find all functions/endpoints without error handling or logging
5. Identify any tight coupling — places where changing one system requires 
   changing another unrelated system
6. Check for any deprecated patterns (blocking I/O, synchronous DB calls in Workers)

Output: Priority-ordered list (CRITICAL / HIGH / MEDIUM / LOW) with file, line, 
issue, and concrete fix. Include estimated engineering effort.
```

---

### Prompt 3 — Phase B Gamification Health Check

```
You are analyzing the Phase B gamification system in the pitchos project at /home/user/pitchos.

Context: Phase B is a 4-phase "Gamification Boost Plan" built on top of a completed 8-phase 
gamification engine. The phases:
- B1: Quick wins (badge progress, prediction accuracy, streak revival, sound)
- B2: Retention loop (daily quests, weekly leagues, PWA)
- B3: Social/viral (shareable cards, community heatmap, email digest)
- B4: Depth/seasonal (seasonal events, match alerts)

Audit tasks:
1. For each B1/B2 feature, confirm its endpoint exists and is reachable:
   - /api/me (badge_progress field), /api/leaderboard/accuracy, /api/xp/streak-revival,
   - /api/quests, /api/league, manifest.json
2. Identify any B1/B2 features that exist as API but are NOT wired to the frontend
3. Read CLAUDE.md and NEXT.md — identify any discrepancy between "DONE" status and 
   actual code state
4. Count the XP action types in xp_actions table (via src/xp.js or functions); 
   verify daily caps make the economy coherent
5. Check quest progress computation in /api/quests.js — does it re-query xp_events 
   on every call? Would it survive 10K concurrent users?
6. Read league/index.js — are TIERS hardcoded? What happens at end-of-season?

Output: Status table for each B-phase feature (DONE/PARTIAL/NOT_STARTED/BROKEN) 
with evidence from code. Flag any features marked DONE in CLAUDE.md but incomplete in code.
```

---

### Prompt 4 — Method B Story Agent Activation Readiness

```
You are evaluating whether the pitchos "Method B" story synthesis worker is ready to activate.

Context: worker-story-agent.js is a Cloudflare Worker that:
1. Reads recent articles from Supabase content_items
2. Clusters them by topic using sharedStoryTokens() (TF-IDF token overlap)
3. Synthesizes each cluster into a narrative using Claude Sonnet
4. Stores output in topics + topic_edges tables
Currently disabled via KV flag: methodb:enabled = 0

Evaluate:
1. Read worker-story-agent.js in full. Map the complete data flow.
2. What is the synthesis gate (checkH5SynthGate)? Under what conditions does synthesis fire?
3. What happens if Claude API returns an error during synthesis? Is there a retry? A fallback?
4. Is there a cost circuit breaker? What is the max Sonnet calls per hour?
5. What does the published story look like in the DB? Is it surfaced anywhere in the frontend?
6. Does worker-story-agent.js have test coverage?
7. What would need to change to activate in "shadow mode" (synthesize but don't publish) 
   for a 2-week quality evaluation?

Output: Activation readiness score (0-10) with specific blockers listed, 
recommended changes before activation, and a shadow-mode activation checklist.
```

---

### Prompt 5 — Security & XP Integrity Audit

```
You are doing a security and XP integrity audit of the pitchos gamification platform 
at /home/user/pitchos.

Context: The system awards XP to authenticated users for: check-in, article reading, 
video watching, reactions, comments, shares, predictions, polls, starting-11 guesses.
Stack: Cloudflare Pages Functions + Supabase with service_role_key on the backend.

Audit tasks:
1. Map the XP award flow: where does auth happen? Where is site_id verified? 
   Where is rate limiting applied? (start from _shared/xp.js)
2. Find every XP endpoint that an authenticated user could spam to gain unlimited XP
3. For article-read and video-watch: verify the HMAC token flow. Can a user replay a token?
4. Check isRateLimited() — is the sliding window DB query consistent under concurrent requests?
   (Race condition: two simultaneous requests both pass the count check before either inserts)
5. Check comment submission flow: client-side blocklist → AI toxicity check → insert.
   What happens if the AI moderation service is down?
6. Is is_bot writable by the user themselves, or admin-only?
7. Are admin endpoints (/admin/*) behind any auth beyond session cookie?

Output: Threat model table: Attack vector | Current protection | Gap | Fix | Priority
```

---

### Prompt 6 — Content Pipeline Multi-Source Architecture Review

```
You are reviewing the content pipeline architecture in pitchos at /home/user/pitchos.

Context: The project has two content workers:
- worker-fetch-agent.js (864KB): RSS aggregation, scoring, classification, KV cache write
- worker-story-agent.js (18KB): Story clustering and synthesis from multiple sources (disabled)
- src/fetcher.js, src/publisher.js, src/utils.js: Core pipeline logic

The goal is to support multi-source article/news creation from: RSS feeds, Twitter, 
official club sources, beIN Sports, Reddit.

Review tasks:
1. Read src/fetcher.js in full. How are sources prioritized when multiple sources 
   cover the same story? Is there deduplication? By URL only, or by content similarity?
2. Read src/publisher.js. What are the 6-8 publication modes? Under what conditions 
   does a piece go to review_queue vs publish vs discard?
3. How does trust_tier affect scoring? Where is it applied in the pipeline?
4. Does the pipeline handle the case where a low-trust source breaks a story 2 hours 
   before the official club announcement? (i.e., speculative → confirmed update flow)
5. Is there any mechanism to RETRACT or UPDATE published content if a source 
   later corrects a story?
6. How would you add a 14th RSS source for a second club without touching the 
   keyword filtering logic?

Output: Architecture diagram (ASCII), 3 strengths, 3 critical gaps, 
5 concrete improvement recommendations with effort estimates.
```

---

*End of audit. This document covers commit `e7df628` as of 2026-06-21.*
*Regenerate sections using the prompts in Chapter 8.*
