import { describe, it, expect } from 'vitest';
import { addCost } from '../utils.js';

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
