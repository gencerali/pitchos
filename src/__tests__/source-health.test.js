import { describe, it, expect } from 'vitest';
import { computeSourceHealth, sourceHealthAlarms } from '../source-health.js';

const NOW = new Date('2026-06-10T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

// Build N rows for a source across the last few days, with a given published count.
function rows(name, total, published, dayOffset = 0) {
  const out = [];
  for (let i = 0; i < total; i++) {
    out.push({ source_name: name, stage: i < published ? 'published' : 'off_topic', run_at: daysAgo(dayOffset) });
  }
  return out;
}

describe('computeSourceHealth', () => {
  it('marks a productive source healthy with correct pass rate', () => {
    const r = computeSourceHealth(rows('Transfermarkt', 50, 22, 0), [{ name: 'Transfermarkt' }], { now: NOW });
    const t = r.find((s) => s.name === 'Transfermarkt');
    expect(t.status).toBe('healthy');
    expect(t.passRate).toBeCloseTo(0.44, 3);
    expect(t.knownActive).toBe(true);
  });

  it('marks a high-volume, low-pass source noisy', () => {
    const r = computeSourceHealth(rows('Duhuliye', 100, 2, 0), [{ name: 'Duhuliye' }], { now: NOW });
    expect(r.find((s) => s.name === 'Duhuliye').status).toBe('noisy');
  });

  it('marks a configured source with no rows as dead (zeroDays >= threshold)', () => {
    const r = computeSourceHealth([], [{ name: 'NTV Spor' }], { now: NOW });
    const s = r.find((x) => x.name === 'NTV Spor');
    expect(s.status).toBe('dead');
    expect(s.zeroDays).toBeGreaterThanOrEqual(3);
  });

  it('marks a source silent for 4 days dead (gap detection)', () => {
    const r = computeSourceHealth(rows('A Spor', 30, 10, 4), [{ name: 'A Spor' }], { now: NOW });
    const s = r.find((x) => x.name === 'A Spor');
    expect(s.zeroDays).toBe(4);     // today, -1, -2, -3 all empty
    expect(s.status).toBe('dead');
  });

  it('does NOT flag a source quiet only 2 days (under threshold)', () => {
    const r = computeSourceHealth(rows('beIN', 30, 12, 2), [{ name: 'beIN' }], { now: NOW });
    const s = r.find((x) => x.name === 'beIN');
    expect(s.zeroDays).toBe(2);
    expect(s.status).toBe('healthy');
  });

  it('counts drop reasons by stage', () => {
    const mixed = [
      { source_name: 'X', stage: 'published', run_at: daysAgo(0) },
      { source_name: 'X', stage: 'rival_subject', run_at: daysAgo(0) },
      { source_name: 'X', stage: 'off_topic', run_at: daysAgo(0) },
      { source_name: 'X', stage: 'off_topic', run_at: daysAgo(0) },
    ];
    const s = computeSourceHealth(mixed, [{ name: 'X' }], { now: NOW }).find((x) => x.name === 'X');
    expect(s.drops).toEqual({ rival_subject: 1, off_topic: 2 });
    expect(s.published).toBe(1);
  });

  it('flags unknown sources (not in configs) as knownActive=false', () => {
    const s = computeSourceHealth(rows('Mystery', 5, 1, 0), [], { now: NOW }).find((x) => x.name === 'Mystery');
    expect(s.knownActive).toBe(false);
  });

  it('sorts dead/noisy first', () => {
    const r = computeSourceHealth(
      [...rows('Healthy', 30, 15, 0), ...rows('Noisy', 100, 1, 0)],
      [{ name: 'Healthy' }, { name: 'Noisy' }, { name: 'Dead' }],
      { now: NOW },
    );
    expect(r[0].status).toBe('dead');     // Dead (no rows) first
    expect(r.map((s) => s.status)).toContain('noisy');
  });
});

describe('sourceHealthAlarms', () => {
  it('extracts dead + noisy names', () => {
    const report = [
      { name: 'A', status: 'dead' }, { name: 'B', status: 'noisy' }, { name: 'C', status: 'healthy' },
    ];
    expect(sourceHealthAlarms(report)).toEqual({ dead: ['A'], noisy: ['B'] });
  });
});
