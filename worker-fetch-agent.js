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
import { getActiveSites, addUsagePhase, sleep, isTodayArticle, supabase, MODEL_FETCH, MODEL_SCORE, MODEL_SUMMARY } from './src/utils.js';
import { fetchRSSArticles, fetchArticles, fetchBeIN, fetchTwitterSources, fetchFullArticle } from './src/fetcher.js';
import { preFilter, dedupeByTitle, scoreArticles, getSeenHashes, saveSeenHashes } from './src/processor.js';
import { writeArticles, saveArticles, cacheToKV, getCachedArticles, logFetch } from './src/publisher.js';

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
    if (url.pathname === '/debug') {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/sites?status=eq.live&select=*`, {
        headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` },
      });
      return new Response(await res.text(), { headers: { 'Content-Type': 'application/json' } });
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
    fetched: 0, published: 0, queued: 0, rejected: 0, skipped_seen: 0,
    claudeCalls: 0,
    scout_tokens_in: 0, scout_tokens_out: 0, scout_cost_eur: 0,
    write_tokens_in: 0, write_tokens_out: 0, write_cost_eur: 0,
    tokensIn: 0, tokensOut: 0, costEur: 0,
  };

  // ── FETCH (RSS + web search + beIN + Twitter in parallel) ────
  const [rssArticles, { articles: webArticles, usage: fetchUsage }, { articles: beINArticles, usage: beINUsage }, { articles: twitterArticles, usage: twitterUsage }] = await Promise.all([
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
  const allFetched  = [...rssArticles, ...webArticles, ...beINArticles, ...twitterArticles];
  const preFiltered = preFilter(allFetched, seenHashes);
  stats.fetched      = preFiltered.length;
  stats.skipped_seen = allFetched.length - dedupeByTitle(allFetched).length;
  console.log(`${site.short_code}: ${rssArticles.length} RSS + ${webArticles.length} web + ${beINArticles.length} beIN + ${twitterArticles.length} twitter → ${preFiltered.length} after pre-filter`);

  if (preFiltered.length === 0) {
    await logFetch(env, site.id, 'partial', stats, 'No articles after pre-filter');
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

  const top8 = mergedScored.sort((a, b) => (b.nvs || 0) - (a.nvs || 0)).slice(0, 8);
  stats.rejected = mergedScored.slice(8).length;
  console.log(`${site.short_code}: top 8 → NVS ${top8.map(a => a.nvs).join(', ')}`);

  // ── DEEP DIVE (top 3) ─────────────────────────────────────────
  const top3 = top8.slice(0, 3);
  for (let i = 0; i < top3.length; i++) {
    if (i > 0) await sleep(500);
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
  const { written: writtenTop, usage: writeTopUsage } = await writeArticles(top3, site, env, MODEL_SUMMARY, true);
  stats.claudeCalls += writtenTop.length;
  addUsagePhase(stats, writeTopUsage, MODEL_SUMMARY, 'write');

  const remainder = top8.slice(3);
  const { written: writtenRem, usage: writeRemUsage } = await writeArticles(remainder, site, env, MODEL_FETCH, false);
  stats.claudeCalls += writtenRem.length;
  addUsagePhase(stats, writeRemUsage, MODEL_FETCH, 'write');

  console.log(`Write phase: scout ${stats.scout_tokens_in}in/${stats.scout_tokens_out}out, write ${stats.write_tokens_in}in/${stats.write_tokens_out}out, total €${stats.costEur.toFixed(4)}`);

  const allWritten = [...writtenTop, ...writtenRem];

  // ── ROUTE & SAVE ──────────────────────────────────────────────
  const publishThreshold = Math.min(site.auto_publish_threshold, 30);
  const toPublish = allWritten.filter(a => a.nvs >= publishThreshold);
  const toQueue   = allWritten.filter(a => a.nvs >= site.review_threshold && a.nvs < publishThreshold);
  stats.published = toPublish.length;
  stats.queued    = toQueue.length;

  if (toPublish.length > 0) await saveArticles(env, site.id, toPublish, 'published');
  if (toQueue.length > 0)   await saveArticles(env, site.id, toQueue,   'pending');

  await cacheToKV(env, site, toPublish, toQueue);
  await saveSeenHashes(env, site.short_code, preFiltered);
  await logFetch(env, site.id, 'success', stats);

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

  return {
    funnel: {
      total_fetched: lastRun.items_fetched || 0,
      after_date_filter: lastRun.items_fetched || 0,
      after_keyword_filter: lastRun.items_fetched || 0,
      after_hash_dedup: lastRun.items_fetched || 0,
      after_title_dedup: lastRun.items_scored || 0,
      auto_published: lastRun.items_published || 0,
      queued_for_review: lastRun.items_queued || 0,
      rejected: lastRun.items_rejected || 0,
      final_in_cache: cached.length,
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
