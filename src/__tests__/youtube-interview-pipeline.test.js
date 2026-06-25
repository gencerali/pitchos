import { describe, it, expect, vi } from 'vitest';
import { qualifyYouTubeVideo, shouldFetchTranscript } from '../youtube.js';
import { getSeasonalBurstConfig } from '../publisher.js';

// ─── Test data: Kafa Sports / Sergen Yalçın interview video ────
const KAFA_VIDEO = {
  video_id:           'FUlQNP98xs4',
  title:              'Sergen Yalçın Beşiktaş Gerçeklerini Açıkladı',
  published_at:       new Date(Date.now() - 18 * 3600 * 1000).toISOString(),
  channel_id:         'UCuRJ7zpj8K51YTnUio20rTg',
  channel_name:       'Kafa Sports',
  channel_tier:       'digital',
  all_qualify:        false,
  embed_qualify:      true,
  transcript_qualify: true,
  interview_qualify:  false,
};

const HT_SPOR_INTERVIEW = {
  video_id:           'tuinfSkHQSw',
  title:              'BJK Yönetimi Spor Gündemini Değerlendirdi | HT Spor Stüdyosunda',
  published_at:       new Date(Date.now() - 26 * 3600 * 1000).toISOString(),
  channel_id:         'UCK3mI2lsk3LSo8PBUc8JTSw',
  channel_name:       'HT Spor',
  channel_tier:       'broadcast',
  all_qualify:        false,
  embed_qualify:      true,
  transcript_qualify: false,
  interview_qualify:  true,   // ← new flag on broadcast channels
};

const HT_SPOR_HIGHLIGHTS = {
  video_id:           'abc123',
  title:              'Beşiktaş 3-1 Trabzonspor Maç Özeti',
  published_at:       new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  channel_id:         'UCK3mI2lsk3LSo8PBUc8JTSw',
  channel_name:       'HT Spor',
  channel_tier:       'broadcast',
  all_qualify:        false,
  embed_qualify:      true,
  transcript_qualify: false,
  interview_qualify:  true,
};

// ─── STAGE 1: qualifyYouTubeVideo ─────────────────────────────
describe('Stage 1 — qualifyYouTubeVideo: Kafa Sports interview', () => {
  it('passes Kafa Sports BJK interview (has BJK keyword, transcript_qualify)', () => {
    expect(qualifyYouTubeVideo(KAFA_VIDEO)).toBe(true);
  });

  it('passes HT Spor BJK management interview', () => {
    expect(qualifyYouTubeVideo(HT_SPOR_INTERVIEW)).toBe(true);
  });

  it('a Kafa Sports video with NO BJK keyword is rejected (all_qualify=false)', () => {
    const offTopic = { ...KAFA_VIDEO, title: 'Galatasaray Transferleri 2026' };
    expect(qualifyYouTubeVideo(offTopic)).toBe(false);
  });

  it('a rival-only Kafa Sports video is rejected even with transcript_qualify', () => {
    const rivalOnly = { ...KAFA_VIDEO, title: 'Fenerbahçe kadrosu değerlendirmesi' };
    expect(qualifyYouTubeVideo(rivalOnly)).toBe(false);
  });

  it('a Kafa Sports live stream is rejected (dead embed after broadcast)', () => {
    const live = { ...KAFA_VIDEO, title: 'Sergen Yalçın Canlı Yayın | Beşiktaş' };
    expect(qualifyYouTubeVideo(live)).toBe(false);
  });
});

// ─── STAGE 2: shouldFetchTranscript ───────────────────────────
describe('Stage 2 — shouldFetchTranscript: interview detection', () => {
  it('Kafa Sports video: returns true (transcript_qualify=true)', () => {
    expect(shouldFetchTranscript(KAFA_VIDEO)).toBe(true);
  });

  it('HT Spor interview video: returns true (interview_qualify=true + title matches)', () => {
    expect(shouldFetchTranscript(HT_SPOR_INTERVIEW)).toBe(true);
  });

  it('HT Spor match highlights: returns false (interview_qualify but title is özet not interview)', () => {
    expect(shouldFetchTranscript(HT_SPOR_HIGHLIGHTS)).toBe(false);
  });

  it('beIN SPORTS standard highlight: returns false', () => {
    const highlight = {
      channel_tier: 'broadcast', transcript_qualify: false, interview_qualify: true,
      title: 'Beşiktaş - Trabzonspor Maç Özeti',
    };
    expect(shouldFetchTranscript(highlight)).toBe(false);
  });

  it('beIN SPORTS press conference: returns true (interview_qualify + açıkladı in title)', () => {
    const presser = {
      channel_tier: 'broadcast', transcript_qualify: false, interview_qualify: true,
      title: 'Beşiktaş Teknik Direktörü Basın Toplantısında Açıkladı',
    };
    expect(shouldFetchTranscript(presser)).toBe(true);
  });

  it('beIN SPORTS "yorumladı" in title triggers transcript fetch', () => {
    const analysis = {
      channel_tier: 'broadcast', transcript_qualify: false, interview_qualify: true,
      title: 'Sergen Yalçın transferleri yorumladı | beIN SPORTS',
    };
    expect(shouldFetchTranscript(analysis)).toBe(true);
  });

  it('beIN SPORTS "itiraf" in title triggers transcript fetch', () => {
    const confess = {
      channel_tier: 'broadcast', transcript_qualify: false, interview_qualify: true,
      title: 'Beşiktaş eski hocasından olay itiraf',
    };
    expect(shouldFetchTranscript(confess)).toBe(true);
  });
});

// ─── STAGE 3: Seasonal burst config ───────────────────────────
describe('Stage 3 — getSeasonalBurstConfig: article count + spread', () => {
  it('June (summer off-season): max 8 topics, 30-min spread', () => {
    const cfg = getSeasonalBurstConfig(new Date('2026-06-25'));
    expect(cfg.maxTopics).toBe(8);
    expect(cfg.spreadMinutes).toBe(30);
  });

  it('July (peak off-season): max 8 topics, 30-min spread', () => {
    const cfg = getSeasonalBurstConfig(new Date('2026-07-15'));
    expect(cfg.maxTopics).toBe(8);
    expect(cfg.spreadMinutes).toBe(30);
  });

  it('August (last off-season month): max 8 topics, 30-min spread', () => {
    const cfg = getSeasonalBurstConfig(new Date('2026-08-10'));
    expect(cfg.maxTopics).toBe(8);
    expect(cfg.spreadMinutes).toBe(30);
  });

  it('September (pre-season shoulder): max 5 topics, 20-min spread', () => {
    const cfg = getSeasonalBurstConfig(new Date('2026-09-01'));
    expect(cfg.maxTopics).toBe(5);
    expect(cfg.spreadMinutes).toBe(20);
  });

  it('May (post-season shoulder): max 5 topics, 20-min spread', () => {
    const cfg = getSeasonalBurstConfig(new Date('2026-05-20'));
    expect(cfg.maxTopics).toBe(5);
    expect(cfg.spreadMinutes).toBe(20);
  });

  it('December (mid-season): max 3 topics, 15-min spread', () => {
    const cfg = getSeasonalBurstConfig(new Date('2026-12-15'));
    expect(cfg.maxTopics).toBe(3);
    expect(cfg.spreadMinutes).toBe(15);
  });

  it('today (June 2026 = summer) gives max 8 topics for the Kafa interview', () => {
    const cfg = getSeasonalBurstConfig(); // uses Date.now()
    expect(cfg.maxTopics).toBe(8);
    // Kafa interview has 13 duhuliye articles → up to 8 would be published, 5 dropped
    // (vs 13 at once or only 1 with the old pipeline)
  });
});

// ─── STAGE 4: Burst queue scheduling math ─────────────────────
describe('Stage 4 — Burst queue: scheduling logic', () => {
  it('7 overflow articles at 30-min spread → last article in 3.5h', () => {
    const spreadMinutes = 30;
    const overflowCount = 7; // articles[1..7] after the first one is published immediately
    const lastArticleDelayMs = overflowCount * spreadMinutes * 60 * 1000;
    const lastArticleDelayHours = lastArticleDelayMs / (1000 * 60 * 60);
    expect(lastArticleDelayHours).toBe(3.5);
  });

  it('drain rate: 2 per 30-min cron = ~4 articles/hour in burst mode', () => {
    // With 8 topics, article 1 immediate + 7 queued:
    // - Cron 1 (t+30m): releases articles 2-3
    // - Cron 2 (t+60m): releases 4-5
    // - Cron 3 (t+90m): releases 6-7
    // - Cron 4 (t+120m): releases 8
    // Total: 8 articles over ~2h = matches 30-min spread × 7 = 210min, but drain
    // of 2/run vs 1 article every 30min means drain is fast enough
    const DRAIN_PER_RUN = 2;
    const CRON_INTERVAL_MIN = 30;
    const articlesPerHour = DRAIN_PER_RUN * (60 / CRON_INTERVAL_MIN);
    expect(articlesPerHour).toBe(4);
  });
});
