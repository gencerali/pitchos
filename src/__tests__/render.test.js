import { describe, it, expect } from 'vitest';
import { articleBodyToHtml } from '../render.js';

const longBody = (subhead) => {
  // 6 blocks, >350 words, with one ## subhead in the middle.
  const para = 'kelime '.repeat(70).trim() + '.';
  return [para, para, `${subhead}`, para, para, para].join('\n\n');
};

describe('articleBodyToHtml — paragraphs', () => {
  it('splits blank-line-separated text into <p> (fixes the single-block bug)', () => {
    const html = articleBodyToHtml('Birinci paragraf.\n\nİkinci paragraf.', { publishMode: 'rewrite' });
    expect(html).toBe('<p>Birinci paragraf.</p><p>İkinci paragraf.</p>');
  });
  it('falls back to single-newline splitting when not double-spaced', () => {
    const html = articleBodyToHtml('Bir.\nİki.', { publishMode: 'rewrite' });
    expect(html).toBe('<p>Bir.</p><p>İki.</p>');
  });
  it('passes already-HTML bodies through (sanitized)', () => {
    const html = articleBodyToHtml('<p>Hazır HTML</p><script>alert(1)</script>', { publishMode: 'rewrite' });
    expect(html).toContain('<p>Hazır HTML</p>');
    expect(html).not.toContain('<script>');
  });
});

describe('articleBodyToHtml — inline bold + escaping', () => {
  it('converts **bold** to <strong> (no literal stars)', () => {
    const html = articleBodyToHtml('Bu **çok önemli** bir gelişme.', { publishMode: 'rewrite' });
    expect(html).toContain('<strong>çok önemli</strong>');
    expect(html).not.toContain('**');
  });
  it('escapes inline angle-brackets in plain text', () => {
    const html = articleBodyToHtml('Skor 3 < 5 oldu', { publishMode: 'rewrite' });
    expect(html).toContain('3 &lt; 5');
  });
});

describe('articleBodyToHtml — gated subheads', () => {
  it('renders ## as <h2> for long-form articles past the gate', () => {
    const html = articleBodyToHtml(longBody('## Pazarlık Detayları'), { publishMode: 'rewrite' });
    expect(html).toContain('<h2>Pazarlık Detayları</h2>');
  });
  it('downgrades ## to a paragraph on short articles', () => {
    const html = articleBodyToHtml('Kısa haber.\n\n## Başlık\n\nBir cümle.', { publishMode: 'rewrite' });
    expect(html).not.toContain('<h2>');
    expect(html).toContain('<p>Başlık</p>');
  });
  it('never makes the FIRST block a subhead (protects the drop-cap lead <p>)', () => {
    const body = ['## Erken Başlık', 'kelime '.repeat(70).trim() + '.', 'kelime '.repeat(70).trim() + '.', 'p', 'p', 'p'].join('\n\n');
    const html = articleBodyToHtml(body, { publishMode: 'rewrite' });
    expect(html.startsWith('<p>')).toBe(true);      // first block is a paragraph
    expect(html).not.toContain('<h2>Erken Başlık');
  });
  it('does not add subheads for non-long-form modes', () => {
    const html = articleBodyToHtml(longBody('## Başlık'), { publishMode: 'copy_source' });
    expect(html).not.toContain('<h2>');
  });
});
