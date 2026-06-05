import { describe, it, expect } from 'vitest';
import { renderArticleCardSVG, pickCardVariant, categoryLabel, pickBackground } from '../card.js';

describe('IT6 generated card', () => {
  it('returns a well-formed 1200×630 SVG', () => {
    const svg = renderArticleCardSVG({ title: 'Test başlık', category: 'Transfer', slug: 'x' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('width="1200" height="630"');
    expect(svg).toContain('KARTALIX');
  });

  it('includes the (escaped) headline and category label', () => {
    const svg = renderArticleCardSVG({ title: 'Rashica & Co <gol>', category: 'Match', slug: 'y' });
    expect(svg).toContain('MAÇ');
    expect(svg).toContain('Rashica &amp; Co &lt;gol&gt;'); // XSS-safe escaping
  });

  it('is deterministic per slug (same slug → same variant)', () => {
    const a = renderArticleCardSVG({ title: 'A', category: 'Haber', slug: 'same' });
    const b = renderArticleCardSVG({ title: 'A', category: 'Haber', slug: 'same' });
    expect(a).toBe(b);
  });

  it('maps known categories to Turkish, falls back for unknown', () => {
    expect(categoryLabel('Injury')).toBe('SAKATLIK');
    expect(categoryLabel('Weird')).toBe('WEIRD');
    expect(categoryLabel(undefined)).toBe('HABER');
  });

  it('pickCardVariant returns a valid variant object', () => {
    const v = pickCardVariant('slug-123');
    expect(v).toHaveProperty('accent');
    expect(v).toHaveProperty('bg0');
  });

  it('photo mode embeds the data URI background + scrim', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgo=';
    const svg = renderArticleCardSVG({ title: 'X', category: 'Match', slug: 'p' }, { bgDataUri: uri });
    expect(svg).toContain(`<image href="${uri}"`);
    expect(svg).toContain('url(#scrim)');
  });

  it('procedural mode (no bgDataUri) uses grain + bokeh, no <image>', () => {
    const svg = renderArticleCardSVG({ title: 'X', category: 'Match', slug: 'q' });
    expect(svg).toContain('feTurbulence');     // grain
    expect(svg).not.toContain('<image');
  });

  it('pickBackground: null for empty pool, deterministic pick otherwise', () => {
    expect(pickBackground('s', [])).toBeNull();
    expect(pickBackground('s', null)).toBeNull();
    const pool = ['a.jpg', 'b.jpg', 'c.jpg'];
    expect(pickBackground('same', pool)).toBe(pickBackground('same', pool));
    expect(pool).toContain(pickBackground('same', pool));
  });
});
