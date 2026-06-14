import { describe, it, expect } from 'vitest';
import { esc, isKartalix, videoEmbedHtml, badgeFor, articleBodyToHtml } from '../shared.js';

describe('shared — esc', () => {
  it('escapes &<>"\' ', () => {
    expect(esc(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });
});

describe('shared — isKartalix', () => {
  it('true for kartalix-original modes / empty source', () => {
    expect(isKartalix({ publish_mode: 'rewrite' })).toBe(true);
    expect(isKartalix({ publish_mode: 'template_official' })).toBe(true);
    expect(isKartalix({ source: 'Kartalix' })).toBe(true);
    expect(isKartalix({})).toBe(true);
  });
  it('false for external sources', () => {
    expect(isKartalix({ source: 'Fanatik', publish_mode: 'copy_source' })).toBe(false);
    expect(isKartalix({ source_name: 'NTV Spor', publish_mode: 'rss_summary' })).toBe(false);
  });
});

describe('shared — videoEmbedHtml', () => {
  it('builds the yt-embed iframe with an escaped title; empty for no id', () => {
    const h = videoEmbedHtml('abc123', 'Maç "özeti"');
    expect(h).toContain('youtube.com/embed/abc123');
    expect(h).toContain('&quot;');
    expect(videoEmbedHtml('')).toBe('');
  });
});

describe('shared — badgeFor', () => {
  it('maps templates, synthesis, transfer, and default', () => {
    expect(badgeFor({ template_id: 'T10' })).toEqual({ label: 'Gol', kind: 'live' });
    expect(badgeFor({ template_id: 'T-VID1' })).toEqual({ label: 'Video', kind: 'video' });
    expect(badgeFor({ publish_mode: 'original_synthesis' })).toEqual({ label: 'Analiz', kind: 'analysis' });
    expect(badgeFor({ category: 'Transfer haberi' })).toEqual({ label: 'Transfer', kind: 'transfer' });
    expect(badgeFor({ category: 'Haber' })).toEqual({ label: 'Haber', kind: '' });
  });
});

describe('shared — re-exports articleBodyToHtml', () => {
  it('is the same body renderer', () => {
    expect(articleBodyToHtml('Bir.\n\nİki.', { publishMode: 'rewrite' })).toBe('<p>Bir.</p><p>İki.</p>');
  });
});
