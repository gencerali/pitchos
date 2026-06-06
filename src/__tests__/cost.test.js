import { describe, it, expect } from 'vitest';
import { addCost, costTrajectory } from '../utils.js';

// KV mock that records puts (and their options).
function mkEnv() {
  const store = {};
  const opts = {};
  return {
    store, opts,
    PITCHOS_CACHE: {
      get: async (k) => (k in store ? store[k] : null),
      put: async (k, v, o) => { store[k] = v; if (o) opts[k] = o; },
    },
    MONTHLY_CLAUDE_CAP: '16',
  };
}

describe('addCost — daily spend tracking (Cost Ceiling 1.6 / Step 1)', () => {
  const month = new Date().toISOString().slice(0, 10).slice(0, 7);
  const day = new Date().toISOString().slice(0, 10);

  it('increments BOTH the monthly and the daily counter', async () => {
    const env = mkEnv();
    await addCost(env, 0.42);
    expect(parseFloat(env.store[`cost:${month}`])).toBeCloseTo(0.42, 6);
    expect(parseFloat(env.store[`cost:day:${day}`])).toBeCloseTo(0.42, 6);
  });

  it('accumulates across calls on the same day', async () => {
    const env = mkEnv();
    await addCost(env, 0.42);
    await addCost(env, 0.10);
    expect(parseFloat(env.store[`cost:day:${day}`])).toBeCloseTo(0.52, 6);
    expect(parseFloat(env.store[`cost:${month}`])).toBeCloseTo(0.52, 6);
  });

  it('sets a TTL on the daily key (auto-expiry), not on the monthly', async () => {
    const env = mkEnv();
    await addCost(env, 1);
    expect(env.opts[`cost:day:${day}`]?.expirationTtl).toBeGreaterThan(0);
    expect(env.opts[`cost:${month}`]).toBeUndefined();
  });

  it('ignores zero/negative spend (no keys written)', async () => {
    const env = mkEnv();
    await addCost(env, 0);
    expect(Object.keys(env.store)).toHaveLength(0);
  });
});

describe('costTrajectory — month-end projection (Step 2)', () => {
  it('projects from month-to-date average and flags off-track early', async () => {
    const env = mkEnv();                       // cap 16
    env.store['cost:2026-06'] = '3.60';
    env.store['cost:day:2026-06-06'] = '0.42';
    const t = await costTrajectory(env, new Date('2026-06-06T12:00:00Z'));
    expect(t.dayOfMonth).toBe(6);
    expect(t.daysInMonth).toBe(30);
    expect(t.avgPerDayMTD).toBeCloseTo(0.60, 6);
    expect(t.projectedMonthEnd).toBeCloseTo(18.0, 6); // 0.60 * 30
    expect(t.onTrack).toBe(false);
    expect(t.projectionBasis).toBe('mtd');
    expect(t.pctOfCap).toBeCloseTo(22.5, 4);          // only 22.5% spent so far…
    expect(t.projectedPctOfCap).toBeCloseTo(112.5, 4); // …but projected 112.5%
  });

  it('trailing-7-day catches a spike a cheap early month would mask', async () => {
    const env = mkEnv();                       // cap 16
    env.store['cost:2026-06'] = '0.90';        // MTD avg low (0.30/day → proj 9, looks fine)
    // but the last 3 days each spent 1.40 (a spike, e.g. Method B turned on)
    env.store['cost:day:2026-06-03'] = '1.40';
    env.store['cost:day:2026-06-02'] = '1.40';
    env.store['cost:day:2026-06-01'] = '1.40';
    const t = await costTrajectory(env, new Date('2026-06-03T12:00:00Z'));
    expect(t.projMTD).toBeCloseTo(9.0, 4);     // month-to-date says fine
    expect(t.proj7d).toBeCloseTo((4.2 / 7) * 30, 4); // 0.6/day → 18
    expect(t.projectedMonthEnd).toBeCloseTo(18.0, 4);
    expect(t.projectionBasis).toBe('7d');      // spike wins
    expect(t.onTrack).toBe(false);
  });

  it('on-track when projection stays under cap', async () => {
    const env = mkEnv();
    env.store['cost:2026-06'] = '2.00';
    env.store['cost:day:2026-06-10'] = '0.20';
    const t = await costTrajectory(env, new Date('2026-06-10T00:00:00Z'));
    expect(t.projectedMonthEnd).toBeLessThan(t.cap); // 0.20/day * 30 = 6 < 16
    expect(t.onTrack).toBe(true);
  });
});
