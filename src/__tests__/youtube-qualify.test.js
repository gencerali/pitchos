import { describe, it, expect } from 'vitest';
import { qualifyYouTubeVideo } from '../youtube.js';

// Videos bypass preFilter + scoreArticles, so qualifyYouTubeVideo is their ONLY gate.
// These lock in the rival-guard parity added 2026-06-06.
describe('qualifyYouTubeVideo — rival guard parity', () => {
  it('rejects a rival-led video even on an all_qualify channel (the real hole)', () => {
    // all_qualify skips bjkMatch, so without the rival guard this would publish at NVS 72.
    expect(qualifyYouTubeVideo({ title: 'Fenerbahçede tarihi genel kurul', all_qualify: true })).toBe(false);
  });
  it('rejects rival-led on a broadcast channel', () => {
    expect(qualifyYouTubeVideo({ title: 'Galatasaray yeni transferini açıkladı', all_qualify: false })).toBe(false);
  });
  it('keeps a BJK match video', () => {
    expect(qualifyYouTubeVideo({ title: 'Beşiktaş maç özeti', all_qualify: false })).toBe(true);
  });
  it('keeps a BJK-vs-rival video (Beşiktaş named in title)', () => {
    expect(qualifyYouTubeVideo({ title: 'Beşiktaş Fenerbahçe derbisi özeti', all_qualify: false })).toBe(true);
  });
  it('rejects non-BJK, non-rival on a broadcast channel (no BJK keyword)', () => {
    expect(qualifyYouTubeVideo({ title: 'Süper Lig panorama programı', all_qualify: false })).toBe(false);
  });
  it('keeps all_qualify content with no rival keyword', () => {
    expect(qualifyYouTubeVideo({ title: 'Antrenman görüntüleri', all_qualify: true })).toBe(true);
  });
});

describe('qualifyYouTubeVideo — live-stream rejection (dead-embed fix)', () => {
  it('rejects "Canlı Yayın" live streams even on the official (all_qualify) channel', () => {
    expect(qualifyYouTubeVideo({ title: 'İmza Töreni | Canlı Yayın', all_qualify: true })).toBe(false);
  });
  it('rejects english live-stream + 🔴 titles', () => {
    expect(qualifyYouTubeVideo({ title: 'Press conference LIVE STREAM', all_qualify: true })).toBe(false);
    expect(qualifyYouTubeVideo({ title: '🔴 Beşiktaş basın toplantısı', all_qualify: true })).toBe(false);
  });
  it('rejects /live/ URL form regardless of title', () => {
    expect(qualifyYouTubeVideo({ title: 'Beşiktaş', all_qualify: true, url: 'https://www.youtube.com/live/nE4u4QEY19Y' })).toBe(false);
  });
  it('keeps a normal (non-live) official video', () => {
    expect(qualifyYouTubeVideo({ title: 'İmza töreni özeti', all_qualify: true })).toBe(true);
  });
});
