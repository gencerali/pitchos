// Source Health (Module 1.1) — pure analytics over pipeline_log rows.
// Per-source pass rate, drop breakdown, and consecutive zero-fetch-day detection, so dead
// or noisy feeds surface before the homepage thins out. Pure + deterministic (inject `now`).

const DEFAULTS = {
  windowDays: 7,          // pipeline_log retention is 7 days
  zeroDayThreshold: 3,    // consecutive zero-fetch days → "dead"
  noisyMinFetched: 20,    // need volume before calling a source noisy
  noisyMaxPassRate: 0.10, // <10% published → noisy
};

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

// rows: [{source_name, stage, run_at}], knownSources: [{name, ...}] (active configs)
export function computeSourceHealth(rows = [], knownSources = [], opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now || new Date();
  const known = new Set(knownSources.map((s) => s.name));
  const byName = {};
  const ensure = (name) => (byName[name] ||= { name, fetched: 0, published: 0, drops: {}, perDay: {}, lastRunAt: null, knownActive: known.has(name) });

  for (const r of rows) {
    const s = ensure(r.source_name || '(unknown)');
    s.fetched++;
    if (r.stage === 'published') s.published++;
    else s.drops[r.stage] = (s.drops[r.stage] || 0) + 1;
    if (r.run_at) {
      s.perDay[dayKey(r.run_at)] = (s.perDay[dayKey(r.run_at)] || 0) + 1;
      if (!s.lastRunAt || r.run_at > s.lastRunAt) s.lastRunAt = r.run_at;
    }
  }
  // Make sure every active configured source appears, even with zero rows (= dead candidate).
  for (const s of knownSources) ensure(s.name);

  const result = Object.values(byName).map((s) => {
    let zeroDays = 0;
    for (let i = 0; i < o.windowDays; i++) {
      const d = dayKey(new Date(now.getTime() - i * 86400000));
      if ((s.perDay[d] || 0) === 0) zeroDays++; else break;
    }
    const passRate = s.fetched ? s.published / s.fetched : 0;
    let status;
    if (zeroDays >= o.zeroDayThreshold) status = 'dead';
    else if (s.fetched === 0) status = 'idle';
    else if (s.fetched >= o.noisyMinFetched && passRate < o.noisyMaxPassRate) status = 'noisy';
    else status = 'healthy';
    return {
      name: s.name, knownActive: s.knownActive, status,
      fetched: s.fetched, published: s.published, passRate: +passRate.toFixed(3),
      drops: s.drops, zeroDays, lastRunAt: s.lastRunAt,
    };
  });

  const rank = { dead: 0, noisy: 1, idle: 2, healthy: 3 };
  result.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.fetched - a.fetched));
  return result;
}

// Compact alarm payload for the alarms section: which sources are dead / noisy.
export function sourceHealthAlarms(report = []) {
  return {
    dead: report.filter((s) => s.status === 'dead').map((s) => s.name),
    noisy: report.filter((s) => s.status === 'noisy').map((s) => s.name),
  };
}
