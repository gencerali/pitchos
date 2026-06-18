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
- [ ] **3.7** Moderation Layer 2 — Claude Haiku toxicity check on `/comment` POST
- [ ] **3.8** Emotion reactions — expand `article_reactions.reaction` to 5 values; update SPA UI
- [ ] **3.9** Taraftar Nabzı — `/api/sentiment` aggregation + article sidebar widget

---

## Phase 4 — Tribün / Community Features

- [x] **4.1** Score prediction UI + `/api/xp/predict` wiring — `tribun.html`, `/api/upcoming-match`, 52 tests
- [ ] **4.2** Prediction evaluation — `/api/xp/evaluate-predictions` after match result
- [ ] **4.3** Starting 11 lineup guess + `/api/xp/starting-11` wiring
- [ ] **4.4** Poll voting + `/api/xp/poll-vote` wiring
- [ ] **4.5** Tribün page `/tribun` — community hub

---

## Phase 5 — Profile & UX Polish

- [ ] **5.1** Profile: XP activity feed (recent `xp_events`)
- [ ] **5.2** Profile: badge grid (earned + locked as goals)
- [ ] **5.3** Profile: prediction history tab
- [ ] **5.4** Level-up notification (modal/banner)
- [ ] **5.5** Badge unlock notification

---

## Phase 6 — Schema Migrations

- [x] `xp_actions`: `cap_fallback_xp integer default 0`
- [x] `xp_actions`: insert `react_article` row
- [x] `article_comments`: add `article_slug`, `user_id`, `site_id`
- [x] `article_comments`: add `parent_id` (reply threading, Phase 3.4)
- [x] `article_reactions`: add `article_slug`, `site_id`
- [ ] `article_reactions`: add `emotion` (5-value reactions, Phase 3.8)
- [ ] `profiles`: add `is_bot boolean default false`

---

## Phase 7 — Pre-Launch

- [ ] Full XP QA pass — test each action, no double-earning
- [ ] Set `XP_TOKEN_SECRET` in Cloudflare Pages env vars (not `dev-secret`)
- [ ] Bot seeding — after Phase 3+4 stable; 1500 synthetic users + weekly cron engine
- [ ] Rate limiting on `/react` and `/comment`

---

## Known Failing Tests (pre-existing, unrelated to Phase 4)

All 5 failures are in `src/__tests__/gamification-xp-engine.test.js`.
**Root cause:** `checkBadges()` in `xp.js` was expanded after the tests were written —
it now issues more `user_badges` existence-check fetches than the test's fetch-queue
helper (`enqueueTail`) was set up to handle. The tests assert correct behaviour but
don't enqueue enough mock responses, so the queue runs dry and throws
`"Unexpected fetch call: …/user_badges?…"`.

The production code is correct. Only the test fixtures need updating.

| # | Test | Why it fails |
|---|------|-------------|
| 1 | `cap fallback (2.1) › awards cap_fallback_xp (1) when daily cap hit` | `checkBadges` checks `first_read` badge existence (1 read ≥ 1) — 1 extra `user_badges` GET not in queue |
| 2 | `cap fallback (2.1) › awards full XP when under the cap` | Same — `first_read` threshold crossed at 3 reads, badge existence check not queued |
| 3 | `articles_100 badge › does NOT award articles_100 at 99 reads` | At 99 reads: `first_read`, `articles_10`, `articles_25`, `articles_50` all qualify; `enqueueTail` only queued the count query, not the 4 badge existence checks |
| 4 | `articles_100 badge › awards articles_100 badge at exactly 100 reads` | At 100 reads: `articles_10` badge existence check fires before `articles_100`; queue only pre-loaded the `articles_100` path |
| 5 | `articles_100 badge › does NOT run article count check when action is not react_article` | Test assumed `react_article` skips `countMap`; it doesn't — `countMap` includes `react_article` for `reactor_10`/`reactor_50` badges, so a count query fires but no response was queued |

**Fix:** Update `enqueueTail` in `gamification-xp-engine.test.js` to enqueue
`user_badges` existence-check responses for every badge candidate that crosses
its threshold at the given article/reaction count. Tests 3 & 4 also need the
`setupForBadge` helper extended. Test 5 needs an extra reaction-count entry in
its queue (or the test assertion rewritten to match the real `countMap`).

---

## Gamification live criteria

- [x] All Phase 2 shipped
- [ ] Comments visible and submittable on all articles
- [ ] Emotion reactions wired with XP
- [ ] At least one Tribün feature live (score prediction or polls)
- [ ] Profile shows XP feed + badges + prediction history
- [ ] `XP_TOKEN_SECRET` set in production
- [ ] Bot seeding complete — 1500+ users on leaderboard
