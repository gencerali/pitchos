# Gamification System — Development Plan & Acceptance Criteria

**Status:** Planning  
**Last updated:** 2026-06-14  
**Scope:** Full gamification layer including auth, XP economy, progression, animations, anti-cheat, and admin tooling

---

## Table of Contents

1. [Phase 0 — Auth & Identity Foundation](#phase-0--auth--identity-foundation)
2. [Phase 1 — XP Economy Engine](#phase-1--xp-economy-engine)
3. [Phase 2 — Tier Progression & Badges](#phase-2--tier-progression--badges)
4. [Phase 3 — Streak System](#phase-3--streak-system)
5. [Phase 4 — Leaderboards](#phase-4--leaderboards)
6. [Phase 5 — UI & Animations](#phase-5--ui--animations)
7. [Phase 6 — Guest Funnel](#phase-6--guest--anonymous-funnel)
8. [Phase 7 — Sound Design](#phase-7--sound-design)
9. [Phase 8 — Anti-Cheat & Economy Protection](#phase-8--anti-cheat--economy-protection)
10. [Phase 9 — XP Admin Panel](#phase-9--xp-admin-panel)
11. [Phase 10 — Media & Card UI](#phase-10--media--card-ui)
12. [Phase 11 — Gamification Boost Plan](#phase-11--gamification-boost-plan)
13. [XP Economy Reference Table](#xp-economy-reference-table)
13. [Level Threshold Reference](#level-threshold-reference)
14. [Open Questions](#open-questions)

---

## Phase 0 — Auth & Identity Foundation

**Priority: Must ship before any gamification feature.**  
All XP, streaks, and leaderboard data is meaningless without a stable identity layer.

---

### 0.1 Registration

**Logic:**
- Email + password registration. Password minimum: 8 characters, 1 uppercase, 1 number.
- Username: 3–20 characters, alphanumeric + underscore only, globally unique.
- KVKK consent checkbox — mandatory, non-pre-ticked, links to full policy page.
- On submit: create account in `pending_verification` state. Send verification email.
- In `pending_verification` state: user can browse but cannot earn XP, comment, or appear on leaderboards.
- Social login paths (Google OAuth, Apple Sign-In, X/Twitter OAuth) bypass email verification step; email is considered verified via the provider.
- If a social login email matches an existing password account, present an account-linking prompt rather than creating a duplicate.

**Acceptance Criteria:**
- [ ] User submits valid registration form → receives verification email within 60 seconds.
- [ ] User submits invalid email format → inline error shown before submit, no network call made.
- [ ] Username "kartal_123" is taken → real-time availability indicator shows red before form submission.
- [ ] Username "kartal_123" is available → indicator shows green.
- [ ] KVKK checkbox unchecked → submit button remains disabled.
- [ ] User registers via Google with an email already in the system → shown "Bu e-posta ile hesap mevcut. Hesapları birleştir?" prompt, not a duplicate account.
- [ ] After email verification, user's state transitions to `active` and XP earning is unlocked.
- [ ] Unverified accounts are purged after 7 days of no activity.

---

### 0.2 Login

**Logic:**
- Email + password, or social provider button.
- "Beni hatırla" checkbox → 30-day persistent refresh token stored as HttpOnly cookie.
- 5 consecutive failed attempts on the same account → 15-minute lockout. Countdown shown in UI.
- Successful login issues: short-lived JWT (15-minute expiry) + long-lived refresh token (30 days).
- Refresh tokens are rotated on each use (refresh token rotation).

**Acceptance Criteria:**
- [ ] Valid credentials → user logged in, redirected to homepage, header shows account avatar and streak flame.
- [ ] Wrong password × 5 → "Hesabınız 15 dakika kilitlendi" message with countdown timer. No further attempts accepted during lockout.
- [ ] Lockout expires → user can attempt login again.
- [ ] "Beni hatırla" checked → closing and reopening browser does not require re-login for 30 days.
- [ ] "Beni hatırla" unchecked → closing browser ends the session.
- [ ] JWT expires after 15 minutes → silent refresh using refresh token occurs without user noticing.
- [ ] Refresh token used → old refresh token immediately invalidated; new one issued.

---

### 0.3 Forgot / Reset Password

**Logic:**
- User enters email → system sends a reset link containing a signed, single-use token.
- Token expires after 1 hour.
- On successful password reset: all active sessions for that account are invalidated except the one completing the reset.
- A "your password was changed" security notification email is sent to the address on file.

**Acceptance Criteria:**
- [ ] User submits a registered email → receives reset link within 60 seconds.
- [ ] User submits an unregistered email → same success message shown ("Eğer bu e-posta kayıtlıysa link gönderildi") — no enumeration of registered emails.
- [ ] Reset link clicked after 1 hour → "Bu link süresi doldu" error; option to request a new one.
- [ ] Reset link clicked twice → second attempt returns an invalid token error.
- [ ] Password successfully reset → all other sessions terminated. Security email sent.
- [ ] User is logged into device A and resets password from device B → device A session is invalidated within 15 minutes (next JWT refresh attempt fails).

---

### 0.4 Change Password (Authenticated)

**Logic:**
- Requires current password confirmation before accepting new password.
- Invalidates all sessions except the current device.
- Confirmation email sent.

**Acceptance Criteria:**
- [ ] Correct current password + valid new password → password updated, confirmation email sent.
- [ ] Wrong current password → "Mevcut şifreniz hatalı" error; no change made.
- [ ] Change succeeds → user's other active sessions (other devices) are terminated.
- [ ] Social-only accounts (no password set) → "Şifre belirle" flow instead of change, which sets an initial password without requiring a current one.

---

### 0.5 Change Email

**Logic:**
- Requires password confirmation.
- Verification link sent to the **new** email address; change is not applied until verified.
- Old email address receives a security alert with a 24-hour rollback link.

**Acceptance Criteria:**
- [ ] User submits new email + correct password → verification sent to new email; old email receives security alert.
- [ ] User clicks verify link in new email → email updated; user sees confirmation.
- [ ] User clicks rollback link in old email within 24 hours → email reverted to old address; all sessions terminated.
- [ ] Rollback link clicked after 24 hours → "Bu link süresi doldu" error.
- [ ] New email is already registered to another account → "Bu e-posta başka bir hesaba ait" error shown before any email is sent.

---

### 0.6 Delete Account

**Logic:**
- Requires password re-authentication (or social re-auth).
- 14-day soft-delete window: account suspended, login blocked, data retained. User can restore by contacting support or clicking restore link.
- After 14 days: hard delete. Personal identifiers (name, email, avatar) permanently removed. Activity records anonymized: comments attributed to "Silinen Kullanıcı", XP history and leaderboard entries removed.
- KVKK Article 7 compliant (right to erasure).
- Display name change is throttled to once per 30 days specifically to prevent leaderboard identity manipulation.

**Acceptance Criteria:**
- [ ] User initiates deletion → shown explicit "14 gün içinde geri alabilirsiniz" warning with item list of what will be deleted.
- [ ] Password confirmed → account enters soft-delete state. Login returns "Hesabınız silme sürecinde" message with restore option.
- [ ] User attempts to restore within 14 days → account fully restored, all XP and progress intact.
- [ ] 14 days pass → personal identifiers purged. All comments in the system show "Silinen Kullanıcı". Leaderboard entries removed.
- [ ] KVKK data export request is fulfilled within 72 hours (separate tooling, out of scope for MVP but must be planned).

---

### 0.7 Session Management

**Logic:**
- Profile settings shows list of active sessions: device type, approximate location (city/country from IP at login time), last active timestamp.
- User can terminate individual sessions or all sessions except current.

**Acceptance Criteria:**
- [ ] Settings > Oturumlar shows at least one active session (current).
- [ ] "Bu oturumu kapat" terminates that session; next API call from that session returns 401.
- [ ] "Diğer tüm oturumları kapat" terminates all other sessions; current session unaffected.
- [ ] After session termination, the terminated device is redirected to login on next action.

---

### 0.8 Profile Management

**Fields:** Avatar, display name, notification preferences (push, email digest), sound toggle, leaderboard visibility toggle.

**Acceptance Criteria:**
- [ ] Avatar upload: JPEG/PNG/WebP accepted. Files >2MB rejected with "Dosya 2MB'dan küçük olmalı" error. Uploaded image server-side resized to 256×256.
- [ ] Display name change allowed maximum once per 30 days. Attempting change before cooldown shows days remaining.
- [ ] Sound toggle state persists across sessions (stored server-side, not just localStorage).
- [ ] Leaderboard visibility set to private → user's entry absent from all leaderboard views. XP still earned normally.
- [ ] Notification preferences: at least one channel must remain enabled (cannot disable both push and email).

---

## Phase 1 — XP Economy Engine

---

### 1.1 XP Action Registry

All XP-earning actions are defined in a central registry (database table `xp_actions`). No XP values are hardcoded.

**Schema:**

```sql
xp_actions (
  id                    TEXT PRIMARY KEY,   -- e.g. 'daily_checkin'
  label                 TEXT,               -- "Günlük Giriş"
  category              TEXT,               -- 'retention' | 'community' | 'tribun'
  xp_per_action         INTEGER,
  daily_cap             INTEGER,            -- max awards per rolling 24h per user
  pool_estimate         INTEGER,            -- estimated opportunities per month
  streak_bonus_eligible BOOLEAN DEFAULT true,
  active                BOOLEAN DEFAULT true
)
```

**Acceptance Criteria:**
- [ ] All XP awards in the system read from `xp_actions` — no hardcoded XP integers in application code.
- [ ] Disabling a row (`active = false`) immediately stops that action from awarding XP without a deploy.
- [ ] Changing `xp_per_action` takes effect for all future events; does not retroactively alter earned XP.

---

### 1.2 XP Transaction Log

Every XP award creates an immutable ledger entry.

```sql
xp_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  action_id   TEXT REFERENCES xp_actions(id),
  xp_earned   INTEGER,           -- actual XP after multiplier
  base_xp     INTEGER,           -- pre-multiplier value
  multiplier  NUMERIC(3,2),      -- e.g. 1.20
  source_ref  TEXT,              -- article_id, match_id, etc.
  created_at  TIMESTAMPTZ DEFAULT now()
)
```

**Acceptance Criteria:**
- [ ] Every XP award creates exactly one row in `xp_events`.
- [ ] `xp_earned` = `base_xp × multiplier`, rounded down.
- [ ] Deleting or editing `xp_events` rows is blocked at the DB level (no DELETE privilege granted to application role).
- [ ] User's displayed XP total is always computed as `SUM(xp_earned)` from `xp_events`, never stored as a mutable counter.

---

### 1.3 Daily Check-in (+10 XP)

**Logic:** One award per calendar day (UTC) per user. Server-side check; client cannot trigger a second award on the same day.

**Acceptance Criteria:**
- [ ] First check-in of the day → +10 XP (×streak multiplier if applicable), XP particle animation fires.
- [ ] Second check-in attempt same day → no XP awarded, no error shown to user (silently ignored).
- [ ] Check-in at 23:59 UTC, then again at 00:01 UTC next day → both award XP correctly.

---

### 1.4 Read Article (+5 XP, cap 5/day)

**Logic:** Verified by: scroll depth ≥70% of article body AND minimum 30-second dwell time. Both conditions must be met. Server receives a signed completion token generated client-side when both conditions pass; server validates the token has not been replayed.

**Acceptance Criteria:**
- [ ] User scrolls to 70% of article and stays 30s → completion token sent → +5 XP awarded.
- [ ] User scrolls to 70% but leaves in 10s → no token generated, no XP.
- [ ] User scrolls to 20% and stays 60s → no token generated, no XP.
- [ ] Same article read twice in same day → second read awards no XP (deduplicated by `source_ref` in `xp_events`).
- [ ] 6th article read in rolling 24h → no XP (daily cap of 5 enforced server-side).
- [ ] Same signed token submitted twice → second submission rejected with 409.

---

### 1.5 Watch Video 30s (+5 XP, cap 5/day)

**Logic:** YouTube IFrame API `onStateChange` event tracks playback. At 30 continuous seconds of play (pauses reset the counter), client sends a signed token to the server. Server validates. Same daily cap and deduplication rules as article reading.

**Acceptance Criteria:**
- [ ] User watches 30 continuous seconds → +5 XP.
- [ ] User watches 20s, pauses, resumes, reaches 30s total but not continuous → no XP (counter resets on pause).
- [ ] Same video watched again on same day → no XP.
- [ ] 6th video in rolling 24h → no XP.

---

### 1.6 Poll Vote (+15 XP, cap 3/day)

**Logic:** XP awarded on the server at the moment the vote is persisted. One XP event per poll per user per day (can vote in 3 different polls per day).

**Acceptance Criteria:**
- [ ] User votes in poll → +15 XP awarded server-side alongside vote storage.
- [ ] User tries to vote in same poll twice → second vote rejected ("Zaten oy kullandınız"), no XP.
- [ ] 4th poll voted in rolling 24h → vote accepted but no XP awarded.

---

### 1.7 Comment (+10 XP, cap 5/day)

**Logic:** XP awarded when comment passes validation (min 15 characters, not a duplicate of user's last 3 comments on same article). Awarded at persistence time, not at submit time.

**Acceptance Criteria:**
- [ ] Comment with ≥15 characters, unique → +10 XP.
- [ ] Comment with <15 characters → "Yorum çok kısa" error, no XP, comment not saved.
- [ ] Comment identical to user's previous comment on same article → "Aynı yorumu tekrar gönderemezsiniz" error, no XP.
- [ ] 6th comment in rolling 24h → comment saved, no XP.

---

### 1.8 Share Link (+15 XP, cap 3/day)

**Logic:** XP awarded when share action is confirmed (user taps the share button and selects a target, or the share sheet is confirmed). Not awarded if share sheet is dismissed.

**Acceptance Criteria:**
- [ ] User completes a share action → +15 XP.
- [ ] User opens share sheet and dismisses without sharing → no XP.
- [ ] 4th share in rolling 24h → no XP.

---

### 1.9 Submit Starting 11 (+50 XP, cap 1/day)

**Logic:** XP awarded when a valid 11-player lineup is submitted for an upcoming match. Match must be in the future at time of submission (server validates against match kickoff time).

**Acceptance Criteria:**
- [ ] Valid 11-player lineup submitted before kickoff → +50 XP.
- [ ] Fewer than 11 players selected → submit blocked, no XP.
- [ ] Lineup submitted after kickoff → "Maç başladı" error, no submission accepted, no XP.
- [ ] Second Starting 11 submission on the same day → no XP (daily cap 1).

---

### 1.10 Predict Score (+30 XP, cap 2/day; +100 XP bonus for exact match)

**Logic:** Prediction submitted before match kickoff. Server locks prediction once kickoff timestamp passes (5-minute buffer before kickoff). After match result is confirmed, system evaluates all predictions for that match. Exact matches receive the +100 XP bonus in a separate `xp_events` row.

**Acceptance Criteria:**
- [ ] Prediction submitted before kickoff → +30 XP.
- [ ] Prediction submitted after server-side lock (≤5 min before kickoff) → "Tahmin süresi doldu" error, no XP.
- [ ] Prediction matches exact final score → +100 XP bonus row added after result confirmation.
- [ ] Prediction matches correct winner/draw but wrong score → no bonus.
- [ ] 3rd prediction in rolling 24h → prediction rejected, no XP.
- [ ] Only one prediction accepted per user per match (first submission locked; edits rejected after first save).

---

### 1.11 First-Time Action Bonuses (One-time, +25 XP each)

Actions: first comment, first poll vote, first Starting 11 submission, first score prediction, first share.

**Acceptance Criteria:**
- [ ] Each action fires the one-time +25 XP bonus exactly once per user's lifetime.
- [ ] After the bonus fires once, further completions of that action no longer trigger the bonus.
- [ ] Bonus fires in the same transaction as the regular XP award (one API call, two `xp_events` rows).

---

## Phase 2 — Tier Progression & Badges

---

### 2.1 Level & Tier System

**15 levels, 5 tiers:**

| Tier | Levels | Name |
|---|---|---|
| 1 | 1–3 | Misafir Kartal |
| 2 | 4–6 | Taraftar |
| 3 | 7–9 | Kapalı Tribün |
| 4 | 10–12 | Çarşı Ruhu |
| 5 | 13–15 | Efsane |

**XP thresholds (to be tuned in admin panel before launch — these are starting estimates):**

| Level | Cumulative XP required |
|---|---|
| 1 | 0 (starting level) |
| 2 | 50 |
| 3 | 150 |
| 4 | 400 |
| 5 | 800 |
| 6 | 1,400 |
| 7 | 2,200 |
| 8 | 3,200 |
| 9 | 4,500 |
| 10 | 6,200 |
| 11 | 8,500 |
| 12 | 11,500 |
| 13 | 15,000 |
| 14 | 20,000 |
| 15 | 27,000 |

Levels 1–3 designed to clear within the first week of active use (early dopamine loop). Levels 13–15 require sustained multi-month engagement.

**No demotion.** XP is never subtracted. Level only moves upward.

**Acceptance Criteria:**
- [ ] User's current level is always derived from total XP against threshold table — never stored as a mutable integer.
- [ ] Changing a level's XP threshold in the admin panel immediately re-computes all users' levels on next page load.
- [ ] A user at Level 3 earning XP that crosses the Level 4 threshold → Kara Kartal animation triggered (see Phase 5).
- [ ] No level displays as 0 to the user; all users start at Level 1 / Misafir Kartal.
- [ ] Profile page shows: current level number, tier name, XP progress bar (current XP toward next level), total XP all-time.

---

### 2.2 Rank Display in Social Contexts

**Logic:** User's tier badge and level number displayed inline with username in comments and live chat.

**Acceptance Criteria:**
- [ ] Comment by Level 8 user shows: avatar → username → "Kapalı Tribün Lvl 8" badge.
- [ ] Leaderboard display shows tier name and level.
- [ ] Badge renders correctly on both dark background (card UI) and light background (if any).
- [ ] Badge is absent for anonymous/guest users.

---

### 2.3 Achievement Badges

**Badge triggers requiring Kara Kartal animation:**
- Crossing a major tier boundary (hitting Lvl 4, 7, 10, or 13)
- First exact score prediction
- 15-day streak achieved
- 100 articles read lifetime

**Acceptance Criteria:**
- [ ] Badge is awarded server-side and idempotent (can be triggered multiple times, only creates one badge record).
- [ ] Badge unlock triggers Kara Kartal animation (queued if another animation is playing).
- [ ] Maximum 2 animations play in sequence; if 3+ unlock simultaneously, they are consolidated into a single "Çoklu Kilit Açıldı" reveal.
- [ ] Badge collection visible on user profile page.

---

## Phase 3 — Streak System

---

### 3.1 Daily Streak Counter

**Logic:** Streak increments when a user completes a daily check-in. Streak breaks if the user misses a calendar day (UTC). Streak Shield (see 3.3) can absorb one miss.

**Acceptance Criteria:**
- [ ] Check-in on Day 1 → streak = 1.
- [ ] Check-in on Day 2 → streak = 2.
- [ ] Miss Day 3 (no check-in), check-in Day 4 without Shield → streak resets to 1.
- [ ] Miss Day 3 with Shield active → Shield consumed, streak continues as if Day 3 was completed, Shield slot now empty.
- [ ] Streak counter in header updates immediately on check-in without page refresh.

---

### 3.2 Streak Milestones & Multipliers

| Milestone | Name | Effect |
|---|---|---|
| Day 5 | Bronze Streak | 1.2× XP multiplier on all eligible actions |
| Day 10 | Silver Streak | 1.5× XP multiplier on all eligible actions |
| Day 15 | — | One-time Streak Shield token awarded |
| Day 20 | Gold Streak | 1.5× multiplier continues + "Streak Kartalı" badge |
| Day 30 | Sadakat Kartalı | One-time +500 XP bonus + unique badge |

Multiplier is applied server-side when computing `xp_earned` in the transaction. Non-integer results are rounded down.

**Acceptance Criteria:**
- [ ] User on Day 5 streak earns 5 XP from article read → `xp_earned = floor(5 × 1.2) = 6`. `xp_events` row shows `base_xp=5, multiplier=1.20, xp_earned=6`.
- [ ] User on Day 10 streak earns 15 XP from poll vote → `xp_earned = floor(15 × 1.5) = 22`.
- [ ] Multiplier applies to all `streak_bonus_eligible = true` actions.
- [ ] Streak breaks and rebuilds to Day 5 → 1.2× multiplier re-activates.
- [ ] Day 10+ streak flame in header switches to animated glowing red flame variant.
- [ ] Day 30 bonus fires exactly once per streak run (cannot be repeated by deliberately breaking and rebuilding).

---

### 3.3 Streak Shield

**Logic:** Awarded at Day 15 milestone. Shown as a shield icon on the profile/header. One shield maximum at a time (cannot stack). Shield is consumed automatically on the first missed day.

**Acceptance Criteria:**
- [ ] Day 15 achieved → shield token appears in header. Kara Kartal animation fires.
- [ ] User misses a day with shield active → shield consumed, streak preserved, shield icon disappears.
- [ ] User earns a second shield while one is already active → "Zaten bir kalkanınız var" notification, no second shield stored.
- [ ] Shield state visible on profile: present/absent, and tooltip explaining its function.

---

## Phase 4 — Leaderboards

---

### 4.1 Leaderboard Types

Three concurrent leaderboards tracked simultaneously:

| Board | Scope | Reset |
|---|---|---|
| All-Time | Lifetime XP | Never |
| Seasonal | Current Süper Lig season | **June 1** each year (after season ends) |
| Monthly | Calendar month XP | 1st of each month, 00:00 UTC |
| Weekly | Calendar week XP | Monday 00:00 UTC — **in MVP** |
| Streak | Current streak + personal best | Never (live) |

**Acceptance Criteria:**
- [ ] Monthly board resets to zero for all users at 00:00 UTC on the 1st.
- [ ] Weekly board resets at 00:00 UTC every Monday.
- [ ] Seasonal board resets on June 1.
- [ ] A user who joins mid-month sees a clean monthly slate immediately competitive.
- [ ] Users with `leaderboard_visibility = private` on their profile are excluded from all board displays.
- [ ] Top 100 users shown per board. User's own rank always shown even if outside top 100 ("Sen: #342").

---

### 4.2 Streak Leaderboard

Shows two columns side by side: **Current Streak** (active days, resets to 0 on miss) and **Personal Best** (highest streak ever achieved by that user). Ranked by Current Streak descending; Personal Best is informational. Tie-broken by streak start date (longer-running streak ranks higher).

**Acceptance Criteria:**
- [ ] User breaks streak → Current Streak column resets to 0 immediately; Personal Best column unchanged.
- [ ] Personal Best updates only when current streak exceeds it.
- [ ] Streak board clearly labeled as separate from XP boards in UI (tab or section, not scroll).

---

## Phase 5 — UI & Animations

---

### 5.1 XP Particle Animation

**Logic:** A floating "+N XP" text node in crimson rises vertically from the element that triggered the action, fades to transparent over 500ms max, then is removed from the DOM. Multiple particles can coexist if actions trigger rapidly.

**Acceptance Criteria:**
- [ ] Particle appears at the position of the triggering UI element (button/card), not at a fixed screen position.
- [ ] Animation completes in ≤500ms total (rise + fade).
- [ ] Particle element is fully removed from DOM after animation (no invisible elements accumulating).
- [ ] `prefers-reduced-motion: reduce` → particle skips rise animation, appears briefly in place then fades in 150ms.
- [ ] Multiple rapid XP events (e.g., 3 quick shares) show 3 separate particles, not one combined.

---

### 5.2 Kara Kartal Fly-In Animation

**Trigger conditions:** Major tier boundary crossed (Lvl 4, 7, 10, 13), elite cup unlocked, landmark badge earned.

**Animation spec:**
1. Viewport darkens (overlay at 40% opacity black), 200ms fade in.
2. 2D transparent vector Black Eagle enters from top-left edge.
3. Eagle arcs toward screen center, drops trophy/badge at center.
4. Eagle continues flight, exits top-right corner.
5. Overlay fades out. Trophy/badge remains visible as a reveal moment.
6. Total duration: 1,200ms.
7. Tap-to-skip: any tap during animation skips immediately to the trophy reveal state.

**Acceptance Criteria:**
- [ ] Animation fires exactly once per qualifying unlock event.
- [ ] If two qualifying events occur simultaneously, animations queue — second plays immediately after first completes.
- [ ] More than 2 simultaneous events → consolidated into single "Çoklu Kilit Açıldı" reveal (eagle drops multiple items).
- [ ] `prefers-reduced-motion: reduce` → animation skipped entirely; trophy/badge fades in at center directly.
- [ ] Tap-to-skip works on all mobile touch events and desktop click.
- [ ] Animation is hardware-accelerated (CSS transforms, no layout-triggering properties).
- [ ] Eagle asset is an SVG (scalable, no raster) with transparent background.

---

### 5.3 Header Gamification Bar

**Location:** Top-right of header, replacing the permanent CANLI button.

**Contents (left to right):** Streak flame icon (+ day count) → Tier badge icon → User avatar.

**CANLI button:** Moved to main navigation or shown inline only when a live event is actually active (conditional render based on live match schedule data).

**Acceptance Criteria:**
- [ ] Header shows streak flame, tier badge, and avatar for authenticated users.
- [ ] Streak ≥10 → flame icon switches from static to animated glowing red variant.
- [ ] Streak <10 → standard static flame icon.
- [ ] Day count next to flame updates on check-in without page refresh.
- [ ] CANLI button absent from header when no live event is scheduled.
- [ ] CANLI button appears in header (or a prominent secondary location) when a match is currently live.
- [ ] Guest/unauthenticated users see login/register CTA in top-right, no gamification bar.

---

### 5.4 Thematic Card Styles

| Category tag | Background token | Overlay |
|---|---|---|
| Transfer | `#4A0208` (dark crimson) | None |
| Analiz | `#1C1C1C` | Chalkboard grid lines at 6% opacity, clipped to background layer only |
| Match Report | `#0F1A0A` (deep forest) | None |
| Injury | `#1A1200` (dark amber) | None |
| Default / Other | `#111111` | None |

**Acceptance Criteria:**
- [ ] Card background token changes based on article category metadata at render time.
- [ ] Chalkboard grid is visible on Analiz cards but does not overlay text or headline areas.
- [ ] Unknown/unmapped category → falls back to `#111111`, no error thrown.
- [ ] Video containers: 6px border-radius, `1px solid #1A1A1A` border, bottom-up dark gradient overlay on thumbnail.

---

### 5.5 Card Typography

**Acceptance Criteria:**
- [ ] Headlines wrap up to 3 lines. Line 3 truncates with ellipsis only if text exceeds 3 lines.
- [ ] No headline truncation before line 3.
- [ ] Cards have a fixed height; headlines shorter than 3 lines do not cause card height variation in a grid row.
- [ ] "Kartalix Editöryel" or equivalent internal source stamps are absent from inside the card canvas.
- [ ] Source attribution, timestamp, and AI accuracy score appear exclusively in the metadata row beneath the card, not inside the card.

---

## Phase 6 — Guest / Anonymous Funnel

---

### 6.1 Guest XP Accrual

**Logic:** Unauthenticated users can earn XP locally via `sessionStorage` (data lost on tab close). Guest starts at "Misafir Kartal Level 1". Maximum guest XP cap: 50 XP. After 50 XP, further earning is locked and the registration modal triggers.

**Acceptance Criteria:**
- [ ] Guest reads article → +5 XP stored in sessionStorage. Particle animation fires.
- [ ] Guest closes and reopens browser → XP is gone (sessionStorage cleared). Guest starts fresh.
- [ ] Guest reaches 50 XP → registration modal triggers on the next XP-earning action.
- [ ] Guest XP claim on registration: claimed amount validated server-side against a reasonable cap (max 50 XP). Client-side value is not trusted directly.

---

### 6.2 Registration Modal (Bottom Sheet)

**Triggers:**
- Guest reaches 50 XP cap.
- Guest attempts to comment, vote, predict score, or submit Starting 11.
- Guest initiates page departure (before-unload event, only on desktop — not on mobile Safari which ignores it).

**Modal content:** Shows current guest XP earned, "Bu puanları kaybetmeden önce kayıt ol" message, register CTA, login link, and a "Misafir olarak devam et" escape option.

**Acceptance Criteria:**
- [ ] Modal slides up from bottom on mobile. Appears as a centered dialog on desktop.
- [ ] "Misafir olarak devam et" button dismisses the modal without registering. User can continue browsing.
- [ ] Escape option present and functional — no dark pattern that fully blocks the user.
- [ ] Modal does not appear more than once per session if user has already dismissed it (session flag set on first dismiss).
- [ ] After registration via modal, guest XP (up to 50) is added to new account immediately.

---

## Phase 7 — Sound Design

---

### 7.1 Sound Registry

| Event | Sound |
|---|---|
| Standard XP award | Short coin-drop/crowd-clap hybrid (≤0.3s) |
| Major achievement / Eagle fly-in | Brief stadium stand roar + wind-swoosh as eagle exits (≤1.5s, synced to animation) |

**All audio assets must be either original recordings or royalty-free licensed. No recordings of actual Çarşı stands or other copyrighted stadium audio.**

**Default state: OFF.** User must explicitly enable sounds in profile settings.

**Acceptance Criteria:**
- [ ] Sound is OFF by default for all new users.
- [ ] Profile settings shows "Ses Efektleri" toggle. State persists across sessions (stored server-side).
- [ ] Sound ON → XP award plays coin-drop sound in sync with particle animation.
- [ ] Sound ON → Eagle animation plays stadium/swoosh audio timed to match animation phases.
- [ ] Sound OFF → no audio plays under any circumstance, even with browser autoplay unlocked.
- [ ] All audio files are MP3 + WebM dual-format for cross-browser support.
- [ ] Audio files preloaded on settings enable to avoid first-play latency.
- [ ] Total audio payload: ≤100KB combined.

---

## Phase 8 — Anti-Cheat & Economy Protection

---

### 8.1 Daily Caps (Server-Enforced)

All daily caps listed in Phase 1 are enforced server-side. Client UI showing "cap reached" is informational only.

**Acceptance Criteria:**
- [ ] Any XP-earning API endpoint checks the rolling 24h count before awarding. Excess requests return 200 with `{ xp: 0, reason: "daily_cap_reached" }` — no error code, to avoid tipping off scripts.
- [ ] Cap checks are atomic (no race condition allowing two simultaneous requests to both pass the cap check).

---

### 8.2 Signed Completion Tokens

Article reads and video watches use HMAC-signed tokens to prevent simple API replay.

**Acceptance Criteria:**
- [ ] Token includes: `user_id`, `content_id`, `action_type`, `issued_at` timestamp, HMAC signature.
- [ ] Server rejects tokens older than 5 minutes.
- [ ] Server rejects tokens already seen (stored in a short-TTL deduplication cache).
- [ ] Token validation failure returns 200 with `{ xp: 0, reason: "invalid_token" }` (not 401, to avoid fingerprinting).

---

### 8.3 Comment Spam Prevention

**Acceptance Criteria:**
- [ ] Comments under 15 characters rejected before save.
- [ ] Comment identical to user's last 3 comments on the same article rejected.
- [ ] Per-user cooldown: max 3 comments per article per 10-minute window.
- [ ] Cooldown is server-enforced; client UI shows remaining cooldown time.

---

### 8.4 Score Prediction Lock

**Acceptance Criteria:**
- [ ] Server computes lock time as `kickoff_timestamp - 5 minutes`.
- [ ] Any prediction submitted after lock time is rejected server-side, regardless of what the client shows.
- [ ] One prediction per user per match. First submission is final; subsequent attempts return 409.

---

### 8.5 Shadow Ban Escalation

**Logic:** Accounts with 3+ anti-cheat violations within 7 days enter shadow-ban state. Their XP awards are silently nullified (returned as 0 to the server, but UI shows XP as earned). They are excluded from leaderboards.

**Acceptance Criteria:**
- [ ] Shadow-banned user sees XP particle animations and level UI as normal.
- [ ] Shadow-banned user's XP is not added to `xp_events` (or is added with `nullified = true` flag).
- [ ] Shadow-banned user does not appear on any leaderboard.
- [ ] Admin panel shows shadow-ban status and violation log per user.
- [ ] Shadow ban can be lifted manually by an admin.

---

### 8.6 Guest XP Claim Validation

**Acceptance Criteria:**
- [ ] On registration, client sends claimed guest XP value.
- [ ] Server caps the claimed amount at 50 XP regardless of what the client sends.
- [ ] Claimed XP added to new account as a single `xp_events` row with `action_id = 'guest_claim'`.

---

## Phase 9 — XP Admin Panel

---

### 9.1 XP Action Editor

Editable table of all `xp_actions` rows. Columns: Label, Category, XP/Action, Daily Cap, Pool Estimate (per month), Streak Eligible, Active.

**Computed columns (read-only, auto-refresh on edit):**
- Max XP/day: `xp_per_action × daily_cap`
- Max XP/month: `min(pool_estimate, daily_cap × 30) × xp_per_action`

**Acceptance Criteria:**
- [ ] Inline edit of any numeric field updates computed columns in real time (before save).
- [ ] Save button commits changes to DB. Unsaved changes shown with a dirty-state indicator.
- [ ] Audit log entry created on every save: `{ changed_by, action_id, field, old_value, new_value, timestamp }`.
- [ ] Toggling `active = false` immediately stops XP from being awarded for that action (no deploy needed).
- [ ] Changes are NOT retroactive by default. A toggle "Geçmişe uygula" is present but gated behind a confirmation dialog: "Bu, N kullanıcının XP toplamını değiştirir. Emin misiniz?"

---

### 9.2 Economy Simulator

Below the action editor: a summary table grouped by category showing monthly ceiling per category and grand total.

**Engagement slider:** "Ortalama kullanıcı etkileşimi: [30%]" — adjusts the estimated realistic XP/month by the selected percentage.

**Acceptance Criteria:**
- [ ] Category totals update immediately when any action's XP values change.
- [ ] Engagement slider at 30% shows `grand_total × 0.30` as "Gerçekçi tahmini aylık XP".
- [ ] Slider range: 10%–100%.

---

### 9.3 Level Threshold Editor

Editable table of level thresholds (15 rows). Adjacent column shows "Days to reach at [slider]% engagement" computed as `threshold_xp / (realistic_monthly_xp / 30)`.

**Acceptance Criteria:**
- [ ] Editing a threshold updates the "days to reach" column instantly.
- [ ] Saving thresholds triggers a background re-computation of all users' current levels.
- [ ] Admin panel shows a progress indicator while re-computation runs.
- [ ] "Days to reach Level 4" at 30% engagement should be ≤14 days for the progression loop to feel rewarding (design constraint, not an automated check).

---

### 9.4 Admin Audit Log

Full log of all admin panel changes (XP values, threshold edits, shadow bans, manual XP awards).

**Acceptance Criteria:**
- [ ] Log is append-only (no delete).
- [ ] Filterable by: admin user, action type, date range.
- [ ] Each row shows: timestamp, admin username, entity changed, field, old value, new value.

---

## Phase 10 — Media & Card UI

---

### 10.1 YouTube Embed Handling

**Acceptance Criteria:**
- [ ] YouTube video cards display native thumbnails fetched via YouTube Data API (legally compliant).
- [ ] No iframe loaded until user taps the card (click-to-play pattern, not auto-embed).
- [ ] Video container: 6px border-radius, `1px solid #1A1A1A` border.
- [ ] Bottom-up dark linear gradient overlay applied to thumbnail: `linear-gradient(to top, rgba(10,10,10,0.85) 0%, transparent 50%)`.

---

### 10.2 RSS / Text News Image Handling

**Acceptance Criteria:**
- [ ] No external images loaded for RSS/text news cards. Zero external image requests for this card type.
- [ ] Category-appropriate vector hero placeholder renders instead.
- [ ] Placeholder background uses the category design token from 5.4.

---

## Phase 11 — Gamification Boost Plan

Phased improvements to retention, virality, and depth. All audio follows the Phase 7 contract: default OFF, stored server-side, MP3+WebM dual-format, ≤100KB total payload.

---

### Phase B1 — Quick Wins

#### B1.1 Badge Progress Visibility

**Logic:** Every badge card in the profile grid shows a progress bar toward the unlock condition, even for unearned badges. Progress is computed at read time from existing `xp_events` data — no new DB columns required.

**Acceptance Criteria:**
- [ ] Unearned badge shows progress bar: "3 / 5 maç yorumu yapıldı" style copy below the badge icon.
- [ ] Earned badge shows full bar and unlock date.
- [ ] Progress bar updates on next profile page load after an XP event (no real-time push required).
- [ ] Badges with one-time conditions (e.g. first comment) show "Tamamlandı" or remain locked without a progress bar (no misleading fraction like 0/1).

---

#### B1.2 Prediction Accuracy Stat

**Logic:** For each user, compute `correct_exact` (exact score), `correct_outcome` (right winner/draw), and `total_predictions` from `score_predictions`. Show accuracy % on profile. Add a sortable accuracy column to the weekly leaderboard.

**Acceptance Criteria:**
- [ ] Profile page → Tahminler tab shows: Total predictions, Exact score %, Correct outcome %.
- [ ] Accuracy is computed server-side on each `/api/me` call — never cached to a mutable column.
- [ ] Leaderboard `/liderlik` gets a new **Tahmin Doğruluğu** tab: ranked by exact score %, tie-broken by total predictions (≥5 minimum to appear).
- [ ] Users with fewer than 5 predictions are excluded from the accuracy leaderboard to prevent noise from 1-prediction outliers.

---

#### B1.3 Streak Drama + XP Revival

**Logic:** On streak loss, a dramatic counter animation plays showing the lost streak count before resetting to 0. User is offered a revival option: spend 100 XP to restore the streak, limited to once per 7 rolling days.

**Acceptance Criteria:**
- [ ] First check-in after a broken streak triggers a "Seriniz koptu! 12 günlük serini kaybettin." modal/toast with streak count animated down to 0.
- [ ] Modal offers "Seriyi Geri Getir — 100 XP" CTA (only if user has ≥100 XP and hasn't used revival in past 7 days).
- [ ] Revival accepted → streak restored to previous value − 1 (the missed day is "forgiven"); 100 XP deducted via a new `streak_revival` action row in `xp_events` with negative `xp_earned`.
- [ ] Revival rejected → streak resets to 1 on next check-in.
- [ ] Revival CTA absent if user has already used it within 7 rolling days. Tooltip: "Bu haftanın canlanma hakkını kullandın."
- [ ] Revival is server-enforced: client cannot bypass XP deduction or the 7-day cooldown.

---

#### B1.S Sound — Quick Wins

Activate the existing Phase 7 audio spec which is specced but not yet shipped.

**Acceptance Criteria:**
- [ ] All Phase 7 acceptance criteria pass (see Phase 7 above).
- [ ] Streak revival denial plays a short "miss" sound (≤0.3s) when the revival is unavailable.

---

### Phase B2 — Core Retention Loop

#### B2.1 Weekly Leagues

**Logic:** A parallel competitive layer where users race for XP within a weekly window (Monday 00:00 UTC → Sunday 23:59 UTC). Tiers: Bronze / Silver / Gold / Diamond. Each tier holds ~50 users drawn from similar XP ranges. At week end: top 20% promote, bottom 20% relegate.

**Schema additions:**
```sql
league_tiers (id TEXT PRIMARY KEY, name TEXT, label TEXT, promotion_pct NUMERIC, relegation_pct NUMERIC)
league_memberships (user_id UUID, tier_id TEXT, week_start DATE, week_xp INTEGER, rank INTEGER, outcome TEXT CHECK (outcome IN ('promoted','relegated','stayed',NULL)))
```

**Acceptance Criteria:**
- [ ] Every registered user is assigned to a league tier at the start of the first week they earn XP.
- [ ] `/liderlik` gets a **Lig** tab showing the user's current tier, weekly XP earned, rank within tier, and promotion/relegation thresholds.
- [ ] At Monday 00:00 UTC cron: finalize previous week outcomes, promote/relegate, create new week memberships.
- [ ] User who earned 0 XP in a week is relegated one tier but not shown a "relegated" notification — they simply see their new tier on next login.
- [ ] Newly registered users start in Bronze regardless of total XP.
- [ ] League tier badge (🥉🥈🥇💎) shown in user profile header next to existing tier badge.

---

#### B2.2 Daily Quest Banner

**Logic:** A persistent banner on Tribün and Profile pages showing the day's primary action and a countdown to the next match prediction lock.

**Acceptance Criteria:**
- [ ] Banner shows: "Bugünün Görevi: Skor Tahmin Et" with remaining time to lock.
- [ ] If no upcoming match within 48h, banner shows the next best available action (check-in, poll vote, etc.).
- [ ] Countdown timer updates client-side every minute (no server polling).
- [ ] Banner is absent for unauthenticated users.
- [ ] Banner dismissed by user stays dismissed for the rest of the calendar day (localStorage flag).

---

#### B2.3 Web Push + PWA

**Logic:** Progressive Web App baseline so users can install the site to home screen and receive push notifications without a native app.

**Deliverables:**
- `manifest.json` (name, icons, display: standalone, theme_color)
- Service worker (offline shell, push subscription endpoint)
- Push triggers (3): match-day reminder 3h before kickoff, Starting 11 prediction window open, streak-break warning (if user hasn't checked in by 21:00 local)

**Acceptance Criteria:**
- [ ] `/manifest.json` served with correct MIME type; Chrome/Safari show "Add to Home Screen" prompt.
- [ ] Installed PWA launches in standalone mode (no browser chrome).
- [ ] `/api/push/subscribe` endpoint stores `PushSubscription` (endpoint + keys) in new `push_subscriptions` table per user.
- [ ] Push cron fires 3h before upcoming match kickoff → sends "Maç yaklaşıyor! Skor tahminini yap." to all subscribed users who haven't yet predicted.
- [ ] Push cron fires when Starting 11 window opens (match confirmed ≥2h before kickoff).
- [ ] Streak-break warning sent at 21:00 TRT to subscribed users with current streak ≥3 who haven't checked in today.
- [ ] User can unsubscribe from pushes in Profile → Bildirimler settings.
- [ ] Push payload ≤4KB (Web Push limit).

---

#### B2.S Sound — Core Retention Loop

**Acceptance Criteria:**
- [ ] League promotion: on first visit after promotion, play ascending stadium cheer (≤2s). Fires once per promotion event.
- [ ] League relegation: silent — no sound on relegation (avoid punishing the user with audio).
- [ ] Streak break revival modal: plays a short "alert" stinger (≤0.5s) when the modal appears.

---

### Phase B3 — Social & Viral

#### B3.1 Shareable Result Card

**Logic:** After match result is confirmed and predictions evaluated, each user who predicted can see a generated image card showing their predicted score vs actual score, their accuracy badge, and their streak. Card is generated as a dynamic OG image (Cloudflare Worker + Canvas or SVG template).

**Acceptance Criteria:**
- [ ] `/api/share-card?match_id=X` returns a PNG (or redirect to cached PNG URL) for the authenticated user's prediction result.
- [ ] Card includes: Beşiktaş crest, match score (predicted vs actual), "TAHMİNİM TUTTU! ✅" or "Fark az!" or "Yanıldım 😔" label, user's streak, kartalix.com branding.
- [ ] Share button on Tribün result view opens native share sheet with the card image pre-attached.
- [ ] Cards are generated once and cached to R2 or KV with a `match_id:user_id` key — not regenerated on every request.
- [ ] Users who did not submit a prediction for the match cannot generate a card.

---

#### B3.2 Community Prediction Reveal

**Logic:** After prediction lock (kickoff − 5 min), Tribün shows an aggregate heatmap of all users' predicted scores. Users who have submitted their prediction see the full heatmap; users who did not predict see a blurred teaser with "Tahmin yap ve gör!" CTA.

**Acceptance Criteria:**
- [ ] `/api/predictions-summary` (already exists) extended to return a score-frequency matrix (e.g. {home: 2, away: 1} → N users).
- [ ] Heatmap rendered client-side: grid of scoreline cells, cell darkness proportional to prediction count.
- [ ] Heatmap only visible after lock time (server enforces; no peeking before lock).
- [ ] Users who haven't predicted see blurred heatmap + CTA if match is still before lock time.
- [ ] After match: heatmap persists and shows correct score highlighted.

---

#### B3.3 Weekly Email Digest

**Logic:** Every Monday morning, users who have opted in receive a short email recap: their weekly XP earned, rank change, upcoming match prediction window, and a Tribün activity highlight.

**Acceptance Criteria:**
- [ ] Opt-in toggle in Profile → Bildirimler. Default: opted in for users who have earned XP in the past 14 days; opted out for inactive users.
- [ ] Email sent via Resend every Monday 08:00 TRT.
- [ ] Email includes: personal weekly XP, rank vs last week (▲ / ▼ / =), league tier, next match kickoff time + prediction CTA link, top 3 community predictions from last week.
- [ ] Email is plain-text + HTML (responsive, dark-mode-friendly).
- [ ] Unsubscribe link in every email → one-click opt-out stored server-side; no re-opt-in from backend.
- [ ] Users with no XP in the past 30 days are excluded from the weekly send (inactive user suppression).

---

#### B3.S Sound — Social & Viral

**Acceptance Criteria:**
- [ ] Exact prediction confirmed (post-match evaluation): plays crowd roar + goal-horn variant (≤1.5s). Triggers alongside existing Kara Kartal fly-in animation if that animation is also queued.
- [ ] Correct outcome (not exact): plays a shorter cheer (≤0.5s).
- [ ] Wrong prediction: no sound.

---

### Phase B4 — Depth & Seasonal

#### B4.1 Seasonal Events

**Logic:** Time-boxed events tied to real BJK fixtures (Kadıköy Derbisi, European nights, championship run) that grant double XP on specific actions and unlock limited-time badges.

**Schema additions:**
```sql
seasonal_events (id TEXT PRIMARY KEY, label TEXT, starts_at TIMESTAMPTZ, ends_at TIMESTAMPTZ, xp_multiplier NUMERIC DEFAULT 2.0, badge_id TEXT REFERENCES badges(id), active BOOLEAN)
```

**Acceptance Criteria:**
- [ ] Admin can create a seasonal event in `/admin/gamification` with label, date range, XP multiplier, and optional badge.
- [ ] During an active seasonal event, all XP awards respect the event multiplier (applied on top of existing streak multiplier).
- [ ] Limited badge awarded to every user who earns ≥1 XP action during the event window.
- [ ] Seasonal event banner shown on Tribün and homepage during the active window.
- [ ] Seasonal badges are marked visually as "limited" (gold border, event name stamped on badge).
- [ ] Events are enforced server-side: the multiplier is applied in `awardXP()` when `seasonal_events` has an active row.

---

#### B4.2 Prediction Accuracy Leaderboard Tab

**Logic:** Separate leaderboard view ranked purely by prediction accuracy. Two sub-tabs: all-time and current season.

**Acceptance Criteria:**
- [ ] New tab **Tahmin** on `/liderlik` page.
- [ ] Ranked by exact score % descending, tie-broken by total predictions (minimum 5 to appear).
- [ ] Columns: rank, user, exact score %, correct outcome %, total predictions.
- [ ] Season sub-tab resets June 1 (same as Seasonal leaderboard).
- [ ] User's own rank shown below the table even if outside top 100.

---

#### B4.3 Match Alerts

**Logic:** Opt-in push/message alerts for upcoming matches. Delivery channel: WhatsApp Business API or Telegram Bot (whichever is simpler to configure first).

**Acceptance Criteria:**
- [ ] Profile → Bildirimler shows "Maç Bildirimleri" toggle with channel selector (WhatsApp / Telegram).
- [ ] User links their phone number or Telegram username.
- [ ] Alert sent 3h before kickoff: "Beşiktaş maçı yaklaşıyor — tahminini yap: [link]".
- [ ] Alert sent at final whistle: "Maç bitti! Sonucu gör: [link]".
- [ ] User can unlink their number/username at any time; alerts stop immediately.
- [ ] Backend sends via Twilio WhatsApp or Telegram Bot API; credentials stored in Cloudflare env vars.

---

#### B4.S Sound — Depth & Seasonal

**Acceptance Criteria:**
- [ ] Seasonal event activated for user (first XP earned during event): plays a distinct seasonal jingle (≤1s), different from the standard XP coin-drop.
- [ ] Seasonal jingle plays at most once per event activation per user (not on every XP award during the event).
- [ ] Audio file added to the shared audio payload budget (≤100KB total across all sounds).

---

## XP Economy Reference Table

Starting values — tune in admin panel before launch.

| Action | Category | XP | Daily Cap | Pool/mo | Max XP/mo |
|---|---|---|---|---|---|
| Daily Check-in | Retention | 10 | 1 | 30 | 300 |
| 5-Day Streak Bonus | Retention | 50 | 1 | 6 | 300 |
| Read Article | Retention | 5 | 5 | 100 | 500 |
| Watch Video 30s | Retention | 5 | 5 | 40 | 200 |
| **Retention Total** | | | | | **1,300** |
| Poll Vote | Community | 15 | 3 | 20 | 300 |
| Comment | Community | 10 | 5 | — | 300 |
| Share Link | Community | 15 | 3 | — | 900 |
| **Community Total** | | | | | **1,500** |
| Submit Starting 11 | Tribün | 50 | 1 | 8 | 400 |
| Predict Score | Tribün | 30 | 2 | 8 | 240 |
| Exact Score Bonus | Tribün | 100 | 1 | 8 | 800 |
| **Tribün Total** | | | | | **1,440** |
| First-time bonuses (5 actions) | All | 25 ea | 1-time | — | 125 |
| **Grand Total / month** | | | | | **~4,365** |

At 30% engagement (casual user): ~1,310 XP/month.  
At 70% engagement (active user): ~3,056 XP/month.

---

## Level Threshold Reference

| Level | Tier | XP Required | Days at 30% | Days at 70% |
|---|---|---|---|---|
| 1 | Misafir Kartal | 0 | Day 1 | Day 1 |
| 2 | Misafir Kartal | 50 | Day 1 | Day 1 |
| 3 | Misafir Kartal | 150 | Day 3 | Day 1 |
| 4 | Taraftar | 400 | Day 9 | Day 4 |
| 5 | Taraftar | 800 | Day 18 | Day 8 |
| 6 | Taraftar | 1,400 | Day 32 | Day 14 |
| 7 | Kapalı Tribün | 2,200 | Day 50 | Day 22 |
| 8 | Kapalı Tribün | 3,200 | Day 73 | Day 31 |
| 9 | Kapalı Tribün | 4,500 | Day 103 | Day 44 |
| 10 | Çarşı Ruhu | 6,200 | Day 142 | Day 61 |
| 11 | Çarşı Ruhu | 8,500 | Day 195 | Day 84 |
| 12 | Çarşı Ruhu | 11,500 | Day 264 | Day 113 |
| 13 | Efsane | 15,000 | Day 344 | Day 147 |
| 14 | Efsane | 20,000 | Day 457 | Day 196 |
| 15 | Efsane | 27,000 | Day 617 | Day 264 |

*Tune thresholds in admin panel until Level 3 clears in ≤7 days at 30% engagement.*

---

## Decisions Log

All open questions resolved 2026-06-14.

| # | Question | Decision |
|---|---|---|
| 1 | Social auth providers beyond Google + Apple? | **Google + Apple + X (Twitter)** |
| 2 | Seasonal leaderboard reset date? | **June 1** (after Süper Lig season ends in May) |
| 3 | Match kickoff data source for prediction lock? | **api-football.js** — reuse existing integration |
| 4 | Push notifications in MVP? | **Post-launch** |
| 5 | Streak Leaderboard ranking metric? | **Both columns** — current active streak + personal best all-time |
| 6 | Sound asset production? | **Licensed royalty-free library** (Freesound / Epidemic Sound / Pixabay) |
| 7 | KVKK data export in MVP? | **Yes — MVP**. Basic JSON export of profile + XP history on day one |
| 8 | Admin panel access model? | **Single super-admin** for now |
| 9 | Post-Day-30 streak multiplier? | **1.5× persists indefinitely** as long as streak holds. No further milestones. |
| 10 | Weekly leaderboard in MVP? | **Yes — MVP**. Resets every Monday 00:00 UTC |
