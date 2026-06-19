/**
 * Tests for /api/xp/evaluate-starting-11 (cron endpoint).
 *
 * Invariants:
 *  1. Only POST accepted; guarded by X-Internal-Secret
 *  2. Requires match_id, site_id, and exactly 11 player_ids in body
 *  3. correct_count = intersection of predicted vs actual player IDs
 *  4. Only the HIGHEST tier XP is awarded (≥11 → lineup_11_correct, etc.)
 *  5. Predictions with correct_count < 8 receive 0 XP
 *  6. lineup_predict_* badges awarded on cumulative ≥8-correct predictions
 *  7. lineup_perfect_* badges awarded on cumulative 11/11 predictions
 *  8. Badges are idempotent (checked before insert)
 *  9. starting_elevens.correct_count + actual_player_ids updated after evaluation
 * 10. actual_lineups row stored (duplicate silently ignored)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../functions/api/_shared/auth.js', () => ({
  json: (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  }),
  err: (msg, status = 400) => new Response(JSON.stringify({ error: msg }), { status }),
}));

vi.mock('../../functions/api/_shared/xp.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    sbGet:   vi.fn(),
    sbPost:  vi.fn(),
    sbPatch: vi.fn(),
    awardXP: vi.fn(),
  };
});

import { sbGet, sbPost, sbPatch, awardXP } from '../../functions/api/_shared/xp.js';
import { onRequest as evalHandler } from '../../functions/api/xp/evaluate-starting-11.js';

// ── Constants ────────────────────────────────────────────────────────────────

const MATCH_ID  = 'match-bjk-2026';
const SITE_ID   = 'site-bjk-1';
const INTERNAL  = 'super-secret-internal';

const ACTUAL_11 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const USER_ID   = 'user-predict-1';

function makeEnv(overrides = {}) {
  return {
    SUPABASE_URL:              'https://proj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
    INTERNAL_SECRET:           INTERNAL,
    ...overrides,
  };
}

function evalReq({ secret = INTERNAL, body = null } = {}) {
  const defaultBody = { match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_11 };
  return new Request('https://kartalix.com/api/xp/evaluate-starting-11', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': secret,
    },
    body: JSON.stringify(body ?? defaultBody),
  });
}

function makePred(overrides = {}) {
  return {
    id:         'pred-1',
    user_id:    USER_ID,
    site_id:    SITE_ID,
    match_id:   MATCH_ID,
    player_ids: ACTUAL_11,   // 11/11 correct by default
    xp_awarded: false,
    ...overrides,
  };
}

const XP_RESULT = { xp_earned: 150, total_xp: 500, level: 4, tier_name: 'Atmaca', xp_to_next: 100, badge_unlocks: [] };

async function jsonBody(res) { return res.json(); }

// ── Helpers for mock setup ───────────────────────────────────────────────────

function setupNoBadges() {
  // When no badge thresholds are met, sbGet after count returns enough to indicate earned
  // This is set up inline per test as needed
}

beforeEach(() => {
  vi.clearAllMocks();
  sbPost.mockResolvedValue([]);
  sbPatch.mockResolvedValue([]);
  awardXP.mockResolvedValue(XP_RESULT);
});

afterEach(() => vi.clearAllMocks());

// ── Security ─────────────────────────────────────────────────────────────────

describe('/api/xp/evaluate-starting-11 — security', () => {
  it('returns 405 for GET', async () => {
    const res = await evalHandler({
      request: new Request('https://kartalix.com/api/xp/evaluate-starting-11', { method: 'GET' }),
      env: makeEnv(),
    });
    expect(res.status).toBe(405);
  });

  it('returns 403 when X-Internal-Secret header is missing', async () => {
    const res = await evalHandler({
      request: new Request('https://kartalix.com/api/xp/evaluate-starting-11', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: MATCH_ID, site_id: SITE_ID, player_ids: ACTUAL_11 }),
      }),
      env: makeEnv(),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when X-Internal-Secret is wrong', async () => {
    const res = await evalHandler({ request: evalReq({ secret: 'wrong-secret' }), env: makeEnv() });
    expect(res.status).toBe(403);
  });

  it('returns 403 when INTERNAL_SECRET env var is not set', async () => {
    const res = await evalHandler({ request: evalReq(), env: makeEnv({ INTERNAL_SECRET: undefined }) });
    expect(res.status).toBe(403);
  });
});

// ── Body validation ───────────────────────────────────────────────────────────

describe('/api/xp/evaluate-starting-11 — body validation', () => {
  it('returns 400 when match_id is missing', async () => {
    const res = await evalHandler({
      request: evalReq({ body: { site_id: SITE_ID, player_ids: ACTUAL_11 } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when site_id is missing', async () => {
    const res = await evalHandler({
      request: evalReq({ body: { match_id: MATCH_ID, player_ids: ACTUAL_11 } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when player_ids is missing', async () => {
    const res = await evalHandler({
      request: evalReq({ body: { match_id: MATCH_ID, site_id: SITE_ID } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when player_ids has fewer than 11 players', async () => {
    const res = await evalHandler({
      request: evalReq({ body: { match_id: MATCH_ID, site_id: SITE_ID, player_ids: [1, 2, 3] } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when player_ids has more than 11 players', async () => {
    const res = await evalHandler({
      request: evalReq({ body: { match_id: MATCH_ID, site_id: SITE_ID, player_ids: [1,2,3,4,5,6,7,8,9,10,11,12] } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });
});

// ── No predictions ────────────────────────────────────────────────────────────

describe('/api/xp/evaluate-starting-11 — no predictions', () => {
  it('returns evaluated: 0 when no pending predictions exist', async () => {
    sbGet.mockResolvedValueOnce([]); // predictions query → empty
    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(res.status).toBe(200);
    expect(body.evaluated).toBe(0);
    expect(body.results).toHaveLength(0);
    expect(awardXP).not.toHaveBeenCalled();
  });
});

// ── Tiered XP ─────────────────────────────────────────────────────────────────

describe('/api/xp/evaluate-starting-11 — tiered XP', () => {
  function setupPredictionOnly(playerIds) {
    // Mocks for a single prediction with no badge thresholds met:
    // 1. predictions fetch
    // 2. awardXP (if tier met)
    // 3. sbPatch to mark evaluated
    // 4. sbGet for success preds (for predict badges)
    // 5. sbGet for perfect preds (only if 11/11)
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: playerIds })]) // predictions
      .mockResolvedValueOnce([])                                     // success preds (0 → no badges)
      // No perfect preds query for < 11 correct
  }

  it('awards lineup_11_correct XP for 11/11 correct', async () => {
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: ACTUAL_11 })]) // predictions
      .mockResolvedValueOnce([{ id: 'p1' }])                         // success preds (count=1)
      .mockResolvedValueOnce([])                                     // user_badges for predict_1 → not earned
      .mockResolvedValueOnce([{ id: 'lineup_predict_1', label: 'İlk Tahmin', icon: '🎯' }]) // badge metadata
      .mockResolvedValueOnce([{ id: 'p1' }])                         // perfect preds (count=1)
      .mockResolvedValueOnce([])                                     // user_badges for perfect_1 → not earned
      .mockResolvedValueOnce([{ id: 'lineup_perfect_1', label: 'Mükemmel', icon: '⭐' }]); // badge metadata

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    expect(res.status).toBe(200);
    expect(awardXP).toHaveBeenCalledWith(
      expect.anything(), USER_ID, SITE_ID, 'lineup_11_correct', String(MATCH_ID)
    );
  });

  it('awards lineup_10_correct XP for 10/11 correct', async () => {
    const tenCorrect = [...ACTUAL_11.slice(0, 10), 99]; // 10 match + 1 wrong
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: tenCorrect })]) // predictions
      .mockResolvedValueOnce([{ id: 'p1' }])                          // success preds (count=1, ≥8 correct)
      .mockResolvedValueOnce([])                                      // user_badges for predict_1
      .mockResolvedValueOnce([{ id: 'lineup_predict_1' }]);           // badge metadata

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    expect(res.status).toBe(200);
    expect(awardXP).toHaveBeenCalledWith(
      expect.anything(), USER_ID, SITE_ID, 'lineup_10_correct', String(MATCH_ID)
    );
    expect(awardXP).not.toHaveBeenCalledWith(
      expect.anything(), USER_ID, SITE_ID, 'lineup_11_correct', String(MATCH_ID)
    );
  });

  it('awards lineup_9_correct XP for 9/11 correct', async () => {
    const nineCorrect = [...ACTUAL_11.slice(0, 9), 98, 99];
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: nineCorrect })])
      .mockResolvedValueOnce([{ id: 'p1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'lineup_predict_1' }]);

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    expect(awardXP).toHaveBeenCalledWith(
      expect.anything(), USER_ID, SITE_ID, 'lineup_9_correct', String(MATCH_ID)
    );
  });

  it('awards lineup_8_correct XP for 8/11 correct', async () => {
    const eightCorrect = [...ACTUAL_11.slice(0, 8), 97, 98, 99];
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: eightCorrect })])
      .mockResolvedValueOnce([{ id: 'p1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'lineup_predict_1' }]);

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    expect(awardXP).toHaveBeenCalledWith(
      expect.anything(), USER_ID, SITE_ID, 'lineup_8_correct', String(MATCH_ID)
    );
  });

  it('awards 0 XP for 7/11 correct (below threshold)', async () => {
    const sevenCorrect = [...ACTUAL_11.slice(0, 7), 96, 97, 98, 99];
    sbGet.mockResolvedValueOnce([makePred({ player_ids: sevenCorrect })]); // predictions only

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(awardXP).not.toHaveBeenCalled();
    expect(body.results[0].xp_earned).toBe(0);
    expect(body.results[0].correct_count).toBe(7);
  });

  it('does NOT also award lower tiers when 11/11 correct — only highest tier', async () => {
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: ACTUAL_11 })])
      .mockResolvedValueOnce([{ id: 'p1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'lineup_predict_1' }])
      .mockResolvedValueOnce([{ id: 'p1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'lineup_perfect_1' }]);

    await evalHandler({ request: evalReq(), env: makeEnv() });
    // awardXP called exactly once (only lineup_11_correct, not lineup_8/9/10)
    expect(awardXP).toHaveBeenCalledTimes(1);
    expect(awardXP.mock.calls[0][3]).toBe('lineup_11_correct');
  });
});

// ── correct_count stored ──────────────────────────────────────────────────────

describe('/api/xp/evaluate-starting-11 — starting_elevens update', () => {
  it('patches starting_elevens with correct_count and actual_player_ids', async () => {
    const tenCorrect = [...ACTUAL_11.slice(0, 10), 99];
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: tenCorrect })])
      .mockResolvedValueOnce([{ id: 'p1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'lineup_predict_1' }]);

    await evalHandler({ request: evalReq(), env: makeEnv() });

    const patchCall = sbPatch.mock.calls.find(c => c[1].includes('starting_elevens'));
    expect(patchCall).toBeDefined();
    expect(patchCall[2]).toMatchObject({
      xp_awarded:         true,
      correct_count:      10,
      actual_player_ids:  ACTUAL_11,
    });
  });

  it('stores actual_lineups for the match', async () => {
    sbGet.mockResolvedValueOnce([]); // no predictions
    await evalHandler({ request: evalReq(), env: makeEnv() });

    const postCall = sbPost.mock.calls.find(c => c[1] === 'actual_lineups');
    expect(postCall).toBeDefined();
    expect(postCall[2]).toMatchObject({
      match_id:   String(MATCH_ID),
      site_id:    SITE_ID,
      player_ids: ACTUAL_11,
    });
  });

  it('returns correct_count in results', async () => {
    const eightCorrect = [...ACTUAL_11.slice(0, 8), 97, 98, 99];
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: eightCorrect })])
      .mockResolvedValueOnce([{ id: 'p1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'lineup_predict_1' }]);

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.results[0].correct_count).toBe(8);
  });
});

// ── Prediction milestone badges ───────────────────────────────────────────────

describe('/api/xp/evaluate-starting-11 — lineup_predict badges', () => {
  it('awards lineup_predict_1 badge on first ≥8 correct prediction', async () => {
    const eightCorrect = [...ACTUAL_11.slice(0, 8), 97, 98, 99];
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: eightCorrect })])  // predictions
      .mockResolvedValueOnce([{ id: 'p1' }])                             // success preds count=1
      .mockResolvedValueOnce([])                                         // user_badges → not earned
      .mockResolvedValueOnce([{ id: 'lineup_predict_1', label: 'İlk Başarılı Tahmin', icon: '🎯' }]); // badge info

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.results[0].badge_unlocks.some(b => b.id === 'lineup_predict_1')).toBe(true);
  });

  it('does NOT award lineup_predict_5 when user has only 3 successful predictions', async () => {
    const tenCorrect = [...ACTUAL_11.slice(0, 10), 99];
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: tenCorrect })])    // predictions
      .mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]) // success preds count=3
      // Only lineup_predict_1 is checked (3 >= 1); lineup_predict_5 (3 < 5) → skipped
      .mockResolvedValueOnce([{ id: 'already' }]);                      // predict_1 already earned

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    const badgeIds = body.results[0].badge_unlocks.map(b => b.id);
    expect(badgeIds).not.toContain('lineup_predict_5');
  });

  it('awards lineup_predict_5 badge when user has 5 successful predictions', async () => {
    const tenCorrect = [...ACTUAL_11.slice(0, 10), 99];
    const fiveSuccessPreds = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }, { id: 'p5' }];
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: tenCorrect })])  // predictions
      .mockResolvedValueOnce(fiveSuccessPreds)                         // success preds count=5
      // lineup_predict_5 eligible: sbGet(user_badges) → not earned → insert → badge meta
      .mockResolvedValueOnce([])                                       // predict_5 not earned
      .mockResolvedValueOnce([{ id: 'lineup_predict_5', label: '5 Tahmin', icon: '🔥' }])
      // lineup_predict_1 also eligible: already earned → skip
      .mockResolvedValueOnce([{ id: 'already-earned' }]);             // predict_1 already earned

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    const badgeIds = body.results[0].badge_unlocks.map(b => b.id);
    expect(badgeIds).toContain('lineup_predict_5');
  });

  it('does NOT award badge when prediction has <8 correct', async () => {
    const sevenCorrect = [...ACTUAL_11.slice(0, 7), 96, 97, 98, 99];
    sbGet.mockResolvedValueOnce([makePred({ player_ids: sevenCorrect })]); // predictions only

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.results[0].badge_unlocks).toHaveLength(0);
    // Success preds NOT queried when <8 correct
    expect(sbGet).toHaveBeenCalledTimes(1);
  });
});

// ── Perfect prediction badges ─────────────────────────────────────────────────

describe('/api/xp/evaluate-starting-11 — lineup_perfect badges', () => {
  it('awards lineup_perfect_1 badge on first 11/11 correct prediction', async () => {
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: ACTUAL_11 })])  // predictions
      .mockResolvedValueOnce([{ id: 'p1' }])                          // success preds count=1
      .mockResolvedValueOnce([])                                      // predict_1 not earned
      .mockResolvedValueOnce([{ id: 'lineup_predict_1' }])            // predict_1 badge meta
      .mockResolvedValueOnce([{ id: 'p1' }])                          // perfect preds count=1
      .mockResolvedValueOnce([])                                      // perfect_1 not earned
      .mockResolvedValueOnce([{ id: 'lineup_perfect_1', label: 'Mükemmel 11', icon: '⭐' }]); // badge meta

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    const badgeIds = body.results[0].badge_unlocks.map(b => b.id);
    expect(badgeIds).toContain('lineup_perfect_1');
  });

  it('does NOT award lineup_perfect_1 for 10/11 correct (only exact 11/11)', async () => {
    const tenCorrect = [...ACTUAL_11.slice(0, 10), 99];
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: tenCorrect })])
      .mockResolvedValueOnce([{ id: 'p1' }])    // success preds
      .mockResolvedValueOnce([])                 // predict_1 not earned
      .mockResolvedValueOnce([{ id: 'lineup_predict_1' }]);
    // perfect preds NOT queried for 10/11

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    const badgeIds = body.results[0].badge_unlocks.map(b => b.id);
    expect(badgeIds).not.toContain('lineup_perfect_1');
  });

  it('is idempotent — does not re-award lineup_perfect_1 if already earned', async () => {
    sbGet
      .mockResolvedValueOnce([makePred({ player_ids: ACTUAL_11 })])
      .mockResolvedValueOnce([{ id: 'p1' }])
      .mockResolvedValueOnce([{ id: 'already' }])   // predict_1 already earned → skip
      .mockResolvedValueOnce([{ id: 'p1' }])         // perfect preds
      .mockResolvedValueOnce([{ id: 'already' }]);   // perfect_1 already earned → skip

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    // No badge inserts — everything already earned
    const insertCalls = sbPost.mock.calls.filter(c => c[1] === 'user_badges');
    expect(insertCalls).toHaveLength(0);
    expect(body.results[0].badge_unlocks).toHaveLength(0);
  });
});

// ── Multi-prediction batch ───────────────────────────────────────────────────

describe('/api/xp/evaluate-starting-11 — multi-prediction batch', () => {
  it('evaluates multiple predictions in one call', async () => {
    const user2 = 'user-predict-2';
    const pred1 = makePred({ id: 'pred-a', user_id: USER_ID, player_ids: ACTUAL_11 });
    const pred2 = makePred({ id: 'pred-b', user_id: user2, player_ids: [...ACTUAL_11.slice(0, 7), 96, 97, 98, 99] });

    sbGet
      .mockResolvedValueOnce([pred1, pred2])          // predictions fetch (2 preds)
      // pred1: 11/11 → awardXP, then predict/perfect badge checks
      .mockResolvedValueOnce([{ id: 'pred-a' }])      // success preds user1 count=1
      .mockResolvedValueOnce([{ id: 'existing' }])    // predict_1 already earned
      .mockResolvedValueOnce([{ id: 'pred-a' }])      // perfect preds user1 count=1
      .mockResolvedValueOnce([{ id: 'existing' }]);   // perfect_1 already earned
    // pred2: 7/11 → no awardXP, no badge queries

    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.evaluated).toBe(2);
    expect(body.results[0].correct_count).toBe(11);
    expect(body.results[1].correct_count).toBe(7);
    expect(body.results[1].xp_earned).toBe(0);
  });

  it('skips already-evaluated predictions (xp_awarded filter on query)', async () => {
    sbGet.mockResolvedValueOnce([]); // xp_awarded=eq.false returns 0
    const res = await evalHandler({ request: evalReq(), env: makeEnv() });
    const body = await jsonBody(res);
    expect(body.evaluated).toBe(0);
    // The query must include xp_awarded=eq.false filter
    const predQuery = sbGet.mock.calls[0][1];
    expect(predQuery).toContain('xp_awarded=eq.false');
  });
});
