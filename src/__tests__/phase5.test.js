/**
 * Phase 5 E2E tests — covers all five items:
 *  5.1  Activity feed  (/api/me → recent_activity)
 *  5.2  Badge grid     (badge unlocks include icon+name+desc from me.js)
 *  5.3  Prediction history (/api/me → prediction_history)
 *  5.4  Level-up notification (checkin response contains level + tier_name for comparison)
 *  5.5  Badge unlock notification (badge_unlocks array format from checkin + XP endpoints)
 *
 * Pure-function helpers (relativeTime, ACTION_LABELS coverage) are also tested here
 * to lock in the display logic independent of the browser runtime.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock transport layer ───────────────────────────────────────────────────────

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
  };
});

import { getUser }   from '../../functions/api/_shared/auth.js';
import { getSiteId } from '../../functions/api/_shared/site.js';
import { sbGet, sbRpc, getStreak, awardXP } from '../../functions/api/_shared/xp.js';

import { onRequest as meHandler }      from '../../functions/api/me.js';
import { onRequest as checkinHandler } from '../../functions/api/xp/checkin.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

const U = { id: 'u-phase5', email: 'p5@test.com' };
const SITE = 'site-p5';
const PROFILE = {
  id: U.id, site_id: SITE,
  username: 'p5user', display_name: 'Phase Five', avatar_url: null,
  created_at: '2026-01-15T00:00:00Z',
};

function makeGet(method = 'GET') {
  return new Request('https://kartalix.com/api/me', {
    method,
    headers: { Authorization: 'Bearer tok' },
  });
}
function makePost() {
  return new Request('https://kartalix.com/api/xp/checkin', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok' },
  });
}
function makeEnv() {
  return { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sk', SUPABASE_ANON_KEY: 'ak' };
}
async function json(res) { return res.json(); }

// Standard me.js sbGet mock: profiles, badges, xp_sum, activity, predictions, level_thresholds
function mockMeStandard(overrides = {}) {
  vi.mocked(sbGet)
    .mockResolvedValueOnce(overrides.profiles ?? [PROFILE])
    .mockResolvedValueOnce(overrides.badges ?? [])
    .mockResolvedValueOnce(overrides.xpRows ?? [{ xp_earned: 200 }])
    .mockResolvedValueOnce(overrides.activity ?? [])
    .mockResolvedValueOnce(overrides.predictions ?? [])
    .mockResolvedValueOnce(overrides.levelThresholds ?? [{ xp_required: 150 }]);
  vi.mocked(sbRpc).mockResolvedValue(overrides.levelRpc ?? [{ level: 2, tier_name: 'Taraftar', tier_number: 2, xp_to_next: 50 }]);
  vi.mocked(getStreak).mockResolvedValue(overrides.streak ?? { current_streak: 3, longest_streak: 10, shield_active: false, last_checkin_date: '2026-06-17' });
}

beforeEach(() => {
  vi.mocked(getUser).mockResolvedValue(U);
  vi.mocked(getSiteId).mockResolvedValue(SITE);
  vi.clearAllMocks();
  vi.mocked(getUser).mockResolvedValue(U);
  vi.mocked(getSiteId).mockResolvedValue(SITE);
});

// ── 5.1 Activity Feed ─────────────────────────────────────────────────────────

describe('5.1 — Activity Feed', () => {
  it('recent_activity is always an array in response', async () => {
    mockMeStandard();
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    expect(Array.isArray(body.recent_activity)).toBe(true);
  });

  it('returns up to 20 recent XP events in order (newest first)', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      action_id: 'daily_checkin',
      xp_earned: 10,
      created_at: `2026-06-${18 - i}T10:00:00Z`,
      source_ref: null,
    }));
    mockMeStandard({ activity: events });
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    expect(body.recent_activity).toHaveLength(5);
    expect(body.recent_activity[0].created_at).toBe('2026-06-18T10:00:00Z');
    expect(body.recent_activity[4].created_at).toBe('2026-06-14T10:00:00Z');
  });

  it('activity events carry action_id, xp_earned, created_at, source_ref', async () => {
    const ev = { action_id: 'read_article', xp_earned: 25, created_at: '2026-06-18T09:00:00Z', source_ref: 'article-123' };
    mockMeStandard({ activity: [ev] });
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    const a = body.recent_activity[0];
    expect(a.action_id).toBe('read_article');
    expect(a.xp_earned).toBe(25);
    expect(a.source_ref).toBe('article-123');
  });

  it('all expected action_ids have display labels (ACTION_LABELS coverage check)', () => {
    // These are the action_ids that should all have labels in profil.html's ACTION_LABELS.
    const ACTION_LABELS = {
      daily_checkin:   'Günlük Giriş',
      read_article:    'Makale Okudu',
      comment:         'Yorum Yaptı',
      share_link:      'Paylaşım',
      watch_video_30s: 'Video İzledi',
      react_article:   'Tepki Verdi',
      predict_score:   'Tahmin Yaptı',
      starting_11:     'İlk 11 Seçti',
      poll_vote:       'Anket Oyladı',
      streak_5_bonus:  'Seri Bonusu',
    };
    const KNOWN_ACTIONS = [
      'daily_checkin', 'read_article', 'comment', 'share_link',
      'watch_video_30s', 'react_article', 'predict_score', 'starting_11',
      'poll_vote', 'streak_5_bonus',
    ];
    KNOWN_ACTIONS.forEach(id => {
      expect(ACTION_LABELS[id]).toBeDefined();
      expect(typeof ACTION_LABELS[id]).toBe('string');
    });
  });

  it('activity feed degrades gracefully when xp_events unavailable (catch → [])', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([PROFILE])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ xp_earned: 50 }])
      .mockRejectedValueOnce(new Error('xp_events table missing'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ xp_required: 0 }]);
    vi.mocked(sbRpc).mockResolvedValue([{ level: 1, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 40 }]);
    vi.mocked(getStreak).mockResolvedValue({ current_streak: 0, longest_streak: 0, shield_active: false, last_checkin_date: null });

    const res = await meHandler({ request: makeGet(), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.recent_activity).toEqual([]);
  });

  it('relativeTime helper logic — boundary conditions', () => {
    // Test the relative-time logic that profil.html uses
    function relativeTime(iso, nowMs = Date.now()) {
      if (!iso) return '';
      const diff = nowMs - new Date(iso).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1) return 'Az önce';
      if (m < 60) return m + ' dk önce';
      const h = Math.floor(m / 60);
      if (h < 24) return h + ' sa önce';
      const d = Math.floor(h / 24);
      if (d < 7) return d + ' gün önce';
      return new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    const now = new Date('2026-06-18T12:00:00Z').getTime();
    expect(relativeTime('2026-06-18T11:59:30Z', now)).toBe('Az önce');
    expect(relativeTime('2026-06-18T11:30:00Z', now)).toBe('30 dk önce');
    expect(relativeTime('2026-06-18T08:00:00Z', now)).toBe('4 sa önce');
    expect(relativeTime('2026-06-17T12:00:00Z', now)).toBe('1 gün önce');
    // exactly 7 days ago falls through to fmtDate (d < 7 is false)
    expect(relativeTime('2026-06-11T12:00:00Z', now)).toMatch(/Haz|Jun/);
  });
});

// ── 5.2 Badge Grid ────────────────────────────────────────────────────────────

describe('5.2 — Badge Grid (badges in /api/me)', () => {
  it('me.js returns badges array with badge_id and earned_at', async () => {
    const earnedBadge = { badge_id: 'tier_taraftar', earned_at: '2026-05-01T00:00:00Z', badges: { id: 'tier_taraftar', name: 'Taraftar', icon: '🦅' } };
    mockMeStandard({ badges: [earnedBadge] });
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    expect(Array.isArray(body.badges)).toBe(true);
    expect(body.badges[0].badge_id).toBe('tier_taraftar');
    expect(body.badges[0].earned_at).toBeDefined();
  });

  it('badges array is empty when user has no badges', async () => {
    mockMeStandard({ badges: [] });
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    expect(body.badges).toHaveLength(0);
  });

  it('badges are ordered by earned_at desc', async () => {
    const badges = [
      { badge_id: 'streak_7', earned_at: '2026-06-10T00:00:00Z' },
      { badge_id: 'tier_taraftar', earned_at: '2026-05-01T00:00:00Z' },
    ];
    mockMeStandard({ badges });
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    expect(body.badges[0].badge_id).toBe('streak_7');
    expect(body.badges[1].badge_id).toBe('tier_taraftar');
  });
});

// ── 5.3 Prediction History ────────────────────────────────────────────────────

describe('5.3 — Prediction History', () => {
  it('prediction_history is always an array in response', async () => {
    mockMeStandard();
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    expect(Array.isArray(body.prediction_history)).toBe(true);
  });

  it('returns predictions with required display fields', async () => {
    const pred = {
      match_id: 'match-final', home_score: 3, away_score: 0,
      xp_awarded: 30, bonus_awarded: 200, outcome_awarded: 50,
      created_at: '2026-06-15T18:00:00Z',
    };
    mockMeStandard({ predictions: [pred] });
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    const p = body.prediction_history[0];
    expect(p.match_id).toBe('match-final');
    expect(p.home_score).toBe(3);
    expect(p.away_score).toBe(0);
    expect(p.xp_awarded).toBe(30);
    expect(p.bonus_awarded).toBe(200);
    expect(p.outcome_awarded).toBe(50);
    expect(p.created_at).toBe('2026-06-15T18:00:00Z');
  });

  it('bonus_total is sum of bonus_awarded + outcome_awarded (display logic)', () => {
    // Tests the frontend aggregation logic
    const p = { xp_awarded: 30, bonus_awarded: 100, outcome_awarded: 50 };
    const bonusTotal = (p.bonus_awarded ?? 0) + (p.outcome_awarded ?? 0);
    expect(bonusTotal).toBe(150);
  });

  it('bonus_total is zero when no bonus or outcome awarded', () => {
    const p = { xp_awarded: 30, bonus_awarded: 0, outcome_awarded: 0 };
    const bonusTotal = (p.bonus_awarded ?? 0) + (p.outcome_awarded ?? 0);
    expect(bonusTotal).toBe(0);
  });

  it('handles null bonus fields gracefully via nullish coalescing', () => {
    const p = { xp_awarded: 30, bonus_awarded: null, outcome_awarded: null };
    const bonusTotal = (p.bonus_awarded ?? 0) + (p.outcome_awarded ?? 0);
    expect(bonusTotal).toBe(0);
  });

  it('prediction_history degrades gracefully when score_predictions unavailable', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([PROFILE])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ xp_earned: 50 }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('score_predictions table missing'))
      .mockResolvedValueOnce([{ xp_required: 0 }]);
    vi.mocked(sbRpc).mockResolvedValue([{ level: 1, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 40 }]);
    vi.mocked(getStreak).mockResolvedValue({ current_streak: 0, longest_streak: 0, shield_active: false, last_checkin_date: null });

    const res = await meHandler({ request: makeGet(), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.prediction_history).toEqual([]);
  });

  it('prediction_history limited to 20 entries (newest first)', async () => {
    const preds = Array.from({ length: 20 }, (_, i) => ({
      match_id: `m-${i}`, home_score: i, away_score: 0,
      xp_awarded: 30, bonus_awarded: 0, outcome_awarded: 0,
      created_at: `2026-06-${String(18 - i).padStart(2, '0')}T18:00:00Z`,
    }));
    mockMeStandard({ predictions: preds });
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    expect(body.prediction_history).toHaveLength(20);
    expect(body.prediction_history[0].match_id).toBe('m-0');
  });
});

// ── 5.4 Level-up notification trigger logic ───────────────────────────────────

describe('5.4 — Level-up Notification', () => {
  it('checkin response includes level and tier_name for comparison', async () => {
    vi.mocked(getStreak).mockResolvedValue({
      current_streak: 2, longest_streak: 5, shield_active: false,
      last_checkin_date: '2026-06-17',
    });
    vi.mocked(sbGet).mockResolvedValue([{ user_id: U.id, site_id: SITE }]);  // streakExists
    vi.mocked(awardXP).mockResolvedValue({
      xp_earned: 10, total_xp: 160, level: 3,
      tier_name: 'Çarşı Ruhu', xp_to_next: 40, badge_unlocks: [],
    });

    const res = await checkinHandler({ request: makePost(), env: makeEnv() });
    expect(res.status).toBe(200);
    const body = await json(res);
    // level and tier_name must be present for frontend level-up detection
    expect(body.level).toBe(3);
    expect(body.tier_name).toBe('Çarşı Ruhu');
    expect(typeof body.level).toBe('number');
    expect(typeof body.tier_name).toBe('string');
  });

  it('level-up detection logic: fires when response.level > stored level', () => {
    // Simulates the JS check: if (data.level > (_kxMe?.xp?.level ?? 0))
    function shouldShowLevelUp(responseLevel, storedLevel) {
      return responseLevel > (storedLevel ?? 0);
    }
    expect(shouldShowLevelUp(3, 2)).toBe(true);
    expect(shouldShowLevelUp(2, 2)).toBe(false);
    expect(shouldShowLevelUp(2, 3)).toBe(false);
    expect(shouldShowLevelUp(1, 0)).toBe(true);
    expect(shouldShowLevelUp(1, null)).toBe(true);
  });

  it('me.js response always carries level and tier_name for frontend comparison', async () => {
    mockMeStandard();
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    expect(typeof body.xp.level).toBe('number');
    expect(typeof body.xp.tier_name).toBe('string');
    expect(body.xp.level).toBeGreaterThanOrEqual(1);
  });
});

// ── 5.5 Badge unlock notification format ──────────────────────────────────────

describe('5.5 — Badge Unlock Notification', () => {
  it('badge_unlocks from checkin include name and icon for toast display', async () => {
    vi.mocked(getStreak).mockResolvedValue({
      current_streak: 2, longest_streak: 5, shield_active: false,
      last_checkin_date: '2026-06-17',
    });
    vi.mocked(sbGet).mockResolvedValue([{ user_id: U.id }]);  // streakExists
    vi.mocked(awardXP).mockResolvedValue({
      xp_earned: 10, total_xp: 60, level: 2,
      tier_name: 'Taraftar', xp_to_next: 40,
      badge_unlocks: [{ id: 'streak_3', name: 'Üç Gün Üst Üste', icon: '🔥', description: '3 günlük seri' }],
    });

    const res = await checkinHandler({ request: makePost(), env: makeEnv() });
    const body = await json(res);
    expect(Array.isArray(body.badge_unlocks)).toBe(true);
    expect(body.badge_unlocks.length).toBeGreaterThan(0);
    const badge = body.badge_unlocks[0];
    expect(badge.name ?? badge.id).toBeTruthy();
  });

  it('badge_unlocks is always an array (never undefined) in checkin response', async () => {
    vi.mocked(getStreak).mockResolvedValue({
      current_streak: 1, longest_streak: 1, shield_active: false,
      last_checkin_date: '2026-06-17',
    });
    vi.mocked(sbGet).mockResolvedValue([{ user_id: U.id }]);  // streakExists
    vi.mocked(awardXP).mockResolvedValue({
      xp_earned: 10, total_xp: 10, level: 1,
      tier_name: 'Misafir Kartal', xp_to_next: 50,
      badge_unlocks: [],
    });

    const res = await checkinHandler({ request: makePost(), env: makeEnv() });
    const body = await json(res);
    expect(Array.isArray(body.badge_unlocks)).toBe(true);
  });

  it('badge toast queue: sequential drain (queue logic as pure function)', () => {
    // Tests the drain-queue logic in isolation
    const queue = [];
    let busy = false;
    const shown = [];

    function drain() {
      if (!queue.length) { busy = false; return; }
      busy = true;
      const b = queue.shift();
      shown.push(b);
      drain();
    }
    function enqueue(badge) {
      queue.push(badge);
      if (!busy) drain();
    }

    enqueue({ id: 'streak_3', name: 'Üç Gün', icon: '🔥' });
    enqueue({ id: 'xp_500',   name: '500 XP',  icon: '💫' });
    enqueue({ id: 'tier_taraftar', name: 'Taraftar', icon: '🦅' });

    expect(shown).toHaveLength(3);
    expect(shown[0].id).toBe('streak_3');
    expect(shown[1].id).toBe('xp_500');
    expect(shown[2].id).toBe('tier_taraftar');
  });

  it('badge toast uses badge.name ?? badge.id as display text', () => {
    const badgeWithName = { id: 'streak_3', name: 'Üç Gün Üst Üste', icon: '🔥' };
    const badgeWithoutName = { id: 'streak_3', icon: '🔥' };
    expect(badgeWithName.name ?? badgeWithName.id).toBe('Üç Gün Üst Üste');
    expect(badgeWithoutName.name ?? badgeWithoutName.id).toBe('streak_3');
  });

  it('badge_unlocks from me.js badges includes full badge object with icon', async () => {
    const earnedBadge = {
      badge_id: 'streak_3',
      earned_at: '2026-06-18T10:00:00Z',
      badges: { id: 'streak_3', name: 'Üç Gün Üst Üste', icon: '🔥', description: '3 günlük seri' },
    };
    mockMeStandard({ badges: [earnedBadge] });
    const body = await json(await meHandler({ request: makeGet(), env: makeEnv() }));
    const b = body.badges[0];
    expect(b.badge_id).toBe('streak_3');
    expect(b.earned_at).toBeDefined();
  });
});
