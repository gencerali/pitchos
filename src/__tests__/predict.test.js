/**
 * Phase 4.1 — Score Prediction tests
 *
 * Covers /api/xp/predict and /api/xp/evaluate-predictions.
 *
 * Invariants locked in by this file:
 *  1. predict rejects any request within 5 min of kickoff
 *  2. duplicate predictions (same user + match) return 409, not a silent no-op
 *  3. evaluate-predictions is internal-only — wrong secret = 403
 *  4. exact-score bonus is awarded only when both home AND away match exactly
 *  5. Skor Avcısı badge is awarded once (idempotent)
 *  6. all predictions (exact or not) are marked xp_awarded=true after evaluation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../functions/api/_shared/auth.js', () => ({
  getUser:     vi.fn(),
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
    sbGet:  vi.fn(),
    sbPost: vi.fn(),
    sbPatch: vi.fn(),
    awardXP: vi.fn(),
  };
});

import { getUser }   from '../../functions/api/_shared/auth.js';
import { getSiteId } from '../../functions/api/_shared/site.js';
import { sbGet, sbPost, sbPatch, awardXP } from '../../functions/api/_shared/xp.js';

import { onRequest as predictHandler }  from '../../functions/api/xp/predict.js';
import { onRequest as evaluateHandler } from '../../functions/api/xp/evaluate-predictions.js';

// ── Constants ────────────────────────────────────────────────────────────────

const FAKE_USER    = { id: 'user-1', email: 'taraftar@bjk.com.tr' };
const FAKE_SITE_ID = 'site-bjk-1';
const MATCH_ID     = 12345;

// kickoff 2 hours in the future — safely past the 5-min lock window
const FUTURE_KICKOFF   = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
// kickoff 3 minutes from now — inside the 5-min lock window
const IMMINENT_KICKOFF = new Date(Date.now() + 3 * 60 * 1000).toISOString();
// kickoff 1 minute ago — already started
const PAST_KICKOFF     = new Date(Date.now() - 60 * 1000).toISOString();

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnv(overrides = {}) {
  return {
    SUPABASE_URL:              'https://proj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
    SUPABASE_ANON_KEY:         'anon-key',
    API_FOOTBALL_KEY:          'football-api-key',
    INTERNAL_SECRET:           'super-secret-internal',
    ...overrides,
  };
}

function predictReq(body = { match_id: MATCH_ID, home_score: 2, away_score: 1 }) {
  return new Request('https://kartalix.com/api/xp/predict', {
    method: 'POST',
    headers: { Authorization: 'Bearer fake-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fixturePayload(kickoffDate = FUTURE_KICKOFF) {
  return {
    response: [{
      fixture: { id: MATCH_ID, date: kickoffDate, status: { short: 'NS' } },
      teams:   { home: { id: 2672, name: 'Beşiktaş' }, away: { id: 611, name: 'Fenerbahçe' } },
      league:  { name: 'Süper Lig', season: 2025 },
    }],
  };
}

function mockFootball(payload = fixturePayload(), status = 200) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(payload), {
      status, headers: { 'Content-Type': 'application/json' },
    })
  );
}

async function json(res) { return res.json(); }

const PREDICT_XP = {
  xp_earned: 30, total_xp: 80, level: 2,
  tier_name: 'Şahin', xp_to_next: 20, badge_unlocks: [],
};
const FIRST_PREDICT_BONUS = {
  xp_earned: 25, total_xp: 105, level: 2,
  tier_name: 'Şahin', xp_to_next: 0, badge_unlocks: [],
};
const FIRST_PREDICT_CAPPED = {
  xp_earned: 0, capped: true, reason: 'already_earned',
  total_xp: 80, level: 2, tier_name: 'Şahin', xp_to_next: 20, badge_unlocks: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// /api/xp/predict
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/xp/predict — HTTP method guard', () => {
  it('returns 204 for OPTIONS (CORS preflight)', async () => {
    const res = await predictHandler({
      request: new Request('https://kartalix.com/api/xp/predict', { method: 'OPTIONS' }),
      env: makeEnv(),
    });
    expect(res.status).toBe(204);
  });

  it('returns 405 for GET', async () => {
    const res = await predictHandler({
      request: new Request('https://kartalix.com/api/xp/predict', {
        method: 'GET', headers: { Authorization: 'Bearer t' },
      }),
      env: makeEnv(),
    });
    expect(res.status).toBe(405);
  });
});

// ── Auth & site ──────────────────────────────────────────────────────────────

describe('/api/xp/predict — auth', () => {
  it('returns 401 when no valid session', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(null);
    vi.mocked(getSiteId).mockResolvedValueOnce(FAKE_SITE_ID);
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('returns 404 when site_id cannot be resolved', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValueOnce(null);
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    expect(res.status).toBe(404);
  });
});

// ── Request body validation ──────────────────────────────────────────────────

describe('/api/xp/predict — body validation', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
  });

  it('returns 400 when match_id is missing', async () => {
    const res = await predictHandler({
      request: predictReq({ home_score: 1, away_score: 0 }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when home_score is missing', async () => {
    const res = await predictHandler({
      request: predictReq({ match_id: MATCH_ID, away_score: 0 }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when away_score is missing', async () => {
    const res = await predictHandler({
      request: predictReq({ match_id: MATCH_ID, home_score: 2 }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when home_score is negative', async () => {
    const res = await predictHandler({
      request: predictReq({ match_id: MATCH_ID, home_score: -1, away_score: 0 }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when away_score is negative', async () => {
    const res = await predictHandler({
      request: predictReq({ match_id: MATCH_ID, home_score: 0, away_score: -1 }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when home_score is a float', async () => {
    const res = await predictHandler({
      request: predictReq({ match_id: MATCH_ID, home_score: 1.5, away_score: 0 }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when away_score is a float', async () => {
    const res = await predictHandler({
      request: predictReq({ match_id: MATCH_ID, home_score: 0, away_score: 2.7 }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed JSON body', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValueOnce(FAKE_SITE_ID);
    const res = await predictHandler({
      request: new Request('https://kartalix.com/api/xp/predict', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: 'not-json',
      }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });
});

// ── api-football fixture validation ──────────────────────────────────────────

describe('/api/xp/predict — fixture lookup', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns 503 when api-football is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('upstream error', { status: 503 })
    );
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    expect(res.status).toBe(503);
  });

  it('returns 400 when api-football response has no fixtures', async () => {
    mockFootball({ response: [] });
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  it('returns 400 with Turkish message when kickoff is imminent (3 min away)', async () => {
    mockFootball(fixturePayload(IMMINENT_KICKOFF));
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Tahmin süresi doldu/);
  });

  it('returns 400 when match has already started', async () => {
    mockFootball(fixturePayload(PAST_KICKOFF));
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  it('passes through when kickoff is safely in the future', async () => {
    mockFootball(fixturePayload(FUTURE_KICKOFF));
    vi.mocked(sbGet).mockResolvedValueOnce([]);   // no existing prediction
    vi.mocked(sbPost).mockResolvedValueOnce({});
    vi.mocked(awardXP)
      .mockResolvedValueOnce(PREDICT_XP)
      .mockResolvedValueOnce(FIRST_PREDICT_CAPPED);
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    expect(res.status).toBe(200);
  });
});

// ── Duplicate prediction guard ────────────────────────────────────────────────

describe('/api/xp/predict — duplicate guard', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns 409 when user already predicted this match', async () => {
    mockFootball(fixturePayload(FUTURE_KICKOFF));
    vi.mocked(sbGet).mockResolvedValueOnce([{ id: 'pred-uuid-1' }]); // existing
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    const body = await json(res);
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/zaten tahmin/i);
  });

  it('does NOT call awardXP when duplicate detected', async () => {
    mockFootball(fixturePayload(FUTURE_KICKOFF));
    vi.mocked(sbGet).mockResolvedValueOnce([{ id: 'pred-uuid-1' }]);
    await predictHandler({ request: predictReq(), env: makeEnv() });
    expect(vi.mocked(awardXP)).not.toHaveBeenCalled();
  });
});

// ── Successful prediction ─────────────────────────────────────────────────────

describe('/api/xp/predict — successful submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
    mockFootball(fixturePayload(FUTURE_KICKOFF));
    vi.mocked(sbGet).mockResolvedValueOnce([]);  // no existing prediction
    vi.mocked(sbPost).mockResolvedValueOnce({});
  });

  afterEach(() => vi.restoreAllMocks());

  it('saves the prediction to score_predictions table', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce(PREDICT_XP)
      .mockResolvedValueOnce(FIRST_PREDICT_CAPPED);
    await predictHandler({ request: predictReq({ match_id: MATCH_ID, home_score: 2, away_score: 1 }), env: makeEnv() });
    expect(vi.mocked(sbPost)).toHaveBeenCalledWith(
      expect.anything(),
      'score_predictions',
      expect.objectContaining({ match_id: MATCH_ID, home_score: 2, away_score: 1 })
    );
  });

  it('calls awardXP twice: predict_score then first_score_predict', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce(PREDICT_XP)
      .mockResolvedValueOnce(FIRST_PREDICT_BONUS);
    await predictHandler({ request: predictReq(), env: makeEnv() });
    expect(vi.mocked(awardXP)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(awardXP).mock.calls[0][3]).toBe('predict_score');
    expect(vi.mocked(awardXP).mock.calls[0][4]).toBe(String(MATCH_ID));
    expect(vi.mocked(awardXP).mock.calls[1][3]).toBe('first_score_predict');
  });

  it('returns prediction_saved: true on success', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce(PREDICT_XP)
      .mockResolvedValueOnce(FIRST_PREDICT_CAPPED);
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.prediction_saved).toBe(true);
  });

  it('returns xp_earned from predict_score call', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce(PREDICT_XP)
      .mockResolvedValueOnce(FIRST_PREDICT_CAPPED);
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.xp_earned).toBe(30);
  });

  it('uses bonus total_xp and level when first_score_predict earns XP', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce(PREDICT_XP)
      .mockResolvedValueOnce(FIRST_PREDICT_BONUS);
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.total_xp).toBe(105);  // from FIRST_PREDICT_BONUS
    expect(body.bonus_xp).toBe(25);
  });

  it('falls back to predict_score total_xp when first_score_predict already earned', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce(PREDICT_XP)
      .mockResolvedValueOnce(FIRST_PREDICT_CAPPED);
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.total_xp).toBe(80);   // falls back to PREDICT_XP
    expect(body.bonus_xp).toBe(0);    // capped → no bonus
  });

  it('merges badge_unlocks from both XP calls', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce({ ...PREDICT_XP,         badge_unlocks: [{ id: 'xp_500' }] })
      .mockResolvedValueOnce({ ...FIRST_PREDICT_BONUS, badge_unlocks: [{ id: 'tier_taraftar' }] });
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.badge_unlocks).toHaveLength(2);
    expect(body.badge_unlocks.map(b => b.id)).toEqual(['xp_500', 'tier_taraftar']);
  });

  it('returns empty badge_unlocks when neither call unlocks a badge', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce(PREDICT_XP)
      .mockResolvedValueOnce(FIRST_PREDICT_CAPPED);
    const res = await predictHandler({ request: predictReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.badge_unlocks).toHaveLength(0);
  });

  it('passes user_id and site_id to sbGet for duplicate check', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce(PREDICT_XP)
      .mockResolvedValueOnce(FIRST_PREDICT_CAPPED);
    await predictHandler({ request: predictReq(), env: makeEnv() });
    const [, path] = vi.mocked(sbGet).mock.calls[0];
    expect(path).toContain(`user_id=eq.${FAKE_USER.id}`);
    expect(path).toContain(`site_id=eq.${FAKE_SITE_ID}`);
    expect(path).toContain(`match_id=eq.${MATCH_ID}`);
  });

  it('accepts a 0-0 draw prediction', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce(PREDICT_XP)
      .mockResolvedValueOnce(FIRST_PREDICT_CAPPED);
    const res = await predictHandler({
      request: predictReq({ match_id: MATCH_ID, home_score: 0, away_score: 0 }),
      env: makeEnv(),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.prediction_saved).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/xp/evaluate-predictions
// ─────────────────────────────────────────────────────────────────────────────

function evaluateReq({
  secret = 'super-secret-internal',
  body   = { match_id: MATCH_ID, site_id: FAKE_SITE_ID, home_score: 2, away_score: 1 },
} = {}) {
  return new Request('https://kartalix.com/api/xp/evaluate-predictions', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Internal-Secret': secret,
    },
    body: JSON.stringify(body),
  });
}

const EXACT_PRED = {
  id: 'pred-1', user_id: 'user-1', site_id: FAKE_SITE_ID,
  match_id: MATCH_ID, home_score: 2, away_score: 1,
  xp_awarded: false, bonus_awarded: false,
};
const WRONG_PRED = {
  id: 'pred-2', user_id: 'user-2', site_id: FAKE_SITE_ID,
  match_id: MATCH_ID, home_score: 0, away_score: 0,
  xp_awarded: false, bonus_awarded: false,
};
const CLOSE_PRED = {
  id: 'pred-3', user_id: 'user-3', site_id: FAKE_SITE_ID,
  match_id: MATCH_ID, home_score: 2, away_score: 2, // right home, wrong away
  xp_awarded: false, bonus_awarded: false,
};

const BONUS_XP_RESULT = {
  xp_earned: 100, total_xp: 180, level: 3,
  tier_name: 'Şahin', xp_to_next: 20, badge_unlocks: [],
};

// ── Security ─────────────────────────────────────────────────────────────────

describe('/api/xp/evaluate-predictions — security', () => {
  it('returns 405 for GET', async () => {
    const res = await evaluateHandler({
      request: new Request('https://kartalix.com/api/xp/evaluate-predictions', { method: 'GET' }),
      env: makeEnv(),
    });
    expect(res.status).toBe(405);
  });

  it('returns 403 when X-Internal-Secret header is missing', async () => {
    const res = await evaluateHandler({
      request: new Request('https://kartalix.com/api/xp/evaluate-predictions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: MATCH_ID, site_id: FAKE_SITE_ID, home_score: 2, away_score: 1 }),
      }),
      env: makeEnv(),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when X-Internal-Secret is wrong', async () => {
    const res = await evaluateHandler({
      request: evaluateReq({ secret: 'wrong-secret' }),
      env: makeEnv(),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when INTERNAL_SECRET env var is not set', async () => {
    const res = await evaluateHandler({
      request: evaluateReq({ secret: 'super-secret-internal' }),
      env: makeEnv({ INTERNAL_SECRET: undefined }),
    });
    expect(res.status).toBe(403);
  });
});

// ── Body validation ───────────────────────────────────────────────────────────

describe('/api/xp/evaluate-predictions — body validation', () => {
  it('returns 400 when match_id is missing', async () => {
    const res = await evaluateHandler({
      request: evaluateReq({ body: { site_id: FAKE_SITE_ID, home_score: 2, away_score: 1 } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when site_id is missing', async () => {
    const res = await evaluateHandler({
      request: evaluateReq({ body: { match_id: MATCH_ID, home_score: 2, away_score: 1 } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when home_score is missing', async () => {
    const res = await evaluateHandler({
      request: evaluateReq({ body: { match_id: MATCH_ID, site_id: FAKE_SITE_ID, away_score: 1 } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when away_score is missing', async () => {
    const res = await evaluateHandler({
      request: evaluateReq({ body: { match_id: MATCH_ID, site_id: FAKE_SITE_ID, home_score: 2 } }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });
});

// ── No predictions ────────────────────────────────────────────────────────────

describe('/api/xp/evaluate-predictions — empty predictions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns evaluated: 0 and empty results when no predictions exist', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([]); // no predictions
    const res = await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.evaluated).toBe(0);
    expect(body.results).toHaveLength(0);
    expect(vi.mocked(awardXP)).not.toHaveBeenCalled();
  });

  it('does not call sbPatch when there are no predictions', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([]);
    await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    expect(vi.mocked(sbPatch)).not.toHaveBeenCalled();
  });
});

// ── Exact score match ─────────────────────────────────────────────────────────

describe('/api/xp/evaluate-predictions — exact score bonus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('awards exact_score_bonus for a correct prediction', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([EXACT_PRED])   // predictions list
      .mockResolvedValueOnce([]);             // no existing Skor Avcısı badge
    vi.mocked(sbPost).mockResolvedValueOnce({});  // badge insert
    vi.mocked(sbPatch).mockResolvedValueOnce({});
    vi.mocked(awardXP).mockResolvedValueOnce(BONUS_XP_RESULT);

    await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    expect(vi.mocked(awardXP)).toHaveBeenCalledWith(
      expect.anything(),
      EXACT_PRED.user_id,
      FAKE_SITE_ID,
      'exact_score_bonus',
      String(MATCH_ID)
    );
  });

  it('marks exact prediction as xp_awarded AND bonus_awarded', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([EXACT_PRED])
      .mockResolvedValueOnce([]);
    vi.mocked(sbPost).mockResolvedValueOnce({});
    vi.mocked(sbPatch).mockResolvedValueOnce({});
    vi.mocked(awardXP).mockResolvedValueOnce(BONUS_XP_RESULT);

    await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    expect(vi.mocked(sbPatch)).toHaveBeenCalledWith(
      expect.anything(),
      `score_predictions?id=eq.${EXACT_PRED.id}`,
      { xp_awarded: true, bonus_awarded: true }
    );
  });

  it('returns exact: true in results for correct prediction', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([EXACT_PRED])
      .mockResolvedValueOnce([]);
    vi.mocked(sbPost).mockResolvedValueOnce({});
    vi.mocked(sbPatch).mockResolvedValueOnce({});
    vi.mocked(awardXP).mockResolvedValueOnce(BONUS_XP_RESULT);

    const res = await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.results[0].exact).toBe(true);
    expect(body.results[0].bonus_xp).toBe(100);
  });

  it('partial match (correct home, wrong away) does NOT trigger exact bonus', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([CLOSE_PRED]);
    vi.mocked(sbPatch).mockResolvedValueOnce({});

    const res = await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    const body = await json(res);
    expect(vi.mocked(awardXP)).not.toHaveBeenCalled();
    expect(body.results[0].exact).toBe(false);
  });

  it('does NOT award bonus_awarded flag for a wrong prediction', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([WRONG_PRED]);
    vi.mocked(sbPatch).mockResolvedValueOnce({});

    await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    expect(vi.mocked(sbPatch)).toHaveBeenCalledWith(
      expect.anything(),
      `score_predictions?id=eq.${WRONG_PRED.id}`,
      { xp_awarded: true }  // no bonus_awarded: true
    );
  });
});

// ── Skor Avcısı badge (first exact prediction) ────────────────────────────────

describe('/api/xp/evaluate-predictions — Skor Avcısı badge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts exact_score_first badge when user has never had one', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([EXACT_PRED])
      .mockResolvedValueOnce([]);              // no existing badge
    vi.mocked(sbPost).mockResolvedValueOnce({});
    vi.mocked(sbPatch).mockResolvedValueOnce({});
    vi.mocked(awardXP).mockResolvedValueOnce(BONUS_XP_RESULT);

    await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    expect(vi.mocked(sbPost)).toHaveBeenCalledWith(
      expect.anything(),
      'user_badges',
      expect.objectContaining({ badge_id: 'exact_score_first', user_id: EXACT_PRED.user_id })
    );
  });

  it('does NOT insert badge when user already has exact_score_first', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([EXACT_PRED])
      .mockResolvedValueOnce([{ id: 'badge-exists' }]); // badge already exists
    vi.mocked(sbPatch).mockResolvedValueOnce({});
    vi.mocked(awardXP).mockResolvedValueOnce(BONUS_XP_RESULT);

    await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    expect(vi.mocked(sbPost)).not.toHaveBeenCalled();
  });

  it('badge check uses correct user_id and site_id', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([EXACT_PRED])
      .mockResolvedValueOnce([]);
    vi.mocked(sbPost).mockResolvedValueOnce({});
    vi.mocked(sbPatch).mockResolvedValueOnce({});
    vi.mocked(awardXP).mockResolvedValueOnce(BONUS_XP_RESULT);

    await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    const badgeCheck = vi.mocked(sbGet).mock.calls[1][1];
    expect(badgeCheck).toContain(`user_id=eq.${EXACT_PRED.user_id}`);
    expect(badgeCheck).toContain(`site_id=eq.${FAKE_SITE_ID}`);
    expect(badgeCheck).toContain('exact_score_first');
  });
});

// ── Mixed predictions ─────────────────────────────────────────────────────────

describe('/api/xp/evaluate-predictions — mixed predictions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('handles a mix: 1 exact + 2 wrong — only awards bonus once', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([EXACT_PRED, WRONG_PRED, CLOSE_PRED]) // predictions
      .mockResolvedValueOnce([]);   // badge check for EXACT_PRED (no prior badge)
    vi.mocked(sbPost).mockResolvedValueOnce({});   // badge insert
    vi.mocked(sbPatch)
      .mockResolvedValueOnce({})   // EXACT_PRED patch
      .mockResolvedValueOnce({})   // WRONG_PRED patch
      .mockResolvedValueOnce({});  // CLOSE_PRED patch
    vi.mocked(awardXP).mockResolvedValueOnce(BONUS_XP_RESULT); // only exact gets this

    const res = await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    const body = await json(res);

    expect(body.evaluated).toBe(3);
    expect(body.results.filter(r => r.exact)).toHaveLength(1);
    expect(body.results.filter(r => !r.exact)).toHaveLength(2);
    expect(vi.mocked(awardXP)).toHaveBeenCalledTimes(1);
  });

  it('marks every prediction as xp_awarded=true regardless of exactness', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([EXACT_PRED, WRONG_PRED])
      .mockResolvedValueOnce([]);
    vi.mocked(sbPost).mockResolvedValueOnce({});
    vi.mocked(sbPatch)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    vi.mocked(awardXP).mockResolvedValueOnce(BONUS_XP_RESULT);

    await evaluateHandler({ request: evaluateReq(), env: makeEnv() });

    const patchCalls = vi.mocked(sbPatch).mock.calls;
    expect(patchCalls).toHaveLength(2);
    patchCalls.forEach(([, , patchBody]) => {
      expect(patchBody.xp_awarded).toBe(true);
    });
  });

  it('returns correct evaluated count', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([EXACT_PRED, WRONG_PRED, CLOSE_PRED])
      .mockResolvedValueOnce([]);
    vi.mocked(sbPost).mockResolvedValueOnce({});
    vi.mocked(sbPatch)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    vi.mocked(awardXP).mockResolvedValueOnce(BONUS_XP_RESULT);

    const res = await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.evaluated).toBe(3);
    expect(body.match_id).toBe(MATCH_ID);
    expect(body.site_id).toBe(FAKE_SITE_ID);
  });
});

// ── Idempotency — predictions query filters ───────────────────────────────────

describe('/api/xp/evaluate-predictions — query filters', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only queries predictions where xp_awarded=false', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([]);
    await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    const queryPath = vi.mocked(sbGet).mock.calls[0][1];
    expect(queryPath).toContain('xp_awarded=eq.false');
  });

  it('queries predictions scoped to the given match_id and site_id', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([]);
    await evaluateHandler({ request: evaluateReq(), env: makeEnv() });
    const queryPath = vi.mocked(sbGet).mock.calls[0][1];
    expect(queryPath).toContain(`match_id=eq.${MATCH_ID}`);
    expect(queryPath).toContain(`site_id=eq.${FAKE_SITE_ID}`);
  });
});
