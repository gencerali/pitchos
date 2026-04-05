
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
    fetched: 0, published: 0, queued: 0, rejected: 0, skipped_seen: 0,
    claudeCalls: 0,
    scout_tokens_in: 0, scout_tokens_out: 0, scout_cost_eur: 0,
    write_tokens_in: 0, write_tokens_out: 0, write_cost_eur: 0,
    tokensIn: 0, tokensOut: 0, costEur: 0,
  };

  // ── FETCH (RSS + web search + beIN in parallel) ──────────────
  const [rssArticles, { articles: webArticles, usage: fetchUsage }, { articles: beINArticles, usage: beINUsage }] = await Promise.all([
    fetchRSSArticles(site),
    fetchArticles(site, env),
    fetchBeIN(site, env),
  ]);
  stats.claudeCalls += 2; // web search + beIN
  addUsagePhase(stats, fetchUsage, MODEL_FETCH, 'scout');
  addUsagePhase(stats, beINUsage, MODEL_FETCH, 'scout');

  // ── PRE-FILTER (pure JS, zero Claude calls) ──────────────────
  const seenHashes = await getSeenHashes(env, site.short_code);
  const allFetched = [...rssArticles, ...webArticles, ...beINArticles];
  const preFiltered = preFilter(allFetched, seenHashes);
  stats.fetched      = preFiltered.length;
  stats.skipped_seen = allFetched.length - dedupeByTitle(allFetched).length;
  console.log(`${site.short_code}: ${rssArticles.length} RSS + ${webArticles.length} web + ${beINArticles.length} beIN → ${preFiltered.length} after pre-filter`);

  if (preFiltered.length === 0) {
    await logFetch(env, site.id, 'partial', stats, 'No articles after pre-filter');
    return stats;
  }

  // ── SCOUT PHASE (Haiku, title+source+trust_tier+sport only) ──
  await sleep(500); // brief pause before scoring
  const { scored, usage: scoreUsage } = await scoreArticles(preFiltered, site, env);
  const mergedScored = preFiltered.map((orig, i) => ({
    ...orig,
    nvs:          scored[i]?.nvs          || 50,
    content_type: scored[i]?.content_type || 'unknown',
    nvs_notes:    scored[i]?.nvs_notes    || '',
    golden_score: scored[i]?.golden_score || null,
  }));
  stats.claudeCalls++;
  addUsagePhase(stats, scoreUsage, MODEL_SCORE, 'scout');

  // Top 8 by NVS
  const top8 = mergedScored.sort((a, b) => (b.nvs || 0) - (a.nvs || 0)).slice(0, 8);
  stats.rejected = mergedScored.slice(8).length;
  console.log(`${site.short_code}: top 8 → NVS ${top8.map(a => a.nvs).join(', ')}`);

  // ── DEEP DIVE (top 3, free fetch) ────────────────────────────
  const top3 = top8.slice(0, 3);
  for (let i = 0; i < top3.length; i++) {
    if (i > 0) await sleep(500);
    // Duhuliye articles already have full_text from RSS content:encoded — no extra fetch
    if (top3[i].full_text && top3[i].full_text.length > 200) {
      console.log(`Deep dive [${i+1}]: using cached full_text (${top3[i].full_text.length} chars)`);
    } else if (top3[i].url && top3[i].url !== '#') {
      const fetched = await fetchFullArticle(top3[i].url);
      if (fetched) {
        top3[i] = { ...top3[i], full_text: fetched };
        console.log(`Deep dive [${i+1}]: fetched ${fetched.length} chars from ${top3[i].url}`);
      }
    }
  }

  // ── WRITE PHASE ───────────────────────────────────────────────
  // Top 3: Sonnet with full text
  const { written: writtenTop, usage: writeTopUsage } =
    await writeArticles(top3, site, env, MODEL_SUMMARY, true);
  stats.claudeCalls += writtenTop.length;
  addUsagePhase(stats, writeTopUsage, MODEL_SUMMARY, 'write');

  // Ranks 4–8: Haiku with summary only
  const remainder = top8.slice(3);
  const { written: writtenRem, usage: writeRemUsage } =
    await writeArticles(remainder, site, env, MODEL_FETCH, false);
  stats.claudeCalls += writtenRem.length;
  addUsagePhase(stats, writeRemUsage, MODEL_FETCH, 'write');

  console.log(`Write phase: scout ${stats.scout_tokens_in}in/${stats.scout_tokens_out}out, write ${stats.write_tokens_in}in/${stats.write_tokens_out}out, total €${stats.costEur.toFixed(4)}`);

  const allWritten = [...writtenTop, ...writtenRem];

  // Route by NVS
  const toPublish = allWritten.filter(a => a.nvs >= site.auto_publish_threshold);
  const toQueue   = allWritten.filter(a => a.nvs >= site.review_threshold && a.nvs < site.auto_publish_threshold);
  stats.published = toPublish.length;
  stats.queued    = toQueue.length;

  // Save to Supabase
  if (toPublish.length > 0) await saveArticles(env, site.id, toPublish, 'published');
  if (toQueue.length > 0)   await saveArticles(env, site.id, toQueue,   'pending');

  // Cache published articles to KV
  const existing = await getCachedArticles(env, site.short_code);
  const mergedKV  = mergeAndDedupe([...toPublish, ...existing], 20);
  await env.PITCHOS_CACHE.put(
    `articles:${site.short_code}`,
    JSON.stringify(mergedKV.map(a => ({
      title:        a.title        || '',
      summary:      a.summary      || '',
      full_body:    a.full_body    || '',
      source:       a.source       || a.source_name || '',
      url:          a.url          || a.original_url || '',
      category:     a.category     || 'Haber',
      nvs:          a.nvs          || a.nvs_score   || 0,
      golden_score: a.golden_score || null,
      time_ago:     a.time_ago     || 'Güncel',
      is_fresh:     a.is_fresh     ?? true,
      sport:        a.sport        || 'football',
    }))),
    { expirationTtl: 7200 }
  );

  // Store processed hashes so next run skips them
  await saveSeenHashes(env, site.short_code, preFiltered);

  await logFetch(env, site.id, 'success', stats);
  stats.durationMs = Date.now() - startTime;
  return stats;
}
// ─── PRE-FILTER (pure JS, zero Claude calls) ─────────────────
const BJK_REGEX = /beşiktaş|besiktas|bjk|kartal|siyah.beyaz/i;
const CUTOFF_48H = 48 * 60 * 60 * 1000;

function preFilter(articles, seenHashes) {
  const cutoff = Date.now() - CUTOFF_48H;
  return dedupeByTitle(articles)
    .filter(a => {
      // 48-hour recency (skip if pubMs known and too old)
      const pubMs = a.published_at ? new Date(a.published_at).getTime() : Date.now();
      if (pubMs < cutoff) return false;
      // Keyword filter
      const haystack = `${a.title} ${a.summary || ''}`;
      if (!BJK_REGEX.test(haystack)) return false;
      // Min 50 chars in summary
      if ((a.summary || '').length < 50) return false;
      // Skip already processed
      const hash = simpleHash(a.title + (a.summary || '').slice(0, 100));
      if (seenHashes.has(hash)) return false;
      return true;
    })
    .sort((a, b) => {
      // Most recent first; missing published_at sorts last
      const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
      const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 20);
}

async function getSeenHashes(env, siteCode) {
  try {
    const raw = await env.PITCHOS_CACHE.get(`seen:${siteCode}`);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

async function saveSeenHashes(env, siteCode, articles) {
  try {
    const existing = await getSeenHashes(env, siteCode);
    for (const a of articles) {
      existing.add(simpleHash(a.title + (a.summary || '').slice(0, 100)));
    }
    // Keep last 100 hashes only
    const trimmed = [...existing].slice(-100);
    await env.PITCHOS_CACHE.put(`seen:${siteCode}`, JSON.stringify(trimmed), { expirationTtl: 172800 }); // 48h
  } catch (e) {
    console.error('saveSeenHashes failed:', e.message);
  }
}

// ─── FETCH ARTICLES via RSS ──────────────────────────────────
// trust values: official, broadcast, press, journalist, international, aggregator
// titleOnly: only check title for keyword match (international sources)
// ntvFallback: HTML fallback URL if RSS returns 0 items
const RSS_FEEDS = [
  { url: 'https://nitter.privacydev.net/Besiktas/rss',     name: 'Beşiktaş JK Resmi', trust: 'official',      sport: 'football' },
  { url: 'https://www.ntvspor.net/rss/kategori/futbol',    name: 'NTV Spor',           trust: 'broadcast',     sport: 'football', ntvFallback: 'https://www.ntvspor.net/futbol/takim/besiktas' },
  { url: 'https://www.fotomac.com.tr/rss/Besiktas.xml',    name: 'Fotomaç',            trust: 'press',         sport: 'football' },
  { url: 'https://www.fotomac.com.tr/rss/Basketbol.xml',   name: 'Fotomaç Basketbol',  trust: 'press',         sport: 'basketball' },
  { url: 'https://www.ahaber.com.tr/rss/besiktas.xml',     name: 'A Haber',            trust: 'press',         sport: 'football' },
  { url: 'https://www.trthaber.com/spor_articles.rss',     name: 'TRT Haber',          trust: 'broadcast',     sport: 'football' },
  { url: 'https://www.aspor.com.tr/rss/anasayfa.xml',      name: 'A Spor',             trust: 'broadcast',     sport: 'football' },
  { url: 'https://www.hurriyet.com.tr/rss/spor',           name: 'Hürriyet',           trust: 'press',         sport: 'football' },
  { url: 'https://nitter.privacydev.net/firatgunayer/rss',  name: 'Fırat Günayer',      trust: 'journalist',    sport: 'football', titleOnly: true },
  { url: 'https://nitter.privacydev.net/FabrizioRomano/rss', name: 'Fabrizio Romano',  trust: 'journalist',    sport: 'football', titleOnly: true },
  { url: 'https://www.transfermarkt.com/rss/news',         name: 'Transfermarkt',      trust: 'international', sport: 'football', titleOnly: true },
  { url: 'https://www.skysports.com/rss/12040',            name: 'Sky Sports',         trust: 'international', sport: 'football', titleOnly: true },
];

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

async function fetchOneFeed(feed, site) {
  const sourceName = feed.name || feed.source;
  const trustTier  = feed.trust || feed.trust_tier || 'unknown';
  const feedSport  = feed.sport || 'football';
  const titleOnly  = feed.titleOnly || false;

  let res;
  try {
    res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PitchOS/1.0)' }, cf: { cacheTtl: 300 } });
  } catch (e) {
    console.error(`RSS [${sourceName}]: fetch error ${e.message}`);
    return feed.ntvFallback ? fetchNTVSporFromHTML(feed.ntvFallback, sourceName) : [];
  }
  if (!res.ok) {
    console.error(`RSS [${sourceName}]: HTTP ${res.status}`);
    return feed.ntvFallback ? fetchNTVSporFromHTML(feed.ntvFallback, sourceName) : [];
  }
  const xml = await res.text();
  const cutoff = Date.now() - CUTOFF_48H;
  const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  console.log(`RSS [${sourceName}]: ${items.length} total items in feed`);

  // NTV Spor fallback if RSS is empty
  if (items.length === 0 && feed.ntvFallback) {
    return fetchNTVSporFromHTML(feed.ntvFallback, sourceName);
  }

  let recentCount = 0;
  const articles = [];

  for (const item of items) {
    const title        = stripCDATA(getTag(item, 'title'));
    const rawDesc      = stripCDATA(getTag(item, 'description'));
    const rawContent   = stripCDATA(getTagNS(item, 'content:encoded') || getTagNS(item, 'content'));
    const url_         = getRSSLink(item) || getTag(item, 'guid') || '';
    const pubDate      = getTag(item, 'pubDate') || getTag(item, 'dc:date') || getTag(item, 'updated');
    let published_at = null, pubMs = 0;
    if (pubDate) {
      const d = new Date(pubDate);
      if (!isNaN(d.getTime())) { published_at = d.toISOString(); pubMs = d.getTime(); }
    }
    const image_url    = getEnclosureUrl(item);

    if (pubMs && pubMs < cutoff) continue;
    recentCount++;

    // titleOnly sources: strict title-only keyword match
    const haystack = titleOnly
      ? title.toLowerCase()
      : (title + ' ' + rawDesc + ' ' + rawContent).toLowerCase();
    if (!BJK_REGEX.test(haystack)) continue;

    const summary   = stripHTML(rawDesc).slice(0, 500) || title;
    const full_text = rawContent
      ? rawContent.split(/<br\s*\/?>|<\/p>/i)
          .map(p => stripHTML(p).trim())
          .filter(p => p.length > 20)
          .join('\n\n')
          .slice(0, 3000)
      : summary;

    // Detect aggregated source (e.g. aggregator republishes with credit line)
    let original_source = null;
    if (trustTier === 'aggregator') {
      const srcMatch = rawContent.match(/(?:Haber kaynağı|Kaynak)\s*[:\-]\s*([^\n<]{2,60})/i);
      if (srcMatch) original_source = srcMatch[1].trim();
    }

    // Sport detection (override feed default if haystack signals another sport)
    let sport = feedSport;
    if (feedSport === 'football') {
      if (/basketbol|basket\b/i.test(haystack)) sport = 'basketball';
      else if (/voleybol/i.test(haystack))       sport = 'volleyball';
    }

    articles.push({
      title,
      summary,
      full_text,
      source:          sourceName,
      original_source,
      url:             url_,
      image_url,
      category:        'Club',
      time_ago:        pubMs ? relativeTime(pubMs) : 'Güncel',
      published_at,
      is_fresh:        true,
      trust_tier:      trustTier,
      sport,
    });
  }

  console.log(`RSS [${sourceName}]: ${recentCount} within 48h, ${articles.length} passed keyword filter`);
  return articles;
}

async function fetchNTVSporFromHTML(fallbackUrl, sourceName) {
  try {
    const res = await fetch(fallbackUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PitchOS/1.0)' },
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const articles = [];
    const seen = new Set();
    // Extract article links with titles from the page
    const re = /href="(https?:\/\/www\.ntvspor\.net\/[^"]{10,120})"[^>]*>([^<]{20,150})/gi;
    let m;
    while ((m = re.exec(html)) !== null && articles.length < 8) {
      const url = m[1];
      const title = stripHTML(m[2]).trim();
      if (title.length < 20 || seen.has(url)) continue;
      seen.add(url);
      if (!BJK_REGEX.test(title)) continue;
      articles.push({
        title,
        summary: title,
        url,
        source:     sourceName,
        trust_tier: 'broadcast',
        sport:      'football',
        is_fresh:   true,
        time_ago:   'Güncel',
        published_at: null,
      });
    }
    console.log(`RSS [${sourceName}] HTML fallback: ${articles.length} articles`);
    return articles;
  } catch (e) {
    console.error(`NTV Spor HTML fallback failed: ${e.message}`);
    return [];
  }
}

// ─── FETCH beIN SPORTS via Claude web search ──────────────────
async function fetchBeIN(site, env) {
  const prompt = `Search "site:beinsports.com.tr beşiktaş" for the latest Beşiktaş news from beIN Sports Turkey. Return ONLY a JSON array (no other text):
[{"title":"...","url":"...","summary":"...","published_at":"ISO date or null"}]
Maximum 5 results. Only include items directly about Beşiktaş.`;

  let searchResponse;
  try {
    searchResponse = await callClaude(env, MODEL_FETCH, prompt, true, 600);
  } catch (e) {
    console.error('fetchBeIN search failed:', e.message);
    return { articles: [], usage: null };
  }

  const allText = searchResponse.content.map(b => b.type === 'text' ? b.text : '').join(' ');
  const match = allText.match(/\[[\s\S]*?\]/);
  if (!match) return { articles: [], usage: searchResponse.usage };

  try {
    const raw = JSON.parse(match[0]);
    const articles = (Array.isArray(raw) ? raw : []).filter(a => a.title).map(a => ({
      title:        a.title,
      summary:      a.summary || a.title,
      url:          a.url || '',
      source:       'beIN Sports',
      trust_tier:   'broadcast',
      sport:        'football',
      published_at: a.published_at || null,
      time_ago:     a.published_at ? relativeTime(new Date(a.published_at).getTime()) : 'Güncel',
      is_fresh:     true,
    }));
    console.log(`beIN Sports: ${articles.length} articles`);
    return { articles, usage: searchResponse.usage };
  } catch (e) {
    console.error('fetchBeIN parse failed:', e.message);
    return { articles: [], usage: searchResponse.usage };
  }
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
${allText.slice(0, 1500)}`;

  let formatResponse;
  try {
    formatResponse = await callClaude(env, MODEL_FETCH, formatPrompt, false, 600);
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
// ─── FETCH FULL ARTICLE TEXT ──────────────────────────────────
async function fetchFullArticle(url) {
  if (!url || url === '#' || url === '') return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PitchOS/1.0)' },
      cf: { cacheTtl: 3600 },
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Prefer <article> block, fall back to all <p> tags
    const articleBlock = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const source = articleBlock ? articleBlock[1] : html;
    const paragraphs = [...source.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => stripHTML(m[1]).trim())
      .filter(p => p.length > 40);
    return paragraphs.join('\n\n').slice(0, 3000) || null;
  } catch (e) {
    console.error(`fetchFullArticle failed for ${url}:`, e.message);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── WRITE FULL TURKISH ARTICLES ─────────────────────────────
// model: MODEL_SUMMARY (Sonnet) for top 3, MODEL_FETCH (Haiku) for 4-8
// useFullText: true = include full_text in context, false = summary only
async function writeArticles(articles, site, env, model = MODEL_SUMMARY, useFullText = false) {
  if (articles.length === 0) return { written: [], usage: null };

  const groups = [];
  for (const a of articles) {
    const norm = normalizeTitle(a.title);
    const existing = groups.find(g => titleSimilarity(norm, normalizeTitle(g[0].title)) > 0.4);
    if (existing) existing.push(a);
    else groups.push([a]);
  }
  console.log(`writeArticles (model=${model.includes('sonnet') ? 'sonnet' : 'haiku'}, fullText=${useFullText}): ${groups.length} groups`);

  const results = await Promise.allSettled(
    groups.map(group => writeOneArticle(group, site, env, model, useFullText))
  );

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

async function writeOneArticle(group, site, env, model, useFullText) {
  const lead = group.reduce((best, a) => (a.nvs || 0) > (best.nvs || 0) ? a : best, group[0]);

  const context = group.map(a => {
    const content = useFullText && a.full_text
      ? a.full_text.slice(0, 2000)
      : (a.summary || '').slice(0, 400);
    return `KAYNAK: ${a.source}\nBAŞLIK: ${a.title}\nİÇERİK: ${content}`;
  }).join('\n\n---\n\n');

  const prompt = `Sen ${site.team_name} için profesyonel bir spor gazetecisisin. Aşağıdaki kaynakları kullanarak kısa Türkçe haber yaz (maksimum 120 kelime).

${context}

Sadece ham JSON döndür (başka metin yok):
{"headline":"başlık","body":"giriş\\n\\ngelişme\\n\\nsonuç","sources":["kaynak"],"category":"${lead.category || 'Club'}","nvs_score":${lead.nvs || 50}}`;

  const writeTokens = model.includes('sonnet') ? 1000 : 500;
  const response = await callClaude(env, model, prompt, false, writeTokens);
  const text = extractText(response.content);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in writeOneArticle response');

  const parsed = JSON.parse(match[0]);
  return {
    article: {
      ...lead,
      title:        parsed.headline || lead.title,
      summary:      (parsed.body || '').split('\n\n')[0] || lead.summary,
      full_body:    parsed.body    || '',
      source:       (parsed.sources || [lead.source]).join(', '),
      category:     parsed.category || lead.category,
      nvs:          parsed.nvs_score ?? lead.nvs,
      golden_score: lead.golden_score,
    },
    usage: response.usage,
  };
}

// ─── SCORE ARTICLES (batch NVS) ──────────────────────────────
async function scoreArticles(articles, site, env) {
  const slim = articles.map(a => ({
    t: (a.title || '').slice(0, 100),  // title max 100 chars
    s: a.source,
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
    // Fallback: assign neutral score
    scored = articles.map(a => ({ ...a, nvs: 50, nvs_notes: 'Scoring failed, defaulted' }));
  }
  return { scored, usage: response.usage };
}
// ─── CLAUDE API CALL ─────────────────────────────────────────
async function callClaude(env, model, prompt, useWebSearch, maxTokens = 1000) {
  const body = {
    model,
    max_tokens: maxTokens,
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
  console.log(`logFetch [${status}] scout: ${stats.scout_tokens_in}in €${(stats.scout_cost_eur||0).toFixed(4)} | write: ${stats.write_tokens_in}in €${(stats.write_cost_eur||0).toFixed(4)} | total €${(stats.costEur||0).toFixed(4)}`);
  const row = {
    site_id:            siteId,
    trigger_type:       'cron',
    status,
    items_fetched:      stats.fetched      || 0,
    items_scored:       stats.fetched      || 0,
    items_published:    stats.published    || 0,
    items_queued:       stats.queued       || 0,
    items_rejected:     stats.rejected     || 0,
    claude_calls:       stats.claudeCalls  || 0,
    tokens_input:       stats.tokensIn     || 0,
    tokens_output:      stats.tokensOut    || 0,
    estimated_cost_eur: stats.costEur      || 0,
    model_used:         `${MODEL_FETCH}+${MODEL_SCORE}+${MODEL_SUMMARY}`,
    error_message:      errorMsg || null,
    duration_ms:        stats.durationMs   || null,
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

function addUsagePhase(stats, usage, model, phase) {
  if (!usage) return;
  addUsage(stats, usage, model);
  const rates = COST[model] || { input: 3, output: 15 };
  const cost = ((usage.input_tokens  / 1_000_000) * rates.input) +
               ((usage.output_tokens / 1_000_000) * rates.output);
  if (phase === 'scout') {
    stats.scout_tokens_in  += usage.input_tokens  || 0;
    stats.scout_tokens_out += usage.output_tokens || 0;
    stats.scout_cost_eur   += cost;
  } else if (phase === 'write') {
    stats.write_tokens_in  += usage.input_tokens  || 0;
    stats.write_tokens_out += usage.output_tokens || 0;
    stats.write_cost_eur   += cost;
  }
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
