// IT6 generated card — a fully-owned fallback image for articles that have no licensed
// or embedded image. Pure: takes article fields, returns an SVG string. No third-party
// IP (headline text + BJK colours + a generic geometric motif + the Kartalix wordmark —
// NOT the official club crest), so it needs no licensing and is AdSense-safe.
// See docs/ROADMAP.md "Visual Assets" / IT-tier.

import { simpleHash } from './utils.js';

// On-brand schemes designed to STAND OUT on a black site: each card has an accent
// border frame + a bold corner wedge, and one light variant for maximum contrast.
const VARIANTS = [
  { mode: 'dark',  bg0: '#171717', bg1: '#262626', accent: '#E30A17', text: '#ffffff' }, // charcoal + red
  { mode: 'light', bg0: '#f4f4f5', bg1: '#e4e4e7', accent: '#E30A17', text: '#0a0a0a' }, // white + red (pops on black)
  { mode: 'dark',  bg0: '#1a1a1a', bg1: '#2b2b2b', accent: '#ffffff', text: '#ffffff' }, // charcoal + white
  { mode: 'dark',  bg0: '#241d0e', bg1: '#3a2f17', accent: '#d9b25a', text: '#ffffff' }, // espresso + gold
];

// Turkish category labels for the badge; falls back to the raw category, uppercased.
const CATEGORY_LABEL = {
  Transfer: 'TRANSFER', Match: 'MAÇ', Injury: 'SAKATLIK', Squad: 'KADRO',
  Club: 'KULÜP', 'National Team': 'MİLLİ TAKIM', 'Other Sport': 'DİĞER SPOR',
  Haber: 'HABER', haber: 'HABER',
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Greedy word-wrap to at most `maxLines` lines of ~`perLine` chars.
function wrapTitle(text, perLine = 26, maxLines = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length <= perLine) cur = (cur + ' ' + w).trim();
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] += '…'; }
  return lines;
}

export function pickCardVariant(seed) {
  const h = parseInt(simpleHash(String(seed || '')), 36) || 0;
  return VARIANTS[h % VARIANTS.length];
}

export function categoryLabel(category) {
  return CATEGORY_LABEL[category] || String(category || 'HABER').toUpperCase().slice(0, 16);
}

// Returns an SVG string (1200×630, OG ratio). Deterministic for a given slug.
export function renderArticleCardSVG(article = {}) {
  const { title = '', category = 'Haber', slug = '' } = article;
  const v = pickCardVariant(slug || title);
  const cat = categoryLabel(category);
  const lines = wrapTitle(title, 24, 3);
  const badgeW = 48 + cat.length * 16;
  const onAccent = v.accent === '#ffffff' ? '#0a0a0a' : '#ffffff'; // text colour on the accent badge
  const muted = v.mode === 'light' ? '#666666' : '#9aa0a6';
  const lineCol = v.mode === 'light' ? '#cccccc' : '#3a3a3a';

  let y = 300;
  const headline = lines.map((line) => {
    const t = `<text x="80" y="${y}" font-family="Georgia,'Times New Roman',serif" font-size="56" font-weight="700" fill="${v.text}">${esc(line)}</text>`;
    y += 70;
    return t;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${v.bg0}"/><stop offset="1" stop-color="${v.bg1}"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<path d="M1200 0 L1200 360 L770 0 Z" fill="${v.accent}" opacity="0.92"/>
<path d="M1200 360 L1200 470 L1010 0 L860 0 Z" fill="${v.accent}" opacity="0.35"/>
<rect x="14" y="14" width="1172" height="602" rx="14" fill="none" stroke="${v.accent}" stroke-width="6"/>
<rect x="80" y="150" width="96" height="10" fill="${v.accent}"/>
<rect x="80" y="180" rx="6" width="${badgeW}" height="48" fill="${v.accent}"/>
<text x="${80 + badgeW / 2}" y="212" font-family="Arial,Helvetica,sans-serif" font-size="24" font-weight="800" fill="${onAccent}" text-anchor="middle" letter-spacing="2">${esc(cat)}</text>
${headline}
<line x1="80" y1="544" x2="1010" y2="544" stroke="${lineCol}" stroke-width="1"/>
<text x="80" y="590" font-family="Arial,Helvetica,sans-serif" font-size="32" font-weight="900" fill="${v.text}">KARTALIX</text>
<text x="980" y="590" font-family="Arial,Helvetica,sans-serif" font-size="20" fill="${muted}" text-anchor="end">Kartalix Editöryel</text>
</svg>`;
}
