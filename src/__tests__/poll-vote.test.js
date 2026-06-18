/**
 * Phase 4.4 — Poll voting tests
 *
 * Covers /api/xp/poll-vote.
 *
 * Invariants locked in by this file:
 *  1. Requires poll_id and option_id
 *  2. Poll must exist, belong to this site, and be active
 *  3. option_id must be one of the poll's defined options
 *  4. One vote per user per poll per site (409 on duplicate)
 *  5. Saves vote before awarding XP
 *  6. Returns poll_results distribution after successful vote
 *  7. Awards poll_vote XP + first_poll_vote bonus
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

import { onRequest as pollVoteHandler } from '../../functions/api/xp/poll-vote.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_USER    = { id: 'user-1', email: 'taraftar@bjk.com.tr' };
const FAKE_SITE_ID = 'site-bjk-1';
const POLL_ID      = 'poll-uuid-1';

const FAKE_POLL = {
  id: POLL_ID,
  site_id: FAKE_SITE_ID,
  question: 'Beşiktaş bu maçı kazanır mı?',
  options: [
    { id: 'yes', label: 'Evet, kazanır!' },
    { id: 'no',  label: 'Hayır, kaybeder' },
    { id: 'draw', label: 'Beraberlik' },
  ],
  active: true,
};

const VOTE_XP = {
  xp_earned: 15, total_xp: 65, level: 2,
  tier_name: 'Şahin', xp_to_next: 35, badge_unlocks: [],
};
const FIRST_VOTE_BONUS = {
  xp_earned: 10, total_xp: 75, level: 2,
  tier_name: 'Şahin', xp_to_next: 25, badge_unlocks: [],
};
const FIRST_VOTE_CAPPED = {
  xp_earned: 0, capped: true, reason: 'already_earned',
  total_xp: 65, level: 2, tier_name: 'Şahin', xp_to_next: 35, badge_unlocks: [],
};

const ALL_VOTES_AFTER = [
  { option_id: 'yes' }, { option_id: 'yes' }, { option_id: 'no' }, { option_id: 'draw' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEnv(overrides = {}) {
  return {
    SUPABASE_URL:              'https://proj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
    SUPABASE_ANON_KEY:         'anon-key',
    ...overrides,
  };
}

function pollReq(body = { poll_id: POLL_ID, option_id: 'yes' }) {
  return new Request('https://kartalix.com/api/xp/poll-vote', {
    method: 'POST',
    headers: { Authorization: 'Bearer fake-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json(res) { return res.json(); }

// ─────────────────────────────────────────────────────────────────────────────
// HTTP method guard
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/xp/poll-vote — HTTP method guard', () => {
  it('returns 204 for OPTIONS (CORS preflight)', async () => {
    const res = await pollVoteHandler({
      request: new Request('https://kartalix.com/api/xp/poll-vote', { method: 'OPTIONS' }),
      env: makeEnv(),
    });
    expect(res.status).toBe(204);
  });

  it('returns 405 for GET', async () => {
    const res = await pollVoteHandler({
      request: new Request('https://kartalix.com/api/xp/poll-vote', {
        method: 'GET', headers: { Authorization: 'Bearer t' },
      }),
      env: makeEnv(),
    });
    expect(res.status).toBe(405);
  });
});

// ── Auth & site ──────────────────────────────────────────────────────────────

describe('/api/xp/poll-vote — auth', () => {
  it('returns 401 when no valid session', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(null);
    vi.mocked(getSiteId).mockResolvedValueOnce(FAKE_SITE_ID);
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    expect(res.status).toBe(401);
  });

  it('returns 404 when site cannot be resolved', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValueOnce(null);
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    expect(res.status).toBe(404);
  });
});

// ── Body validation ───────────────────────────────────────────────────────────

describe('/api/xp/poll-vote — body validation', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
  });

  it('returns 400 when poll_id is missing', async () => {
    const res = await pollVoteHandler({
      request: pollReq({ option_id: 'yes' }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when option_id is missing', async () => {
    const res = await pollVoteHandler({
      request: pollReq({ poll_id: POLL_ID }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed JSON body', async () => {
    const res = await pollVoteHandler({
      request: new Request('https://kartalix.com/api/xp/poll-vote', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: 'not-json',
      }),
      env: makeEnv(),
    });
    expect(res.status).toBe(400);
  });
});

// ── Poll existence & option validation ───────────────────────────────────────

describe('/api/xp/poll-vote — poll & option validation', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
  });

  it('returns 404 when poll does not exist', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([]); // no polls
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    const body = await json(res);
    expect(res.status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 404 when poll is inactive', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([]); // active filter returns nothing
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    expect(res.status).toBe(404);
  });

  it('returns 400 when option_id is not in the poll options', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([FAKE_POLL]); // poll found
    const res = await pollVoteHandler({
      request: pollReq({ poll_id: POLL_ID, option_id: 'invalid-option' }),
      env: makeEnv(),
    });
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/invalid option/i);
  });
});

// ── Duplicate vote guard ──────────────────────────────────────────────────────

describe('/api/xp/poll-vote — duplicate guard', () => {
  beforeEach(() => {
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
  });

  it('returns 409 when user already voted on this poll', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([FAKE_POLL])                    // poll found
      .mockResolvedValueOnce([{ option_id: 'yes' }]);        // already voted
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    const body = await json(res);
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/zaten oy/i);
  });

  it('does NOT call awardXP when duplicate detected', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([FAKE_POLL])
      .mockResolvedValueOnce([{ option_id: 'yes' }]);
    await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    expect(vi.mocked(awardXP)).not.toHaveBeenCalled();
  });

  it('does NOT call sbPost when duplicate detected', async () => {
    vi.mocked(sbGet)
      .mockResolvedValueOnce([FAKE_POLL])
      .mockResolvedValueOnce([{ option_id: 'yes' }]);
    await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    expect(vi.mocked(sbPost)).not.toHaveBeenCalled();
  });
});

// ── Successful vote ───────────────────────────────────────────────────────────

describe('/api/xp/poll-vote — successful vote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUser).mockResolvedValue(FAKE_USER);
    vi.mocked(getSiteId).mockResolvedValue(FAKE_SITE_ID);
    vi.mocked(sbGet)
      .mockResolvedValueOnce([FAKE_POLL])                // poll found
      .mockResolvedValueOnce([])                         // no existing vote
      .mockResolvedValueOnce(ALL_VOTES_AFTER);           // distribution after vote
    vi.mocked(sbPost).mockResolvedValueOnce({});         // vote insert
  });

  it('saves vote to poll_votes table', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(VOTE_XP).mockResolvedValueOnce(FIRST_VOTE_CAPPED);
    await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    expect(vi.mocked(sbPost)).toHaveBeenCalledWith(
      expect.anything(),
      'poll_votes',
      expect.objectContaining({
        poll_id: POLL_ID,
        user_id: FAKE_USER.id,
        site_id: FAKE_SITE_ID,
        option_id: 'yes',
      })
    );
  });

  it('calls awardXP twice: poll_vote then first_poll_vote', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(VOTE_XP).mockResolvedValueOnce(FIRST_VOTE_BONUS);
    await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    expect(vi.mocked(awardXP)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(awardXP).mock.calls[0][3]).toBe('poll_vote');
    expect(vi.mocked(awardXP).mock.calls[0][4]).toBe(POLL_ID);
    expect(vi.mocked(awardXP).mock.calls[1][3]).toBe('first_poll_vote');
  });

  it('returns vote_saved: true', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(VOTE_XP).mockResolvedValueOnce(FIRST_VOTE_CAPPED);
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body.vote_saved).toBe(true);
  });

  it('returns the chosen option_id in the response', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(VOTE_XP).mockResolvedValueOnce(FIRST_VOTE_CAPPED);
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.option_id).toBe('yes');
  });

  it('returns poll_results with vote counts per option', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(VOTE_XP).mockResolvedValueOnce(FIRST_VOTE_CAPPED);
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.poll_results).toHaveLength(3);
    const yes = body.poll_results.find(r => r.id === 'yes');
    const no  = body.poll_results.find(r => r.id === 'no');
    expect(yes.vote_count).toBe(2);
    expect(no.vote_count).toBe(1);
  });

  it('returns xp_earned from poll_vote call', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(VOTE_XP).mockResolvedValueOnce(FIRST_VOTE_CAPPED);
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.xp_earned).toBe(15);
  });

  it('uses bonus total_xp when first_poll_vote earns XP', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(VOTE_XP).mockResolvedValueOnce(FIRST_VOTE_BONUS);
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.total_xp).toBe(75);
    expect(body.bonus_xp).toBe(10);
  });

  it('falls back to base total_xp when first_poll_vote already earned', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(VOTE_XP).mockResolvedValueOnce(FIRST_VOTE_CAPPED);
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.total_xp).toBe(65);
    expect(body.bonus_xp).toBe(0);
  });

  it('merges badge_unlocks from both XP calls', async () => {
    vi.mocked(awardXP)
      .mockResolvedValueOnce({ ...VOTE_XP,         badge_unlocks: [{ id: 'xp_500' }] })
      .mockResolvedValueOnce({ ...FIRST_VOTE_BONUS, badge_unlocks: [{ id: 'tier_taraftar' }] });
    const res = await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    const body = await json(res);
    expect(body.badge_unlocks).toHaveLength(2);
  });

  it('queries poll_votes with correct poll_id, user_id, site_id for duplicate check', async () => {
    vi.mocked(awardXP).mockResolvedValueOnce(VOTE_XP).mockResolvedValueOnce(FIRST_VOTE_CAPPED);
    await pollVoteHandler({ request: pollReq(), env: makeEnv() });
    const dupeCheckPath = vi.mocked(sbGet).mock.calls[1][1];
    expect(dupeCheckPath).toContain(`poll_id=eq.${POLL_ID}`);
    expect(dupeCheckPath).toContain(`user_id=eq.${FAKE_USER.id}`);
    expect(dupeCheckPath).toContain(`site_id=eq.${FAKE_SITE_ID}`);
  });
});
