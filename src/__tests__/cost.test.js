import { describe, it, expect } from 'vitest';
import { addCost, costTrajectory, costAlarmConditions, checkCostCap, rollupDailyCost } from '../utils.js';

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

describe('costAlarmConditions — Step 3 decision (defaults)', () => {
  const traj = { cap: 16, daysInMonth: 30, todaySpend: 0.42, onTrack: false };

  it('defaults daily cap to cap / daysInMonth', () => {
    const c = costAlarmConditions(traj, NaN);
    expect(c.dailyCap).toBeCloseTo(16 / 30, 6); // ~0.533
  });
  it('uses an override daily cap when provided', () => {
    expect(costAlarmConditions(traj, 1.0).dailyCap).toBe(1.0);
  });
  it('trajectoryOver mirrors !onTrack', () => {
    expect(costAlarmConditions({ ...traj, onTrack: false }, NaN).trajectoryOver).toBe(true);
    expect(costAlarmConditions({ ...traj, onTrack: true }, NaN).trajectoryOver).toBe(false);
  });
  it('dailyOver true only when today exceeds the daily cap', () => {
    expect(costAlarmConditions({ ...traj, todaySpend: 0.42 }, NaN).dailyOver).toBe(false); // 0.42 < 0.533
    expect(costAlarmConditions({ ...traj, todaySpend: 0.80 }, NaN).dailyOver).toBe(true);  // 0.80 > 0.533
  });
});

describe('checkCostCap — daily enforcement (Step 4, default OFF)', () => {
  const month = new Date().toISOString().slice(0, 7);
  const day = new Date().toISOString().slice(0, 10);

  it('default OFF: never daily-blocks even if today is huge', async () => {
    const env = mkEnv();
    env.store['cost:cap'] = '16';
    env.store[`cost:${month}`] = '2.00';        // under monthly
    env.store[`cost:day:${day}`] = '99.00';     // way over any daily cap
    const r = await checkCostCap(env);           // no cost:daily_enforce
    expect(r.blocked).toBe(false);
  });

  it('monthly block still works and is reported as reason "monthly"', async () => {
    const env = mkEnv();
    env.store['cost:cap'] = '16';
    env.store[`cost:${month}`] = '16.00';
    const r = await checkCostCap(env);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('monthly');
  });

  it('flag ON + daily over (monthly under): blocks with reason "daily"', async () => {
    const env = mkEnv();
    env.store['cost:cap'] = '16';
    env.store['cost:daily_enforce'] = '1';
    env.store[`cost:${month}`] = '2.00';        // under monthly
    env.store[`cost:day:${day}`] = '5.00';      // over daily cap (~0.53 default)
    const r = await checkCostCap(env);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('daily');
  });

  it('flag ON + daily under: not blocked', async () => {
    const env = mkEnv();
    env.store['cost:cap'] = '16';
    env.store['cost:daily_enforce'] = '1';
    env.store[`cost:${month}`] = '2.00';
    env.store[`cost:day:${day}`] = '0.10';      // under daily cap
    const r = await checkCostCap(env);
    expect(r.blocked).toBe(false);
  });
});

describe('rollupDailyCost — archive merge + prune (Step 5a)', () => {
  it('merges live daily over archive (live wins) and keeps recent days', () => {
    const archive = { '2026-06-01': 0.10, '2026-06-05': 0.20 };
    const daily = { '2026-06-05': 0.25, '2026-06-06': 0.40 };
    const out = rollupDailyCost(archive, daily, '2026-06-06', 730);
    expect(out['2026-06-05']).toBe(0.25); // live overrides archive
    expect(out['2026-06-06']).toBe(0.40); // new day added
    expect(out['2026-06-01']).toBe(0.10); // archive kept
  });
  it('prunes entries older than retentionDays', () => {
    const archive = { '2026-01-01': 1.0, '2026-06-01': 2.0 };
    const out = rollupDailyCost(archive, {}, '2026-06-06', 30); // 30-day window
    expect(out['2026-01-01']).toBeUndefined(); // ~156 days old → pruned
    expect(out['2026-06-01']).toBe(2.0);       // 5 days old → kept
  });
});
