import { describe, it, expect } from 'vitest';
import { normalizeStoryType, parseFirewallResponse } from '../firewall.js';
import { tierToTrustScore, classifyVideoType } from '../publisher.js';

describe('normalizeStoryType — maps free-text → controlled set', () => {
  it('passes through valid types', () => {
    expect(normalizeStoryType('transfer')).toBe('transfer');
    expect(normalizeStoryType('injury')).toBe('injury');
  });
  it('maps invented compound types by keyword', () => {
    expect(normalizeStoryType('transfer_interest')).toBe('transfer');
    expect(normalizeStoryType('player_contract_extension')).toBe('contract');
    expect(normalizeStoryType('medical update')).toBe('injury');
    expect(normalizeStoryType('suspension')).toBe('disciplinary');
    expect(normalizeStoryType('managerial appointment')).toBe('institutional');
  });
  it('falls back to other for unknown / empty', () => {
    expect(normalizeStoryType('weather report')).toBe('other');
    expect(normalizeStoryType('')).toBe('other');
    expect(normalizeStoryType(null)).toBe('other');
  });
});

describe('parseFirewallResponse — robust JSON extraction + defaults', () => {
  it('extracts JSON embedded in prose and fills array/null defaults', () => {
    const r = parseFirewallResponse('Here you go: {"entities":{"players":["Rashica"]},"numbers":{"transfer_fee":5}} done');
    expect(r.entities.players).toEqual(['Rashica']);
    expect(r.entities.clubs).toEqual([]);          // default
    expect(r.numbers.transfer_fee).toBe(5);
    expect(r.numbers.release_clause).toBeNull();    // default
    expect(r.dates.other).toEqual([]);              // default
  });
  it('throws when no JSON object is present', () => {
    expect(() => parseFirewallResponse('no json here')).toThrow();
  });
});

describe('tierToTrustScore — tier → numeric score', () => {
  it('maps T1–T4 and legacy labels', () => {
    expect(tierToTrustScore('T1')).toBe(90);
    expect(tierToTrustScore('T2')).toBe(70);
    expect(tierToTrustScore('T3')).toBe(50);
    expect(tierToTrustScore('T4')).toBe(25);
    expect(tierToTrustScore('official')).toBe(90);
    expect(tierToTrustScore('aggregator')).toBe(25);
  });
  it('defaults unknown tiers to 50', () => {
    expect(tierToTrustScore('T9')).toBe(50);
    expect(tierToTrustScore(undefined)).toBe(50);
  });
});

describe('classifyVideoType — title → video type', () => {
  it('detects match highlights', () => {
    expect(classifyVideoType('Beşiktaş Galatasaray highlights')).toBe('match_highlight');
  });
  it('defaults to news for unmatched titles', () => {
    expect(classifyVideoType('Kulüpten bir duyuru')).toBe('news');
  });
});
