// IT6 generated card — a fully-owned fallback image for articles that have no licensed
// or embedded image. Pure: takes article fields, returns an SVG string. No third-party
// IP (headline text + BJK colours + a generic geometric motif + the Kartalix wordmark —
// NOT the official club crest), so it needs no licensing and is AdSense-safe.
// See docs/ROADMAP.md "Visual Assets" / IT-tier.

import { simpleHash } from './utils.js';

// A few on-brand colour schemes; the slug hash picks one so cards vary without per-article work.
const VARIANTS = [
  { bg0: '#0a0a0a', bg1: '#1c1c1c', accent: '#E30A17' }, // black + red
  { bg0: '#0b0f14', bg1: '#161d26', accent: '#ffffff' }, // black + white
  { bg0: '#111111', bg1: '#222222', accent: '#c8a04a' }, // black + gold
  { bg0: '#0a0a0a', bg1: '#181818', accent: '#9aa0a6' }, // black + silver
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
  const lines = wrapTitle(title, 26, 3);
  const badgeW = 60 + cat.length * 15;

  let y = 300;
  const headline = lines.map((line) => {
    const t = `<text x="80" y="${y}" font-family="Georgia,'Times New Roman',serif" font-size="52" font-weight="700" fill="#ffffff">${esc(line)}</text>`;
    y += 66;
    return t;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${v.bg0}"/><stop offset="1" stop-color="${v.bg1}"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<g opacity="0.07" fill="#ffffff"><path d="M880 120 L1140 80 L980 230 L1180 210 L900 380 Z"/><path d="M870 300 L1120 360 L940 430 L1130 470 L860 520 Z"/></g>
<rect x="80" y="150" width="70" height="8" fill="${v.accent}"/>
<rect x="80" y="180" rx="6" width="${badgeW}" height="44" fill="${v.accent}"/>
<text x="${80 + badgeW / 2}" y="210" font-family="Arial,Helvetica,sans-serif" font-size="22" font-weight="800" fill="${v.accent === '#ffffff' ? '#0a0a0a' : '#ffffff'}" text-anchor="middle" letter-spacing="2">${esc(cat)}</text>
${headline}
<line x1="80" y1="540" x2="1120" y2="540" stroke="#333333" stroke-width="1"/>
<text x="80" y="585" font-family="Arial,Helvetica,sans-serif" font-size="30" font-weight="900" fill="#ffffff">KARTALIX</text>
<text x="1120" y="585" font-family="Arial,Helvetica,sans-serif" font-size="20" fill="#9aa0a6" text-anchor="end">Kartalix Editöryel</text>
</svg>`;
}
