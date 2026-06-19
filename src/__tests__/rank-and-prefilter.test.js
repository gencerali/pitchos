import { describe, it, expect } from 'vitest';
import { preFilter, isRivalSubject } from '../processor.js';
import { rankAndEvict, SCORING_CONFIG_DEFAULTS as CFG } from '../publisher.js';
import { simpleHash } from '../utils.js';

// Characterization tests for the two functions that decide what enters the pipeline
// (preFilter) and what composes the homepage (rankAndEvict). No prior direct coverage.

const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

describe('preFilter — intake gating', () => {
  const fresh = () => iso(Date.now());

  it('keeps a valid fresh BJK article', () => {
    const arts = [{ title: 'Beşiktaş transfer haberi', summary: 'Bu bir geçerli özet metni, elli karakterden uzun olmalı.', url: 'https://x/1', published_at: fresh() }];
    const { articles } = preFilter(arts, new Set());
    expect(articles).toHaveLength(1);
  });

  it('rejects stale articles (older than lookback)', () => {
    const arts = [{ title: 'Beşiktaş haberi', summary: 'yeterince uzun bir özet metni buraya yazıldı tamam.', url: 'https://x/2', published_at: iso(Date.now() - 10 * 24 * H) }];
    const { articles, rejected } = preFilter(arts, new Set());
    expect(articles).toHaveLength(0);
    expect(rejected.some(r => r._stage === 'date_old')).toBe(true);
  });

  it('rejects live-blog URLs', () => {
    const arts = [{ title: 'Beşiktaş canlı', summary: 'yeterince uzun bir özet metni buraya yazıldı tamam.', url: 'https://x/canli/mac', published_at: fresh() }];
    const { rejected } = preFilter(arts, new Set());
    expect(rejected.some(r => r._stage === 'live_blog_source')).toBe(true);
  });

  it('rejects off-topic (no BJK keyword, non-rival)', () => {
    const arts = [{ title: 'Hava durumu raporu yayınlandı', summary: 'yeterince uzun bir özet metni buraya yazıldı tamam.', url: 'https://x/3', published_at: fresh() }];
    const { rejected } = preFilter(arts, new Set());
    expect(rejected.some(r => r._stage === 'off_topic')).toBe(true);
  });

  it('rejects too-short bodies (<50 chars)', () => {
    const arts = [{ title: 'Beşiktaş', summary: 'kısa', url: 'https://x/4', published_at: fresh() }];
    const { rejected } = preFilter(arts, new Set());
    expect(rejected.some(r => r._stage === 'too_short')).toBe(true);
  });

  it('rejects rival-subject articles (rival-led title, no BJK angle)', () => {
    const arts = [{ title: 'Fenerbahçede tarihi genel kurul: Aziz Yıldırım ve Hakan Safi yarışıyor', summary: 'Genel kurul öncesi Beşiktaş ve diğer kulüpler de gündemde, uzun özet metni burada.', url: 'https://x/fb', published_at: fresh() }];
    const { articles, rejected } = preFilter(arts, new Set());
    expect(articles).toHaveLength(0);
    expect(rejected.some(r => r._stage === 'rival_subject')).toBe(true);
  });

  it('rejects already-seen hashes', () => {
    const a = { title: 'Beşiktaş transfer haberi', summary: 'yeterince uzun bir özet metni buraya yazıldı tamam.', url: 'https://x/5', published_at: fresh() };
    expect(preFilter([a], new Set()).articles).toHaveLength(1);
    // build the seen set the same way preFilter does, then re-run
    const seen = new Set([simpleHash(a.title + (a.summary || '').slice(0, 100))]);
    const { rejected } = preFilter([a], seen);
    expect(rejected.some(r => r._stage === 'hash_dedup')).toBe(true);
  });
});

describe('isRivalSubject — deterministic rival guard', () => {
  it('flags a rival-led title with no BJK keyword', () => {
    expect(isRivalSubject('Fenerbahçede tarihi genel kurul')).toBe(true);
    expect(isRivalSubject('Galatasaray yeni hocasını açıkladı')).toBe(true);
  });
  it('does NOT flag when the title also names Beşiktaş (real BJK-vs-rival story)', () => {
    expect(isRivalSubject('Beşiktaş Fenerbahçe derbisine hazır')).toBe(false);
  });
  it('does NOT flag pure BJK or non-rival titles', () => {
    expect(isRivalSubject('Beşiktaş transfer haberi')).toBe(false);
    expect(isRivalSubject('Milli takım kampa girdi')).toBe(false);
  });
  it('flags a rival-led title where the only "BJK" token is a surname (İsmail Kartal)', () => {
    // Regression: bare "kartal" (coach surname) must NOT count as a Beşiktaş angle. (2026-06-18)
    expect(isRivalSubject("Fenerbahçe'de İsmail Kartal dönemi resmen başlıyor")).toBe(true);
  });
  it('still spares a real BJK-vs-rival story (unambiguous Beşiktaş signal)', () => {
    expect(isRivalSubject("Beşiktaş, Fenerbahçe'nin yıldızını istiyor")).toBe(false);
    expect(isRivalSubject('BJK, Galatasaraylı oyuncuyu transfer etti')).toBe(false);
  });
  it('flags a rival COACH (İsmail Kartal) even when no rival club is named', () => {
    // "Kartal" is also BJK's nickname, so the FB coach must be filtered explicitly. (2026-06)
    expect(isRivalSubject("İsmail Kartal'dan Tadic'e sürpriz telefon! Geri mi dönüyor")).toBe(true);
    // …but a genuine Beşiktaş angle still spares it.
    expect(isRivalSubject('Beşiktaş, İsmail Kartal ile görüştü')).toBe(false);
  });
});

describe('rankAndEvict — homepage composition', () => {
  const fresh = (extra) => ({ fetched_at: iso(Date.now()), ...extra });
  const opts = { config: CFG, floor: 5 };

  it('ranks survivors by score desc and stamps current_rank', () => {
    const { articles } = rankAndEvict([
      fresh({ title: 'low', publish_mode: 'rewrite', category: 'Match', nvs: 20, trust_tier: 'T3', slug: 'a' }),
      fresh({ title: 'high', publish_mode: 'rewrite', category: 'Match', nvs: 90, trust_tier: 'T3', slug: 'b' }),
    ], 200, opts);
    expect(articles.map(a => a.slug)).toEqual(['b', 'a']);
    expect(articles[0].current_rank).toBeGreaterThan(articles[1].current_rank);
  });

  it('evicts below-floor (aged-out) articles', () => {
    const old = { title: 'ancient', publish_mode: 'rewrite', category: 'Match', nvs: 60, trust_tier: 'T3', slug: 'old', fetched_at: iso(Date.now() - 60 * H) };
    const { articles, evictedReasonMap } = rankAndEvict([old], 200, opts);
    expect(articles).toHaveLength(0);
    expect(evictedReasonMap.get('old')).toBe('aged_out');
  });

  it('hard-TTL evicts copy_source past its TTL', () => {
    const stale = { title: 'placeholder', publish_mode: 'copy_source', nvs: 80, slug: 'cs', fetched_at: iso(Date.now() - 13 * H) };
    const { articles, evictedReasonMap } = rankAndEvict([stale], 200, opts);
    expect(articles.find(a => a.slug === 'cs')).toBeUndefined();
    expect(evictedReasonMap.get('cs')).toBe('ttl');
  });

  it('caps videos at max_videos_in_main_feed (3) and marks excess video_cap', () => {
    const vids = Array.from({ length: 5 }, (_, i) => fresh({ title: 'v' + i, publish_mode: 'youtube_embed', video_type: 'match_highlight', slug: 'v' + i }));
    const { articles, evictedReasonMap } = rankAndEvict(vids, 200, opts);
    const kept = articles.filter(a => a.publish_mode === 'youtube_embed');
    expect(kept).toHaveLength(3);
    expect([...evictedReasonMap.values()].filter(r => r === 'video_cap')).toHaveLength(2);
  });

  it('dedupes by identical title hash', () => {
    const { articles } = rankAndEvict([
      fresh({ title: 'Same Title', publish_mode: 'rewrite', category: 'Match', nvs: 80, trust_tier: 'T3', slug: 'x1' }),
      fresh({ title: 'Same Title', publish_mode: 'rewrite', category: 'Match', nvs: 70, trust_tier: 'T3', slug: 'x2' }),
    ], 200, opts);
    expect(articles).toHaveLength(1);
  });
});
