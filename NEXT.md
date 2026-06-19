# Gamification To-Do

Track at: https://kartalix.com/admin/releases?site=BJK → expand "Gamification System"

---

## Phase 1 — Core Engine ✅ DONE

- [x] XP actions table, `awardXP()`, dedup, daily caps, streak multiplier
- [x] Level thresholds (20 levels, 5 tiers)
- [x] Daily check-in XP
- [x] Article read XP (10s dwell, server-side HMAC token)
- [x] Video watch XP (30s dwell, server-side HMAC token)
- [x] Central `gamification.js` meta-tag system
- [x] Leaderboard page `/liderlik` (5 tabs)
- [x] XP Admin Panel `/admin/gamification`
- [x] Profile page `/profil`
- [x] All XP backend endpoints written

---

## Phase 2 — Bugs & Quick Wins ✅ DONE

- [x] **2.1** Post-cap fallback XP — `cap_fallback_xp` col on `xp_actions`; +1 after daily cap
- [x] **2.2** Reaction XP — `react_article` action (+1, daily_cap=10); `/api/xp/react` endpoint; wired in SPA + Worker article page
- [x] **2.3** Streak bonus — auto-award `streak_5_bonus` (+50) every 5th checkin streak
- [x] **2.4** Share XP — wire `share_link` XP call to share buttons in SPA + Worker article page

---

## Phase 3 — Comment & Reaction System

- [x] **3.1** Fix comments not showing in SPA article view (`renderArticleView`)
- [x] **3.2** Slug-based keying — `article_comments` + `article_reactions` now use `article_slug` + `user_id`; no guest commenting (auth required)
- [x] **3.3** Comment XP — wire `/api/xp/comment` on successful submit
- [x] **3.4** Reply threading — `parent_id UUID` on `article_comments`, 1-level indented display
- [x] ~~**3.5** Guest commenting~~ — **cancelled**: require login to comment; guest CTA shown instead
- [x] **3.6** Moderation Layer 1 — client-side Turkish swear word blocklist (~50 terms)
- [ ] **3.7** Moderation Layer 2 — Claude Haiku toxicity check on `/api/xp/comment` POST. Needs `ANTHROPIC_API_KEY` in Cloudflare env.
- [ ] **3.8** Emotion reactions — 5 emotions: atesli/mutlu/uzgun/kizgin/hayal_kirikligi. Backend (`/api/sentiment.js`) and XP hook (`/api/xp/react`) are ready; needs: (a) schema migration to add `emotion` column on `article_reactions`, (b) update react.js to write `emotion` field, (c) replace like button with 5-emotion picker UI in `index.html` article view + article page.
- [ ] **3.9** Taraftar Nabzı widget — sentiment aggregation widget in article sidebar/bottom. `/api/sentiment.js` is fully built with 5-emotion breakdown + Turkish conclusion text. Needs: frontend widget in `index.html` article view that calls `GET /api/sentiment?slug={slug}` and renders a bar/summary.

---

## Phase 4 — Tribün / Community Features ✅ DONE

- [x] **4.1** Score prediction UI + `/api/xp/predict` wiring — `tribun.html`, `/api/upcoming-match`, 52 tests
- [x] **4.2** Prediction evaluation — `/api/xp/evaluate-predictions` (cron, `X-Internal-Secret` protected, fully tested in Phase 4.1)
- [x] **4.3** Starting 11 lineup guess — `/api/xp/starting-11`, `/api/squad`, UI card in `tribun.html` with duplicate guard + XP, 40 tests
- [x] **4.4** Poll voting — `/api/xp/poll-vote`, `/api/polls`, DB tables (`polls`, `poll_votes`), UI card in `tribun.html` with auth gate + results, 35 tests
- [x] **4.5** Tribün page `/tribun` — full community hub: score prediction + Starting 11 + Poll + community stats section

---

## Phase 5 — Profile & UX Polish ✅ DONE

- [x] **5.1** Profile: XP activity feed — rendered in `profil.html`, backed by `/api/me` (queries `xp_events`, last 20 rows, Turkish action labels + icons)
- [x] **5.2** Profile: badge grid — earned + locked-as-goals display
- [x] **5.3** Profile: prediction history tab — rendered in `profil.html`, backed by `/api/me` (queries `score_predictions`, shows predicted vs actual score, exact/outcome/wrong outcome indicator)
- [x] **5.4** Level-up notification — `window.kxShowLevelUp` in `gamification.js`, wired in checkin/article-read/video-watch and all three tribün XP handlers
- [x] **5.5** Badge unlock notification — `window.kxShowBadge` in `gamification.js`, wired same as 5.4
- [ ] **5.6** *(minor gap)* Wire badge + level-up notifications in `index.html` for comment / react / share XP handlers — those 3 success handlers currently don't call `kxShowBadge` / `kxShowLevelUp`

---

## Phase 6 — Schema Migrations

- [x] `xp_actions`: `cap_fallback_xp integer default 0`
- [x] `xp_actions`: insert `react_article` row
- [x] `article_comments`: add `article_slug`, `user_id`, `site_id`
- [x] `article_comments`: add `parent_id` (reply threading, Phase 3.4)
- [x] `article_reactions`: add `article_slug`, `site_id`
- [x] `polls`: add `starts_at TIMESTAMPTZ` (scheduled poll publishing)
- [ ] `article_reactions`: add `emotion VARCHAR(20) DEFAULT 'like'` ← **needed for 3.8**
- [ ] `profiles`: add `is_bot BOOLEAN DEFAULT false` ← needed for bot seeding

---

## Phase 7 — Poll Automation (Future)

- [ ] **7.A** AI poll generator — Claude Haiku auto-creates weekly polls from trending article topics; scheduled via cron
- [ ] **7.B** Poll scheduling engine — batch-create future polls with start/end dates from admin or API
- [ ] **7.C** Sentiment-driven polls — auto-generate polls triggered by match outcomes or viral articles
- [ ] **7.D** Poll analytics dashboard — per-poll breakdown, demographic split, time-series vote chart

---

## Phase 8 — Pre-Launch

- [ ] Full XP QA pass — test each action, no double-earning
- [ ] Set `XP_TOKEN_SECRET` in Cloudflare Pages env vars (not `dev-secret`)
- [ ] Bot seeding — 1500 synthetic users + weekly cron engine. Needs `profiles.is_bot` column (Phase 6).
- [ ] Rate limiting on `/api/xp/react` and `/api/xp/comment`

---

## Gamification Live Criteria

- [x] All Phase 1 + 2 shipped
- [x] Comments visible and submittable on all articles
- [ ] Emotion reactions wired with XP (Phase 3.8)
- [x] At least one Tribün feature live — all three live: score prediction, Starting 11, polls
- [x] Profile shows XP feed + badges + prediction history
- [ ] `XP_TOKEN_SECRET` set in production
- [ ] Bot seeding complete — 1500+ users on leaderboard

---

## All Tests Passing

386 tests passing as of 2026-06-19. Last fixes: test format mismatch after ESPN/upcoming-match migration (predict + starting-11 test suites), mobile UX bugs (header fixed position, 16px font on form inputs).
