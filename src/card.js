// IT6 generated card — a fully-owned fallback image for articles with no licensed or
// embedded image. Pure: takes article fields, returns an SVG string. No third-party IP
// in the design itself (headline + BJK colours + Kartalix mark + generic motifs).
//
// Two render modes:
//   • procedural (default)  — self-contained art (gradient + floodlight bokeh + faint
//     pitch lines + watermark + photographic grain). Works everywhere, incl. as <img>.
//   • photo (opts.bgDataUri) — a CC0 background image, INLINED as a data URI (must be
//     inlined, not <image href=url>, because SVG-as-<img> blocks external fetches), with
//     a dark scrim + headline overlay. The route supplies the data URI from the config pool.
// See docs/ROADMAP.md "Visual Assets" / IT-tier.

import { simpleHash } from './utils.js';

// On-brand schemes designed to STAND OUT on a black site (accent frame + bold motif).
const VARIANTS = [
  { mode: 'dark',  bg0: '#171717', bg1: '#262626', accent: '#E30A17', text: '#ffffff' }, // charcoal + red
  { mode: 'light', bg0: '#f4f4f5', bg1: '#e4e4e7', accent: '#E30A17', text: '#0a0a0a' }, // white + red (pops on black)
  { mode: 'dark',  bg0: '#1a1a1a', bg1: '#2b2b2b', accent: '#ffffff', text: '#ffffff' }, // charcoal + white
  { mode: 'dark',  bg0: '#241d0e', bg1: '#3a2f17', accent: '#d9b25a', text: '#ffffff' }, // espresso + gold
  { mode: 'dark',  bg0: '#2a0a0c', bg1: '#3d0e12', accent: '#ffffff', text: '#ffffff' }, // deep red + white
  { mode: 'dark',  bg0: '#14181d', bg1: '#222a33', accent: '#cfd6dd', text: '#ffffff' }, // slate + silver
];

const CATEGORY_LABEL = {
  Transfer: 'TRANSFER', Match: 'MAÇ', Injury: 'SAKATLIK', Squad: 'KADRO',
  Club: 'KULÜP', 'National Team': 'MİLLİ TAKIM', 'Other Sport': 'DİĞER SPOR',
  Haber: 'HABER', haber: 'HABER',
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrapTitle(text, perLine = 24, maxLines = 3) {
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

function seedOf(s) { return parseInt(simpleHash(String(s || '')), 36) || 0; }

export function pickCardVariant(seed) {
  return VARIANTS[seedOf(seed) % VARIANTS.length];
}

export function categoryLabel(category) {
  return CATEGORY_LABEL[category] || String(category || 'HABER').toUpperCase().slice(0, 16);
}

// Hash-assign a background from a pool (array of URLs or data URIs); null if pool empty.
export function pickBackground(slug, pool) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  return pool[seedOf(slug) % pool.length];
}

// Kartalix "K" brand mark (from Logo and Branding/kartalix-icon-*.svg) inlined so the
// card SVG stays self-contained (no external fetch). `main` = the white K stroke colour
// (adapts: white on dark cards, black on light), `red` = the brand accent.
function kIcon(x, y, size, main, red) {
  const s = size / 64;
  return `<g transform="translate(${x},${y}) scale(${s})">` +
    `<rect x="8" y="4" width="12" height="56" fill="${main}"/>` +
    `<polygon points="20,32 56,4 46,4 20,22" fill="${main}"/>` +
    `<polygon points="20,32 58,60 68,60 20,36" fill="${red}"/>` +
    `<rect x="8" y="29" width="12" height="7" fill="${red}"/></g>`;
}

// Generic spread-wing eagle silhouette — a nod to "Kartal" (eagles). Deliberately NOT the
// official Beşiktaş crest (trademark); a plain heraldic shape used only as a faint motif.
function eagleMotif(cx, cy, scale, color, opacity) {
  return `<g transform="translate(${cx},${cy}) scale(${scale})" fill="${color}" fill-opacity="${opacity}">` +
    `<path d="M0,-6 C-42,-42 -92,-30 -124,-52 C-92,-22 -70,-18 -80,0 C-50,-14 -28,-8 0,6 Z"/>` +
    `<path d="M0,-6 C42,-42 92,-30 124,-52 C92,-22 70,-18 80,0 C50,-14 28,-8 0,6 Z"/>` +
    `<path d="M0,-14 L11,2 L5,34 L-5,34 L-11,2 Z"/>` +
    `<circle cx="0" cy="-20" r="9"/>` +
    `<path d="M0,-24 L16,-21 L3,-15 Z"/></g>`;
}

// The foreground (frame + badge + headline + brand lockup) shared by both modes.
function foreground(v, cat, lines, textColor, muted, lineCol, badgeOnPhoto) {
  const badgeW = 48 + cat.length * 16;
  const onAccent = v.accent === '#ffffff' ? '#0a0a0a' : '#ffffff';
  let y = 330;
  const headline = lines.map((line) => {
    const t = `<text x="80" y="${y}" font-family="Georgia,'Times New Roman',serif" font-size="58" font-weight="700" fill="${textColor}">${esc(line)}</text>`;
    y += 72;
    return t;
  }).join('');
  return `<rect x="14" y="14" width="1172" height="602" rx="14" fill="none" stroke="${v.accent}" stroke-width="6"/>
<rect x="80" y="170" width="96" height="10" fill="${v.accent}"/>
<rect x="80" y="200" rx="6" width="${badgeW}" height="48" fill="${v.accent}"/>
<text x="${80 + badgeW / 2}" y="232" font-family="Arial,Helvetica,sans-serif" font-size="24" font-weight="800" fill="${onAccent}" text-anchor="middle" letter-spacing="2">${esc(cat)}</text>
${headline}
<line x1="80" y1="556" x2="1010" y2="556" stroke="${lineCol}" stroke-width="1"/>
${kIcon(80, 566, 40, textColor, '#E30A17')}
<text x="134" y="600" font-family="'Barlow Condensed',Impact,'Arial Narrow',sans-serif" font-size="36" font-weight="900" letter-spacing="3" fill="${textColor}">KARTALIX</text>
<text x="1010" y="600" font-family="Arial,Helvetica,sans-serif" font-size="20" fill="${muted}" text-anchor="end">Kartalix Editöryel</text>`;
}

// Returns an SVG string (1200×630, OG ratio). Deterministic for a given slug.
// opts.bgDataUri — a `data:image/...;base64,...` background (photo mode).
export function renderArticleCardSVG(article = {}, opts = {}) {
  const { title = '', category = 'Haber', slug = '' } = article;
  const v = pickCardVariant(slug || title);
  const cat = categoryLabel(category);
  const lines = wrapTitle(title, 22, 3);
  const seed = seedOf(slug || title);

  // ── Photo mode ──
  if (opts.bgDataUri) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0.25"/><stop offset="0.55" stop-color="#000000" stop-opacity="0.6"/><stop offset="1" stop-color="#000000" stop-opacity="0.92"/></linearGradient></defs>
<image href="${opts.bgDataUri}" x="0" y="0" width="1200" height="630" preserveAspectRatio="xMidYMid slice"/>
<rect width="1200" height="630" fill="url(#scrim)"/>
${foreground(v, cat, lines, '#ffffff', '#cbd1d8', '#555555')}
</svg>`;
  }

  // ── Procedural mode ──
  const flipped = seed % 2 === 1;
  const glowAx = flipped ? 1080 : 120, glowBx = flipped ? 120 : 1080;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${v.bg0}"/><stop offset="1" stop-color="${v.bg1}"/></linearGradient>
<radialGradient id="gw" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffffff" stop-opacity="0.20"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<radialGradient id="ga" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${v.accent}" stop-opacity="0.33"/><stop offset="1" stop-color="${v.accent}" stop-opacity="0"/></radialGradient>
<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.06"/></feComponentTransfer></filter>
</defs>
<rect width="1200" height="630" fill="url(#g)"/>
<ellipse cx="${glowAx}" cy="60" rx="520" ry="360" fill="url(#gw)"/>
<ellipse cx="${glowBx}" cy="120" rx="560" ry="420" fill="url(#ga)"/>
<g fill="none" stroke="${v.text}" stroke-opacity="0.06" stroke-width="3"><circle cx="600" cy="720" r="250"/><path d="M-50 480 Q600 370 1250 480"/><rect x="430" y="610" width="340" height="200"/></g>
${seed % 2 === 0
  ? eagleMotif(995, 300, 2.05, v.text, 0.07)
  : `<g opacity="0.05">${kIcon(840, 150, 360, v.text, v.accent)}</g>`}
<rect width="1200" height="630" filter="url(#grain)" opacity="0.5"/>
<path d="M1200 0 L1200 300 L870 0 Z" fill="${v.accent}" opacity="0.9"/>
${foreground(v, cat, lines, v.text, v.mode === 'light' ? '#666666' : '#9aa0a6', v.mode === 'light' ? '#cccccc' : '#3a3a3a')}
</svg>`;
}
