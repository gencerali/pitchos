/**
 * Kartalix — Fetch Agent (Cloudflare Worker)
 * ==========================================
 * Runs every hour via Cron Trigger.
 * For each active site:
 *   1. Fetches latest news via RSS + Claude web search
 *   2. Scores each article with NVS + Golden Score
 *   3. Routes: auto-publish | review queue | discard
 *   4. Caches articles to KV (fan site reads from here)
 *   5. Logs cost + results to Supabase
 */
import { getActiveSites, addUsagePhase, sleep, isTodayArticle, supabase, MODEL_FETCH, MODEL_SCORE } from './src/utils.js';
import { fetchRSSArticles, fetchArticles, fetchBeIN, fetchTwitterSources, RSS_FEEDS } from './src/fetcher.js';
import { preFilter, dedupeByTitle, scoreArticles, getSeenHashes, saveSeenHashes } from './src/processor.js';
import { writeArticles, saveArticles, cacheToKV, getCachedArticles, logFetch, mergeAndDedupe } from './src/publisher.js';

// ─── MAIN ENTRY POINT ────────────────────────────────────────
export default {
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
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' },
      });
    }
    if (url.pathname === '/report') {
      const report = await buildReport(env);
      return new Response(JSON.stringify(report), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }
    if (url.pathname === '/clear-cache') {
      await Promise.all([
        env.PITCHOS_CACHE.delete('articles:BJK'),
        env.PITCHOS_CACHE.delete('seen:BJK'),
      ]);
      return Response.json({ cleared: ['articles:BJK', 'seen:BJK'] });
    }
    if (url.pathname === '/debug') {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/sites?status=eq.live&select=*`, {
        headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` },
      });
      return new Response(await res.text(), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/debug-dates') {
      const results = [];
      const feedsToCheck = [
        'https://www.ahaber.com.tr/rss/besiktas.xml',
        'https://www.trthaber.com/spor_articles.rss',
        'https://www.ntvspor.net/rss/kategori/futbol',
      ];

      for (const feedUrl of feedsToCheck) {
        try {
          const res = await fetch(feedUrl, { signal: AbortSignal.timeout(8000) });
          const text = await res.text();
          const items = text.match(/<item[\s\S]*?<\/item>/g)
                     || text.match(/<entry[\s\S]*?<\/entry>/g)
                     || [];

          const sample = items.slice(0, 5).map(item => {
            const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i)
                            || item.match(/<title>([^<]+)<\/title>/i);
            const dateMatch  = item.match(/<pubDate>([^<]+)<\/pubDate>/i)
                            || item.match(/<published>([^<]+)<\/published>/i)
                            || item.match(/<dc:date>([^<]+)<\/dc:date>/i)
                            || item.match(/<updated>([^<]+)<\/updated>/i);

            const rawDate  = dateMatch?.[1]?.trim() || 'NO DATE FOUND';
            const parsed   = new Date(rawDate);
            const ageHours = isNaN(parsed) ? 'PARSE ERROR' : Math.round((Date.now() - parsed.getTime()) / 3600000) + 'h ago';

            return {
              title:    (titleMatch?.[1] || 'no title').slice(0, 50),
              raw_date: rawDate,
              parsed:   isNaN(parsed) ? 'INVALID' : parsed.toISOString(),
              age:      ageHours,
            };
          });

          results.push({ feed: feedUrl, item_count: items.length, sample });
        } catch (e) {
          results.push({ feed: feedUrl, error: e.message });
        }
      }

      return Response.json(results, {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (url.pathname === '/debug-feeds') {
      const results = [];
      for (const feed of RSS_FEEDS) {
        try {
          if (feed.proxy) {
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(feed.url)}`;
            const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error(`allorigins HTTP ${res.status}`);
            const text = await res.text();
            const items = text.match(/<item[\s\S]*?<\/item>/g) || [];
            const sampleTitles = items.slice(0, 3).map(item => {
              const t = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)?.[1]
                     || item.match(/<title>([^<]+)<\/title>/i)?.[1] || '';
              return t.trim().slice(0, 60);
            });
            results.push({
              name: feed.name,
              url: feed.url,
              status: items.length > 0 ? 200 : 400,
              format: 'proxy',
              total_items: items.length,
              sample_titles: sampleTitles,
              proxy_message: items.length > 0 ? 'ok' : 'no items parsed',
            });
            continue;
          }
          const res = await fetch(feed.url, { signal: AbortSignal.timeout(8000) });
          const text = await res.text();
          // Count both RSS <item> and Atom <entry> tags
          const rssItems  = (text.match(/<item[\s>]/gi) || []).length;
          const atomItems = (text.match(/<entry[\s>]/gi) || []).length;
          const itemCount = rssItems || atomItems;
          const format    = atomItems > rssItems ? 'atom' : 'rss';
          const titles = [];
          // Try CDATA titles first, then plain text titles
          const cdataTitles = [...text.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/gi)];
          const plainTitles = [...text.matchAll(/<title>([^<]{5,})<\/title>/gi)];
          const allTitles   = cdataTitles.length ? cdataTitles : plainTitles;
          for (const m of allTitles) {
            if (titles.length < 3) titles.push(m[1].trim().slice(0, 60));
          }
          results.push({
            name: feed.name,
            url: feed.url,
            status: res.status,
            format,
            total_items: itemCount,
            sample_titles: titles,
          });
        } catch (e) {
          results.push({ name: feed.name, url: feed.url, error: e.message });
        }
      }
      return Response.json(results, { headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (url.pathname === '/status') {
      const log = await supabase(env, 'GET', '/rest/v1/fetch_logs?select=*&order=created_at.desc&limit=1');
      return Response.json(log?.[0] || { error: 'No fetch logs found' }, { headers: { 'Access-Control-Allow-Origin': '*' } });
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
    return new Response('Kartalix Fetch Agent — OK', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllSites(env));
  },
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
    raw_fetched: 0, after_date: 0, after_keyword: 0, after_hash: 0, after_title: 0,
    scored: 0, published: 0, queued: 0, rejected: 0,
    claudeCalls: 0,
    scout_tokens_in: 0, scout_tokens_out: 0, scout_cost_eur: 0,
    tokensIn: 0, tokensOut: 0, costEur: 0,
  };

  // ── FETCH (RSS + web search + beIN + Twitter in parallel) ────
  const [{ articles: rssArticles, bySource }, { articles: webArticles, usage: fetchUsage }, { articles: beINArticles, usage: beINUsage }, { articles: twitterArticles, usage: twitterUsage }] = await Promise.all([
    fetchRSSArticles(site),
    fetchArticles(site, env),
    fetchBeIN(site, env),
    fetchTwitterSources(site, env),
  ]);
  stats.claudeCalls += 3;
  addUsagePhase(stats, fetchUsage,   MODEL_FETCH, 'scout');
  addUsagePhase(stats, beINUsage,    MODEL_FETCH, 'scout');
  addUsagePhase(stats, twitterUsage, MODEL_FETCH, 'scout');

  // ── PRE-FILTER (pure JS, zero Claude calls) ──────────────────
  const seenHashes = await getSeenHashes(env, site.short_code);
  const allFetched = [...rssArticles, ...webArticles, ...beINArticles, ...twitterArticles];

  const { articles: preFiltered, counts: filterCounts } = preFilter(allFetched, seenHashes);

  const funnelStats = {
    raw_fetched:   allFetched.length,
    after_date:    filterCounts.after_date,
    after_keyword: filterCounts.after_keyword,
    after_hash:    filterCounts.after_hash,
    after_title:   filterCounts.after_title,
    scored:        0,
    by_source:     bySource,
  };

  stats.raw_fetched   = funnelStats.raw_fetched;
  stats.after_title   = funnelStats.after_title;

  console.log(
    `${site.short_code} FUNNEL: ${funnelStats.raw_fetched} raw` +
    ` → ${funnelStats.after_date} date` +
    ` → ${funnelStats.after_keyword} keyword` +
    ` → ${funnelStats.after_hash} hash` +
    ` → ${funnelStats.after_title} title-dedup` +
    ` (RSS:${rssArticles.length} web:${webArticles.length} beIN:${beINArticles.length} twitter:${twitterArticles.length})`
  );

  if (preFiltered.length === 0) {
    await logFetch(env, site.id, 'partial', stats, 'No articles after pre-filter', funnelStats);
    return stats;
  }

  // ── SCOUT PHASE ───────────────────────────────────────────────
  await sleep(500);
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

  const top30 = mergedScored.sort((a, b) => (b.nvs || 0) - (a.nvs || 0)).slice(0, 30);
  stats.scored        = top30.length;
  stats.rejected      = mergedScored.slice(30).length;
  funnelStats.scored  = mergedScored.length;
  console.log(`${site.short_code}: scored ${mergedScored.length} → top 30 NVS: ${top30.map(a => a.nvs).join(', ')}`);

  // ── WRITE PHASE — only top 8 get expensive HTTP fetches ──────
  const top8forWrite = top30.slice(0, 8);
  const allWritten = await writeArticles(top8forWrite, site, env);
  console.log(`Write phase: modes ${allWritten.map(a => a.publish_mode).join(', ')} | scout ${stats.scout_tokens_in}in €${stats.costEur.toFixed(4)}`);

  // ── ROUTE & SAVE ──────────────────────────────────────────────
  const publishThreshold = Math.min(site.auto_publish_threshold, 20);
  const toPublish = allWritten.filter(a => a.nvs >= publishThreshold);
  const toQueue   = allWritten.filter(a => a.nvs >= site.review_threshold && a.nvs < publishThreshold);
  stats.published = toPublish.length;
  stats.queued    = toQueue.length;

  if (toPublish.length > 0) await saveArticles(env, site.id, toPublish, 'published');
  if (toQueue.length > 0)   await saveArticles(env, site.id, toQueue,   'pending');

  // Cache top 30 — merge published + queued + rest of scored, dedupe, map to KV shape
  const existing   = await getCachedArticles(env, site.short_code);
  const allForKV   = mergeAndDedupe([...toPublish, ...toQueue, ...top30.slice(8), ...existing], 30);
  const kvArticles = allForKV.map(a => ({
    title:        a.title        || '',
    summary:      a.summary      || a.description || '',
    full_body:    a.full_body && a.full_body.length > 300
      ? a.full_body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000)
      : (a.summary || a.description || ''),
    source:       a.source       || a.source_name || '',
    url:          a.url          || a.original_url || '',
    category:     a.category     || 'Haber',
    nvs:          a.nvs          || a.nvs_score   || 0,
    golden_score: a.golden_score || null,
    time_ago:     a.time_ago     || 'Güncel',
    is_fresh:     a.is_fresh     ?? true,
    sport:        a.sport        || 'football',
    publish_mode: a.publish_mode || 'rss_summary',
    image_url:    a.image_url    || '',
  }));
  console.log('Calling cacheToKV with', kvArticles.length, 'articles for site', site.short_code);
  await cacheToKV(env, site.short_code, kvArticles);
  await saveSeenHashes(env, site.short_code, toPublish);
  await logFetch(env, site.id, 'success', stats, null, funnelStats);

  stats.durationMs = Date.now() - startTime;
  return stats;
}

// ─── REPORT ──────────────────────────────────────────────────
async function buildReport(env) {
  const [lastRuns, contentItems, cachedRaw] = await Promise.all([
    supabase(env, 'GET', '/rest/v1/fetch_logs?site_id=eq.2b5cfe49-b69a-4143-8323-ca29fff6502e&order=created_at.desc&limit=5&select=*'),
    supabase(env, 'GET', '/rest/v1/content_items?site_id=eq.2b5cfe49-b69a-4143-8323-ca29fff6502e&order=created_at.desc&limit=200&select=id,title,source_name,category,content_type,nvs_score,status,fetched_at,reviewed_at,original_url,nvs_notes'),
    env.PITCHOS_CACHE.get('articles:BJK'),
  ]);

  const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
  const items = contentItems || [];

  const published = items.filter(a => a.status === 'published');
  const pending = items.filter(a => a.status === 'pending');
  const rejected = items.filter(a => a.status === 'rejected');

  const bySource = {};
  items.forEach(a => {
    const s = a.source_name || 'Unknown';
    if (!bySource[s]) bySource[s] = { source_name: s, contributed: 0, published: 0, rejected: 0, nvs_total: 0, last_article_at: null };
    bySource[s].contributed++;
    if (a.status === 'published') bySource[s].published++;
    if (a.status === 'rejected') bySource[s].rejected++;
    bySource[s].nvs_total += (a.nvs_score || 0);
    if (!bySource[s].last_article_at || a.fetched_at > bySource[s].last_article_at) bySource[s].last_article_at = a.fetched_at;
  });
  const by_source = Object.values(bySource).map(s => ({ ...s, avg_nvs: s.contributed > 0 ? Math.round(s.nvs_total / s.contributed) : 0 })).sort((a,b) => b.contributed - a.contributed);

  const byCat = {};
  items.forEach(a => {
    const c = a.category || 'Unknown';
    if (!byCat[c]) byCat[c] = { category: c, count_published: 0, count_rejected: 0, nvs_total: 0, count: 0 };
    byCat[c].count++;
    byCat[c].nvs_total += (a.nvs_score || 0);
    if (a.status === 'published') byCat[c].count_published++;
    if (a.status === 'rejected') byCat[c].count_rejected++;
  });
  const by_category = Object.values(byCat).map(c => ({ ...c, avg_nvs: c.count > 0 ? Math.round(c.nvs_total / c.count) : 0 })).sort((a,b) => b.count_published - a.count_published);

  const byType = {};
  items.forEach(a => {
    const t = a.content_type || 'unknown';
    if (!byType[t]) byType[t] = { content_type: t, count: 0, count_published: 0, nvs_total: 0 };
    byType[t].count++;
    byType[t].nvs_total += (a.nvs_score || 0);
    if (a.status === 'published') byType[t].count_published++;
  });
  const by_content_type = Object.values(byType).map(t => ({ ...t, avg_nvs: t.count > 0 ? Math.round(t.nvs_total / t.count) : 0 }));

  const dist = { nvs_90_100: 0, nvs_70_89: 0, nvs_50_69: 0, nvs_30_49: 0, nvs_0_29: 0 };
  items.forEach(a => {
    const n = a.nvs_score || 0;
    if (n >= 90) dist.nvs_90_100++;
    else if (n >= 70) dist.nvs_70_89++;
    else if (n >= 50) dist.nvs_50_69++;
    else if (n >= 30) dist.nvs_30_49++;
    else dist.nvs_0_29++;
  });

  const lastRun = lastRuns?.[0] || {};
  const lastSuccess = (lastRuns || []).find(r => r.status === 'success');
  let funnelData = {};
  if (lastSuccess?.error_message) {
    try { funnelData = JSON.parse(lastSuccess.error_message); } catch (e) {}
  }

  return {
    funnel: {
      total_fetched:        funnelData.raw_fetched   || lastRun.items_fetched  || 0,
      after_date_filter:    funnelData.after_date    || funnelData.raw_fetched || 0,
      after_keyword_filter: funnelData.after_keyword || funnelData.after_date  || 0,
      after_hash_dedup:     funnelData.after_hash    || funnelData.after_keyword || 0,
      after_title_dedup:    funnelData.after_title   || funnelData.after_hash  || 0,
      after_scoring:        funnelData.scored        || lastRun.items_scored   || 0,
      auto_published:       lastRun.items_published  || 0,
      queued_for_review:    lastRun.items_queued     || 0,
      rejected:             lastRun.items_rejected   || 0,
      final_in_cache:       cached.length,
      by_source:            funnelData.by_source     || {},
    },
    by_source,
    by_category,
    by_content_type,
    scoring_distribution: dist,
    last_runs: lastRuns || [],
    top_published: published.slice(0, 20),
    top_rejected: rejected.slice(0, 10),
    all_fetched: items,
    queued_items: pending,
  };
}
