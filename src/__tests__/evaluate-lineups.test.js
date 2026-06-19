/**
 * evaluate-lineups.js tests
 *
 * Invariants:
 *  1. POST-only; OPTIONS rejected
 *  2. X-Internal-Secret required — 403 without it
 *  3. Missing / invalid body fields → 400
 *  4. player_ids must be exactly 11 → 400
 *  5. Actual lineup recorded to actual_lineups (idempotent — skips if already recorded)
 *  6. Fetches only unscored (correct_count IS NULL) predictions for the match
 *  7. correct_count = intersection of predicted ids ∩ actual ids
 *  8. Updates starting_elevens with correct_count + actual_player_ids + xp_awarded=true
 *  9. Awards lineup_11_correct XP only for perfect 11/11
 * 10. Awards lineup_predict_* badges when 8+ correct threshold met
 * 11. Returns evaluated count and per-user result list
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../functions/api/_shared/auth.js', () => ({
  json: (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  }),
  err: (msg, status = 400) => new Response(JSON.stringify({ error: msg }), { status }),
}));

vi.mock('../../functions/api/_shared/xp.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, sbGet: vi.fn(), sbPost: vi.fn(), sbPatch: vi.fn(), awardXP: vi.fn() };
});

import { sbGet, sbPost, sbPatch, awardXP } from '../../functions/api/_shared/xp.js';
import { onRequest } from '../../functions/api/xp/evaluate-lineups.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SECRET    = 'test-secret';
const MATCH_ID  = '98765';
const SITE_ID   = 'site-bjk-1';
const USER_1    = 'user-uuid-1';
const USER_2    = 'user-uuid-2';

const ACTUAL_IDS   = [1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11];
const PERFECT_PRED = [1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11]; // 11/11
const GOOD_PRED    = [1,  2,  3,  4,  5,  6,  7,  8,  99, 88, 77]; // 8/11
const POOR_PRED    = [99, 88, 77, 66, 55, 44, 33, 22, 11, 10, 9];  // 3/11

function makeEnv() {
  return {
    SUPABASE_URL:              'https://proj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
    INTERNAL_SECRET:           SECRET,
  };
}

function makeReq(body = {}, secret = SECRET) {
  return new Request('https://kartalix.com/api/xp/evaluate-lineups', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'X-Internal-Secret': secret,
    },
    body: JSON.stringify(body),
  });
}

function makePred(user_id, player_ids, id = `pred-${user_id}`) {
  return { id, user_id, player_ids, match_id: MATCH_ID, site_id: SITE_ID, correct_count: null };
}

const PERFECT_XP = { xp_earned: 150, total_xp: 500, badge_unlocks: [{ id: 'lineup_perfect_1', label: 'Mükemmel Kadro' }] };
const ZERO_XP    = { xp_earned: 0,   total_xp: 400, badge_unlocks: [] };

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/xp/evaluate-lineups', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Auth / method guards ──────────────────────────────────────────────────

  it('rejects GET', async () => {
    const res = await onRequest({
      request: new Request('https://x.com', { method: 'GET', headers: { 'X-Internal-Secret': SECRET } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(405);
  });

  it('returns 403 without secret', async () => {
    const res = await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }, 'wrong'), env: makeEnv() });
    expect(res.status).toBe(403);
  });

  it('returns 403 with missing secret header', async () => {
    const req = new Request('https://x.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const res = await onRequest({ request: req, env: makeEnv() });
    expect(res.status).toBe(403);
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it('returns 400 for missing match_id', async () => {
    const res = await onRequest({ request: makeReq({ site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing site_id', async () => {
    const res = await onRequest({ request: makeReq({ match_id: MATCH_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  it('returns 400 for fewer than 11 player_ids', async () => {
    const res = await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: [1, 2, 3] }), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-array player_ids', async () => {
    const res = await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: 'bad' }), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  // ── Idempotency: actual_lineups ───────────────────────────────────────────

  it('records actual lineup when not yet stored', async () => {
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    sbPost.mockResolvedValue({});

    await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });

    expect(sbPost).toHaveBeenCalledWith(expect.anything(), 'actual_lineups', expect.objectContaining({
      match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS,
    }));
  });

  it('skips recording actual lineup when already stored', async () => {
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([{ id: 'existing' }]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });

    expect(sbPost).not.toHaveBeenCalledWith(expect.anything(), 'actual_lineups', expect.anything());
  });

  // ── Scoring ───────────────────────────────────────────────────────────────

  it('computes correct_count as intersection of predicted and actual ids', async () => {
    const pred = makePred(USER_1, GOOD_PRED); // 8 overlap with ACTUAL_IDS
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([pred]);
      if (path.includes('correct_count=gte.8')) return Promise.resolve([{ id: 'q1' }]);
      if (path.includes('user_badges')) return Promise.resolve([]);
      if (path.includes('badges?id=eq.lineup_predict_1')) return Promise.resolve([{ id: 'lineup_predict_1', label: 'İlk Kadro Kahin' }]);
      return Promise.resolve([]);
    });
    sbPost.mockResolvedValue({});
    sbPatch.mockResolvedValue({});
    awardXP.mockResolvedValue(ZERO_XP);

    await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });

    expect(sbPatch).toHaveBeenCalledWith(
      expect.anything(),
      `starting_elevens?id=eq.${pred.id}`,
      expect.objectContaining({ correct_count: 8 })
    );
  });

  it('stores actual_player_ids and sets xp_awarded=true on the prediction row', async () => {
    const pred = makePred(USER_1, POOR_PRED);
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([pred]);
      return Promise.resolve([]);
    });
    sbPost.mockResolvedValue({});
    sbPatch.mockResolvedValue({});
    awardXP.mockResolvedValue(ZERO_XP);

    await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });

    expect(sbPatch).toHaveBeenCalledWith(
      expect.anything(),
      `starting_elevens?id=eq.${pred.id}`,
      expect.objectContaining({ actual_player_ids: ACTUAL_IDS, xp_awarded: true })
    );
  });

  // ── Perfect 11/11 XP ─────────────────────────────────────────────────────

  it('awards lineup_11_correct XP for a perfect 11/11 prediction', async () => {
    const pred = makePred(USER_1, PERFECT_PRED);
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([pred]);
      if (path.includes('correct_count=gte.8')) return Promise.resolve([{ id: 'q1' }]);
      if (path.includes('user_badges')) return Promise.resolve([]);
      if (path.includes('badges?id=eq.lineup_predict_1')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    sbPost.mockResolvedValue({});
    sbPatch.mockResolvedValue({});
    awardXP.mockResolvedValue(PERFECT_XP);

    await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });

    expect(awardXP).toHaveBeenCalledWith(
      expect.anything(), USER_1, SITE_ID, 'lineup_11_correct', MATCH_ID
    );
  });

  it('does NOT award lineup_11_correct XP for a partial prediction', async () => {
    const pred = makePred(USER_1, GOOD_PRED); // 8/11, not perfect
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([pred]);
      if (path.includes('correct_count=gte.8')) return Promise.resolve([{ id: 'q1' }]);
      if (path.includes('user_badges')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    sbPost.mockResolvedValue({});
    sbPatch.mockResolvedValue({});

    await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });

    expect(awardXP).not.toHaveBeenCalled();
  });

  // ── 8+ badge logic ────────────────────────────────────────────────────────

  it('awards lineup_predict_1 badge on first 8+ correct prediction', async () => {
    const pred = makePred(USER_1, GOOD_PRED);
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([pred]);
      if (path.includes('correct_count=gte.8')) return Promise.resolve([{ id: 'q1' }]); // 1 qualifying
      if (path.includes('user_badges')) return Promise.resolve([]); // no badge yet
      if (path.includes('badges?id=eq.lineup_predict_1')) return Promise.resolve([{ id: 'lineup_predict_1', label: 'İlk Kadro Kahin' }]);
      return Promise.resolve([]);
    });
    sbPost.mockResolvedValue({});
    sbPatch.mockResolvedValue({});

    const res = await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });

    expect(sbPost).toHaveBeenCalledWith(
      expect.anything(), 'user_badges', expect.objectContaining({ badge_id: 'lineup_predict_1', user_id: USER_1 })
    );
    const data = await res.json();
    expect(data.results[0].badge_unlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lineup_predict_1' }),
    ]));
  });

  it('skips badge already earned', async () => {
    const pred = makePred(USER_1, GOOD_PRED);
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([pred]);
      if (path.includes('correct_count=gte.8')) return Promise.resolve([{ id: 'q1' }]);
      if (path.includes('user_badges')) return Promise.resolve([{ id: 'existing-badge' }]); // already has it
      return Promise.resolve([]);
    });
    sbPost.mockResolvedValue({});
    sbPatch.mockResolvedValue({});

    await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });

    expect(sbPost).not.toHaveBeenCalledWith(expect.anything(), 'user_badges', expect.objectContaining({ badge_id: 'lineup_predict_1' }));
  });

  it('does not check badges for fewer than 8 correct', async () => {
    const pred = makePred(USER_1, POOR_PRED); // 3/11
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([pred]);
      return Promise.resolve([]);
    });
    sbPost.mockResolvedValue({});
    sbPatch.mockResolvedValue({});

    await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });

    // No qualifying query should have been made
    expect(sbGet).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('correct_count=gte.8'));
  });

  // ── Multiple users ────────────────────────────────────────────────────────

  it('evaluates multiple predictions independently', async () => {
    const pred1 = makePred(USER_1, PERFECT_PRED, 'pred-1');
    const pred2 = makePred(USER_2, POOR_PRED,    'pred-2');

    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([pred1, pred2]);
      if (path.includes('correct_count=gte.8')) return Promise.resolve([{ id: 'q1' }]);
      if (path.includes('user_badges')) return Promise.resolve([]);
      if (path.includes('badges?id=eq.lineup_predict_1')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    sbPost.mockResolvedValue({});
    sbPatch.mockResolvedValue({});
    awardXP.mockResolvedValue(PERFECT_XP);

    const res = await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });
    const data = await res.json();

    expect(data.evaluated).toBe(2);
    expect(data.results.find(r => r.user_id === USER_1)).toMatchObject({ correct_count: 11, perfect: true });
    expect(data.results.find(r => r.user_id === USER_2)).toMatchObject({ correct_count: 3,  perfect: false });
    // XP only awarded once (for user_1)
    expect(awardXP).toHaveBeenCalledTimes(1);
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it('returns evaluated count and results array', async () => {
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    const res = await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS }), env: makeEnv() });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ match_id: MATCH_ID, site_id: SITE_ID, evaluated: 0, results: [] });
  });

  it('passes formation through to actual_lineups when provided', async () => {
    sbGet.mockImplementation((_env, path) => {
      if (path.includes('actual_lineups')) return Promise.resolve([]);
      if (path.includes('starting_elevens?match_id')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    sbPost.mockResolvedValue({});

    await onRequest({ request: makeReq({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_IDS, formation: '4-3-3' }), env: makeEnv() });

    expect(sbPost).toHaveBeenCalledWith(expect.anything(), 'actual_lineups', expect.objectContaining({ formation: '4-3-3' }));
  });
});
