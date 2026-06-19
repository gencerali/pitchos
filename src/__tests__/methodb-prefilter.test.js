import { describe, it, expect } from 'vitest';
import { claimTrackMoved } from '../../worker-story-agent.js';
import { normalizeDeltaType } from '../firewall.js';

describe('normalizeDeltaType — maps free-text → controlled set', () => {
  it('passes through valid delta types unchanged', () => {
    expect(normalizeDeltaType('milestone')).toBe('milestone');
    expect(normalizeDeltaType('statement')).toBe('statement');
    expect(normalizeDeltaType('decision')).toBe('decision');
    expect(normalizeDeltaType('contradiction')).toBe('contradiction');
    expect(normalizeDeltaType('development')).toBe('development');
    expect(normalizeDeltaType('routine')).toBe('routine');
  });

  it('maps unknown strings by keyword fallback', () => {
    expect(normalizeDeltaType('signing_confirmed')).toBe('milestone');
    expect(normalizeDeltaType('official_statement')).toBe('milestone'); // "official" → milestone
    expect(normalizeDeltaType('player_quote')).toBe('statement');       // "quote" → statement
    expect(normalizeDeltaType('penalty_sanction')).toBe('decision');    // "sanction" → decision
    expect(normalizeDeltaType('transfer_cancelled')).toBe('contradiction'); // "cancel" → contradiction
    expect(normalizeDeltaType('talks_progressing')).toBe('development'); // "progress" → development
  });

  it('falls back to routine for empty / null / unrecognised input', () => {
    expect(normalizeDeltaType(null)).toBe('routine');
    expect(normalizeDeltaType('')).toBe('routine');
    expect(normalizeDeltaType('random_noise')).toBe('routine');
  });
});

describe('claimTrackMoved — pure JS track diff (zero LLM cost)', () => {
  it('returns true when there is no prior track (first contribution)', () => {
    expect(claimTrackMoved(null, { numbers: {}, dates: {} })).toBe(true);
    expect(claimTrackMoved(undefined, {})).toBe(true);
  });

  it('returns false when numbers and dates are identical to the prior track', () => {
    const prior = { numbers: { transfer_fee: 5 }, dates: { announcement: '2026-07-01' } };
    const facts = { numbers: { transfer_fee: 5 }, dates: { announcement: '2026-07-01' } };
    expect(claimTrackMoved(prior, facts)).toBe(false);
  });

  it('returns true when a number changed (fee 5 → 7)', () => {
    const prior = { numbers: { transfer_fee: 5 }, dates: {} };
    const facts = { numbers: { transfer_fee: 7 }, dates: {} };
    expect(claimTrackMoved(prior, facts)).toBe(true);
  });

  it('returns true when a date is newly set', () => {
    const prior = { numbers: {}, dates: {} };
    const facts = { numbers: {}, dates: { announcement: '2026-07-15' } };
    expect(claimTrackMoved(prior, facts)).toBe(true);
  });

  it('ignores null / empty-array values in the new fact (not a real change)', () => {
    const prior = { numbers: { transfer_fee: 5 }, dates: {} };
    const facts = { numbers: { transfer_fee: null, other: [] }, dates: {} };
    expect(claimTrackMoved(prior, facts)).toBe(false);
  });

  it('always returns true for contradiction delta_type regardless of values', () => {
    const prior = { numbers: { transfer_fee: 5 }, dates: {} };
    const facts = { delta_type: 'contradiction', numbers: { transfer_fee: 5 }, dates: {} };
    expect(claimTrackMoved(prior, facts)).toBe(true);
  });
});
