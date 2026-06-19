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
- [x] **3.8** Emotion reactions — 5 emotions (🔥 Ateşli / 😊 Mutlu / ❤️ Uzgun / 😔 Hayal kırıklığı / 💛 Kızgın) live in `index.html` article view and article page; XP wired via `/api/xp/react`.
- [x] **3.9** Taraftar Nabzı widget — live in `tribun.html` (community hub) and `index.html`; calls `/api/sentiment`; shows 5-emotion bar + Turkish conclusion text (e.g. "Taraftar ateşli! Heyecan dorukta.").

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
- [x] **5.6** Wire badge + level-up notifications in `index.html` for comment / react / share XP handlers

---

## Phase 6 — Schema Migrations

- [x] `xp_actions`: `cap_fallback_xp integer default 0`
- [x] `xp_actions`: insert `react_article` row
- [x] `article_comments`: add `article_slug`, `user_id`, `site_id`
- [x] `article_comments`: add `parent_id` (reply threading, Phase 3.4)
- [x] `article_reactions`: add `article_slug`, `site_id`
- [x] `polls`: add `starts_at TIMESTAMPTZ` (scheduled poll publishing)
- [x] `article_reactions`: `reaction` column already stores emotion type (atesli/mutlu/uzgun/kizgin/hayal_kirikligi) — separate `emotion` col not needed
- [x] `profiles`: add `is_bot BOOLEAN DEFAULT false` — applied; all 5 leaderboard views updated to filter `is_bot = false`

---

## Phase 7 — Poll Automation (Future)

- [ ] **7.A** AI poll generator — Claude Haiku auto-creates weekly polls from trending article topics; scheduled via cron
- [ ] **7.B** Poll scheduling engine — batch-create future polls with start/end dates from admin or API
- [ ] **7.C** Sentiment-driven polls — auto-generate polls triggered by match outcomes or viral articles
- [ ] **7.D** Poll analytics dashboard — per-poll breakdown, demographic split, time-series vote chart

---

## Phase 8 — Pre-Launch

- [x] Full XP QA pass — 399 tests; lifetime dedup (daily_cap=-1) + isRateLimited + comment handler all covered
- [x] Set `XP_TOKEN_SECRET` in Cloudflare Pages env vars (not `dev-secret`) ← config only, set in Cloudflare dashboard
- [ ] Bot seeding — 1500 synthetic users + weekly cron engine. `profiles.is_bot` column now ready (Phase 6 ✅)
- [x] Rate limiting on `/api/xp/react` and `/api/xp/comment` — DB-based sliding window, returns 429

---

## Phase 9 — Gamification Boost Plan

Four phased improvements to drive retention, virality, and depth. Each phase has a sound design component (all audio default OFF per Phase 7 spec: MP3+WebM, ≤100KB total, server-side toggle).

### Phase B1 — Quick Wins

- [ ] **B1.1** Badge progress visibility — show "3/5 articles read" progress toward every unearned badge
- [ ] **B1.2** Prediction accuracy stat — % correct predictions shown on profile + accuracy column on leaderboard
- [ ] **B1.3** Streak drama — animated counter on streak loss; XP-cost revival option (spend 100 XP to restore a broken streak once per week)
- [ ] **B1.S** Sound: activate existing Phase 7 design — coin-drop for XP award, chime for badge unlock

### Phase B2 — Core Retention Loop

- [ ] **B2.1** Weekly leagues — Bronze/Silver/Gold/Diamond tiers; weekly XP race; top 20% promoted, bottom 20% relegated; resets Monday 00:00 UTC
- [ ] **B2.2** Daily quest banner — countdown to next match prediction lock; "günün görevi" banner on tribün and profile
- [ ] **B2.3** Web Push + PWA — `manifest.json` + service worker; push triggers: match-day reminder, lineup prediction open, streak-break warning
- [ ] **B2.S** Sound: league promotion fanfare (ascending stadium cheer ≤2s); streak-break drama (low drum hit ≤0.5s)

### Phase B3 — Social & Viral

- [ ] **B3.1** Shareable result card — dynamic OG image generated after match result; shows user's predicted vs actual score + accuracy badge; share button on Tribün
- [ ] **B3.2** Community prediction reveal — after prediction lock, show score heatmap of what all users predicted; unlocked only after user has submitted own prediction
- [ ] **B3.3** Weekly email digest — Monday morning; personal stats recap + leaderboard rank + upcoming week preview; skimmable format via Resend
- [ ] **B3.S** Sound: exact-prediction celebration — crowd roar + goal-horn variant (≤1.5s); triggers with existing Kara Kartal animation

### Phase B4 — Depth & Seasonal

- [ ] **B4.1** Seasonal events — double XP weekends tied to derby fixtures; limited-time badges (Kadıköy Derbisi, Şampiyonluk, etc.)
- [ ] **B4.2** Prediction accuracy leaderboard tab — separate tab on `/liderlik`; ranked by % exact + % correct outcome; lifetime and seasonal views
- [ ] **B4.3** Match alerts — WhatsApp or Telegram channel; kickoff reminders + result pings; opt-in via profile settings
- [ ] **B4.S** Sound: seasonal event jingle — distinct limited-time audio cue (≤1s); only plays during active seasonal event window

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
