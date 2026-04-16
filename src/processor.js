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

// ─── POST-SCORING STORY DEDUP ─────────────────────────────────
// Deduplicates scored articles by story cluster, keeping highest-NVS per story.
// Input must already be sorted by NVS descending.
export function dedupeByStory(articles) {
  const kept = [];
  for (const a of articles) {
    const aNorm = normalizeTitle(a.title);
    const aKeys = extractKeyTokens(a.title);
    const isDupe = kept.some(k => {
      // Same story: ≥25% word overlap
      if (titleSimilarity(aNorm, normalizeTitle(k.title)) > 0.25) return true;
      // Same story: 2+ shared named tokens (player name, club, event)
      const kKeys = extractKeyTokens(k.title);
      let shared = 0;
      for (const t of aKeys) if (kKeys.has(t)) shared++;
      return shared >= 2;
    });
    if (!isDupe) kept.push(a);
  }
  return kept;
}

// ─── FETCH RECENTLY PUBLISHED TITLES (for story-aware scoring) ──
export async function getRecentPublishedTitles(env, siteId) {
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const result = await supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${siteId}&status=eq.published&fetched_at=gte.${since}&select=title&limit=50&order=fetched_at.desc`);
    return (result || []).map(r => r.title).filter(Boolean);
  } catch { return []; }
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

  const now = Date.now();
  const recentTitles = await getRecentPublishedTitles(env, site.id);
  const recentBlock = recentTitles.length > 0
    ? `\nALREADY PUBLISHED in last 24h (avoid scoring duplicates high — same story covered = band -1):\n${recentTitles.map((t, i) => `- ${t}`).join('\n')}\n`
    : '';

  for (const chunk of chunks) {
    const prompt = `You are the editorial AI for Kartalix, a Beşiktaş JK fan news site.
Score each article for BJK fans using the NVS bands below. Return ONLY a JSON array, no other text.
${recentBlock}
Articles to evaluate:
${chunk.map((a, i) => {
  const ageH = a.published_at ? Math.round((now - new Date(a.published_at).getTime()) / 3600000) : null;
  const ageTag = ageH === null ? '' : ageH < 6 ? ' [FRESH]' : ageH < 24 ? ` [${ageH}h ago]` : ageH < 48 ? ` [${Math.floor(ageH/24)}d ago]` : ` [${Math.floor(ageH/24)}d ago — OLD]`;
  return `${i}. Title: "${a.title}"${ageTag} | Source: ${a.source_name || a.source} (${a.trust_tier || a.trust || 'unknown'}) | Summary: "${(a.summary || '').slice(0, 200)}"`;
}).join('\n')}

For each article return:
{"i":index,"relevant":true/false,"rival_pov":true/false,"sentiment":"positive"|"neutral"|"negative"|"rival_celebration","category":"Match"|"Transfer"|"Injury"|"Squad"|"Club","content_type":"fact"|"rumor"|"analysis","nvs":0-100,"golden_score":1-5,"nvs_notes":"one sentence"}

NVS BANDS — pick the band that fits, then fine-tune within it:
BAND 0-19 IRRELEVANT: BJK only mentioned in passing; rival team article; general Süper Lig table without BJK focus; "Siyah-beyaz"/"Kartal" alone with no BJK player/club name
BAND 20-39 LOW: Unnamed-source speculation; rumor with no journalist credibility; repackaged old story; general squad filler
BAND 40-59 MEDIUM-LOW: Pre-match preview with named players; training/fitness update; squad availability (unconfirmed); credible transfer rumor from known journalist
BAND 60-74 MEDIUM-HIGH: Press conference quote or coach statement; post-match reaction; confirmed squad news; journalist-sourced transfer with named player and club
BAND 75-84 HIGH: Match result with score + scorers; confirmed injury with player name and timeline; confirmed transfer (official source or senior journalist)
BAND 85-94 VERY HIGH: Major signing/departure officially confirmed; dramatic result vs top rival; official club statement on key issue (coach firing, board decision)
BAND 95-100 ELITE: Transfer contract officially signed and announced; BJK wins trophy; breaking news of historic significance

CATEGORY GUIDE (assign exactly one):
Match — fixtures, results, lineups, referee, pre/post-match, European match
Transfer — signings, departures, loans, contract extensions, transfer rumors (confirmed or rumor)
Injury — injuries, suspensions, fitness, return timelines
Squad — training, youth, non-transfer roster management, tactical news, coach work
Club — board, finance, stadium, fan groups, management, sponsor, official statements

EXCLUSION RULES:
- rival_pov=true (rival beats BJK, rival celebration): nvs ≤ 25
- relevant=false (BJK barely mentioned): nvs ≤ 19
- sentiment=rival_celebration: nvs ≤ 30
- Fenerbahçe/Galatasaray win article mentioning BJK loss: rival_pov=true

Return JSON array only. No markdown. No text outside JSON.`;

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
      // Apply post-processing rules + age penalty
      normalized.forEach((a, idx) => {
        if (a.rival_pov) a.nvs = Math.min(a.nvs, 25);
        if (!a.relevant) a.nvs = Math.min(a.nvs, 19);
        if (a.sentiment === 'rival_celebration') a.nvs = Math.min(a.nvs, 30);
        if (a.nvs === undefined || isNaN(a.nvs)) a.nvs = 0;

        // Age penalty (applied after model score, before final NVS)
        const orig = chunk[idx];
        if (orig?.published_at) {
          const ageH = (now - new Date(orig.published_at).getTime()) / 3600000;
          if (ageH >= 48) a.nvs = Math.max(0, a.nvs - 30);
          else if (ageH >= 24) a.nvs = Math.max(0, a.nvs - 15);
        }

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
