/**
 * Tests for the awardXP engine itself — not the endpoint handlers.
 * Mocks globalThis.fetch (the real transport layer) so awardXP and
 * checkBadges logic runs for real. Each test enqueues response payloads
 * in the order the engine will call fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { awardXP, isRateLimited, streakMultiplier } from '../../functions/api/_shared/xp.js';

const ENV     = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
const USER_ID = 'u-1';
const SITE_ID = 's-1';

const ACTION_READ = {
  id: 'read_article', xp_per_action: 10, daily_cap: 5,
  cap_fallback_xp: 1, streak_bonus_eligible: true, active: true,
};
const ACTION_REACT = {
  id: 'react_article', xp_per_action: 1, daily_cap: 10,
  cap_fallback_xp: 0, streak_bonus_eligible: false, active: true,
};
const NO_STREAK = { current_streak: 0, longest_streak: 0, shield_active: false, last_checkin_date: null };
const LEVEL_1   = [{ level: 1, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 49 }];

// ── Fetch queue helpers ───────────────────────────────────────────────────────

let fetchQueue = [];

function jr(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function enqueue(...payloads) {
  fetchQueue.push(...payloads.map(p => () => jr(p)));
}

beforeEach(() => {
  fetchQueue = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const handler = fetchQueue.shift();
    if (!handler) throw new Error(`Unexpected fetch call: ${url}`);
    return handler(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Shared tail: everything after the daily-count check passes ────────────────
// Order: getStreak → sbPost(event) → total-xp-sum → sbRpc(level) → badge checks
// badge checks: for read_article, also checks articles_100 count

function enqueueTail({ totalXp = 10, articleReadCount = 3, xpEventInsertResult = [{}] } = {}) {
  enqueue(
    [NO_STREAK],             // getStreak (user_streaks GET)
  );
  fetchQueue.push(() => jr(xpEventInsertResult)); // sbPost xp_events
  enqueue(
    Array(1).fill({ xp_earned: totalXp }),        // total XP sum
  );
  fetchQueue.push(() => jr(LEVEL_1));              // sbRpc get_user_level
  // checkBadges: level 1 → no tier candidates; streak 0 → no streak candidates
  // read_article count query:
  enqueue(
    Array(articleReadCount).fill({ id: 'e' }),     // read_article count
  );
  // For every badge threshold met by this read count, enqueue an existence check
  // returning "already earned" so checkBadges skips the insert and fetches no more.
  [1, 10, 25, 50, 100, 250, 500]
    .filter(t => articleReadCount >= t)
    .forEach(() => enqueue([{ id: 'badge-already-earned' }]));
}

// ── streakMultiplier pure function ────────────────────────────────────────────

describe('streakMultiplier', () => {
  it('0 days → 1.00', () => expect(streakMultiplier(0)).toBe(1.00));
  it('4 days → 1.00', () => expect(streakMultiplier(4)).toBe(1.00));
  it('5 days → 1.20', () => expect(streakMultiplier(5)).toBe(1.20));
  it('9 days → 1.20', () => expect(streakMultiplier(9)).toBe(1.20));
  it('10 days → 1.50', () => expect(streakMultiplier(10)).toBe(1.50));
  it('30 days → 1.50', () => expect(streakMultiplier(30)).toBe(1.50));
});

// ── Unknown action ────────────────────────────────────────────────────────────

describe('awardXP — unknown action', () => {
  it('returns unknown_action when action not in DB', async () => {
    enqueue([]); // xp_actions returns empty
    const result = await awardXP(ENV, USER_ID, SITE_ID, 'nonexistent_action');
    expect(result).toMatchObject({ xp_earned: 0, reason: 'unknown_action' });
  });
});

// ── Shadow ban ────────────────────────────────────────────────────────────────

describe('awardXP — shadow ban', () => {
  it('inserts nullified event and returns xp_earned: 0', async () => {
    enqueue(
      [ACTION_READ],                              // xp_actions
      [{ shadow_banned: true }],                  // isShadowBanned
      [],                                         // source dedup
      Array(3).fill({ id: 'e' }),                 // daily count (under cap)
      [NO_STREAK],                                // getStreak
    );
    fetchQueue.push(() => {
      // capture the sbPost call body to verify nullified flag
      return jr([{}]);
    });

    // To inspect what was posted, spy on the fetch calls
    const calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      calls.push({ url: url.toString(), body: opts?.body ? JSON.parse(opts.body) : null });
      const handler = fetchQueue.shift();
      if (!handler) throw new Error(`Unexpected fetch: ${url}`);
      return handler();
    });

    const result = await awardXP(ENV, USER_ID, SITE_ID, 'read_article', 'article-x');
    expect(result.xp_earned).toBe(0);
    const postCall = calls.find(c => c.body?.nullified !== undefined);
    expect(postCall?.body?.nullified).toBe(true);
  });
});

// ── Cap fallback — 2.1 ───────────────────────────────────────────────────────

describe('awardXP — cap fallback (2.1)', () => {
  it('awards cap_fallback_xp (1) when daily cap hit with a new article', async () => {
    enqueue(
      [ACTION_READ],
      [{ shadow_banned: false }],
      [],                                  // source dedup — new article
      Array(5).fill({ id: 'e' }),          // daily count = 5 (= cap)
    );
    enqueueTail({ totalXp: 51 });

    const result = await awardXP(ENV, USER_ID, SITE_ID, 'read_article', 'new-article');
    expect(result.xp_earned).toBe(1);
    expect(result.capped).toBe(false);
  });

  it('does NOT award fallback for same article already read (source dedup early-return)', async () => {
    enqueue(
      [ACTION_READ],
      [{ shadow_banned: false }],
      [{ id: 'existing-event' }],          // source dedup hit → returns early
    );

    const result = await awardXP(ENV, USER_ID, SITE_ID, 'read_article', 'already-read');
    expect(result.xp_earned).toBe(0);
    expect(result.reason).toBe('already_earned_source');
    // fetch should only have been called 3 times (no event insert)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('returns daily_cap reason when cap_fallback_xp is 0 (react_article)', async () => {
    enqueue(
      [ACTION_REACT],
      [{ shadow_banned: false }],
      [],                                  // source dedup
      Array(10).fill({ id: 'e' }),         // daily count = 10 (= cap)
    );

    const result = await awardXP(ENV, USER_ID, SITE_ID, 'react_article', 'article-x');
    expect(result.xp_earned).toBe(0);
    expect(result.reason).toBe('daily_cap');
    expect(globalThis.fetch).toHaveBeenCalledTimes(4); // no event insert
  });

  it('awards full XP when under the cap', async () => {
    enqueue(
      [ACTION_READ],
      [{ shadow_banned: false }],
      [],                                  // source dedup
      Array(3).fill({ id: 'e' }),          // daily count = 3 (under cap of 5)
    );
    enqueueTail({ totalXp: 40 });

    const result = await awardXP(ENV, USER_ID, SITE_ID, 'read_article', 'fresh-article');
    expect(result.xp_earned).toBe(10);
  });

  it('inserts event with xp_earned=1 (fallback) when cap hit', async () => {
    const insertedBodies = [];
    const origFetch = globalThis.fetch;

    enqueue(
      [ACTION_READ],
      [{ shadow_banned: false }],
      [],
      Array(5).fill({ id: 'e' }),
    );
    enqueueTail({ totalXp: 51 });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      if (opts?.method === 'POST' && url.toString().includes('/xp_events')) {
        insertedBodies.push(JSON.parse(opts.body));
      }
      return origFetch(url, opts);
    });

    // Re-queue since spy was replaced
    fetchQueue = [];
    enqueue(
      [ACTION_READ],
      [{ shadow_banned: false }],
      [],
      Array(5).fill({ id: 'e' }),
    );
    enqueueTail({ totalXp: 51 });

    // Patch the mock to use fetchQueue
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      if (opts?.method === 'POST' && url.toString().includes('/xp_events')) {
        insertedBodies.push(JSON.parse(opts.body));
        return jr([{}]);
      }
      const handler = fetchQueue.shift();
      if (!handler) throw new Error(`Unexpected GET: ${url}`);
      return handler();
    });

    const result = await awardXP(ENV, USER_ID, SITE_ID, 'read_article', 'cap-test');
    expect(result.xp_earned).toBe(1);
    expect(insertedBodies[0]).toMatchObject({ xp_earned: 1, action_id: 'read_article' });
  });
});

// ── articles_100 badge ────────────────────────────────────────────────────────

describe('awardXP — articles_100 badge', () => {
  function setupForBadge({ readCount }) {
    enqueue(
      [ACTION_READ],
      [{ shadow_banned: false }],
      [],                                  // source dedup
      Array(3).fill({ id: 'e' }),          // daily count (under cap)
      [NO_STREAK],                         // getStreak
    );
    fetchQueue.push(() => jr([{}]));       // xp_events POST
    enqueue(
      [{ xp_earned: 10 }],                // total XP sum
    );
    fetchQueue.push(() => jr(LEVEL_1));   // sbRpc level
    enqueue(Array(readCount).fill({ id: 'e' })); // read_article count

    // Queue existence checks for every badge threshold met by readCount.
    // Lower thresholds return "already earned" (no insert); articles_100 is the
    // one being tested — return "not found" only when readCount reaches it.
    const badgeDefs = [
      { id: 'first_read',   min: 1   },
      { id: 'articles_10',  min: 10  },
      { id: 'articles_25',  min: 25  },
      { id: 'articles_50',  min: 50  },
      { id: 'articles_100', min: 100 },
      { id: 'articles_250', min: 250 },
      { id: 'articles_500', min: 500 },
    ];
    for (const b of badgeDefs) {
      if (readCount < b.min) continue;
      if (b.id === 'articles_100') {
        enqueue([]);                         // not yet earned → trigger insert
        fetchQueue.push(() => jr([{}]));     // user_badges POST
        enqueue([{ id: 'articles_100', label: '100 Makale', icon: '📚' }]); // badges GET
      } else {
        enqueue([{ id: 'badge-already-earned' }]); // already exists → skip insert
      }
    }
  }

  it('does NOT award articles_100 at 99 reads', async () => {
    setupForBadge({ readCount: 99 });
    const result = await awardXP(ENV, USER_ID, SITE_ID, 'read_article', 'art-99');
    expect(result.badge_unlocks).toHaveLength(0);
  });

  it('awards articles_100 badge at exactly 100 reads', async () => {
    setupForBadge({ readCount: 100 });
    const result = await awardXP(ENV, USER_ID, SITE_ID, 'read_article', 'art-100');
    expect(result.badge_unlocks).toHaveLength(1);
    expect(result.badge_unlocks[0].id).toBe('articles_100');
  });

  it('does NOT run article count check when action is react_article (checks reactor count instead)', async () => {
    enqueue(
      [ACTION_REACT],
      [{ shadow_banned: false }],
      [],
      Array(3).fill({ id: 'e' }),          // daily count
      [NO_STREAK],
    );
    fetchQueue.push(() => jr([{}]));       // xp_events POST
    enqueue([{ xp_earned: 1 }]);           // total XP
    fetchQueue.push(() => jr(LEVEL_1));    // level
    // checkBadges: react_article IS in countMap (for reactor_10 / reactor_50).
    // The engine queries the lifetime reaction count; at 3 neither threshold is met.
    enqueue(Array(3).fill({ id: 'e' }));   // react_article lifetime count (< 10)

    const result = await awardXP(ENV, USER_ID, SITE_ID, 'react_article', 'art-x');
    // read_article count check was NOT run (no articles_* candidates queued)
    expect(fetchQueue).toHaveLength(0);
    expect(result.badge_unlocks).toHaveLength(0);
  });
});

// ── Lifetime event dedup (daily_cap = -1) ────────────────────────────────────

const ACTION_FIRST_COMMENT = {
  id: 'first_comment', xp_per_action: 25, daily_cap: -1,
  cap_fallback_xp: 0, streak_bonus_eligible: false, active: true,
};

describe('awardXP — lifetime event dedup (daily_cap = -1)', () => {
  it('awards XP on first call when no prior lifetime event', async () => {
    enqueue(
      [ACTION_FIRST_COMMENT],
      [{ shadow_banned: false }],
      [],                           // hasLifetimeEvent → none
      [NO_STREAK],                  // getStreak
    );
    fetchQueue.push(() => jr([{}]));             // xp_events POST
    enqueue([{ xp_earned: 25 }]);               // total XP
    fetchQueue.push(() => jr(LEVEL_1));          // level
    // checkBadges: no countMap entry for first_comment; 25 XP < 500 milestone

    const result = await awardXP(ENV, USER_ID, SITE_ID, 'first_comment', null);
    expect(result.xp_earned).toBe(25);
    expect(result.capped).toBe(false);
  });

  it('returns capped:true / already_earned on second call without touching DB again', async () => {
    enqueue(
      [ACTION_FIRST_COMMENT],
      [{ shadow_banned: false }],
      [{ id: 'prior-event' }],      // hasLifetimeEvent → already done
    );

    const result = await awardXP(ENV, USER_ID, SITE_ID, 'first_comment', null);
    expect(result.xp_earned).toBe(0);
    expect(result.capped).toBe(true);
    expect(result.reason).toBe('already_earned');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // no event insert, no streak, no total
  });
});

// ── isRateLimited ─────────────────────────────────────────────────────────────

describe('isRateLimited', () => {
  it('returns false when event count is under maxRequests', async () => {
    enqueue(Array(3).fill({ id: 'e' }));
    expect(await isRateLimited(ENV, USER_ID, SITE_ID, 'react_article', { maxRequests: 5, windowMs: 10_000 })).toBe(false);
  });

  it('returns false when event count equals maxRequests (not over)', async () => {
    enqueue(Array(5).fill({ id: 'e' }));
    expect(await isRateLimited(ENV, USER_ID, SITE_ID, 'react_article', { maxRequests: 5, windowMs: 10_000 })).toBe(false);
  });

  it('returns true when event count exceeds maxRequests', async () => {
    enqueue(Array(6).fill({ id: 'e' }));
    expect(await isRateLimited(ENV, USER_ID, SITE_ID, 'react_article', { maxRequests: 5, windowMs: 10_000 })).toBe(true);
  });

  it('uses maxRequests+1 as DB limit to avoid counting more rows than needed', async () => {
    const fetchCalls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      fetchCalls.push(url.toString());
      return jr(Array(6).fill({ id: 'e' }));
    });

    await isRateLimited(ENV, USER_ID, SITE_ID, 'react_article', { maxRequests: 5, windowMs: 10_000 });
    expect(fetchCalls[0]).toContain('limit=6'); // maxRequests + 1
  });
});
