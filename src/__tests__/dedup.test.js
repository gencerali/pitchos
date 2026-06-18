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

describe('cross-run dedup — paraphrased same-story headlines (root-aware)', () => {
  // Mirrors the gate predicate in publisher.js saveArticles (cross-run + within-batch).
  const sameStory = (a, b) => {
    const sim = titleSimilarity(normalizeTitle(a), normalizeTitle(b));
    if (sim >= 0.5) return true;
    const shared = sharedStoryTokens(extractKeyTokens(a), extractKeyTokens(b), true);
    if (shared >= 3) return true;
    return shared >= 2 && sim >= 0.3;
  };

  // The 4× live duplicate that slipped through (2026-06-18): same UEFA event, all synonyms.
  const T1 = 'Beşiktaş UEFA Kısıtlamalarını Geride Bıraktı';
  const T2 = 'Beşiktaş UEFA yükümlülüklerini tamamladı, kısıtlamalar kalktı';
  const T3 = 'Beşiktaş UEFA kısıtlamalarından tamamen kurtuldu';

  it('flags the paraphrased UEFA-kısıtlama story as duplicates', () => {
    expect(sameStory(T1, T2)).toBe(true);
    expect(sameStory(T1, T3)).toBe(true);
    expect(sameStory(T2, T3)).toBe(true);
  });

  it('root-aware matches divergent inflections of one root; strict mode does not', () => {
    // "tamamladı"/"tamamlandı" share root "tamamla" but neither token is a prefix of the
    // other (…lad vs …land), so only root-aware mode links them.
    const a = extractKeyTokens('tamamladı'), b = extractKeyTokens('tamamlandı');
    expect(sharedStoryTokens(a, b, true)).toBe(1);
    expect(sharedStoryTokens(a, b)).toBe(0);
  });

  it('does NOT collapse genuinely different stories (only the club stopword in common)', () => {
    expect(sameStory('Beşiktaş Orkun sözleşme uzattı', 'Beşiktaş stadyum yenileme projesi')).toBe(false);
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
