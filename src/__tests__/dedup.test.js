import { describe, it, expect } from 'vitest';
import {
  normalizeTitle, titleSimilarity, extractKeyTokens, sharedStoryTokens,
  dedupeByTitle, dedupeByStory,
} from '../processor.js';

// Characterization tests for the dedup primitives that gate what reaches synthesis and
// the homepage. Locks in current behaviour (no prior direct coverage).

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation, collapses whitespace (ASCII)', () => {
    expect(normalizeTitle('Transfer,  RESMEN   done!')).toBe('transfer resmen done');
  });
  // KNOWN LIMITATION (documented 2026-06-05): `\w` is ASCII-only, so Turkish diacritics are
  // STRIPPED, not preserved — "Beşiktaş"→"beikta", "açıkladı"→"aklad". This degrades
  // titleSimilarity for Turkish text. Locked here as current behaviour; fixing it shifts
  // live dedup results, so it's a deliberate change, not a drive-by. See docs/NEXT.md.
  it('strips Turkish diacritics (known limitation)', () => {
    expect(normalizeTitle('Beşiktaş açıkladı')).toBe('beikta aklad');
  });
});

describe('titleSimilarity — shared >3-char words / max set size', () => {
  it('identical titles → 1', () => {
    expect(titleSimilarity('transfer haberi geldi', 'transfer haberi geldi')).toBe(1);
  });
  it('no overlap → 0', () => {
    expect(titleSimilarity('transfer haberi', 'maç sonucu')).toBe(0);
  });
  it('ignores words of length ≤3', () => {
    // only "transfer" (>3) counts; "ve","de" dropped
    expect(titleSimilarity('transfer ve de', 'transfer')).toBe(1);
  });
});

describe('sharedStoryTokens — morphological, stopword-aware', () => {
  it('matches Turkish suffix variants (prefix ≥4)', () => {
    // "muci" vs "muciyi" share root
    expect(sharedStoryTokens(extractKeyTokens('Muci'), extractKeyTokens('Muciyi'))).toBe(1);
  });
  it('excludes club stopwords (beşiktaş/bjk)', () => {
    expect(sharedStoryTokens(extractKeyTokens('Beşiktaş haberi'), extractKeyTokens('Beşiktaş başka'))).toBe(0);
  });
});

describe('dedupeByTitle — pre-synthesis dedup', () => {
  it('collapses near-identical titles, keeps first, records sibling', () => {
    const arts = [
      { title: 'Rashica transfer görüşmeleri başladı', url: 'a' },
      { title: 'Rashica transfer görüşmeleri sürüyor', url: 'b' },
      { title: 'Maç sonucu 2-1', url: 'c' },
    ];
    const { kept, dupeSiblings } = dedupeByTitle(arts);
    expect(kept.map(k => k.url)).toEqual(['a', 'c']);
    expect(dupeSiblings.get('a').map(s => s.url)).toEqual(['b']);
  });
});

describe('dedupeByStory — post-scoring story dedup (keeps first / highest-NVS)', () => {
  it('collapses same-story articles by token overlap', () => {
    const arts = [
      { title: 'Rashica sözleşme yeniledi', nvs: 80 },
      { title: 'Rashica sözleşme uzatma', nvs: 70 },
      { title: 'Stadyum yenileme projesi', nvs: 60 },
    ];
    const kept = dedupeByStory(arts);
    expect(kept.map(k => k.title)).toEqual(['Rashica sözleşme yeniledi', 'Stadyum yenileme projesi']);
  });
});
