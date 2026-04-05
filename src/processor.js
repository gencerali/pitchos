import { simpleHash, callClaude, extractText, MODEL_SCORE } from './utils.js';

export const BJK_REGEX  = /beşiktaş|besiktas|bjk|kartal|siyah.beyaz/i;
export const CUTOFF_48H = 72 * 60 * 60 * 1000;

// ─── PRE-FILTER (pure JS, zero Claude calls) ─────────────────
// Returns { articles, counts } with per-stage breakdown
export function preFilter(articles, seenHashes) {
  const cutoff = Date.now() - CUTOFF_48H;

  // Stage 1: date filter
  const afterDate = articles.filter(a => {
    const pubMs = a.published_at ? new Date(a.published_at).getTime() : Date.now();
    return pubMs >= cutoff;
  });

  // Stage 2: BJK keyword + minimum summary length
  const afterKeyword = afterDate.filter(a => {
    const haystack = `${a.title} ${a.summary || ''} ${a.full_text || ''}`.slice(0, 600);
    if (!BJK_REGEX.test(haystack)) return false;
    if ((a.summary || '').length < 50) return false;
    return true;
  });

  // Stage 3: seen hash dedup
  const afterHash = afterKeyword.filter(a => {
    const hash = simpleHash(a.title + (a.summary || '').slice(0, 100));
    return !seenHashes.has(hash);
  });

  // Stage 4: title similarity dedup + sort by date + cap 20
  const afterTitle = dedupeByTitle(afterHash)
    .sort((a, b) => {
      const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
      const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 20);

  return {
    articles: afterTitle,
    counts: {
      after_date:    afterDate.length,
      after_keyword: afterKeyword.length,
      after_hash:    afterHash.length,
      after_title:   afterTitle.length,
    },
  };
}

// ─── DEDUPE BY TITLE SIMILARITY ──────────────────────────────
const KEY_TOKEN_RE = /\b([A-ZÇĞİÖŞÜa-zçğışöşü]{4,}|\d+-\d+)\b/g;

function extractKeyTokens(title) {
  return new Set((title.match(KEY_TOKEN_RE) || []).map(t => t.toLowerCase()));
}

export function normalizeTitle(title = '') {
  return title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function titleSimilarity(a, b) {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 3));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.max(wordsA.size, wordsB.size);
}

export function dedupeByTitle(articles) {
  const kept = [];
  for (const a of articles) {
    const aNorm = normalizeTitle(a.title);
    const aKeys = extractKeyTokens(a.title);
    const isDupe = kept.some(k => {
      if (titleSimilarity(aNorm, normalizeTitle(k.title)) > 0.3) return true;
      const kKeys = extractKeyTokens(k.title);
      let shared = 0;
      for (const t of aKeys) if (kKeys.has(t)) shared++;
      return shared >= 3;
    });
    if (!isDupe) kept.push(a);
  }
  return kept;
}

// ─── SCORE ARTICLES (batch NVS) ──────────────────────────────
export async function scoreArticles(articles, site, env) {
  const slim = articles.map(a => ({
    t:  (a.title || '').slice(0, 100),
    s:  a.source,
    tt: a.trust_tier || 'unknown',
    sp: a.sport || 'football',
  }));
  const prompt = `Score these ${site.team_name} news items. Return JSON array (same order), each: nvs(0-100), content_type("fact"|"rumor"|"analysis"), golden_score(1-5 for facts, "eye1"|"eye2"|"eye3" for rumors), nvs_notes(max 8 words). No markdown.
nvs guide: match result/confirmed=80+, press/injury=60+, rumor known journalist=50, vague rumor=30, analysis=40.
golden_score: 5=official confirmed, 4=verified journalist, 3=reliable media, 2=plausible unverified, 1=weak; eye3=known journalist rumor, eye2=unverified rumor, eye1=speculation.
Items: ${JSON.stringify(slim)}`;
  const response = await callClaude(env, MODEL_SCORE, prompt, false, 800);
  let scored = [];
  try {
    const text = extractText(response.content);
    const clean = text.replace(/```json|```/gi, '').trim();
    scored = JSON.parse(clean);
    if (!Array.isArray(scored)) scored = articles.map(a => ({ ...a, nvs: 50 }));
    scored = scored.map(s => ({
      ...s,
      golden_score: (s.golden_score == null || s.golden_score === 'N/A' || s.golden_score === '')
        ? 1
        : s.golden_score,
    }));
  } catch (e) {
    scored = articles.map(a => ({ ...a, nvs: 50, nvs_notes: 'Scoring failed, defaulted' }));
  }
  return { scored, usage: response.usage };
}

// ─── SEEN HASH CACHE ─────────────────────────────────────────
export async function getSeenHashes(env, siteCode) {
  try {
    const raw = await env.PITCHOS_CACHE.get(`seen:${siteCode}`);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

export async function saveSeenHashes(env, siteCode, articles) {
  try {
    const existing = await getSeenHashes(env, siteCode);
    for (const a of articles) {
      existing.add(simpleHash(a.title + (a.summary || '').slice(0, 100)));
    }
    const trimmed = [...existing].slice(-100);
    await env.PITCHOS_CACHE.put(`seen:${siteCode}`, JSON.stringify(trimmed), { expirationTtl: 43200 });
  } catch (e) {
    console.error('saveSeenHashes failed:', e.message);
  }
}
