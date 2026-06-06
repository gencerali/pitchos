// Article body rendering — converts the lightweight markdown our generators emit
// (blank-line paragraphs, `## subheads`, `**bold**`) into safe HTML. Shared by the worker's
// renderArticleHTML; the SPA (index.html buildBodyHtml) mirrors this logic inline.
//
// Subheads are gated ("preferred, but not always"): only long-form modes, only when the body
// is long enough, never as the first block (so the drop-cap lands on the lead paragraph),
// capped at 3. Below the gate, stray `##` is downgraded to a paragraph.

const LONGFORM_MODES = new Set([
  'rewrite', 'synthesis', 'original_synthesis', 'synthesis_generated',
  'youtube_synthesis', 'youtube_embed_synthesis',
]);
const BLOCK_TAG_RE = /<(p|h[1-6]|ul|ol|li|img|blockquote|figure|table|iframe)\b/i;
const SUBHEAD_MIN_WORDS = 350;
const SUBHEAD_MIN_BLOCKS = 5;
const SUBHEAD_MAX = 3;

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sanitize(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, '');
}
// Inline markdown on already-escaped text. Only **bold** (single * left alone to avoid
// false positives on stray asterisks / bullets).
function inlineMd(escaped) {
  return escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

export function articleBodyToHtml(bodyRaw, opts = {}) {
  const raw = bodyRaw || '';
  if (!raw.trim()) return '';
  // Already-HTML bodies (e.g. templates): pass through, sanitized.
  if (BLOCK_TAG_RE.test(raw)) return sanitize(raw);

  // Split into paragraph blocks on blank lines; fall back to single newlines if the model
  // didn't double-space (otherwise the whole body collapses into one paragraph).
  let blocks = raw.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
  if (blocks.length === 1 && /\n/.test(raw)) blocks = raw.split(/\n+/).map(b => b.trim()).filter(Boolean);

  const wordCount = raw.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  const allowSubheads = LONGFORM_MODES.has(opts.publishMode) && wordCount >= SUBHEAD_MIN_WORDS && blocks.length >= SUBHEAD_MIN_BLOCKS;

  let subheads = 0;
  return blocks.map((b, idx) => {
    const h = b.match(/^(#{2,3})\s+(.+)$/);
    if (h && allowSubheads && idx > 0 && subheads < SUBHEAD_MAX) {
      subheads++;
      const tag = h[1].length === 2 ? 'h2' : 'h3';
      return `<${tag}>${inlineMd(esc(h[2].trim()))}</${tag}>`;
    }
    // Paragraph: drop any leading #, collapse internal whitespace, convert inline bold.
    const text = b.replace(/^#{1,6}\s*/, '').replace(/\s+/g, ' ').trim();
    return text ? `<p>${inlineMd(esc(text))}</p>` : '';
  }).join('');
}
