// Shared presentation logic — the single source of truth for both renderers:
//   • the Worker (server-side renderArticleHTML) imports this directly (bundled);
//   • the SPA (index.html) will import this via <script type="module"> once Pages serves it.
// Keep this module browser-AND-worker safe: pure ESM, no node/worker-only APIs.

export { articleBodyToHtml } from './render.js';

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Is this article Kartalix-original (vs an external source)? Identical rule in worker + SPA.
export function isKartalix(article = {}) {
  const src = article.source || article.source_name || '';
  const pm = article.publish_mode || '';
  return !src || src === 'Kartalix'
    || ['rewrite', 'original_synthesis', 'manual'].includes(pm)
    || pm.startsWith('template');
}

// The YouTube embed block — identical markup in both renderers.
export function videoEmbedHtml(videoId, title = '') {
  if (!videoId) return '';
  return `<div class="yt-embed"><iframe src="https://www.youtube.com/embed/${videoId}" allowfullscreen loading="lazy" frameborder="0" title="${esc(title)}"></iframe></div>`;
}

// ── Canonical badge + category presentation (STAGED for adoption) ──────────────
// Today the worker keys badges by CSS class and the SPA by hex colour; this encodes the
// decision once as {label, kind} so each side maps `kind` to its own representation.
// Wiring both renderers to these is the supervised step (see docs/NEXT.md).
export const TEMPLATE_BADGES = {
  T01: { label: 'Maç Önü', kind: 'match' }, T02: { label: 'Maç Günü', kind: 'match' },
  T03: { label: 'Maç Raporu', kind: 'match' }, T08: { label: 'Olası 11', kind: 'match' },
  T08b: { label: 'Olası 11', kind: 'match' }, T09: { label: 'İlk 11', kind: 'match' },
  T10: { label: 'Gol', kind: 'live' }, T11: { label: 'Sonuç', kind: 'live' },
  T12: { label: 'Maç Sonu', kind: 'match' }, T13: { label: 'Analiz', kind: 'analysis' },
  'T-XG': { label: 'xG Analizi', kind: 'analysis' }, 'T-REF': { label: 'Referans', kind: 'analysis' },
  'T-RED': { label: 'Kırmızı Kart', kind: 'live' }, 'T-VAR': { label: 'VAR', kind: 'live' },
  'T-PEN': { label: 'Penaltı', kind: 'live' }, 'T-HT': { label: 'Devre Arası', kind: 'live' },
};
export const BADGE_CLASS = { match: 'badge-match', live: 'badge-live', analysis: 'badge-analysis', video: 'badge-video', transfer: 'badge-transfer' };
export const BADGE_COLOR = { match: '#1d4ed8', live: '#f59e0b', analysis: '#0d9488', video: '#374151', transfer: '#d97706' };

// One badge decision for both renderers → {label, kind}. Map kind via BADGE_CLASS/BADGE_COLOR.
export function badgeFor(article = {}) {
  const t = article.template_id;
  if (t) {
    if (t.startsWith('T-VID')) return { label: 'Video', kind: 'video' };
    if (TEMPLATE_BADGES[t]) return TEMPLATE_BADGES[t];
  }
  if (article.publish_mode === 'original_synthesis') return { label: 'Analiz', kind: 'analysis' };
  if ((article.category || '').toLowerCase().includes('transfer')) return { label: 'Transfer', kind: 'transfer' };
  return { label: article.category || 'Haber', kind: '' };
}

export const CAT_ICONS = {
  Match: '⚽', Transfer: '🔄', Injury: '🏥', Club: '🦅',
  European: '🏆', Squad: '👥', Basket: '🏀', Basketball: '🏀', default: '📰',
};
export const TRUST_LABELS = {
  official: 'Resmi Kaynak', broadcast: 'Yayın Kuruluşu', press: 'Basın', journalist: 'Gazeteci',
};
