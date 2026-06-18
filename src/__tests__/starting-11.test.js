/**
 * Phase 4.3 — Starting 11 prediction tests
 *
 * Covers /api/xp/starting-11.
 *
 * Invariants locked in by this file:
 *  1. Requires exactly 11 positive-integer player IDs
 *  2. Rejects submission once match has kicked off
 *  3. One lineup per user per match (409 on duplicate)
 *  4. Awards submit_starting_11 XP + first_starting_11 bonus
 *  5. Saves to starting_elevens table before awarding XP
 *  6. api-football failure propagates correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  return { ...real, sbGet: vi.fn(), sbPost: vi.fn(), awardXP: vi.fn() };
});

import { getUser }   from '../../functions/api/_shared/auth.js';
import { getSiteId } from '../../functions/api/_shared/site.js';
import { sbGet, sbPost, awardXP } from '../../functions/api/_shared/xp.js';

import { onRequest as starting11Handler } from '../../functions/api/xp/starting-11.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_USER    = { id: 'user-1', email: 'taraftar@bjk.com.tr' };
const FAKE_SITE_ID = 'site-bjk-1';
const MATCH_ID     = 98765;

const FUTURE_KICKOFF = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const PAST_KICKOFF   = new Date(Date.now() - 5 * 60 * 1000).toISOString();

const VALID_PLAYERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const SUBMIT_XP = {
  xp_earned: 25, total_xp: 100, level: 2,
  tier_name: 'Şahin', xp_to_next: 0, badge_unlocks: [],
};
const FIRST_BONUS_XP = {
  xp_earned: 20, total_xp: 120, level: 2,
  tier_name: 'Şahin', xp_to_next: 0, badge_unlocks: [],
};
const FIRST_BONUS_CAPPED = {
  xp_earned: 0, capped: true, reason: 'already_earned',
  total_xp: 100, level: 2, tier_name: 'Şahin', xp_to_next: 0, badge_unlocks: [],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnv(overrides = {}) {
  return {
    SUPABASE_URL:              'https://proj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
    SUPABASE_ANON_KEY:         'anon-key',
    API_FOOTBALL_KEY:          'football-api-key',
    ...overrides,
  };
}

function s11Req(body = { match_id: MATCH_ID, player_ids: VALID_PLAYERS }) {
  return new Request('https://kartalix.com/api/xp/starting-11', {
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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP method guard
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/xp/starting-11 — HTTP method guard', () => {
  it('returns 204 for OPTIONS (CORS preflight)', async () => {
    const res = await starting11Handler({
      request: new Request('https://kartalix.com/api/xp/starting-11', { method: 'OPTIONS' }),
      env: makeEnv(),
    });
    expect(res.status).toBe(204);
  });

  it('returns 405 for GET', async () => {
    const res = await starting11Handler({
      request: new Request('https://kartalix.com/api/xp/starting-11', {
        method: 'GET', headers: { Authorization: 'Bearer t' },
      }),
      env: makeEnv(),
    });
    expect(res.status).toBe(405);
  });
});

// ── Auth & site ──────────────────────────────────────────────────────────────

describe('/api/xp/starting-11 — auth', () => {
  it('returns 401 when no valid session', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(null);
    vi.mocked(getSiteId).mockResolvedValueOnce(FAKE_SITE_ID);
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('returns 404 when site cannot be resolved', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValueOnce(null);
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    expect(res.status).toBe(404);
  });
});

// ── Request body validation ──────────────────────────────────────────────────

describe('/api/xp/starting-11 — body validation', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
  });

  it('returns 400 when match_id is missing', async () => {
    const res = await starting11Handler({
      request: s11Req({ player_ids: VALID_PLAYERS }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when player_ids is missing', async () => {
    const res = await starting11Handler({
      request: s11Req({ match_id: MATCH_ID }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when player_ids is not an array', async () => {
    const res = await starting11Handler({
      request: s11Req({ match_id: MATCH_ID, player_ids: 'not-an-array' }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when fewer than 11 players supplied', async () => {
    const res = await starting11Handler({
      request: s11Req({ match_id: MATCH_ID, player_ids: [1, 2, 3] }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when more than 11 players supplied', async () => {
    const res = await starting11Handler({
      request: s11Req({ match_id: MATCH_ID, player_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a player_id is not a positive integer (float)', async () => {
    const players = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10.5];
    const res = await starting11Handler({
      request: s11Req({ match_id: MATCH_ID, player_ids: players }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a player_id is zero', async () => {
    const players = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const res = await starting11Handler({
      request: s11Req({ match_id: MATCH_ID, player_ids: players }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when a player_id is negative', async () => {
    const players = [-1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const res = await starting11Handler({
      request: s11Req({ match_id: MATCH_ID, player_ids: players }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed JSON body', async () => {
    const res = await starting11Handler({
      request: new Request('https://kartalix.com/api/xp/starting-11', {
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

describe('/api/xp/starting-11 — fixture lookup', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns 503 when api-football is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('upstream error', { status: 503 })
    );
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    expect(res.status).toBe(503);
  });

  it('returns 400 when api-football response has no fixtures', async () => {
    mockFootball({ response: [] });
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    expect(res.status).toBe(400);
  });

  it('returns 400 when match has already started', async () => {
    mockFootball(fixturePayload(PAST_KICKOFF));
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Maç başladı/);
  });

  it('passes through when kickoff is in the future', async () => {
    mockFootball(fixturePayload(FUTURE_KICKOFF));
    vi.mocked(sbGet).mockResolvedValueOnce([]);   // no existing lineup
    vi.mocked(sbPost).mockResolvedValueOnce({});
    vi.mocked(awardXP)
      .mockResolvedValueOnce(SUBMIT_XP)
      .mockResolvedValueOnce(FIRST_BONUS_CAPPED);
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    expect(res.status).toBe(200);
  });
});

// ── Duplicate lineup guard ────────────────────────────────────────────────────

describe('/api/xp/starting-11 — duplicate guard', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns 409 when user already submitted lineup for this match', async () => {
    mockFootball(fixturePayload(FUTURE_KICKOFF));
    vi.mocked(sbGet).mockResolvedValueOnce([{ id: 'existing-lineup' }]);
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    const body = await json(res);
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/zaten/i);
  });

  it('does NOT call awardXP when duplicate detected', async () => {
    mockFootball(fixturePayload(FUTURE_KICKOFF));
    vi.mocked(sbGet).mockResolvedValueOnce([{ id: 'existing-lineup' }]);
    await starting11Handler({ request: s11Req(), env: makeEnv() });
    expect(vi.mocked(awardXP)).not.toHaveBeenCalled();
  });
});

// ── Successful submission ─────────────────────────────────────────────────────

describe('/api/xp/starting-11 — successful submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
    mockFootball(fixturePayload(FUTURE_KICKOFF));
    vi.mocked(sbGet).mockResolvedValueOnce([]);   // no existing lineup
    vi.mocked(sbPost).mockResolvedValueOnce({});
  });

  afterEach(() => vi.restoreAllMocks());

  it('saves lineup to starting_elevens table', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(SUBMIT_XP).mockResolvedValueOnce(FIRST_BONUS_CAPPED);
    await starting11Handler({ request: s11Req(), env: makeEnv() });
    expect(vi.mocked(sbPost)).toHaveBeenCalledWith(
      expect.anything(),
      'starting_elevens',
      expect.objectContaining({ match_id: MATCH_ID, player_ids: VALID_PLAYERS })
    );
  });

  it('calls awardXP twice: submit_starting_11 then first_starting_11', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(SUBMIT_XP).mockResolvedValueOnce(FIRST_BONUS_XP);
    await starting11Handler({ request: s11Req(), env: makeEnv() });
    expect(vi.mocked(awardXP)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(awardXP).mock.calls[0][3]).toBe('submit_starting_11');
    expect(vi.mocked(awardXP).mock.calls[0][4]).toBe(String(MATCH_ID));
    expect(vi.mocked(awardXP).mock.calls[1][3]).toBe('first_starting_11');
  });

  it('returns lineup_saved: true', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(SUBMIT_XP).mockResolvedValueOnce(FIRST_BONUS_CAPPED);
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.lineup_saved).toBe(true);
  });

  it('returns xp_earned from submit_starting_11', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(SUBMIT_XP).mockResolvedValueOnce(FIRST_BONUS_CAPPED);
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    const body = await json(res);
    expect(body.xp_earned).toBe(25);
  });

  it('uses bonus total_xp when first_starting_11 earns XP', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(SUBMIT_XP).mockResolvedValueOnce(FIRST_BONUS_XP);
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    const body = await json(res);
    expect(body.total_xp).toBe(120);
    expect(body.bonus_xp).toBe(20);
  });

  it('falls back to base total_xp when first_starting_11 already earned', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(SUBMIT_XP).mockResolvedValueOnce(FIRST_BONUS_CAPPED);
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    const body = await json(res);
    expect(body.total_xp).toBe(100);
    expect(body.bonus_xp).toBe(0);
  });

  it('merges badge_unlocks from both XP calls', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce({ ...SUBMIT_XP,     badge_unlocks: [{ id: 'xp_500' }] })
      .mockResolvedValueOnce({ ...FIRST_BONUS_XP, badge_unlocks: [{ id: 'tier_taraftar' }] });
    const res = await starting11Handler({ request: s11Req(), env: makeEnv() });
    const body = await json(res);
    expect(body.badge_unlocks).toHaveLength(2);
    expect(body.badge_unlocks.map(b => b.id)).toEqual(['xp_500', 'tier_taraftar']);
  });

  it('passes user_id and site_id to sbGet for duplicate check', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(SUBMIT_XP).mockResolvedValueOnce(FIRST_BONUS_CAPPED);
    await starting11Handler({ request: s11Req(), env: makeEnv() });
    const [, path] = vi.mocked(sbGet).mock.calls[0];
    expect(path).toContain(`user_id=eq.${FAKE_USER.id}`);
    expect(path).toContain(`site_id=eq.${FAKE_SITE_ID}`);
    expect(path).toContain(`match_id=eq.${MATCH_ID}`);
  });

  it('includes user_id and site_id in the starting_elevens row', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(SUBMIT_XP).mockResolvedValueOnce(FIRST_BONUS_CAPPED);
    await starting11Handler({ request: s11Req(), env: makeEnv() });
    expect(vi.mocked(sbPost)).toHaveBeenCalledWith(
      expect.anything(),
      'starting_elevens',
      expect.objectContaining({
        user_id: FAKE_USER.id,
        site_id: FAKE_SITE_ID,
      })
    );
  });
});
