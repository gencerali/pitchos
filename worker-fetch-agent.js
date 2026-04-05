
/**
 * PitchOS — Fetch Agent (Cloudflare Worker)
 * ==========================================
 * Runs every hour via Cron Trigger.
 * For each active site:
 *   1. Fetches latest news via Claude API (web search enabled)
 *   2. Scores each article with NVS
 *   3. Routes: auto-publish | review queue | discard
 *   4. Caches published articles to KV (fan site reads from here)
 *   5. Logs cost + results to Supabase
 *
 * SETUP INSTRUCTIONS:
 * -------------------
 * 1. Create a Cloudflare Worker called "pitchos-fetch-agent"
 * 2. Add these environment variables in Worker Settings → Variables:
 *    - ANTHROPIC_API_KEY    → your Claude API key
 *    - SUPABASE_URL         → your Supabase project URL
 *    - SUPABASE_SERVICE_KEY → your Supabase service role key (not anon key)
 * 3. Create a KV namespace called "PITCHOS_CACHE" and bind it to this worker
 * 4. Add a Cron Trigger: "0 * * * *" (every hour)
 * 5. Paste this entire file as your worker code
 */
// ─── MODELS ──────────────────────────────────────────────────
const MODEL_FETCH   = 'claude-haiku-4-5-20251001';   // cheap, fast — for fetching
const MODEL_SCORE   = 'claude-haiku-4-5-20251001';   // cheap — NVS scoring
const MODEL_SUMMARY = 'claude-sonnet-4-6';           // quality — final summaries
// ─── COST ESTIMATES (EUR per 1M tokens) ──────────────────────
const COST = {
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.00  },
  'claude-sonnet-4-6':          { input: 2.75,  output: 13.75 },
};
// ─── MAIN ENTRY POINT ────────────────────────────────────────
export default {
  // HTTP trigger (for manual testing: fetch worker URL)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      ctx.waitUntil(runAllSites(env));
      return Response.json({ status: 'started', message: 'Running in background — check /cache in ~60s' });
    }
    if (url.pathname === '/cache') {
      const siteCode = url.searchParams.get('site') || 'BJK';
      const cached = await env.PITCHOS_CACHE.get(`articles:${siteCode}`);
      return new Response(cached || '[]', {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
        }
      });
    }
    if (url.pathname === '/debug') {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/sites?status=eq.live&select=*`, {
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
        }
      });
      const text = await res.text();
      return new Response(text, { headers: { 'Content-Type': 'application/json' }});
    }
    if (url.pathname === '/status') {
      const siteCode = url.searchParams.get('site') || 'BJK';
      const log = await supabase(env, 'GET',
        `/rest/v1/fetch_logs?select=*&order=created_at.desc&limit=1`
      );
      return Response.json(
        log?.[0] || { error: 'No fetch logs found' },
        { headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    }
    if (url.pathname === '/stats') {
      const siteCode = url.searchParams.get('site') || 'BJK';
      const articles = await getCachedArticles(env, siteCode);
      const todayArticles = articles.filter(a => isTodayArticle(a.time_ago));
      return Response.json(
        { site: siteCode, published_today: todayArticles.length, total_cached: articles.length },
        { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' } }
      );
    }
    return new Response('PitchOS Fetch Agent — OK', { status: 200 });
  },
  // Cron trigger (runs every hour automatically)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllSites(env));
  }
};
// ─── ORCHESTRATOR ────────────────────────────────────────────
async function runAllSites(env) {
  const sites = await getActiveSites(env);
  console.log('Sites found:', JSON.stringify(sites));
  if (!sites || sites.length === 0) {
    return { processed: 0, error: 'No active sites found in Supabase' };
  }
  const results = [];
  for (const site of sites) {
    try {
      const result = await processSite(site, env);
      results.push({ site: site.short_code, ...result });
    } catch (err) {
      console.error(`Failed site ${site.short_code}:`, err);
      results.push({ site: site.short_code, error: err.message });
      await logFetch(env, site.id, 'failed', {}, err.message);
    }
  }
  return { processed: results.length, results };
}
// ─── PROCESS ONE SITE ────────────────────────────────────────
async function processSite(site, env) {
  const startTime = Date.now();
  const stats = {
    fetched: 0, published: 0, queued: 0,
    rejected: 0, claudeCalls: 0,
    tokensIn: 0, tokensOut: 0, costEur: 0
  };
  // 1. Fetch from RSS feeds and Claude web search in parallel
  const [rssArticles, { articles: webArticles, usage: fetchUsage }] = await Promise.all([
    fetchRSSArticles(site),
    fetchArticles(site, env),
  ]);
  stats.claudeCalls++;
  addUsage(stats, fetchUsage, MODEL_FETCH);
  // Combine and deduplicate by title similarity
  const combined = dedupeByTitle([...rssArticles, ...webArticles]);
  stats.fetched = combined.length;
  console.log(`${site.short_code}: ${rssArticles.length} RSS + ${webArticles.length} web = ${combined.length} combined`);
  if (combined.length === 0) {
    await logFetch(env, site.id, 'partial', stats, 'No articles returned');
    return stats;
  }
  // 2. Score all articles in one batch call
  const { scored, usage: scoreUsage } = await scoreArticles(combined, site, env);
  // Merge NVS scores back onto original articles to preserve all fields
  const mergedScored = combined.map((orig, i) => ({
    ...orig,
    nvs:          scored[i]?.nvs          || 50,
    content_type: scored[i]?.content_type || 'unknown',
    nvs_notes:    scored[i]?.nvs_notes    || '',
  }));
  stats.claudeCalls++;
  addUsage(stats, scoreUsage, MODEL_SCORE);
  // 3. Write full Turkish articles for ALL scored articles
  const toWrite = mergedScored.filter(a => a.nvs >= site.review_threshold);
  const toDiscard = mergedScored.filter(a => a.nvs < site.review_threshold);
  const { written, usage: writeUsage } = await writeArticles(toWrite, site, env);
  stats.claudeCalls += written.length;
  addUsage(stats, writeUsage, MODEL_SUMMARY);
  // 4. Route written articles by NVS score
  const writtenPublish = written.filter(a => a.nvs >= site.auto_publish_threshold);
  const writtenQueue   = written.filter(a => a.nvs >= site.review_threshold && a.nvs < site.auto_publish_threshold);
  stats.published = writtenPublish.length;
  stats.queued    = writtenQueue.length;
  stats.rejected  = toDiscard.length;
  // 5. Save to Supabase
  if (writtenPublish.length > 0) {
    await saveArticles(env, site.id, writtenPublish, 'published');
  }
  if (writtenQueue.length > 0) {
    await saveArticles(env, site.id, writtenQueue, 'pending');
  }
  // 5. Cache published articles to KV (fan site reads this)
  const existing = await getCachedArticles(env, site.short_code);
  const merged   = mergeAndDedupe([...writtenPublish, ...existing], 20);
  await env.PITCHOS_CACHE.put(
    `articles:${site.short_code}`,
    JSON.stringify(merged.map(a => ({
      title:     a.title     || '',
      summary:   a.summary   || '',
      full_body: a.full_body || '',
      source:    a.source    || a.source_name || '',
      url:       a.url       || a.original_url || '',
      category:  a.category  || 'Haber',
      nvs:       a.nvs       || a.nvs_score   || 0,
      time_ago:  a.time_ago  || 'Güncel',
      is_fresh:  a.is_fresh  ?? true,
    }))),
    { expirationTtl: 7200 }
  );
  // 6. Log to Supabase
  await logFetch(env, site.id, 'success', stats);
  stats.durationMs = Date.now() - startTime;
  return stats;
}
// ─── FETCH ARTICLES via RSS ──────────────────────────────────
const RSS_FEEDS = [
  { url: 'https://www.fotomac.com.tr/rss/besiktas.xml', source: 'Fotomaç',  trust_tier: 'reliable'   },
  { url: 'https://www.duhuliye.com/rss',                source: 'Duhuliye', trust_tier: 'aggregator' },
];
const CUTOFF_MS = 48 * 60 * 60 * 1000; // 48 hours

const BJK_KEYWORDS = ['beşiktaş', 'besiktas', 'bjk', 'kartal', 'siyah-beyaz'];

async function fetchRSSArticles(site) {
  const results = await Promise.allSettled(RSS_FEEDS.map(feed => fetchOneFeed(feed, site)));
  const articles = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      articles.push(...r.value);
    } else {
      console.error(`RSS feed failed: ${r.reason?.message}`);
    }
  }
  return articles;
}

async function fetchOneFeed({ url, source, trust_tier }, site) {
  const res = await fetch(url, { headers: { 'User-Agent': 'PitchOS/1.0' }, cf: { cacheTtl: 300 } });
  if (!res.ok) {
    console.error(`RSS [${source}]: HTTP ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const cutoff = Date.now() - CUTOFF_MS;
  const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  console.log(`RSS [${source}]: ${items.length} total items in feed`);

  let recentCount = 0;
  const articles = [];

  for (const item of items) {
    // ── Parse fields ──
    const title        = stripCDATA(getTag(item, 'title'));
    const rawDesc      = stripCDATA(getTag(item, 'description'));
    const rawContent   = stripCDATA(getTagNS(item, 'content:encoded') || getTagNS(item, 'content'));
    const url_         = getRSSLink(item) || getTag(item, 'guid') || '';
    const pubDate      = getTag(item, 'pubDate');
    const published_at = pubDate ? new Date(pubDate).toISOString() : null;
    const pubMs        = pubDate ? new Date(pubDate).getTime() : 0;
    const image_url    = getEnclosureUrl(item);

    // ── 48-hour filter ──
    if (pubMs && pubMs < cutoff) continue;
    recentCount++;

    // ── Keyword filter ──
    const haystack = (title + ' ' + rawDesc + ' ' + rawContent).toLowerCase();
    if (!BJK_KEYWORDS.some(k => haystack.includes(k))) continue;

    // ── Clean text ──
    const summary   = stripHTML(rawDesc).slice(0, 500) || title;
    const full_text = rawContent
      ? rawContent.split(/<br\s*\/?>|<\/p>/i)
          .map(p => stripHTML(p).trim())
          .filter(p => p.length > 20)
          .join('\n\n')
          .slice(0, 3000)
      : summary;

    // ── Original source (Duhuliye aggregates other sites) ──
    let original_source = null;
    if (trust_tier === 'aggregator') {
      const srcMatch = rawContent.match(/(?:Haber kaynağı|Kaynak)\s*[:\-]\s*([^\n<]{2,60})/i);
      if (srcMatch) original_source = srcMatch[1].trim();
    }

    // ── Sport detection ──
    let sport = 'football';
    if (/basketbol|basket\b/i.test(haystack)) sport = 'basketball';
    else if (/voleybol/i.test(haystack))       sport = 'volleyball';

    articles.push({
      title,
      summary,
      full_text,
      source,
      original_source,
      url:          url_,
      image_url,
      category:     'Club',
      time_ago:     pubMs ? relativeTime(pubMs) : 'Güncel',
      published_at,
      is_fresh:     true,
      trust_tier,
      sport,
    });
  }

  console.log(`RSS [${source}]: ${recentCount} within 48h, ${articles.length} passed keyword filter`);
  return articles;
}

function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function getTagNS(xml, tag) {
  // Handles namespace tags like content:encoded
  const escaped = tag.replace(':', '\\:');
  const m = xml.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return m ? m[1].trim() : '';
}

function getEnclosureUrl(item) {
  const m = item.match(/<enclosure[^>]+url="([^"]+)"/i);
  return m ? m[1].trim() : null;
}

// RSS <link> is often a naked text node between tags, not wrapped in <link>...</link>
function getRSSLink(item) {
  const standard = item.match(/<link[^>]*>([^<]+)<\/link>/i);
  if (standard) return standard[1].trim();
  const atom = item.match(/<link[^>]+href="([^"]+)"/i);
  if (atom) return atom[1].trim();
  const naked = item.match(/<link\s*\/?>[\s\r\n]*(https?:\/\/[^\s<]+)/i);
  if (naked) return naked[1].trim();
  return '';
}

function stripCDATA(str) {
  return (str || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function stripHTML(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return `${Math.floor(diff / 60000)} dakika önce`;
  if (h < 24) return `${h} saat önce`;
  return 'Dün';
}

// ─── DEDUPE BY TITLE SIMILARITY ──────────────────────────────
function dedupeByTitle(articles) {
  const kept = [];
  for (const a of articles) {
    const aNorm = normalizeTitle(a.title);
    const isDupe = kept.some(k => titleSimilarity(aNorm, normalizeTitle(k.title)) > 0.4);
    if (!isDupe) kept.push(a);
  }
  return kept;
}

function normalizeTitle(title = '') {
  return title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function titleSimilarity(a, b) {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 3));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.max(wordsA.size, wordsB.size);
}

// ─── FETCH ARTICLES via Claude + Web Search ──────────────────
async function fetchArticles(site, env) {
  const searchPrompt = `Search the web for the latest ${site.team_name} football news from the last 24 hours. Find transfers, match results, injuries, squad updates, press conferences.`;

  const searchResponse = await callClaude(env, MODEL_FETCH, searchPrompt, true);

  const allText = searchResponse.content
    .map(b => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_result') return JSON.stringify(b.content);
      return '';
    })
    .join('\n');

  const formatPrompt = `Based on this football news content, return ONLY a valid JSON array. No markdown, just raw JSON starting with [ and ending with ].

RULES:
- Only include news where something specific happened recently (match result, goal, injury, signing, statement, press conference)
- Do NOT include general stats, old fixture lists, or league tables unless a result changed today
- If you find fewer than 3 good articles, return only those - never invent or pad
- Every field must be filled

Each object must have:
- title (string, specific headline)
- summary (string, 2-3 sentences describing what specifically happened)
- source (string, publication name, use "Spor Haberleri" if unknown)
- url (string, use "#" if unknown)
- category (one of: Transfer|Match|Injury|Squad|Club|European)
- time_ago (string, e.g. "1 saat once", "Bugun", "Dun")
- is_fresh (boolean, true if event happened in last 48 hours)

News content to analyze:
${allText.slice(0, 4000)}`;

  let formatResponse;
  try {
    formatResponse = await callClaude(env, MODEL_FETCH, formatPrompt, false);
  } catch(e) {
    console.error('Format call failed:', e.message);
    return { articles: [], usage: searchResponse.usage };
  }

  let articles = [];
  try {
    const text = extractText(formatResponse.content);
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      articles = JSON.parse(match[0]);
    }
    if (!Array.isArray(articles)) articles = [];
    articles = articles.filter(a => a.is_fresh !== false);
  } catch (e) {
    console.error('Parse error:', e.message);
    console.log('Raw format response:', JSON.stringify(formatResponse?.content).slice(0, 300));
  }

  // Combine usage from both calls
  const usage = {
    input_tokens: (searchResponse.usage?.input_tokens || 0) + (formatResponse.usage?.input_tokens || 0),
    output_tokens: (searchResponse.usage?.output_tokens || 0) + (formatResponse.usage?.output_tokens || 0),
  };

  return { articles, usage };
}
// ─── WRITE FULL TURKISH ARTICLES ─────────────────────────────
async function writeArticles(articles, site, env) {
  if (articles.length === 0) return { written: [], usage: null };

  // Group articles about the same story by title similarity
  const groups = [];
  for (const a of articles) {
    const norm = normalizeTitle(a.title);
    const existing = groups.find(g =>
      titleSimilarity(norm, normalizeTitle(g[0].title)) > 0.4
    );
    if (existing) existing.push(a);
    else groups.push([a]);
  }

  // Sort groups by highest NVS in group, cap at 3 to stay within time limits
  const sortedGroups = groups
    .sort((a, b) => Math.max(...b.map(x => x.nvs || 0)) - Math.max(...a.map(x => x.nvs || 0)))
    .slice(0, 3);
  console.log(`writeArticles: ${groups.length} groups → writing top ${sortedGroups.length}`);

  // Write one article per group in parallel
  const results = await Promise.allSettled(sortedGroups.map(group => writeOneArticle(group, site, env)));

  const written = [];
  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  for (const r of results) {
    if (r.status === 'fulfilled') {
      written.push(r.value.article);
      totalUsage.input_tokens  += r.value.usage?.input_tokens  || 0;
      totalUsage.output_tokens += r.value.usage?.output_tokens || 0;
    } else {
      console.error('writeOneArticle failed:', r.reason?.message);
    }
  }
  return { written, usage: totalUsage };
}

async function writeOneArticle(group, site, env) {
  // Use the highest-NVS article as the lead; others provide additional context
  const lead = group.reduce((best, a) => (a.nvs || 0) > (best.nvs || 0) ? a : best, group[0]);
  const context = group.map(a =>
    `KAYNAK: ${a.source}\nBAŞLIK: ${a.title}\nİÇERİK: ${a.summary}`
  ).join('\n\n---\n\n');

  const prompt = `Sen ${site.team_name} için profesyonel bir spor gazetecisisin. Aşağıdaki kaynaklardan derlenen haberi, Türkçe olarak tam bir spor haberi makalesine dönüştür.

KAYNAK HABERLER:
${context}

Aşağıdaki JSON formatında yanıt ver (markdown veya açıklama olmadan, sadece ham JSON):
{
  "headline": "Dikkat çekici, özlü haber başlığı",
  "body": "GİRİŞ PARAGRAFı (kim/ne/ne zaman/nerede - 2-3 cümle)\\n\\nGELİŞME (detaylar ve bağlam - 2-3 paragraf, her biri 2-3 cümle)\\n\\nSONUÇ (genel tablo veya beklentiler - 1 paragraf)",
  "sources": ["kaynak adları dizisi"],
  "category": "${lead.category || 'Club'}",
  "nvs_score": ${lead.nvs || 50}
}`;

  const response = await callClaude(env, MODEL_SUMMARY, prompt, false);
  const text = extractText(response.content);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in writeOneArticle response');

  const parsed = JSON.parse(match[0]);
  return {
    article: {
      ...lead,
      title:     parsed.headline || lead.title,
      summary:   (parsed.body || '').split('\n\n')[0] || lead.summary,
      full_body: parsed.body    || '',
      source:    (parsed.sources || [lead.source]).join(', '),
      category:  parsed.category || lead.category,
      nvs:       parsed.nvs_score ?? lead.nvs,
    },
    usage: response.usage,
  };
}

// ─── SCORE ARTICLES (batch NVS) ──────────────────────────────
async function scoreArticles(articles, site, env) {
  const prompt = `You are a news value scorer for ${site.team_name} football content.

First classify each article as FACT or RUMOR:
- FACT: Verifiable, confirmed information. Match results, official lineups, confirmed signings, scheduled fixtures, press conference statements, injury confirmations by club.
- RUMOR: Unverified claims. Transfer interest, contract talks, speculation, "according to sources", unnamed sources, fan accounts.

Then score each article on NVS (0-100) using these rules:

FOR FACTS — score on:
- Specificity (35): Named people, exact figures, dates, confirmed details
- Recency (30): Today=30, yesterday=20, this week=10, older=5
- Relevance (25): Directly about ${site.team_name}=25, tangential=10
- Source (10): Official club=10, verified media=7, unknown=3

FOR RUMORS — score on:
- Source authority (40): Fabrizio Romano/top journalists=40, verified journalist=30, known media outlet=20, unknown/fan=5
- Specificity (25): Named player+fee+clubs=25, named player only=15, vague=5
- Novelty (20): First to report=20, already known=5
- Engagement signal (15): Exclusive=15, widespread=8, minor=3

Input articles:
${JSON.stringify(articles, null, 2)}

Return ONLY a valid JSON array (same order) where each object adds:
- nvs (integer 0-100)
- content_type ("fact" or "rumor")
- nvs_notes (one sentence explaining the score and classification)
No markdown, no explanation outside the JSON.`;
  const response = await callClaude(env, MODEL_SCORE, prompt, false);
  let scored = [];
  try {
    const text = extractText(response.content);
    const clean = text.replace(/```json|```/gi, '').trim();
    scored = JSON.parse(clean);
    if (!Array.isArray(scored)) scored = articles.map(a => ({ ...a, nvs: 50 }));
  } catch (e) {
    // Fallback: assign neutral score
    scored = articles.map(a => ({ ...a, nvs: 50, nvs_notes: 'Scoring failed, defaulted' }));
  }
  return { scored, usage: response.usage };
}
// ─── CLAUDE API CALL ─────────────────────────────────────────
async function callClaude(env, model, prompt, useWebSearch) {
  const body = {
    model,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }
  return response.json();
}
// ─── SUPABASE HELPERS ─────────────────────────────────────────
async function getActiveSites(env) {
  const res = await supabase(env, 'GET', '/rest/v1/sites?status=eq.live&select=*');
  return res || [];
}
async function saveArticles(env, siteId, articles, status) {
  const rows = articles.map(a => ({
    site_id:      siteId,
    source_type:  'rss',
    source_name:  a.source || 'Unknown',
    original_url: a.url || null,
    title:        a.title,
    summary:      a.summary,
    raw_body:     a.full_body || null,
    category:     a.category || 'Club',
    language:     a.language || 'tr',
    nvs_score:    a.nvs || 0,
    nvs_notes:    a.nvs_notes || null,
    content_hash: simpleHash(a.title + a.summary),
    status,
    reviewed_by:  status === 'published' ? 'auto' : null,
    reviewed_at:  status === 'published' ? new Date().toISOString() : null,
  }));
  await supabase(env, 'POST', '/rest/v1/content_items', rows, {
    'Prefer': 'resolution=ignore-duplicates'
  });
}
async function logFetch(env, siteId, status, stats, errorMsg) {
  const row = {
    site_id:            siteId,
    trigger_type:       'cron',
    status,
    items_fetched:      stats.fetched    || 0,
    items_scored:       stats.fetched    || 0,
    items_published:    stats.published  || 0,
    items_queued:       stats.queued     || 0,
    items_rejected:     stats.rejected   || 0,
    claude_calls:       stats.claudeCalls || 0,
    tokens_input:       stats.tokensIn   || 0,
    tokens_output:      stats.tokensOut  || 0,
    estimated_cost_eur: stats.costEur    || 0,
    model_used:         `${MODEL_FETCH}+${MODEL_SCORE}`,
    error_message:      errorMsg || null,
    duration_ms:        stats.durationMs || null,
  };
  await supabase(env, 'POST', '/rest/v1/fetch_logs', row);
}
async function supabase(env, method, path, body, extraHeaders = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    console.error(`Supabase ${method} ${path} failed:`, await res.text());
    return null;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
// ─── KV CACHE HELPERS ────────────────────────────────────────
async function getCachedArticles(env, siteCode) {
  const cached = await env.PITCHOS_CACHE.get(`articles:${siteCode}`);
  return cached ? JSON.parse(cached) : [];
}
function mergeAndDedupe(articles, limit) {
  const seen = new Set();
  return articles
    .filter(a => {
      const hash = simpleHash(a.title);
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    })
    .sort((a, b) => (b.nvs || 0) - (a.nvs || 0))
    .slice(0, limit);
}
// ─── UTILITIES ───────────────────────────────────────────────
function extractText(content = []) {
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}
function addUsage(stats, usage, model) {
  if (!usage) return;
  const rates = COST[model] || { input: 3, output: 15 };
  stats.tokensIn  += usage.input_tokens  || 0;
  stats.tokensOut += usage.output_tokens || 0;
  stats.costEur   += ((usage.input_tokens  / 1_000_000) * rates.input) +
                     ((usage.output_tokens / 1_000_000) * rates.output);
}
function isTodayArticle(timeAgo = '') {
  const s = timeAgo.toLowerCase();
  // Exclude anything explicitly yesterday or older
  if (s.includes('dün') || s.includes('gün önce') || s.includes('hafta') || s.includes('ay')) return false;
  return true;
}
function simpleHash(str) {
  str = String(str || '');
  let h = 0;
  for (const c of str) h = Math.imul(31, h) + c.charCodeAt(0) | 0;
  return Math.abs(h).toString(36);
}
