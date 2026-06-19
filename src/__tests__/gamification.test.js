/**
 * Gamification tests — covers bugs already found in the wild and locks in
 * the key invariants for XP, streak, and the me/checkin API handlers.
 *
 * Bugs this file would have caught:
 *  1. /api/me crashing when level_thresholds table missing (broke login for all users)
 *  2. checkin streak not resetting on missed days
 *  3. streakMultiplier thresholds being wrong
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Pure function imports (no mocking needed) ─────────────────────────────────

import { streakMultiplier } from '../../functions/api/_shared/xp.js';

// ── Mock Supabase transport so tests never hit the network ────────────────────

vi.mock('../../functions/api/_shared/auth.js', () => ({
  getUser:     vi.fn(),
  getSiteId:   vi.fn(),
  json:        (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  }),
  err:         (msg, status = 400) => new Response(JSON.stringify({ error: msg }), { status }),
  corsHeaders: () => new Response(null, { status: 204 }),
}));

vi.mock('../../functions/api/_shared/site.js', () => ({
  getSiteId: vi.fn(),
}));

// xp.js: mock the network helpers but keep streakMultiplier real
vi.mock('../../functions/api/_shared/xp.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    sbGet:            vi.fn(),
    sbPost:           vi.fn(),
    sbPatch:          vi.fn(),
    sbRpc:            vi.fn(),
    getStreak:        vi.fn(),
    awardXP:          vi.fn(),
    isShadowBanned:   vi.fn(),
    getDailyCount:    vi.fn(),
    hasLifetimeEvent: vi.fn(),
    isRateLimited:    vi.fn(),
  };
});

import { getUser }   from '../../functions/api/_shared/auth.js';
import { getSiteId } from '../../functions/api/_shared/site.js';
import { sbGet, sbRpc, getStreak, awardXP, isRateLimited } from '../../functions/api/_shared/xp.js';

import { onRequest as meHandler }      from '../../functions/api/me.js';
import { onRequest as checkinHandler } from '../../functions/api/xp/checkin.js';
import { onRequest as reactHandler }   from '../../functions/api/xp/react.js';
import { onRequest as shareHandler }   from '../../functions/api/xp/share.js';
import { onRequest as commentHandler } from '../../functions/api/xp/comment.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FAKE_USER    = { id: 'user-1', email: 'test@example.com' };
const FAKE_SITE_ID = 'site-uuid-1';
const FAKE_PROFILE = {
  id: FAKE_USER.id, site_id: FAKE_SITE_ID,
  username: 'kartal99', display_name: 'Kartal', avatar_url: null,
  created_at: '2026-01-01T00:00:00Z',
};

function makeReq(method = 'GET', headers = {}) {
  return new Request('https://kartalix.com/api/me', {
    method,
    headers: { Authorization: 'Bearer fake-token', ...headers },
  });
}

function makeEnv(overrides = {}) {
  return {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
    SUPABASE_ANON_KEY: 'anon-key',
    ...overrides,
  };
}

async function jsonBody(res) {
  return res.json();
}

// ── streakMultiplier ──────────────────────────────────────────────────────────

describe('streakMultiplier', () => {
  it('0 days → 1.00', () => expect(streakMultiplier(0)).toBe(1.00));
  it('1 day  → 1.00', () => expect(streakMultiplier(1)).toBe(1.00));
  it('4 days → 1.00', () => expect(streakMultiplier(4)).toBe(1.00));
  it('5 days → 1.20', () => expect(streakMultiplier(5)).toBe(1.20));
  it('9 days → 1.20', () => expect(streakMultiplier(9)).toBe(1.20));
  it('10 days → 1.50', () => expect(streakMultiplier(10)).toBe(1.50));
  it('30 days → 1.50', () => expect(streakMultiplier(30)).toBe(1.50));
});

// ── /api/me ───────────────────────────────────────────────────────────────────

describe('/api/me', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);

    // Default sbGet responses (ordered by call sequence in me.js Promise.all):
    // 1. profiles, 2. user_badges, 3. xp_events (sum), 4. xp_events (recent),
    // 5. score_predictions, 6. lineup_history, then sequential: 7. level_thresholds
    vi.mocked(sbGet)
      .mockResolvedValueOnce([FAKE_PROFILE])                              // profiles
      .mockResolvedValueOnce([])                                          // user_badges
      .mockResolvedValueOnce([{ xp_earned: 100 }, { xp_earned: 50 }])   // xp_events sum
      .mockResolvedValueOnce([])                                          // recent_activity
      .mockResolvedValueOnce([])                                          // prediction_history
      .mockResolvedValueOnce([])                                          // lineup_history
      .mockResolvedValueOnce([{ xp_required: 75 }]);                     // level_thresholds

    vi.mocked(getStreak).mockResolvedValue({
      current_streak: 5, longest_streak: 12,
      shield_active: true, last_checkin_date: '2026-06-14',
    });

    vi.mocked(sbRpc).mockResolvedValue([{
      level: 3, tier_name: 'Şahin', tier_number: 2, xp_to_next: 25,
    }]);
  });

  it('returns 401 without auth token', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(null);
    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('returns 403 when profile does not exist on this site', async () => {
    vi.mocked(sbGet).mockReset();
    vi.mocked(sbGet)
      .mockResolvedValueOnce([])  // profiles → empty → 403
      .mockResolvedValue([]);      // all remaining calls (badges, xp, activity, preds, etc.)
    vi.mocked(getStreak).mockResolvedValue({ current_streak: 0, longest_streak: 0, shield_active: false, last_checkin_date: null });
    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    expect(res.status).toBe(403);
  });

  it('returns 200 with correct total XP', async () => {
    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.xp.total).toBe(150); // 100 + 50
  });

  it('returns level info from get_user_level RPC', async () => {
    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.xp.level).toBe(3);
    expect(body.xp.tier_name).toBe('Şahin');
    expect(body.xp.xp_to_next).toBe(25);
  });

  it('returns xp_at_level from level_thresholds (xp_required column)', async () => {
    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.xp.xp_at_level).toBe(75);
  });

  // THE KEY REGRESSION TEST — would have caught the login-breaking bug:
  it('does NOT crash when level_thresholds table is missing (returns xp_at_level: 0)', async () => {
    vi.mocked(sbGet)
      .mockReset()
      .mockResolvedValueOnce([FAKE_PROFILE])             // profiles
      .mockResolvedValueOnce([])                          // user_badges
      .mockResolvedValueOnce([{ xp_earned: 100 }])       // xp_events sum
      .mockResolvedValueOnce([])                          // recent_activity (catch → [])
      .mockResolvedValueOnce([])                          // prediction_history (catch → [])
      .mockResolvedValueOnce([])                          // lineup_history (catch → [])
      .mockRejectedValueOnce(new Error('Supabase GET level_thresholds: 404'));

    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.xp.xp_at_level).toBe(0); // graceful fallback
  });

  it('returns streak data', async () => {
    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.streak.current).toBe(5);
    expect(body.streak.longest).toBe(12);
    expect(body.streak.shield_active).toBe(true);
  });

  // ── Phase 5.1 — Activity Feed ─────────────────────────────────
  it('returns recent_activity as empty array when no events', async () => {
    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(Array.isArray(body.recent_activity)).toBe(true);
    expect(body.recent_activity).toHaveLength(0);
  });

  it('returns recent_activity with correct event fields', async () => {
    const FAKE_EVENT = {
      action_id: 'daily_checkin', xp_earned: 10,
      created_at: '2026-06-18T10:00:00Z', source_ref: null,
    };
    vi.mocked(sbGet)
      .mockReset()
      .mockResolvedValueOnce([FAKE_PROFILE])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ xp_earned: 10 }])
      .mockResolvedValueOnce([FAKE_EVENT])        // recent_activity
      .mockResolvedValueOnce([])                   // prediction_history
      .mockResolvedValueOnce([])                   // lineup_history
      .mockResolvedValueOnce([{ xp_required: 0 }]);
    vi.mocked(sbRpc).mockResolvedValue([{ level: 1, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 40 }]);

    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.recent_activity).toHaveLength(1);
    expect(body.recent_activity[0].action_id).toBe('daily_checkin');
    expect(body.recent_activity[0].xp_earned).toBe(10);
    expect(body.recent_activity[0].created_at).toBe('2026-06-18T10:00:00Z');
  });

  it('recent_activity does not crash me endpoint when xp_events table missing', async () => {
    vi.mocked(sbGet)
      .mockReset()
      .mockResolvedValueOnce([FAKE_PROFILE])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ xp_earned: 50 }])
      .mockRejectedValueOnce(new Error('xp_events: 500'))  // recent_activity throws
      .mockResolvedValueOnce([])                            // prediction_history
      .mockResolvedValueOnce([])                            // lineup_history
      .mockResolvedValueOnce([{ xp_required: 0 }]);
    vi.mocked(sbRpc).mockResolvedValue([{ level: 1, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 40 }]);

    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.recent_activity).toEqual([]);  // graceful fallback
  });

  // ── Phase 5.3 — Prediction History ────────────────────────────
  it('returns prediction_history as empty array when no predictions', async () => {
    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(Array.isArray(body.prediction_history)).toBe(true);
    expect(body.prediction_history).toHaveLength(0);
  });

  it('returns prediction_history with correct fields', async () => {
    const FAKE_PRED = {
      match_id: 'match-abc', home_team: 'Beşiktaş', away_team: 'Galatasaray',
      home_score: 2, away_score: 1,
      xp_awarded: true, bonus_awarded: true, outcome_awarded: true,
      actual_home_score: 2, actual_away_score: 1,
      created_at: '2026-06-15T20:00:00Z',
    };
    vi.mocked(sbGet)
      .mockReset()
      .mockResolvedValueOnce([FAKE_PROFILE])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ xp_earned: 130 }])
      .mockResolvedValueOnce([])                    // recent_activity
      .mockResolvedValueOnce([FAKE_PRED])            // prediction_history
      .mockResolvedValueOnce([])                    // lineup_history
      .mockResolvedValueOnce([{ xp_required: 0 }]);
    vi.mocked(sbRpc).mockResolvedValue([{ level: 2, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 25 }]);

    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.prediction_history).toHaveLength(1);
    const p = body.prediction_history[0];
    expect(p.match_id).toBe('match-abc');
    expect(p.home_team).toBe('Beşiktaş');
    expect(p.away_team).toBe('Galatasaray');
    expect(p.home_score).toBe(2);
    expect(p.away_score).toBe(1);
    expect(p.bonus_awarded).toBe(true);
    expect(p.actual_home_score).toBe(2);
    expect(p.actual_away_score).toBe(1);
  });

  it('prediction_history does not crash me endpoint when table missing', async () => {
    vi.mocked(sbGet)
      .mockReset()
      .mockResolvedValueOnce([FAKE_PROFILE])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ xp_earned: 50 }])
      .mockResolvedValueOnce([])                                       // recent_activity
      .mockRejectedValueOnce(new Error('score_predictions: 500'))      // prediction_history throws
      .mockResolvedValueOnce([])                                       // lineup_history
      .mockResolvedValueOnce([{ xp_required: 0 }]);
    vi.mocked(sbRpc).mockResolvedValue([{ level: 1, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 40 }]);

    const res = await meHandler({ request: makeReq(), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.prediction_history).toEqual([]);  // graceful fallback
  });
});

// ── Streak date logic (extracted from checkin.js) ────────────────────────────

function computeNewStreak(streak, todayUTC) {
  const yesterday = new Date(new Date(todayUTC).getTime() - 86400000)
    .toISOString().slice(0, 10);

  if (streak.last_checkin_date === yesterday) {
    return { new_streak: (streak.current_streak ?? 0) + 1, shield_consumed: false };
  }
  if (!streak.last_checkin_date) {
    return { new_streak: 1, shield_consumed: false };
  }
  const daysBehind = Math.floor(
    (new Date(todayUTC).getTime() - new Date(streak.last_checkin_date).getTime()) / 86400000
  );
  if (daysBehind === 2 && streak.shield_active) {
    return { new_streak: (streak.current_streak ?? 0) + 1, shield_consumed: true };
  }
  return { new_streak: 1, shield_consumed: false };
}

describe('Streak date logic', () => {
  const TODAY = '2026-06-15';

  it('new user (no prior checkin) starts at streak 1', () => {
    const { new_streak } = computeNewStreak(
      { last_checkin_date: null, current_streak: 0, shield_active: false }, TODAY
    );
    expect(new_streak).toBe(1);
  });

  it('consecutive day increments streak', () => {
    const { new_streak } = computeNewStreak(
      { last_checkin_date: '2026-06-14', current_streak: 7, shield_active: false }, TODAY
    );
    expect(new_streak).toBe(8);
  });

  it('missed day resets streak to 1', () => {
    const { new_streak, shield_consumed } = computeNewStreak(
      { last_checkin_date: '2026-06-13', current_streak: 7, shield_active: false }, TODAY
    );
    expect(new_streak).toBe(1);
    expect(shield_consumed).toBe(false);
  });

  it('missed day + shield active saves streak', () => {
    const { new_streak, shield_consumed } = computeNewStreak(
      { last_checkin_date: '2026-06-13', current_streak: 7, shield_active: true }, TODAY
    );
    expect(new_streak).toBe(8);
    expect(shield_consumed).toBe(true);
  });

  it('two missed days resets even with shield', () => {
    const { new_streak } = computeNewStreak(
      { last_checkin_date: '2026-06-12', current_streak: 7, shield_active: true }, TODAY
    );
    expect(new_streak).toBe(1);
  });
});

// ── /api/xp/checkin ───────────────────────────────────────────────────────────

describe('/api/xp/checkin', () => {
  const TODAY = new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
    vi.mocked(awardXP).mockResolvedValue({
      xp_earned: 10, total_xp: 160, level: 3,
      tier_name: 'Şahin', xp_to_next: 15, badge_unlocks: [],
    });
  });

  function checkinReq() {
    return new Request('https://kartalix.com/api/xp/checkin', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token' },
    });
  }

  it('returns 401 without auth', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(null);
    const res = await checkinHandler({ request: checkinReq(), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('returns already_checked_in when checkin done today', async () => {
    vi.mocked(getStreak).mockResolvedValue({
      current_streak: 3, longest_streak: 10,
      shield_active: false, last_checkin_date: TODAY,
    });
    vi.mocked(sbGet).mockResolvedValueOnce([{ user_id: FAKE_USER.id }]);

    const res = await checkinHandler({ request: checkinReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.already_checked_in).toBe(true);
    expect(body.current_streak).toBe(3);
  });

  it('increments streak on consecutive day', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    vi.mocked(getStreak).mockResolvedValue({
      current_streak: 4, longest_streak: 10,
      shield_active: false, last_checkin_date: yesterday,
      streak_started_at: '2026-06-11',
    });
    vi.mocked(sbGet).mockResolvedValue([{ user_id: FAKE_USER.id }]);

    const res = await checkinHandler({ request: checkinReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.current_streak).toBe(5);
    expect(body.xp_earned).toBe(10);
  });

  it('awards streak_5_bonus at streak 5', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    vi.mocked(getStreak).mockResolvedValue({
      current_streak: 4, longest_streak: 4,
      shield_active: false, last_checkin_date: yesterday,
    });
    vi.mocked(sbGet).mockResolvedValue([{ user_id: FAKE_USER.id }]);
    vi.mocked(awardXP)
      .mockResolvedValueOnce({ xp_earned: 10, total_xp: 200, level: 3, tier_name: 'Şahin', xp_to_next: 10, badge_unlocks: [] })
      .mockResolvedValueOnce({ xp_earned: 25, total_xp: 225, level: 4, tier_name: 'Kartal', xp_to_next: 50, badge_unlocks: [] });

    const res = await checkinHandler({ request: checkinReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.current_streak).toBe(5);
    expect(body.streak_bonus_xp).toBe(25);
    // awardXP should have been called twice: daily_checkin + streak_5_bonus
    expect(vi.mocked(awardXP)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(awardXP).mock.calls[1][3]).toBe('streak_5_bonus');
  });
});

// ── /api/xp/react ─────────────────────────────────────────────────────────────

describe('/api/xp/react', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
    vi.mocked(isRateLimited).mockResolvedValue(false);
    vi.mocked(awardXP).mockResolvedValue({
      xp_earned: 1, total_xp: 51, level: 1,
      tier_name: 'Misafir Kartal', xp_to_next: 49, badge_unlocks: [],
    });
  });

  function reactReq(body = { article_slug: 'test-slug' }) {
    return new Request('https://kartalix.com/api/xp/react', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 401 without auth', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(null);
    const res = await reactHandler({ request: reactReq(), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('returns 400 when article_slug missing', async () => {
    const res = await reactHandler({ request: reactReq({}), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  it('calls awardXP with react_article action and slug as source_ref', async () => {
    await reactHandler({ request: reactReq({ article_slug: 'besiktas-sampiyonluk' }), env: makeEnv() });
    expect(vi.mocked(awardXP)).toHaveBeenCalledWith(
      expect.anything(), FAKE_USER.id, FAKE_SITE_ID, 'react_article', 'besiktas-sampiyonluk', null
    );
  });

  it('returns xp_earned from awardXP', async () => {
    const res = await reactHandler({ request: reactReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.xp_earned).toBe(1);
  });

  it('returns 0 xp when already reacted to same article (capped)', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce({ xp_earned: 0, capped: true, reason: 'already_earned_source' });
    const res = await reactHandler({ request: reactReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.xp_earned).toBe(0);
    expect(body.capped).toBe(true);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(isRateLimited).mockResolvedValueOnce(true);
    const res = await reactHandler({ request: reactReq(), env: makeEnv() });
    expect(res.status).toBe(429);
    expect(vi.mocked(awardXP)).not.toHaveBeenCalled();
  });
});

// ── /api/xp/comment ───────────────────────────────────────────────────────────

describe('/api/xp/comment', () => {
  const COMMENT_RESULT = { xp_earned: 10, total_xp: 60, level: 1, tier_name: 'Misafir Kartal', xp_to_next: 40, badge_unlocks: [] };
  const BONUS_RESULT   = { xp_earned: 25, total_xp: 85, level: 1, tier_name: 'Misafir Kartal', xp_to_next: 15, badge_unlocks: [] };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
    vi.mocked(isRateLimited).mockResolvedValue(false);
    vi.mocked(awardXP)
      .mockResolvedValueOnce(COMMENT_RESULT)
      .mockResolvedValueOnce(BONUS_RESULT);
  });

  function commentReq(body = { article_slug: 'test-slug' }) {
    return new Request('https://kartalix.com/api/xp/comment', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 401 without auth', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(null);
    const res = await commentHandler({ request: commentReq(), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('returns 400 when article_slug missing', async () => {
    const res = await commentHandler({ request: commentReq({}), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  it('awards comment XP and first_comment bonus', async () => {
    await commentHandler({ request: commentReq({ article_slug: 'besiktas-9-0' }), env: makeEnv() });
    expect(vi.mocked(awardXP)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(awardXP).mock.calls[0][3]).toBe('comment');
    expect(vi.mocked(awardXP).mock.calls[0][4]).toBe('besiktas-9-0');
    expect(vi.mocked(awardXP).mock.calls[1][3]).toBe('first_comment');
  });

  it('merges badge_unlocks from comment and first_comment', async () => {
    const badgeA = { id: 'comment_5', label: 'Yorumcu' };
    const badgeB = { id: 'first_comment', label: 'İlk Yorum' };
    vi.mocked(awardXP).mockReset();
    vi.mocked(awardXP)
      .mockResolvedValueOnce({ ...COMMENT_RESULT, badge_unlocks: [badgeA] })
      .mockResolvedValueOnce({ ...BONUS_RESULT, badge_unlocks: [badgeB] });
    const res = await commentHandler({ request: commentReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.badge_unlocks).toEqual([badgeA, badgeB]);
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(isRateLimited).mockResolvedValueOnce(true);
    const res = await commentHandler({ request: commentReq(), env: makeEnv() });
    expect(res.status).toBe(429);
    expect(vi.mocked(awardXP)).not.toHaveBeenCalled();
  });

  it('returns combined total_xp and level from bonus when both earned', async () => {
    const res = await commentHandler({ request: commentReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.xp_earned).toBe(COMMENT_RESULT.xp_earned);
    expect(body.bonus_xp).toBe(BONUS_RESULT.xp_earned);
    expect(body.total_xp).toBe(BONUS_RESULT.total_xp);
    expect(body.level).toBe(BONUS_RESULT.level);
  });
});

// ── /api/xp/share ─────────────────────────────────────────────────────────────

describe('/api/xp/share', () => {
  const SHARE_RESULT  = { xp_earned: 5, total_xp: 100, level: 2, tier_name: 'Şahin', xp_to_next: 50, badge_unlocks: [] };
  const BONUS_RESULT  = { xp_earned: 10, total_xp: 110, level: 2, tier_name: 'Şahin', xp_to_next: 40, badge_unlocks: [] };
  const CAPPED_RESULT = { xp_earned: 0, capped: true, reason: 'already_earned', total_xp: 100, level: 2, tier_name: 'Şahin', xp_to_next: 50, badge_unlocks: [] };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
    vi.mocked(awardXP)
      .mockResolvedValueOnce(SHARE_RESULT)
      .mockResolvedValueOnce(BONUS_RESULT);
  });

  function shareReq(body = { article_id: 'article-abc' }) {
    return new Request('https://kartalix.com/api/xp/share', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 401 without auth', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(null);
    const res = await shareHandler({ request: shareReq(), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('returns 400 when article_id missing', async () => {
    const res = await shareHandler({ request: shareReq({}), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  it('calls awardXP twice: share_link then first_share', async () => {
    await shareHandler({ request: shareReq({ article_id: 'art-1' }), env: makeEnv() });
    expect(vi.mocked(awardXP)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(awardXP).mock.calls[0][3]).toBe('share_link');
    expect(vi.mocked(awardXP).mock.calls[0][4]).toBe('art-1');
    expect(vi.mocked(awardXP).mock.calls[1][3]).toBe('first_share');
  });

  it('uses bonus total_xp and level when first_share earns XP', async () => {
    const res = await shareHandler({ request: shareReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.total_xp).toBe(110);  // from BONUS_RESULT
    expect(body.bonus_xp).toBe(10);
    expect(body.xp_earned).toBe(5);   // share_link result preserved
  });

  it('merges badge_unlocks from both calls', async () => {
    vi.mocked(awardXP).mockReset();
    vi.mocked(awardXP)
      .mockResolvedValueOnce({ ...SHARE_RESULT, badge_unlocks: [{ id: 'badge-a' }] })
      .mockResolvedValueOnce({ ...BONUS_RESULT, badge_unlocks: [{ id: 'badge-b' }] });
    const res = await shareHandler({ request: shareReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.badge_unlocks).toHaveLength(2);
    expect(body.badge_unlocks.map(b => b.id)).toEqual(['badge-a', 'badge-b']);
  });

  it('first_share already earned (daily_cap=-1 hit) — bonus_xp is 0, total from share_link', async () => {
    vi.mocked(awardXP).mockReset();
    vi.mocked(awardXP)
      .mockResolvedValueOnce(SHARE_RESULT)
      .mockResolvedValueOnce(CAPPED_RESULT);
    const res = await shareHandler({ request: shareReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.bonus_xp).toBe(0);
    expect(body.total_xp).toBe(100);  // falls back to share_link total
  });
});
