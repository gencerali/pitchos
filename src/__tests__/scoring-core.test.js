import { describe, it, expect } from 'vitest';
import {
  SCORING_CONFIG_DEFAULTS as CFG,
  getEffectiveNVS, getHalfLife, getTrustMultiplier, computeScore,
} from '../publisher.js';

// Characterization tests: lock in the CURRENT behaviour of the homepage ranking math so
// future edits can't silently change it. (No prior direct coverage of these functions.)

describe('getEffectiveNVS — resolution precedence', () => {
  it('manual push override wins over everything', () => {
    expect(getEffectiveNVS({ push_to_homepage: true, manual_nvs: 88, publish_mode: 'youtube_embed', video_type: 'match_highlight' }, CFG)).toBe(88);
  });
  it('curated video category beats video_type', () => {
    expect(getEffectiveNVS({ publish_mode: 'youtube_embed', category: 'belgeseller', video_type: 'match_highlight', nvs: 50 }, CFG)).toBe(15);
  });
  it('video_type maps to video_nvs_by_type', () => {
    expect(getEffectiveNVS({ publish_mode: 'youtube_embed', video_type: 'match_highlight', nvs: 50 }, CFG)).toBe(95);
  });
  it('null video_type (news) falls back to channel nvs', () => {
    expect(getEffectiveNVS({ publish_mode: 'youtube_embed', video_type: 'news', nvs: 42 }, CFG)).toBe(42);
  });
  it('template_id maps to template_nvs_by_id', () => {
    expect(getEffectiveNVS({ template_id: 'T10', nvs: 5 }, CFG)).toBe(90);
  });
  it('template_official uses template_official_nvs', () => {
    expect(getEffectiveNVS({ publish_mode: 'template_official' }, CFG)).toBe(90);
  });
  it('plain rewrite falls back to article.nvs', () => {
    expect(getEffectiveNVS({ publish_mode: 'rewrite', nvs: 63 }, CFG)).toBe(63);
    expect(getEffectiveNVS({ publish_mode: 'rewrite' }, CFG)).toBe(0);
  });
});

describe('getHalfLife — resolution precedence', () => {
  it('T05 lineup is pinned (null)', () => {
    expect(getHalfLife({ template_id: 'T05' }, CFG)).toBeNull();
  });
  it('manual push half-life override', () => {
    expect(getHalfLife({ push_to_homepage: true, manual_half_life: 7 }, CFG)).toBe(7);
  });
  it('youtube_embed uses video_half_life_by_type', () => {
    expect(getHalfLife({ publish_mode: 'youtube_embed', video_type: 'news' }, CFG)).toBe(12);
    expect(getHalfLife({ publish_mode: 'youtube_embed', video_type: 'match_highlight' }, CFG)).toBe(24);
  });
  it('template_id uses template_half_life_by_id', () => {
    expect(getHalfLife({ template_id: 'T10' }, CFG)).toBe(0.75);
  });
  it('rewrite uses category half-life, with default fallback', () => {
    expect(getHalfLife({ publish_mode: 'rewrite', category: 'Transfer' }, CFG)).toBe(36);
    expect(getHalfLife({ publish_mode: 'rewrite', category: 'Nonsense' }, CFG)).toBe(24);
  });
});

describe('getTrustMultiplier — tier weighting (rewrite/synthesis only)', () => {
  it('applies tier multiplier to rewrites', () => {
    expect(getTrustMultiplier({ publish_mode: 'rewrite', trust_tier: 'T1' }, CFG)).toBe(1.8);
    expect(getTrustMultiplier({ publish_mode: 'synthesis', trust_tier: 'T4' }, CFG)).toBe(0.5);
  });
  it('returns 1.0 for non-rewrite modes (e.g. video) regardless of tier', () => {
    expect(getTrustMultiplier({ publish_mode: 'youtube_embed', trust_tier: 'T1' }, CFG)).toBe(1.0);
  });
  it('unknown tier defaults to 1.0', () => {
    expect(getTrustMultiplier({ publish_mode: 'rewrite', trust_tier: 'T9' }, CFG)).toBe(1.0);
  });
});

describe('computeScore — NVS × exp(−age/halfLife) × trust', () => {
  const now = Date.parse('2026-06-05T00:00:00Z');
  const fresh = (extra) => ({ fetched_at: new Date(now).toISOString(), ...extra });

  it('fresh rewrite (age 0) = NVS × trustMult', () => {
    expect(computeScore(fresh({ publish_mode: 'rewrite', category: 'Match', nvs: 60, trust_tier: 'T3' }), CFG, now)).toBeCloseTo(60, 5);
    expect(computeScore(fresh({ publish_mode: 'rewrite', category: 'Match', nvs: 60, trust_tier: 'T1' }), CFG, now)).toBeCloseTo(108, 5);
  });
  it('after one half-life decays to ~37%', () => {
    const a = { publish_mode: 'rewrite', category: 'Match', nvs: 60, trust_tier: 'T3', fetched_at: new Date(now - 24 * 3600 * 1000).toISOString() };
    expect(computeScore(a, CFG, now)).toBeCloseTo(60 * Math.exp(-1), 4);
  });
  it('null half-life (T05) returns null (pin signal)', () => {
    expect(computeScore(fresh({ template_id: 'T05', nvs: 50 }), CFG, now)).toBeNull();
  });
  it('zero effective NVS returns 0', () => {
    expect(computeScore(fresh({ publish_mode: 'youtube_embed', video_type: 'news', nvs: 0 }), CFG, now)).toBe(0);
  });
});
