import { simpleHash, callClaude, extractText, MODEL_SCORE, MODEL_FETCH, supabase, bjkMatch, bjkMatchDetail } from './utils.js';

export const BJK_REGEX  = /beşiktaş|besiktas|bjk|kartal|siyah.beyaz/i;
export const CUTOFF_48H = 72 * 60 * 60 * 1000; // kept for any external callers

// Rival clubs — explicit names only (no ambiguous nicknames like "aslan"/"kanarya").
// Used by isRivalSubject for a deterministic off-topic guard.
const RIVAL_KEYWORDS = [
  'fenerbahçe', 'fenerbahce', 'galatasaray', 'trabzonspor',
  'cimbom', 'sarı-lacivert', 'sari-lacivert', 'sarı-kırmızı', 'sari-kirmizi', 'bordo-mavi',
];

// Rival club figures (coaches) whose NAME alone must not make an article read as BJK news.
// "Kartal" is also Beşiktaş's nickname, so Fenerbahçe head coach "İsmail Kartal" otherwise
// trips the BJK keyword check and his transfer/squad stories get treated as Beşiktaş news
// even when no rival CLUB is named (e.g. "İsmail Kartal'dan Tadic'e sürpriz telefon", 2026-06).
// Matched against an ASCII-folded title; a real BJK angle (BJK_ANGLE_RE) still spares the
// article (e.g. "Beşiktaş, İsmail Kartal'la görüştü"). Add current rival coaches here.
const RIVAL_FIGURES = [
  'ismail kartal',   // Fenerbahçe head coach — surname collides with Beşiktaş's "Kartal"
];

// Unambiguous Beşiktaş references for the rival-guard exception below. Bare singular "kartal"
// is deliberately EXCLUDED here: it collides with common Turkish surnames (e.g. Fenerbahçe
// coach "İsmail Kartal"), which let a rival-led story bypass this guard — published 2026-06-18
// ("Fenerbahçe'de İsmail Kartal dönemi resmen başlıyor"). "kara kartal" and "kartallar"
// (the eagles / the fans) are unambiguous and remain valid BJK signals.
const BJK_ANGLE_RE = /beşiktaş|besiktas|\bbjk\b|siyah.?beyaz|kara kartal|kartallar/i;

// True when an article TITLE is led by a rival club/figure AND carries no BJK angle in the
// title — i.e. a rival-internal story (board election, rival-only transfer, rival coach move)
// with no Beşiktaş relevance. Deterministic backstop: the LLM relevance scorer alone has let
// these through (e.g. a Fenerbahçe genel-kurul article published on the BJK site, 2026-06-06).
export function isRivalSubject(title) {
  // Substring match (not token) so Turkish suffixes still match: "Fenerbahçe'de" → fenerbahçe.
  // A genuine Beşiktaş angle spares the article — but only on an UNAMBIGUOUS signal (BJK_ANGLE_RE),
  // never on the bare word "kartal", which is too easily a person's surname.
  const t = (title || '').toLowerCase();
  // ASCII-folded copy so the dotted Turkish İ ("İsmail" → "i̇smail") still matches the
  // plain-ASCII RIVAL_FIGURES entries (strip combining marks U+0300–U+036F).
  const ascii = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const hasRival = RIVAL_KEYWORDS.some(k => t.includes(k)) || RIVAL_FIGURES.some(k => ascii.includes(k));
  return hasRival && !BJK_ANGLE_RE.test(t);
}

// Editorial framing guard (NOT a drop guard): true when a title FOREGROUNDS a rival club —
// a rival CLUB token appears before any Beşiktaş token. On a BJK fan site rivals may be
// mentioned but must never lead/be the subject (e.g. "Galatasaray'a kimler veda edecek?
// Beşiktaş hangi futbolcuları transfer edecek" reads rival-first, 2026-06-23).
// Whitelists legitimate rival-first framings so we never mangle them:
//   • derby coverage ("…derbi…")
//   • rival in adjective/genitive form = Beşiktaş acquiring FROM the rival
//     ("Galatasaraylı yıldız Beşiktaş'a", "Fenerbahçe'nin yıldızını Beşiktaş istiyor").
// Bias to false-negatives (leave a title) over false-positives, and the only action taken
// on a hit is a reframe attempt — never a drop. Uses RIVAL_KEYWORDS (clubs) only.
export function isRivalLedTitle(title) {
  const t = (title || '').toLowerCase();
  let rivalIdx = -1, matched = '';
  for (const k of RIVAL_KEYWORDS) {
    const i = t.indexOf(k);
    if (i !== -1 && (rivalIdx === -1 || i < rivalIdx)) { rivalIdx = i; matched = k; }
  }
  if (rivalIdx === -1) return false;             // no rival club → fine
  const bjkIdx = t.search(BJK_ANGLE_RE);
  if (bjkIdx === -1) return false;               // no BJK angle → isRivalSubject's job (drop), not framing
  if (bjkIdx <= rivalIdx) return false;          // Beşiktaş already leads → fine
  if (/derbi/.test(t)) return false;             // derby coverage is legitimately two-club
  // Rival in adjective (-lı/li/lu/lü) or genitive (-'nın/nin… / -'ın/in…) form → BJK acquiring
  // from the rival; that's a BJK-first story, leave it.
  const after = t.slice(rivalIdx + matched.length, rivalIdx + matched.length + 4);
  if (/^'?(l[ıiuü]|n[ıiuü]n|[ıiuü]n)/.test(after)) return false;
  return true;                                   // rival leads with no whitelist → rival-led
}

// Reframe a rival-led title so it leads with Beşiktaş. Cheap Haiku call made ONLY when
// isRivalLedTitle flags (≈0 marginal cost). Never mangles: returns the ORIGINAL title if the
// reframe fails the framing re-check or the length bounds (false-negative bias by design).
// Shared chokepoint for every generation path (synthesis, video, story synthesis).
export async function ensureBjkFirstTitle(title, body, env, _usages = null) {
  if (!isRivalLedTitle(title)) return title;
  const prompt = `Bu başlık bir rakip kulübü öne çıkarıyor. Burası bir BEŞİKTAŞ haber sitesi. Başlığı yeniden yaz: Beşiktaş'ı (ya da Beşiktaş'ın oyuncusunu/teknik direktörünü) başa al; rakip kulüp (Fenerbahçe/Galatasaray/Trabzonspor) ASLA başta veya özne olmasın — yalnızca Beşiktaş'tan sonra, bağlam olarak geçebilir. Anlamı koru, uydurma bilgi ekleme.

MEVCUT BAŞLIK: ${title}
HABER METNİ: ${(body || '').slice(0, 1200)}

50-90 karakter, abartı yok, emoji yok, tamamı büyük harf yok, ünlem yok. Sadece yeni başlığı yaz.`;
  try {
    const res = await callClaude(env, MODEL_FETCH, prompt, false, 50);
    if (_usages && res?.usage) _usages.push({ model: MODEL_FETCH, usage: res.usage });
    const out = extractText(res.content).trim().replace(/^["'«»]+|["'«»]+$/g, '').replace(/\.+$/, '').trim();
    if (out.length >= 25 && out.length <= 100 && !isRivalLedTitle(out)) return out;
  } catch { /* fall through to original */ }
  return title;
}

// ─── PRE-FILTER (pure JS, zero Claude calls) ─────────────────
// Returns { articles, counts, rejected } with per-stage breakdown.
// lookbackMs: how far back to accept articles (default 3h; caller derives from cron frequency)
export function preFilter(articles, seenHashes, lookbackMs = 3 * 60 * 60 * 1000) {
  const cutoff = Date.now() - lookbackMs;
  const rejected = [];

  // Stage 1: date filter
  const afterDate = articles.filter(a => {
    const pubMs = a.published_at ? new Date(a.published_at).getTime() : Date.now();
    if (pubMs < cutoff) {
      rejected.push({ url: a.url || a.original_url, title: a.title, source_name: a.source_name || a.source, published_at: a.published_at, _stage: 'date_old',
        trust_tier: a.trust_tier || a.trust || null,
        source_body_len: ((a.summary || '') + (a.full_text || '')).length,
        drop_detail: a.published_at || null });
      return false;
    }
    return true;
  });

  // Stage 1.5: live-blog URL rejection — before keyword check to avoid wasting NVS budget
  const LIVE_BLOG_PATTERNS = [/\/canli\//i, /\/live\//i, /\/live-blog\//i];
  const afterLiveBlog = afterDate.filter(a => {
    const url = a.url || a.original_url || '';
    if (LIVE_BLOG_PATTERNS.some(p => p.test(url))) {
      rejected.push({ url, title: a.title, source_name: a.source_name || a.source, published_at: a.published_at, _stage: 'live_blog_source',
        trust_tier: a.trust_tier || a.trust || null,
        source_body_len: ((a.summary || '') + (a.full_text || '')).length,
        drop_detail: 'live-blog URL pattern' });
      return false;
    }
    return true;
  });

  // Stage 1.6: rival-subject rejection — title led by a rival club with no BJK angle.
  // Deterministic guard; the LLM relevance scorer alone has let rival-internal stories
  // through (e.g. Fenerbahçe genel kurul on the BJK site, 2026-06-06).
  const afterRival = afterLiveBlog.filter(a => {
    if (isRivalSubject(a.title || '')) {
      rejected.push({ url: a.url || a.original_url, title: a.title, source_name: a.source_name || a.source, published_at: a.published_at, _stage: 'rival_subject',
        trust_tier: a.trust_tier || a.trust || null,
        source_body_len: ((a.summary || '') + (a.full_text || '')).length,
        drop_detail: 'rival-led title, no BJK keyword' });
      return false;
    }
    return true;
  });

  // Stage 2: BJK keyword + minimum summary length
  const afterKeyword = afterRival.filter(a => {
    const haystack = `${a.title} ${a.summary || ''} ${a.full_text || ''}`.slice(0, 600);
    if (!bjkMatch(haystack)) {
      rejected.push({ url: a.url || a.original_url, title: a.title, source_name: a.source_name || a.source, published_at: a.published_at, _stage: 'off_topic',
        trust_tier: a.trust_tier || a.trust || null,
        source_body_len: ((a.summary || '') + (a.full_text || '')).length,
        drop_detail: 'no_match' });
      return false;
    }
    const bodyLen = `${a.title || ''} ${a.summary || ''} ${a.full_text || ''}`.trim().length;
    if (bodyLen < 50) {
      rejected.push({ url: a.url || a.original_url, title: a.title, source_name: a.source_name || a.source, published_at: a.published_at, _stage: 'too_short',
        trust_tier: a.trust_tier || a.trust || null,
        source_body_len: ((a.summary || '') + (a.full_text || '')).length,
        drop_detail: String(bodyLen) });
      return false;
    }
    return true;
  });

  // Stage 3: seen hash dedup
  const afterHash = afterKeyword.filter(a => {
    const hash = simpleHash(a.title + (a.summary || '').slice(0, 100));
    if (seenHashes.has(hash)) {
      rejected.push({ url: a.url || a.original_url, title: a.title, source_name: a.source_name || a.source, published_at: a.published_at, _stage: 'hash_dedup',
        trust_tier: a.trust_tier || a.trust || null,
        source_body_len: ((a.summary || '') + (a.full_text || '')).length,
        drop_detail: null });
      return false;
    }
    return true;
  });

  // Stage 4: title similarity dedup + sort by date + cap 100
  const { kept: deduped, dupeWinnerMap, dupeSiblings } = dedupeByTitle(afterHash);
  // Attach same-story siblings so writeArticles can try alternative sources if primary synthesis fails.
  // _siblings is stripped by toKVShape's explicit property whitelist and never written to KV.
  for (const a of deduped) {
    const key = a.url || a.original_url || a.title;
    a._siblings = dupeSiblings.get(key) || [];
  }
  // Find title_dedup rejections by comparing afterHash vs deduped
  const dedupedUrlSet = new Set(deduped.map(a => a.url || a.original_url || a.title));
  for (const a of afterHash) {
    const key = a.url || a.original_url || a.title;
    if (!dedupedUrlSet.has(key)) {
      rejected.push({ url: a.url || a.original_url, title: a.title, source_name: a.source_name || a.source, published_at: a.published_at, _stage: 'title_dedup',
        trust_tier: a.trust_tier || a.trust || null,
        source_body_len: ((a.summary || '') + (a.full_text || '')).length,
        drop_detail: dupeWinnerMap.get(key) || null });
    }
  }

  const sorted = deduped.sort((a, b) => {
    const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
    const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
    return tb - ta;
  });

  const afterTitle = sorted.slice(0, 100);
  // Find cap_drop rejections
  if (sorted.length > 100) {
    for (const a of sorted.slice(100)) {
      rejected.push({ url: a.url || a.original_url, title: a.title, source_name: a.source_name || a.source, published_at: a.published_at, _stage: 'cap_drop' });
    }
  }

  return {
    articles: afterTitle,
    counts: {
      after_date:    afterDate.length,
      after_keyword: afterKeyword.length,
      after_hash:    afterHash.length,
      after_title:   afterTitle.length,
    },
    rejected,
  };
}

// ─── DEDUPE BY TITLE SIMILARITY ──────────────────────────────
const KEY_TOKEN_RE = /\b([A-ZÇĞİÖŞÜa-zçğışöşü]{4,}|\d+-\d+)\b/g;

// Tokens that appear in almost every Beşiktaş article — excluded from story-dedup
// shared-token counting so they don't falsely mark unrelated articles as dupes.
// NOTE: KEY_TOKEN_RE uses ASCII word boundaries, so a trailing Turkish "ş" is dropped
// ("Beşiktaş" → token "beşikta", "Kartal'ın" → "kartal"). The truncated/stem forms below
// must be listed too, or the stopword never matches the actual token. (Found via tests 2026-06-05.)
const DEDUP_STOPWORDS = new Set(['beşiktaş', 'beşikta', 'besiktas', 'bjk', 'kartal', 'siyahbeyaz', 'siyah', 'beyaz']);

export function extractKeyTokens(title) {
  return new Set((title.match(KEY_TOKEN_RE) || []).map(t => t.toLowerCase()));
}

// Returns true when two tokens are morphologically related (same Turkish root).
// Handles common suffixes: "Muciyi" → "Muci", "Beşiktaşa" → "Beşiktaş", etc.
// Match if one token is a prefix of the other and the prefix is ≥4 chars.
// rootAware (cross-run dedup only): also match two DIFFERENT inflections of one root that
// share a long common prefix even though neither is a clean prefix of the other —
// "kısıtlamalarını" vs "kısıtlamalarından". Kept opt-in so within-batch recall is unchanged.
function tokensMatch(a, b, rootAware = false) {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 4) return false;
  if (a.startsWith(b.slice(0, minLen)) || b.startsWith(a.slice(0, minLen))) return true;
  if (rootAware) {
    let cp = 0;
    while (cp < minLen && a[cp] === b[cp]) cp++;
    return cp >= 5 && cp >= 0.7 * minLen;
  }
  return false;
}

// Count non-stopword token matches between two token sets, using morphological matching.
export function sharedStoryTokens(aKeys, bKeys, rootAware = false) {
  let shared = 0;
  for (const t of aKeys) {
    if (DEDUP_STOPWORDS.has(t)) continue;
    for (const s of bKeys) {
      if (DEDUP_STOPWORDS.has(s)) continue;
      if (tokensMatch(t, s, rootAware)) { shared++; break; }
    }
  }
  return shared;
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
  const dupeWinnerMap = new Map();
  const dupeSiblings = new Map(); // winner URL → [losing articles], used for synthesis sibling fallback
  for (const a of articles) {
    const aNorm = normalizeTitle(a.title);
    const aKeys = extractKeyTokens(a.title);
    let winner = null;
    const isDupe = kept.some(k => {
      if (titleSimilarity(aNorm, normalizeTitle(k.title)) > 0.3) { winner = k; return true; }
      const kKeys = extractKeyTokens(k.title);
      if (sharedStoryTokens(aKeys, kKeys) >= 3) { winner = k; return true; }
      return false;
    });
    if (!isDupe) {
      kept.push(a);
    } else {
      const winKey = winner?.url || winner?.original_url || winner?.title;
      dupeWinnerMap.set(a.url || a.original_url || a.title, winKey || null);
      if (winKey) {
        if (!dupeSiblings.has(winKey)) dupeSiblings.set(winKey, []);
        dupeSiblings.get(winKey).push(a);
      }
    }
  }
  return { kept, dupeWinnerMap, dupeSiblings };
}

// ─── POST-SCORING STORY DEDUP ─────────────────────────────────
// Deduplicates scored articles by story cluster, keeping highest-NVS per story.
// Input must already be sorted by NVS descending.
// Uses morphological token matching (handles Turkish suffixes) and stopword exclusion.
export function dedupeByStory(articles) {
  const kept = [];
  for (const a of articles) {
    const aNorm = normalizeTitle(a.title);
    const aKeys = extractKeyTokens(a.title);
    const isDupe = kept.some(k => {
      // Same story: ≥25% word overlap
      if (titleSimilarity(aNorm, normalizeTitle(k.title)) >= 0.25) return true;
      // Same story: 1+ shared meaningful named token (morphology-aware, stopwords excluded)
      const kKeys = extractKeyTokens(k.title);
      return sharedStoryTokens(aKeys, kKeys) >= 2;
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
  // Articles with nvs_hint bypass Claude — use the preset value directly
  const hintByIndex = new Map();
  const toScore = articles.filter((a, i) => {
    if (a.nvs_hint != null) {
      hintByIndex.set(i, {
        nvs:          a.nvs_hint,
        relevant:     true,
        rival_pov:    false,
        sentiment:    'positive',
        category:     a.category || 'Match',
        content_type: 'fact',
        golden_score: Math.ceil(a.nvs_hint / 20),
        nvs_notes:    `nvs_hint:${a.source_type || 'youtube'}`,
      });
      return false;
    }
    return true;
  });

  const CHUNK = 10;
  const chunks = [];
  for (let i = 0; i < toScore.length; i += CHUNK) {
    chunks.push(toScore.slice(i, i + CHUNK));
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
Match — BJK football fixtures, results, lineups, referee, pre/post-match, European match
Transfer — signings, departures, loans, contract extensions, transfer rumors (confirmed or rumor)
Injury — injuries, suspensions, fitness, return timelines
Squad — training, youth, non-transfer roster management, tactical news, coach work
Club — board, finance, stadium, fan groups, management, sponsor, official statements
Other Sport — BJK basketball, handball, volleyball (men's or women's), e-sports or any other BJK sport branch result/news
National Team — Turkey national team (football, basketball, etc.) article that features or highlights BJK players

NVS GUIDANCE FOR SPECIAL CATEGORIES:
- Other Sport (BJK branch): championship or trophy won → 90-95; tournament match result with score → 65-78; regular season result → 55-65; squad/training news → 35-50
- Other Sport (non-BJK, e.g. general volleyball/basketball): relevant=false, nvs≤19
- National Team football (Turkey A Milli): World Cup / EURO tournament match → 65-78; qualifying result → 55-65; friendly → 40-52; BJK player scores/assists in any game → +10 bonus on top of base band
- National Team basketball/volleyball (Turkey): major tournament (Olympics, World Cup, EuroBasket, EuroVolley) → 60-75; qualifying → 48-60; BJK player performs → +8 bonus
- When football leagues are closed (international break, summer) and major tournaments are live, treat national team results as primary content (push NVS to top of band)

EXCLUSION RULES:
- rival_pov=true (rival beats BJK, rival celebration): nvs ≤ 25
- relevant=false (BJK barely mentioned AND not a national team or BJK other-sport article): nvs ≤ 19
- sentiment=rival_celebration: nvs ≤ 30
- Fenerbahçe/Galatasaray win article mentioning BJK loss: rival_pov=true
- General Turkish Süper Lig news with no BJK angle: relevant=false
- Turkey national team or BJK other-sport (handball/basketball/volleyball) results: relevant=true even without direct BJK player mention, score per NVS guidance above

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

  // Reconstruct full scored array in original article order
  const fullScored = [];
  let j = 0;
  for (let i = 0; i < articles.length; i++) {
    fullScored.push(hintByIndex.has(i)
      ? hintByIndex.get(i)
      : (allScored[j++] || { nvs: 50, content_type: 'fact', golden_score: 2 })
    );
  }
  return { scored: fullScored, usage: totalUsage };
}

// ─── PERMANENT URL DEDUP (against Supabase) ──────────────────
export async function getSeenUrls(env, siteId) {
  const result = await supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${siteId}&select=original_url&limit=10000&order=created_at.desc`);
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

// ─── SYNTHESIS-FAILED SEEN CACHE ─────────────────────────────
// Prevents re-attempting URLs that failed synthesis (proxy 403, thin source, etc.)
// on every cron run. TTL 6h — longer than lookbackMs to cover multiple cron cycles.
// Keyed by URL hash (not content hash) — synthesis failure is URL-specific.
export async function getSynthesisFailedHashes(env, siteCode) {
  try {
    const raw = await env.PITCHOS_CACHE.get(`seen:synth_failed:${siteCode}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

export async function saveSynthesisFailedHashes(env, siteCode, hashes) {
  try {
    const arr = Array.from(hashes).slice(-200);
    await env.PITCHOS_CACHE.put(
      `seen:synth_failed:${siteCode}`,
      JSON.stringify(arr),
      { expirationTtl: 21600 }
    );
  } catch (e) {
    console.error(`saveSynthesisFailedHashes failed for ${siteCode}:`, e);
  }
}

// ─── OFF-TOPIC SEEN CACHE ─────────────────────────────────────
// Separate from seen:{siteCode} (hash-dedup). off_topic rejection happens
// at Stage 2 (preFilter); mixing with Stage 3 hash-dedup would corrupt semantics.
export async function getOffTopicHashes(env, siteCode) {
  try {
    const raw = await env.PITCHOS_CACHE.get(`seen:off_topic:${siteCode}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

export async function saveOffTopicHashes(env, siteCode, hashes, ttlSeconds) {
  try {
    const arr = Array.from(hashes).slice(-200);
    await env.PITCHOS_CACHE.put(
      `seen:off_topic:${siteCode}`,
      JSON.stringify(arr),
      { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) }
    );
  } catch (e) {
    console.error(`saveOffTopicHashes failed for ${siteCode}:`, e);
  }
}
