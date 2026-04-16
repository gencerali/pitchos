import { simpleHash, callClaude, extractText, MODEL_SCORE, supabase } from './utils.js';

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

  // Stage 4: title similarity dedup + sort by date + cap 100
  const afterTitle = dedupeByTitle(afterHash)
    .sort((a, b) => {
      const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
      const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 100);

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
  const CHUNK = 10;
  const chunks = [];
  for (let i = 0; i < articles.length; i += CHUNK) {
    chunks.push(articles.slice(i, i + CHUNK));
  }

  const allScored = [];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };

  for (const chunk of chunks) {
    const prompt = `You are the editorial AI for Kartalix, a Beşiktaş JK fan news site.
Evaluate each article for BJK fans. Return ONLY a JSON array, no other text.

Articles to evaluate:
${chunk.map((a, i) => `${i}. Title: "${a.title}" | Source: ${a.source_name || a.source} (${a.trust_tier || a.trust || 'unknown'}) | Summary: "${(a.summary || '').slice(0, 200)}"`).join('\n')}

For each article return:
{
  "i": index,
  "relevant": true/false,
  "relevance_reason": "one sentence why",
  "sentiment": "positive" | "neutral" | "negative" | "rival_celebration",
  "rival_pov": true/false,
  "category": "Match" | "Transfer" | "Injury" | "Squad" | "Club" | "European" | "Other",
  "content_type": "fact" | "rumor" | "analysis",
  "nvs": 0-100,
  "golden_score": 1-5,
  "nvs_notes": "one sentence explanation"
}

SCORING RULES (apply strictly):
- If rival_pov=true (article celebrates rival win over BJK): nvs maximum 25
- If relevant=false (BJK only mentioned in passing): nvs maximum 20
- If sentiment=rival_celebration: nvs maximum 30
- "Siyah-beyaz" or "Kartal" alone without BJK player/club name = relevant:false
- General Süper Lig table news mentioning BJK = relevant:false
- Fenerbahçe winning article with BJK losing = rival_pov:true

HIGH VALUE (nvs 70-100):
- Match result with score and scorers: nvs 80-90
- Confirmed injury with player name and timeline: nvs 70-80
- Official club statement or press conference quote: nvs 75-90
- Confirmed transfer (official or journalist tier): nvs 75-85
- Lineup announcement day of match: nvs 80

MEDIUM VALUE (nvs 40-69):
- Pre-match analysis with named players: nvs 50-65
- Credible transfer rumor (journalist source): nvs 45-60
- Squad training news: nvs 40-55
- League table with BJK position explained: nvs 40-50

LOW VALUE (nvs 20-39):
- General speculation without named source: nvs 20-35
- Passing mention of BJK in rival article: nvs 15-25
- Old news angle already covered: nvs 20-30

Return JSON array only. No markdown. No explanation outside JSON.`;

    const response = await callClaude(env, MODEL_SCORE, prompt, false, 2000);
    if (totalUsage && response.usage) {
      totalUsage.input_tokens  += response.usage.input_tokens  || 0;
      totalUsage.output_tokens += response.usage.output_tokens || 0;
    }

    try {
      const text  = extractText(response.content);
      const clean = text.replace(/```json|```/gi, '').trim();
      const parsed = JSON.parse(clean);
      const chunkScored = Array.isArray(parsed) ? parsed : chunk.map(() => ({ nvs: 50 }));
      const normalized = chunkScored.map(s => ({
        ...s,
        golden_score: (s.golden_score == null || s.golden_score === 'N/A' || s.golden_score === '')
          ? 1
          : s.golden_score,
      }));
      // Apply post-processing rules
      normalized.forEach(a => {
        if (a.rival_pov) a.nvs = Math.min(a.nvs, 25);
        if (!a.relevant) a.nvs = Math.min(a.nvs, 20);
        if (a.sentiment === 'rival_celebration') a.nvs = Math.min(a.nvs, 30);
        if (a.nvs === undefined || isNaN(a.nvs)) a.nvs = 0;
        if (a.golden_score === undefined) a.golden_score = Math.ceil(a.nvs / 20);
      });
      // Pad if response was short
      while (normalized.length < chunk.length) {
        normalized.push({ nvs: 50, content_type: 'fact', golden_score: 2, nvs_notes: 'Truncated' });
      }
      allScored.push(...normalized);
    } catch (e) {
      console.error('scoreArticles chunk parse failed:', e.message, '| stop_reason:', response?.stop_reason);
      allScored.push(...chunk.map(() => ({ nvs: 50, content_type: 'fact', golden_score: 2, nvs_notes: 'Parse failed' })));
    }

    if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
  }

  return { scored: allScored, usage: totalUsage };
}

// ─── PERMANENT URL DEDUP (against Supabase) ──────────────────
export async function getSeenUrls(env, siteId) {
  const result = await supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${siteId}&select=original_url&limit=2000&order=created_at.desc`);
  return new Set((result || []).map(r => r.original_url).filter(Boolean));
}

// ─── SEEN HASH CACHE ─────────────────────────────────────────
export async function getSeenHashes(env, siteCode) {
  try {
    const raw = await env.PITCHOS_CACHE.get(`seen:${siteCode}`);
    return new Set(raw ? JSON.parse(raw).slice(-50) : []);
  } catch { return new Set(); }
}

export async function saveSeenHashes(env, siteCode, articles) {
  try {
    const existing = await getSeenHashes(env, siteCode);
    for (const a of articles) {
      existing.add(simpleHash(a.title + (a.summary || '').slice(0, 100)));
    }
    const trimmed = [...existing].slice(-50);
    await env.PITCHOS_CACHE.put(`seen:${siteCode}`, JSON.stringify(trimmed), { expirationTtl: 172800 });
  } catch (e) {
    console.error('saveSeenHashes failed:', e.message);
  }
}
