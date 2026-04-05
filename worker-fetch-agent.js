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
