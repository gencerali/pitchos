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
import { getActiveSites, addUsagePhase, sleep, isTodayArticle, supabase, MODEL_FETCH, MODEL_SCORE, generateSlug } from './src/utils.js';
import { fetchRSSArticles, fetchArticles, fetchBeIN, fetchTwitterSources, RSS_FEEDS } from './src/fetcher.js';
import { preFilter, dedupeByTitle, scoreArticles, getSeenHashes, saveSeenHashes, getSeenUrls, dedupeByStory } from './src/processor.js';
import { writeArticles, saveArticles, cacheToKV, getCachedArticles, logFetch, mergeAndDedupe, generateMatchDayCard, generateMuhtemel11, generateConfirmedLineup } from './src/publisher.js';

// ─── NEXT MATCH CONFIG ────────────────────────────────────────
const NEXT_MATCH = {
  home: true,
  team: 'Beşiktaş',
  team_short: 'BJK',
  opponent: 'Antalyaspor',
  opponent_short: 'Antalyaspor',
  league: 'Trendyol Süper Lig',
  week: 29,
  date: '2026-04-10',
  time: '20:00',
  venue: 'Tüpraş Stadyumu',
  venue_city: 'İstanbul',
  venue_lat: 41.0428,
  venue_lon: 28.9877,
  tv: 'beIN Sports 1',
  match_day: '2026-04-10',
  cup: null,
};

// ─── MAIN ENTRY POINT ────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (url.pathname === '/react') {
      if (request.method !== 'POST') return new Response('POST only', {status:405});
      const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
      const { article_url, reaction, previous } = await request.json();
      if (!article_url) return Response.json({ error: 'invalid' }, { headers });

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const ip_hash = ip.split('.').slice(0,3).join('.') + '.x';

      if (previous) {
        await supabase(env, 'DELETE',
          `/rest/v1/article_reactions?article_url=eq.${encodeURIComponent(article_url)}&ip_hash=eq.${ip_hash}&reaction=eq.${previous}`);
      }

      if (reaction) {
        await supabase(env, 'POST', '/rest/v1/article_reactions', {
          article_url, reaction, ip_hash
        });
      }

      const counts = await supabase(env, 'GET',
        `/rest/v1/article_reactions?article_url=eq.${encodeURIComponent(article_url)}&select=reaction`);
      const likes = (counts||[]).filter(r => r.reaction === 'like').length;
      const dislikes = (counts||[]).filter(r => r.reaction === 'dislike').length;
      return Response.json({ likes, dislikes }, { headers });
    }

    if (url.pathname === '/comment') {
      if (request.method !== 'POST') return new Response('POST only', {status:405});
      const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
      const { article_url, name, surname, comment, honeypot } = await request.json();
      if (honeypot) return Response.json({ error: 'spam' }, { headers });
      if (!article_url || !name?.trim() || !comment?.trim() || comment.length < 3)
        return Response.json({ error: 'invalid' }, { headers });
      if (/https?:\/\//.test(comment))
        return Response.json({ error: 'no links allowed' }, { headers });

      await supabase(env, 'POST', '/rest/v1/article_comments', {
        article_url,
        name: name.trim().slice(0,50),
        surname: (surname||'').trim().slice(0,50),
        comment: comment.trim().slice(0,500),
        approved: true,
      });
      return Response.json({ success: true }, { headers });
    }

    if (url.pathname === '/comments') {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
      const article_url = url.searchParams.get('article_url');
      if (!article_url) return Response.json([], { headers });

      const comments = await supabase(env, 'GET',
        `/rest/v1/article_comments?article_url=eq.${encodeURIComponent(article_url)}&approved=eq.true&order=created_at.desc&limit=50&select=name,surname,comment,created_at`);

      const reactions = await supabase(env, 'GET',
        `/rest/v1/article_reactions?article_url=eq.${encodeURIComponent(article_url)}&select=reaction`);
      const likes = (reactions||[]).filter(r => r.reaction === 'like').length;
      const dislikes = (reactions||[]).filter(r => r.reaction === 'dislike').length;

      return Response.json({ comments: comments||[], likes, dislikes }, { headers });
    }

    if (url.pathname === '/force-cache') {
      try {
        const sites = await getActiveSites(env);
        if (!sites || sites.length === 0) return Response.json({ error: 'No active sites' }, { status: 500 });
        const result = await processSite(sites[0], env, ctx);

        const cached = await env.PITCHOS_CACHE.get('articles:BJK');
        if (cached) {
          const articles = JSON.parse(cached);
          const fixed = articles.map(a => {
            if (a.is_template && !a.published_at) {
              return { ...a, published_at: new Date(Date.now() - 14 * 3600000).toISOString() };
            }
            return a;
          });
          await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(fixed), { expirationTtl: 7200 });
        }

        return Response.json({
          success: true,
          articles: result?.cached || 0,
          message: 'Cache written synchronously',
        });
      } catch(e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }
    if (url.pathname === '/run') {
      ctx.waitUntil(runAllSites(env, ctx));
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
    if (url.pathname === '/update-cache') {
      if (request.method !== 'POST') return new Response('POST only', { status: 405 });
      const articles = await request.json();
      await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(articles), { expirationTtl: 7200 });
      return Response.json({ updated: articles.length });
    }
    if (url.pathname === '/clear-cache') {
      await Promise.all([
        env.PITCHOS_CACHE.delete('articles:BJK'),
        env.PITCHOS_CACHE.delete('seen:BJK'),
      ]);
      return Response.json({ cleared: ['articles:BJK', 'seen:BJK'] });
    }
    if (url.pathname === '/enrich') {
      const cached = await env.PITCHOS_CACHE.get('articles:BJK');
      if (!cached) return Response.json({ error: 'no cache' });
      const articles = JSON.parse(cached);
      const enriched = [];
      for (const article of articles) {
        if (article.url && article.url !== '#') {
          try {
            const proxyUrl = 'https://pitchos-proxy.onrender.com/article?url=' + encodeURIComponent(article.url);
            const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
            if (res.ok) {
              const data = await res.json();
              if (data.content && data.content.length > 200) {
                enriched.push({
                  ...article,
                  full_body: data.content.slice(0, 5000),
                  image_url: data.image_url || article.image_url || '',
                  publish_mode: 'readability',
                });
                console.log('ENRICH OK:', article.title?.slice(0, 40), data.content.length, 'chars');
                continue;
              }
            }
          } catch(e) {
            console.log('ENRICH FAIL:', article.title?.slice(0, 40), e.message);
          }
        }
        enriched.push(article);
      }
      await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(enriched), { expirationTtl: 7200 });
      return Response.json({ enriched: enriched.length, articles: enriched.map(a => ({ title: a.title?.slice(0, 40), mode: a.publish_mode, len: a.full_body?.length || 0 })) });
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
    if (url.pathname === '/test-template') {
      const templateId = url.searchParams.get('id') || '05';
      const cached = await env.PITCHOS_CACHE.get('articles:BJK');
      const articles = cached ? JSON.parse(cached) : [];

      if (templateId === '05') {
        const card = await generateMatchDayCard(NEXT_MATCH, articles, null, env);
        return Response.json({
          template: templateId,
          result: card,
          preview: card.full_body
        }, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
      if (templateId === '08b') {
        const card = await generateMuhtemel11(NEXT_MATCH, articles, null, env);
        if (!card) return Response.json({
          template: templateId, result: null,
          message: 'No muhtemel 11 articles found or confidence too low'
        }, { headers: { 'Access-Control-Allow-Origin': '*' } });
        return Response.json({ template: templateId, result: card, preview: card.full_body },
          { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
      if (templateId === '09') {
        const force = url.searchParams.get('force') === 'true';
        // force=true: use all cached articles (skip 2h recency for testing)
        const articlesForTest = force
          ? articles.map(a => ({ ...a, published_at: new Date().toISOString() }))
          : articles;
        const card = await generateConfirmedLineup(NEXT_MATCH, articlesForTest, null, env);
        if (!card) return Response.json({
          template: templateId, result: null,
          message: force
            ? 'No confirmed lineup found even with force mode (try id=08b for muhtemel)'
            : 'No confirmed lineup articles in last 2h (use ?force=true to bypass recency)'
        }, { headers: { 'Access-Control-Allow-Origin': '*' } });
        return Response.json({ template: templateId, result: card, preview: card.full_body },
          { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
      return Response.json({ error: 'unknown template id' }, { headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (url.pathname === '/rss') {
      return serveRSSFeed(env);
    }
    if (url.pathname === '/sitemap.xml') {
      return serveSitemap(env);
    }
    if (url.pathname.startsWith('/haber/')) {
      const slug = url.pathname.replace('/haber/', '').replace(/\/$/, '');
      return serveArticlePage(slug, env);
    }

    return new Response('Kartalix Fetch Agent — OK', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllSites(env, ctx));
  },
};

// ─── ORCHESTRATOR ────────────────────────────────────────────
async function runAllSites(env, ctx) {
  const sites = await getActiveSites(env);
  console.log('Sites found:', JSON.stringify(sites));
  if (!sites || sites.length === 0) {
    return { processed: 0, error: 'No active sites found in Supabase' };
  }
  const results = [];
  for (const site of sites) {
    try {
      const result = await processSite(site, env, ctx);
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
async function processSite(site, env, ctx) {
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

  const { articles: afterPreFilter, counts: filterCounts } = preFilter(allFetched, seenHashes);

  // ── URL DEDUP against Supabase (permanent, prevents re-scoring) ──
  const seenUrls = await getSeenUrls(env, site.id);
  const preFiltered = afterPreFilter.filter(a => {
    const url = a.url || a.original_url || '';
    if (!url || url === '#') return true;
    return !seenUrls.has(url);
  });

  const funnelStats = {
    raw_fetched:      allFetched.length,
    after_date:       filterCounts.after_date,
    after_keyword:    filterCounts.after_keyword,
    after_hash:       filterCounts.after_hash,
    after_title:      filterCounts.after_title,
    after_url_dedup:  preFiltered.length,
    scored:           0,
    by_source:        bySource,
  };

  stats.raw_fetched   = funnelStats.raw_fetched;
  stats.after_title   = funnelStats.after_title;

  console.log(
    `${site.short_code} FUNNEL: ${funnelStats.raw_fetched} raw` +
    ` → ${funnelStats.after_date} date` +
    ` → ${funnelStats.after_keyword} keyword` +
    ` → ${funnelStats.after_hash} hash` +
    ` → ${funnelStats.after_title} title-dedup` +
    ` → ${funnelStats.after_url_dedup} url-dedup` +
    ` (RSS:${rssArticles.length} web:${webArticles.length} beIN:${beINArticles.length} twitter:${twitterArticles.length})`
  );

  if (preFiltered.length === 0) {
    await logFetch(env, site.id, 'partial', stats, 'No articles after pre-filter', funnelStats);
    return { ...stats, cached: 0 };
  }

  // ── SCORE ARTICLES ────────────────────────────────────────────
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

  const sortedScored = mergedScored.sort((a, b) => (b.nvs || 0) - (a.nvs || 0));
  const storyDeduped = dedupeByStory(sortedScored);
  const top50 = storyDeduped.slice(0, 50);
  stats.scored           = top50.length;
  stats.rejected         = mergedScored.length - storyDeduped.length + (storyDeduped.length > 50 ? storyDeduped.length - 50 : 0);
  funnelStats.scored     = mergedScored.length;
  funnelStats.after_story_dedup = storyDeduped.length;
  console.log(`${site.short_code}: scored ${mergedScored.length} → story-deduped ${storyDeduped.length} → top 50 NVS: ${top50.map(a => a.nvs).join(', ')}`);

  // ── KV SHAPE HELPER ──────────────────────────────────────────
  const toKVShape = a => ({
    title:               a.title        || '',
    summary:             a.summary      || a.description || '',
    full_body:           a.full_body && a.full_body.length > 300
      ? sanitizeBodyHtml(a.full_body).slice(0, 8000)
      : (a.summary || a.description || ''),
    source:              a.source       || a.source_name || '',
    source_name:         a.source_name  || a.source || '',
    source_emoji:        a.source_emoji || '',
    url:                 a.url          || a.original_url || '',
    category:            a.category     || 'Haber',
    nvs:                 a.nvs          || a.nvs_score   || 0,
    golden_score:        a.golden_score || null,
    published_at:        a.published_at || a.fetched_at  || new Date().toISOString(),
    is_fresh:            a.is_fresh     ?? true,
    is_kartalix_content: a.is_kartalix_content || false,
    sport:               a.sport        || 'football',
    publish_mode:        a.publish_mode || 'rss_summary',
    image_url:           a.image_url    || '',
    template_id:         a.template_id  || null,
    slug:                a.slug || generateSlug(a.title, a.published_at || a.fetched_at),
  });

  // ── KV WRITE IMMEDIATELY (before templates, enrichment, Supabase) ──
  const existing = await getCachedArticles(env, site.short_code);
  const immediateKV = mergeAndDedupe([...top50, ...existing], 50).map(toKVShape);
  await cacheToKV(env, site.short_code, immediateKV);
  console.log('KV WRITE IMMEDIATE: done', immediateKV.length, 'articles');

  // ── BACKGROUND WORK: templates + supabase (after KV is safe) ─
  const backgroundWork = async () => {
    // Template 05 — Match Day Card
    try {
      const today = new Date().toISOString().split('T')[0];
      if (NEXT_MATCH.match_day === today && !immediateKV.find(a => a.template_id === '05')) {
        console.log('TEMPLATE 05: generating...');
        const card = await generateMatchDayCard(NEXT_MATCH, preFiltered, site, env);
        if (card) {
          const withT = mergeAndDedupe([toKVShape(card), ...immediateKV], 50);
          await cacheToKV(env, site.short_code, withT);
          console.log('KV WRITE WITH TEMPLATE 05: done');
        }
      }
    } catch(e) { console.error('Template 05 failed:', e.message); }

    // Template 08b & 09 — Lineup Windows
    try {
      const matchDateTime = new Date(`${NEXT_MATCH.date}T${NEXT_MATCH.time}:00+03:00`);
      const hoursToKickoff = (matchDateTime - new Date()) / (1000 * 60 * 60);

      if (hoursToKickoff <= 24 && hoursToKickoff > 3 && !immediateKV.find(a => a.template_id === '08b')) {
        console.log('TEMPLATE 08b: checking for muhtemel 11...');
        const card = await generateMuhtemel11(NEXT_MATCH, preFiltered, site, env);
        if (card) {
          const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
          const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
          await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape(card), ...latest], 50));
          console.log('KV WRITE WITH TEMPLATE 08b: done');
        }
      }

      if (hoursToKickoff <= 2 && hoursToKickoff >= 0 && !immediateKV.find(a => a.template_id === '09')) {
        console.log('TEMPLATE 09: within 2h window, scanning for confirmed lineup...');
        const card = await generateConfirmedLineup(NEXT_MATCH, preFiltered, site, env);
        if (card) {
          const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
          const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
          await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape(card), ...latest], 50));
          console.log('KV WRITE WITH TEMPLATE 09: done');
        }
      }
    } catch(e) { console.error('Template 08b/09 failed:', e.message); }

    // Save to Supabase (best effort)
    try {
      const top50forWrite = top50.slice(0, 50);
      const allWritten = await writeArticles(top50forWrite, site, env);
      console.log(`Write phase: ${allWritten.map(a => a.publish_mode).join(', ')}`);

      const publishThreshold = Math.min(site.auto_publish_threshold, 20);
      const toPublish = allWritten.filter(a => a.nvs >= publishThreshold);
      const toQueue   = allWritten.filter(a => a.nvs >= site.review_threshold && a.nvs < publishThreshold);
      stats.published = toPublish.length;
      stats.queued    = toQueue.length;

      if (toPublish.length > 0) await saveArticles(env, site.id, toPublish, 'published');
      if (toQueue.length > 0)   await saveArticles(env, site.id, toQueue,   'pending');
      await saveSeenHashes(env, site.short_code, toPublish);
    } catch(e) { console.error('Supabase save failed:', e.message); }

    await logFetch(env, site.id, 'success', stats, null, funnelStats);
    stats.durationMs = Date.now() - startTime;
  };

  if (ctx) ctx.waitUntil(backgroundWork());
  else await backgroundWork();

  return { ...stats, cached: immediateKV.length };
}

// ─── REPORT ──────────────────────────────────────────────────
async function buildReport(env) {
  const [lastRuns, contentItems, cachedRaw, publishedCountResult] = await Promise.all([
    supabase(env, 'GET', '/rest/v1/fetch_logs?site_id=eq.2b5cfe49-b69a-4143-8323-ca29fff6502e&order=created_at.desc&limit=5&select=*'),
    supabase(env, 'GET', '/rest/v1/content_items?site_id=eq.2b5cfe49-b69a-4143-8323-ca29fff6502e&order=created_at.desc&limit=200&select=id,title,source_name,category,content_type,nvs_score,status,fetched_at,reviewed_at,original_url,nvs_notes'),
    env.PITCHOS_CACHE.get('articles:BJK'),
    supabase(env, 'GET', '/rest/v1/content_items?site_id=eq.2b5cfe49-b69a-4143-8323-ca29fff6502e&status=eq.published&select=count()'),
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
  // Prefer most-recent run's funnelStats (now saved on both success and partial)
  let funnelData = {};
  for (const run of (lastRuns || [])) {
    if (run.error_message) {
      try { const d = JSON.parse(run.error_message); if (d.raw_fetched) { funnelData = d; break; } } catch (e) {}
    }
  }

  const fd = (key) => funnelData[key] ?? null;

  return {
    funnel: {
      total_fetched:        fd('raw_fetched')      ?? lastRun.items_fetched ?? 0,
      after_date_filter:    fd('after_date')       ?? 0,
      after_keyword_filter: fd('after_keyword')    ?? 0,
      after_hash_dedup:     fd('after_hash')       ?? 0,
      after_title_dedup:    fd('after_title')      ?? 0,
      after_url_dedup:      fd('after_url_dedup')  ?? 0,
      after_scoring:        fd('scored')           ?? lastRun.items_scored ?? 0,
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
    top_published: published.slice(0, 30),
    top_rejected: rejected.slice(0, 10),
    all_fetched: items,
    queued_items: pending,
    published_count: parseInt(publishedCountResult?.[0]?.count || 0),
  };
}

// ─── SPRINT 4: ARTICLE PAGES ─────────────────────────────────

const BASE_URL = 'https://kartalix.com';

async function serveArticlePage(slug, env) {
  const cached = await env.PITCHOS_CACHE.get('articles:BJK');
  const articles = cached ? JSON.parse(cached) : [];

  // Find by slug first, fall back to Supabase
  let article = articles.find(a => a.slug === slug);

  if (!article) {
    const rows = await supabase(env, 'GET',
      `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`);
    if (rows && rows.length > 0) {
      const r = rows[0];
      article = {
        title: r.title, summary: r.summary || '', full_body: r.full_body || '',
        source: r.source_name || '', category: r.category || 'Haber',
        published_at: r.fetched_at, image_url: r.image_url || '',
        nvs: r.nvs_score || 0, url: r.original_url || '#', slug,
      };
    }
  }

  if (!article) {
    return new Response(renderArticleNotFound(slug), {
      status: 404,
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
  }

  return new Response(renderArticleHTML(article), {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public, max-age=900',
    },
  });
}

async function serveRSSFeed(env) {
  const cached = await env.PITCHOS_CACHE.get('articles:BJK');
  const articles = cached ? JSON.parse(cached) : [];
  const items = articles.slice(0, 30).map(a => {
    const url = a.slug ? `${BASE_URL}/haber/${a.slug}` : (a.url && a.url.startsWith('http') ? a.url : BASE_URL);
    const desc = escXml(a.summary || a.full_body?.slice(0, 200) || '');
    return `  <item>
    <title>${escXml(a.title || '')}</title>
    <link>${escXml(url)}</link>
    <guid isPermaLink="true">${escXml(url)}</guid>
    <description>${desc}</description>
    <pubDate>${new Date(a.published_at || Date.now()).toUTCString()}</pubDate>
    <source url="${escXml(BASE_URL)}">${escXml(a.source || 'Kartalix')}</source>
  </item>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Kartalix — Beşiktaş JK Haber Akışı</title>
  <link>${BASE_URL}</link>
  <description>Beşiktaş JK ile ilgili en güncel haberler — Kartalix</description>
  <language>tr</language>
  <atom:link href="${BASE_URL}/rss" rel="self" type="application/rss+xml"/>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml;charset=UTF-8',
      'Cache-Control': 'public, max-age=1800',
    },
  });
}

async function serveSitemap(env) {
  const cached = await env.PITCHOS_CACHE.get('articles:BJK');
  const articles = cached ? JSON.parse(cached) : [];
  const articleUrls = articles
    .filter(a => a.slug)
    .map(a => `  <url>
    <loc>${BASE_URL}/haber/${escXml(a.slug)}</loc>
    <lastmod>${(a.published_at || new Date().toISOString()).slice(0, 10)}</lastmod>
    <changefreq>never</changefreq>
    <news:news>
      <news:publication><news:name>Kartalix</news:name><news:language>tr</news:language></news:publication>
      <news:publication_date>${(a.published_at || new Date().toISOString()).slice(0, 10)}</news:publication_date>
      <news:title>${escXml(a.title || '')}</news:title>
    </news:news>
  </url>`).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url>
    <loc>${BASE_URL}/</loc>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
${articleUrls}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml;charset=UTF-8',
      'Cache-Control': 'public, max-age=1800',
    },
  });
}

// ─── ARTICLE PAGE HTML ────────────────────────────────────────
function renderArticleHTML(a) {
  const slug      = a.slug || '';
  const title     = a.title || 'Haber';
  const desc      = (a.summary || a.full_body || '').replace(/<[^>]+>/g, ' ').slice(0, 200).trim();
  const image     = a.image_url || '';
  const source    = a.source || a.source_name || '';
  const category  = a.category || 'Haber';
  const nvs       = a.nvs || a.nvs_score || 0;
  const pageUrl   = `${BASE_URL}/haber/${slug}`;
  const pubDate   = a.published_at ? new Date(a.published_at) : new Date();
  const dateStr   = pubDate.toLocaleDateString('tr-TR', { day:'numeric', month:'long', year:'numeric' });
  const isoDate   = pubDate.toISOString();
  const srcUrl    = a.url && a.url.startsWith('http') ? a.url : null;

  const bodyText  = a.full_body || a.summary || '';
  const bodyHtml  = bodyText.includes('<') ? bodyText :
    bodyText.split('\n').map(l => l.trim() ? `<p>${escHtml(l)}</p>` : '').join('');

  const waText    = encodeURIComponent(`${title} ${pageUrl}`);
  const twParams  = `text=${encodeURIComponent(title)}&url=${encodeURIComponent(pageUrl)}`;

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: title,
    description: desc,
    url: pageUrl,
    datePublished: isoDate,
    dateModified: isoDate,
    image: image || undefined,
    publisher: { '@type': 'Organization', name: 'Kartalix', url: BASE_URL },
    author: { '@type': 'Organization', name: source || 'Kartalix' },
    inLanguage: 'tr',
    about: { '@type': 'SportsTeam', name: 'Beşiktaş JK' },
  });

  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escHtml(title)} | Kartalix</title>
<meta name="description" content="${escHtml(desc)}"/>
<meta property="og:title" content="${escHtml(title)}"/>
<meta property="og:description" content="${escHtml(desc)}"/>
${image ? `<meta property="og:image" content="${escHtml(image)}"/>` : ''}
<meta property="og:url" content="${escHtml(pageUrl)}"/>
<meta property="og:type" content="article"/>
<meta property="og:site_name" content="Kartalix"/>
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}"/>
<meta name="twitter:title" content="${escHtml(title)}"/>
<meta name="twitter:description" content="${escHtml(desc)}"/>
${image ? `<meta name="twitter:image" content="${escHtml(image)}"/>` : ''}
<link rel="canonical" href="${escHtml(pageUrl)}"/>
<link rel="alternate" type="application/rss+xml" title="Kartalix RSS" href="${BASE_URL}/rss"/>
<script type="application/ld+json">${jsonLd}</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0c0c0c;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:16px;line-height:1.7}
a{color:#E30A17;text-decoration:none}
a:hover{text-decoration:underline}
header{background:#111;border-bottom:1px solid #222;padding:0 1.5rem;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.logo{font-size:1.25rem;font-weight:900;letter-spacing:-0.03em;color:#fff}
.logo span{color:#E30A17}
.back-link{font-size:0.75rem;color:#888;letter-spacing:0.06em}
.back-link:hover{color:#E30A17;text-decoration:none}
main{max-width:720px;margin:0 auto;padding:2rem 1.5rem 4rem}
.cat-tag{display:inline-block;background:#E30A17;color:#fff;font-size:0.6rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;padding:3px 10px;border-radius:2px;margin-bottom:1rem}
h1{font-size:1.65rem;font-weight:800;line-height:1.25;color:#fff;margin-bottom:1rem}
.article-meta{font-size:0.75rem;color:#888;letter-spacing:0.04em;margin-bottom:1.5rem;display:flex;flex-wrap:wrap;gap:0.75rem;align-items:center}
.nvs-pill{background:#1a1a1a;border:1px solid #333;padding:2px 8px;border-radius:10px;font-size:0.65rem}
.article-img{width:100%;max-height:420px;object-fit:cover;border-radius:6px;margin-bottom:1.5rem;display:block}
.article-body{color:#d0cec8;font-size:1rem;line-height:1.8}
.article-body p{margin-bottom:1rem}
.article-body h2{color:#fff;font-size:1.2rem;font-weight:700;margin:2rem 0 0.75rem;line-height:1.3}
.article-body h3{color:#e8e6e0;font-size:1.05rem;font-weight:600;margin:1.5rem 0 0.5rem}
.article-body h4{color:#aaa;font-size:0.95rem;font-weight:600;margin:1.25rem 0 0.4rem}
.article-body img{max-width:100%;height:auto;border-radius:6px;margin:1.25rem 0;display:block}
.article-body figure{margin:1.5rem 0}
.article-body figcaption{font-size:0.8rem;color:#888;margin-top:0.4rem;font-style:italic}
.article-body ul,.article-body ol{padding-left:1.5rem;margin:1rem 0}
.article-body li{margin-bottom:0.5rem}
.article-body a{color:#E30A17}
.article-body blockquote{border-left:3px solid #E30A17;padding:0.75rem 1rem;background:#161616;margin:1.5rem 0;border-radius:0 4px 4px 0;color:#aaa}
.source-attr{font-size:0.75rem;color:#666;margin-top:2rem;padding-top:1rem;border-top:1px solid #222}
.source-link{color:#888;font-size:0.75rem;display:inline-block;margin-top:0.5rem}
.share-box{margin-top:2.5rem;padding:1.5rem;background:#141414;border:1px solid #222;border-radius:6px}
.share-title{font-size:0.7rem;letter-spacing:0.12em;text-transform:uppercase;color:#888;margin-bottom:1rem}
.share-btns{display:flex;gap:0.75rem;flex-wrap:wrap}
.share-btn{display:inline-block;font-size:0.78rem;font-weight:600;padding:9px 18px;border-radius:4px;cursor:pointer;border:none;text-decoration:none;transition:opacity 0.15s}
.share-btn:hover{opacity:0.85;text-decoration:none}
.btn-wa{background:#25D366;color:#fff}
.btn-tw{background:#1DA1F2;color:#fff}
.btn-copy{background:#333;color:#fff}
.home-link{display:inline-block;margin-top:2rem;font-size:0.8rem;color:#888;letter-spacing:0.06em}
.home-link:hover{color:#E30A17;text-decoration:none}
@media(max-width:600px){main{padding:1.5rem 1rem 3rem}h1{font-size:1.35rem}}
</style>
</head>
<body>
<header>
  <a href="/" class="logo">Kartal<span>ix</span></a>
  <a href="/" class="back-link">← Ana Sayfa</a>
</header>
<main>
  <article>
    <div class="cat-tag">${escHtml(category)}</div>
    <h1>${escHtml(title)}</h1>
    <div class="article-meta">
      <span>📰 ${escHtml(source)}</span>
      <time datetime="${isoDate}">${dateStr}</time>
      ${nvs >= 40 ? `<span class="nvs-pill">NVS ${nvs}</span>` : ''}
    </div>
    ${image ? `<img class="article-img" src="${escHtml(image)}" alt="${escHtml(title)}" loading="lazy"/>` : ''}
    <div class="article-body">${bodyHtml}</div>
    <div class="source-attr">Bu içerik <strong>${escHtml(source)}</strong> kaynağından derlendi.
    ${srcUrl ? `<a class="source-link" href="${escHtml(srcUrl)}" target="_blank" rel="noopener">Haberin kaynağına git →</a>` : ''}
    </div>
  </article>
  <div class="share-box">
    <div class="share-title">Bu haberi paylaş</div>
    <div class="share-btns">
      <a class="share-btn btn-wa" href="https://wa.me/?text=${waText}" target="_blank" rel="noopener">WhatsApp</a>
      <a class="share-btn btn-tw" href="https://twitter.com/intent/tweet?${twParams}" target="_blank" rel="noopener">Twitter / X</a>
      <button class="share-btn btn-copy" onclick="copyLink(this)">Linki Kopyala</button>
    </div>
  </div>
  <a href="/" class="home-link">← Kartalix — Tüm Haberler</a>
</main>
<script>
function copyLink(btn){
  navigator.clipboard.writeText(window.location.href).then(()=>{
    btn.textContent='Kopyalandı!';
    setTimeout(()=>btn.textContent='Linki Kopyala',2500);
  });
}
</script>
</body>
</html>`;
}

function renderArticleNotFound(slug) {
  return `<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"/><title>Haber Bulunamadı | Kartalix</title>
<style>body{background:#0c0c0c;color:#888;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:1rem}a{color:#E30A17}</style>
</head><body>
<h2 style="color:#fff">Haber Bulunamadı</h2>
<p>Bu haber artık mevcut değil ya da taşınmış olabilir.</p>
<a href="/">← Ana Sayfaya Dön</a>
</body></html>`;
}

function sanitizeBodyHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/javascript:/gi, '');
}

function escHtml(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function escXml(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
