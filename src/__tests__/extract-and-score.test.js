import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractAndScore } from '../firewall.js';

// Minimal env stub — supabase calls are mocked via global fetch
const ENV = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_KEY: 'testkey',
  ANTHROPIC_API_KEY: 'sk-test',
};

const ARTICLE = {
  id: 'art-001',
  site_id: 1,
  title: 'Beşiktaş Ciro Immobile transferini resmen açıkladı',
  summary: 'Beşiktaş, Ciro Immobile ile 2 yıllık sözleşme imzaladı.',
  url: 'https://example.com/bjk-immobile',
  source_name: 'Test Source',
};

function makeClaudeResponse(json) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(json) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  };
}

function makeSupabaseResponse(rows = [{ id: 'fact-uuid-001' }]) {
  return { ok: true, text: async () => JSON.stringify(rows) };
}

// Mock global fetch: Claude + two Supabase calls
function setupFetch(claudeJson) {
  let callCount = 0;
  global.fetch = vi.fn(async (url) => {
    callCount++;
    if (String(url).includes('anthropic')) return makeClaudeResponse(claudeJson);
    return makeSupabaseResponse();
  });
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('extractAndScore — schema normalization', () => {
  it('parses a well-formed transfer response', async () => {
    setupFetch({
      story_type: 'transfer', story_category: 'sporting', nvs_score: 85,
      entities: { players: ['Ciro Immobile'], clubs: ['Beşiktaş', 'Lazio'], competitions: ['Süper Lig'] },
      numbers: { transfer_fee: '5M EUR', contract_years: 2, ban_games: null, recovery_weeks: null, fine_amount: null, other: [] },
      dates: { primary_date: '2025-07-01', other: [] },
    });

    const result = await extractAndScore('Full article body text here.', ARTICLE, ENV);

    expect(result.story_type).toBe('transfer');
    expect(result.story_category).toBe('sporting');
    expect(result.nvs_score).toBe(85);
    expect(result.entities.players).toEqual(['Ciro Immobile']);
    expect(result.entities.clubs).toContain('Beşiktaş');
    expect(result.numbers.transfer_fee).toBe('5M EUR');
    expect(result.numbers.contract_years).toBe(2);
    expect(result.dates.primary_date).toBe('2025-07-01');
    expect(Array.isArray(result.key_quotes)).toBe(true);
    expect(result._id).toBe('fact-uuid-001');
  });

  it('normalizes unknown story_type via fallback keywords', async () => {
    setupFetch({
      story_type: 'player_transfer_interest', // Claude inventing compound types
      story_category: 'sporting', nvs_score: 40,
      entities: { players: ['Ersin Destanoğlu'], clubs: ['Beşiktaş'], competitions: [] },
      numbers: { transfer_fee: null, contract_years: null, ban_games: null, recovery_weeks: null, fine_amount: null, other: [] },
      dates: { primary_date: null, other: [] },
    });

    const result = await extractAndScore('', ARTICLE, ENV);
    expect(result.story_type).toBe('transfer'); // normalized by normalizeStoryType
  });

  it('clamps nvs_score to [0, 100]', async () => {
    setupFetch({ story_type: 'other', story_category: 'other', nvs_score: 150,
      entities: { players: [], clubs: [], competitions: [] },
      numbers: { transfer_fee: null, contract_years: null, ban_games: null, recovery_weeks: null, fine_amount: null, other: [] },
      dates: { primary_date: null, other: [] },
    });
    const result = await extractAndScore('', ARTICLE, ENV);
    expect(result.nvs_score).toBe(100);
  });

  it('returns fallback on unparseable JSON', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('anthropic')) {
        return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Sorry, I cannot process this.' }], usage: {} }) };
      }
      return makeSupabaseResponse();
    });
    const result = await extractAndScore('', ARTICLE, ENV);
    expect(result.story_type).toBe('other');
    expect(result.nvs_score).toBeNull();
    expect(result._id).toBeNull();
    expect(result.entities.players).toEqual([]);
    expect(result.key_quotes).toEqual([]);
  });

  it('extracts key_quotes from response', async () => {
    setupFetch({
      story_type: 'transfer', story_category: 'sporting', nvs_score: 80,
      key_quotes: [
        { text: 'Takim icin en iyi secim', speaker: 'Önder Özen', role: 'Sportif Direktör' },
        { text: 'Sozlesme imzalandi', speaker: null, role: null },
      ],
      entities: { players: ['Test Player'], clubs: ['Besiktas'], competitions: [] },
      numbers: { transfer_fee: null, contract_years: 1, ban_games: null, recovery_weeks: null, fine_amount: null, other: [] },
      dates: { primary_date: null, other: [] },
    });
    const result = await extractAndScore('body text', ARTICLE, ENV);
    expect(result.key_quotes).toHaveLength(2);
    expect(result.key_quotes[0].text).toBe('Takim icin en iyi secim');
    expect(result.key_quotes[0].speaker).toBe('Önder Özen');
    expect(result.key_quotes[1].text).toBe('Sozlesme imzalandi');
  });

  it('falls back to title+summary when bodyText is empty', async () => {
    setupFetch({
      story_type: 'injury', story_category: 'sporting', nvs_score: 60,
      entities: { players: ['Semih Kılıçsoy'], clubs: ['Beşiktaş'], competitions: [] },
      numbers: { transfer_fee: null, contract_years: null, ban_games: null, recovery_weeks: 4, fine_amount: null, other: [] },
      dates: { primary_date: null, other: [] },
    });
    const result = await extractAndScore('', ARTICLE, ENV); // empty body
    expect(result.story_type).toBe('injury');
    expect(result.numbers.recovery_weeks).toBe(4);
  });

  it('guards missing entity arrays gracefully', async () => {
    setupFetch({
      story_type: 'contract', story_category: 'sporting', nvs_score: 55,
      entities: null, // Claude forgot to include entities
      numbers: { transfer_fee: null, contract_years: 3, ban_games: null, recovery_weeks: null, fine_amount: null, other: [] },
      dates: { primary_date: null, other: [] },
    });
    const result = await extractAndScore('', ARTICLE, ENV);
    expect(result.entities.players).toEqual([]);
    expect(result.entities.clubs).toEqual([]);
    expect(result.numbers.contract_years).toBe(3);
  });
});
