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
import { getActiveSites, addUsagePhase, addCost, checkCostCap, sleep, isTodayArticle, supabase, callClaude, extractText, MODEL_FETCH, MODEL_SCORE, MODEL_GENERATE, generateSlug, simpleHash, saveEditorialNote, deleteEditorialNote, listEditorialNotes, saveRawFeedback, getRawFeedbacks, markFeedbacksProcessed, deleteRawFeedback, saveReferenceArticle, getReferenceArticles, deleteReferenceArticle } from './src/utils.js';
import { fetchRSSArticles, fetchArticles, fetchBeIN, fetchTwitterSources, fetchBJKOfficial, fetchViaRss2Json, RSS_FEEDS } from './src/fetcher.js';
import { preFilter, dedupeByTitle, scoreArticles, getSeenHashes, saveSeenHashes, getSeenUrls, dedupeByStory, titleSimilarity, normalizeTitle } from './src/processor.js';
import { writeArticles, saveArticles, cacheToKV, getCachedArticles, logFetch, mergeAndDedupe, generateMatchDayCard, generateMuhtemel11, generateConfirmedLineup, generateMatchPreview, generateH2HHistory, generateFormGuide, generateInjuryReport, generateGoalFlash, generateResultFlash, generateManOfTheMatch, generateMatchReport, generateXGDelta, generateRefereeProfile, generateHalftimeReport, generateRedCardFlash, generateVARFlash, generateMissedPenaltyFlash, generateVideoEmbed, generateMatchVideoEmbed, generateOriginalNews } from './src/publisher.js';
import { matchOrCreateStory, getOpenStories, archiveStaleStories } from './src/story-matcher.js';
import { apiFetch, getNextFixture, getLiveFixture, getFixture, getH2H, getFixturePlayers, getFixtureStats, getFixtureEvents, getLastFixtures, getInjuries, getFixtureLineup, getStandings } from './src/api-football.js';
import { YOUTUBE_CHANNELS, fetchYouTubeChannel, qualifyYouTubeVideo, classifyMatchVideo } from './src/youtube.js';

// ─── NEXT MATCH CONFIG ────────────────────────────────────────
const NEXT_MATCH = {
  home: false,
  team: 'Beşiktaş',
  team_short: 'BJK',
  opponent: 'Gaziantep FK',
  opponent_short: 'Gaziantep',
  opponent_id: 3573,
  league: 'Trendyol Süper Lig',
  week: 32,
  date: '2026-05-01',
  time: '20:00',
  venue: 'Gaziantep Stadyumu',
  venue_city: 'Gaziantep',
  venue_lat: 37.0662,
  venue_lon: 37.3833,
  tv: 'beIN Sports 1',
  match_day: '2026-05-01',
  cup: null,
  fixture_id: 1394714,
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
      const { article_url, reaction } = await request.json();
      if (!article_url) return Response.json({ error: 'invalid' }, { headers });
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const ip_hash = ip.split('.').slice(0,3).join('.') + '.x';
      // Delete any existing reaction for this user on this article (idempotent)
      await supabase(env, 'DELETE',
        `/rest/v1/article_reactions?article_url=eq.${encodeURIComponent(article_url)}&ip_hash=eq.${encodeURIComponent(ip_hash)}`);
      if (reaction) {
        await supabase(env, 'POST', '/rest/v1/article_reactions', { article_url, reaction, ip_hash });
      }
      const rows = await supabase(env, 'GET',
        `/rest/v1/article_reactions?article_url=eq.${encodeURIComponent(article_url)}&select=reaction`);
      const likes    = (rows||[]).filter(r => r.reaction === 'like').length;
      const dislikes = (rows||[]).filter(r => r.reaction === 'dislike').length;
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
      if (!article_url) return Response.json({ comments: [], likes: 0, dislikes: 0 }, { headers });
      const [comments, reactions] = await Promise.all([
        supabase(env, 'GET',
          `/rest/v1/article_comments?article_url=eq.${encodeURIComponent(article_url)}&approved=eq.true&order=created_at.desc&limit=50&select=name,surname,comment,created_at`),
        supabase(env, 'GET',
          `/rest/v1/article_reactions?article_url=eq.${encodeURIComponent(article_url)}&select=reaction`),
      ]);
      const likes    = (reactions||[]).filter(r => r.reaction === 'like').length;
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
    if (url.pathname === '/widgets/config') {
      return Response.json(
        { apiKey: env.API_FOOTBALL_KEY || '', league: 203, season: 2025, team: 549 },
        { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://app.kartalix.com', 'Cache-Control': 'private, max-age=3600' } }
      );
    }

    if (url.pathname === '/widgets/bjk-fixtures') {
      const CORS = { 'Access-Control-Allow-Origin': 'https://app.kartalix.com' };
      const cacheKey = 'widget:bjk-fixtures';
      const cached = await env.PITCHOS_CACHE.get(cacheKey);
      if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json', ...CORS } });
      const widgetFetch = async (path) => {
        try {
          const r = await fetch(`https://v3.football.api-sports.io${path}`, {
            headers: { 'x-apisports-key': env.API_FOOTBALL_KEY || '', 'Origin': 'https://app.kartalix.com', 'Referer': 'https://app.kartalix.com/' },
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) return null;
          const d = await r.json();
          if (d.errors && Object.keys(d.errors).length > 0) return null;
          return d.response || null;
        } catch(e) { return null; }
      };
      const [lastRes, nextRes] = await Promise.all([
        widgetFetch(`/fixtures?team=549&season=2025&last=6`),
        widgetFetch(`/fixtures?team=549&season=2025&next=5`),
      ]);
      const shape = f => ({
        id:       f.fixture?.id,
        date:     f.fixture?.date,
        status:   f.fixture?.status?.short,
        league:   f.league?.name,
        round:    f.league?.round,
        home:     { name: f.teams?.home?.name, logo: f.teams?.home?.logo, winner: f.teams?.home?.winner },
        away:     { name: f.teams?.away?.name, logo: f.teams?.away?.logo, winner: f.teams?.away?.winner },
        score:    { home: f.goals?.home, away: f.goals?.away },
      });
      const past   = (lastRes || []).map(shape).reverse();
      const upcoming = (nextRes || []).map(shape);
      const payload = JSON.stringify({ past, upcoming });
      await env.PITCHOS_CACHE.put(cacheKey, payload, { expirationTtl: 3600 });
      return new Response(payload, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    if (url.pathname === '/widgets/bjk-match-stats') {
      const CORS = { 'Access-Control-Allow-Origin': 'https://app.kartalix.com' };
      const fixtureId = url.searchParams.get('fixture');
      if (!fixtureId) return new Response('{}', { headers: { 'Content-Type': 'application/json', ...CORS } });
      const cacheKey = `widget:match-stats:${fixtureId}`;
      const cached = await env.PITCHOS_CACHE.get(cacheKey);
      if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json', ...CORS } });
      const payload = await buildMatchStats(fixtureId, env);
      if (!payload) return new Response('{}', { headers: { 'Content-Type': 'application/json', ...CORS } });
      await env.PITCHOS_CACHE.put(cacheKey, payload, { expirationTtl: 86400 });
      return new Response(payload, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    if (url.pathname === '/widgets/current-match-stats') {
      const CORS = { 'Access-Control-Allow-Origin': 'https://app.kartalix.com' };
      const liveRaw = await env.PITCHOS_CACHE.get('match:BJK:live');
      const liveState = liveRaw ? JSON.parse(liveRaw) : null;
      const fixtureId = liveState?.fixture_id || NEXT_MATCH.fixture_id;
      if (!fixtureId) return new Response('{}', { headers: { 'Content-Type': 'application/json', ...CORS } });
      const cacheKey = `widget:match-stats:${fixtureId}`;
      const cached = await env.PITCHOS_CACHE.get(cacheKey);
      if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json', ...CORS } });
      const payload = await buildMatchStats(fixtureId, env);
      if (!payload) return new Response('{}', { headers: { 'Content-Type': 'application/json', ...CORS } });
      await env.PITCHOS_CACHE.put(cacheKey, payload, { expirationTtl: 86400 });
      return new Response(payload, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // ─── WIDGET API PROXY ─────────────────────────────────────────────────────
    // Caches api-sports widget calls in KV to protect daily quota.
    // Widget config sets data-url-football to this proxy instead of direct API.
    if (url.pathname.startsWith('/widgets/api/')) {
      const corsHeaders = { 'Access-Control-Allow-Origin': 'https://app.kartalix.com' };
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
      }
      const apiPath = url.pathname.replace('/widgets/api', '');
      const cacheKey = `widget:football:${apiPath}${url.search}`;
      const cached = await env.PITCHOS_CACHE.get(cacheKey);
      if (cached) {
        return new Response(cached, { headers: { 'Content-Type': 'application/json', ...corsHeaders, 'X-Cache': 'HIT' } });
      }
      const apiRes = await fetch(`https://v3.football.api-sports.io${apiPath}${url.search}`, {
        headers: {
          'x-apisports-key': env.API_FOOTBALL_KEY || '',
          'Origin':  request.headers.get('Origin')  || 'https://app.kartalix.com',
          'Referer': request.headers.get('Referer') || 'https://app.kartalix.com/',
        }
      });
      const data = await apiRes.text();
      const ttl = apiPath.includes('/standings') ? 3600
               : apiPath.includes('/teams')     ? 86400
               : apiPath.includes('/fixtures')  ? 300
               : 600;
      await env.PITCHOS_CACHE.put(cacheKey, data, { expirationTtl: ttl });
      return new Response(data, { headers: { 'Content-Type': 'application/json', ...corsHeaders, 'X-Cache': 'MISS' } });
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
    if (url.pathname === '/rebuild-cache') {
      // Restores KV display cache after a wipe.
      // Strategy 1: pull from Supabase content_items (any status).
      // Strategy 2: if Supabase is empty, fetch RSS feeds directly, skip url-dedup.
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { status: 500 });

        // Strategy 1 — Supabase
        const rows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${site.id}&order=published_at.desc&limit=100&select=title,summary,full_body,source_name,original_url,category,nvs_score,golden_score,published_at,sport,publish_mode,image_url,slug,content_type`
        );

        if (rows && rows.length > 0) {
          const articles = rows.map(a => ({
            title:               a.title        || '',
            summary:             a.summary      || '',
            full_body:           a.full_body    || a.summary || '',
            source:              a.source_name  || 'Kartalix',
            source_name:         a.source_name  || 'Kartalix',
            source_emoji:        '',
            source_url:          a.original_url || '',
            url:                 a.original_url || '',
            category:            a.category     || 'Haber',
            nvs:                 a.nvs_score    || 0,
            golden_score:        a.golden_score || null,
            published_at:        a.published_at || new Date().toISOString(),
            is_fresh:            true,
            is_kartalix_content: a.content_type === 'kartalix_generated',
            is_p4:               false,
            sport:               a.sport        || 'football',
            publish_mode:        a.publish_mode || 'rss_summary',
            image_url:           '',
            template_id:         null,
            slug:                a.slug || generateSlug(a.title, a.published_at),
          }));
          await env.PITCHOS_CACHE.put(`articles:${site.short_code}`, JSON.stringify(articles), { expirationTtl: 7200 });
          return Response.json({ rebuilt: articles.length, source: 'supabase', site: site.short_code });
        }

        // Strategy 2 — RSS direct fetch, skip url-dedup, no scoring needed for display
        console.log('REBUILD: Supabase empty, fetching RSS directly');
        const { articles: rssRaw } = await fetchRSSArticles(site);
        const { articles: filtered } = preFilter(rssRaw, new Set()); // empty Set = skip hash-dedup
        // Sort by date, cap at 100 — no url-dedup (display cache only, not a Supabase insert)
        const top = filtered
          .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0))
          .slice(0, 100)
          .map(a => ({
            title:               a.title        || '',
            summary:             a.summary      || a.description || '',
            full_body:           a.full_body    || a.summary || a.description || '',
            source:              a.source_name  || a.source || '',
            source_name:         a.source_name  || a.source || '',
            source_emoji:        '',
            source_url:          a.url          || '',
            url:                 a.url          || '',
            category:            a.category     || 'Haber',
            nvs:                 a.nvs          || a.nvs_score || 0,
            golden_score:        a.golden_score || null,
            published_at:        a.published_at || new Date().toISOString(),
            is_fresh:            true,
            is_kartalix_content: false,
            is_p4:               a.is_p4        || false,
            sport:               a.sport        || 'football',
            publish_mode:        a.publish_mode || 'rss_summary',
            image_url:           '',
            template_id:         null,
            slug:                generateSlug(a.title, a.published_at),
          }));
        if (top.length === 0) return Response.json({ error: 'RSS feeds returned 0 articles after filtering' });
        await env.PITCHOS_CACHE.put(`articles:${site.short_code}`, JSON.stringify(top), { expirationTtl: 7200 });
        return Response.json({ rebuilt: top.length, source: 'rss_direct', site: site.short_code });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
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
    if (url.pathname === '/debug-next-match') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        // Raw API call so we can see exactly what's returned
        const key = env.API_FOOTBALL_KEY;
        if (!key) return Response.json({ error: 'API_FOOTBALL_KEY secret not set' }, { headers });

        const [teamRes, fixtureRes, statusRes] = await Promise.all([
          fetch('https://v3.football.api-sports.io/teams?name=Besiktas', {
            headers: { 'x-apisports-key': key },
            signal: AbortSignal.timeout(8000),
          }),
          fetch('https://v3.football.api-sports.io/fixtures?team=549&season=2025&next=1&timezone=Europe/Istanbul', {
            headers: { 'x-apisports-key': key },
            signal: AbortSignal.timeout(8000),
          }),
          fetch('https://v3.football.api-sports.io/status', {
            headers: { 'x-apisports-key': key },
            signal: AbortSignal.timeout(8000),
          }),
        ]);

        const teamData    = await teamRes.json();
        const fixtureData = await fixtureRes.json();
        const statusData  = await statusRes.json();

        return Response.json({
          team_search:    { status: teamRes.status,    results: teamData.response?.slice(0, 1) },
          next_fixture:   { status: fixtureRes.status, errors: fixtureData.errors, count: fixtureData.results, fixture: fixtureData.response?.[0] ?? null },
          quota:          { plan: statusData.response?.subscription?.plan, requests_today: statusData.response?.requests?.current, limit_day: statusData.response?.requests?.limit_day },
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
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
    if (url.pathname === '/debug-google-news') {
      const feedUrl = 'https://news.google.com/rss/search?q=Besiktas+BJK&hl=tr&gl=TR&ceid=TR:tr';
      try {
        const res = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PitchOS/1.0)' }, signal: AbortSignal.timeout(10000) });
        const text = await res.text();
        const items = text.match(/<item[\s\S]*?<\/item>/g) || text.match(/<entry[\s\S]*?<\/entry>/g) || [];
        const sample = items.slice(0, 5).map(item => {
          const title   = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)?.[1] || item.match(/<title>([^<]+)<\/title>/i)?.[1] || '';
          const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/i)?.[1] || item.match(/<published>([^<]+)<\/published>/i)?.[1] || 'NO DATE';
          const link    = item.match(/<link>([^<]+)<\/link>/i)?.[1] || item.match(/<link[^>]+href="([^"]+)"/i)?.[1] || '';
          return { title: title.slice(0, 80), pubDate, link: link.slice(0, 80) };
        });
        return Response.json({ status: res.status, length: text.length, item_count: items.length, first_100_chars: text.slice(0, 100), sample }, { headers: { 'Access-Control-Allow-Origin': '*' } });
      } catch(e) {
        return Response.json({ error: e.message }, { headers: { 'Access-Control-Allow-Origin': '*' } });
      }
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
      if (templateId === 'T01') {
        // Direct T01 test — no KV flag check, does NOT save to Supabase (dry run)
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers: { 'Access-Control-Allow-Origin': '*' } });
        const fixture = await getNextFixture(env);
        const match = fixture ? {
          ...NEXT_MATCH, ...fixture,
          venue_lat: NEXT_MATCH.venue_lat, venue_lon: NEXT_MATCH.venue_lon, tv: NEXT_MATCH.tv,
        } : NEXT_MATCH;
        const h2h = match.opponent_id ? await getH2H(match.opponent_id, env) : [];
        const weather = await getMatchWeather(match.venue_lat, match.venue_lon);
        const matchDateTime = new Date(`${match.date}T${match.time}:00+03:00`);
        const hoursToKickoff = (matchDateTime - new Date()) / (1000 * 60 * 60);
        // Call generateMatchPreview with null site to skip Supabase save
        const { callClaude, extractText, MODEL_GENERATE } = await import('./src/utils.js');
        const h2hLines = (h2h || []).slice(0, 5).map(f => {
          const home = f.home ? 'Beşiktaş' : f.opponent;
          const away = f.home ? f.opponent : 'Beşiktaş';
          const res  = f.score_bjk > f.score_opp ? 'G' : f.score_bjk < f.score_opp ? 'M' : 'B';
          return `${f.date}: ${home} ${f.score_bjk ?? '?'}-${f.score_opp ?? '?'} ${away} (BJK: ${res})`;
        }).join('\n') || '(geçmiş karşılaşma verisi yok)';
        const weatherLine = weather ? `Hava: ${Math.round(weather.temperature_2m)}°C, rüzgar ${Math.round(weather.windspeed_10m)} km/s` : 'hava verisi yok';
        return Response.json({
          template: 'T01',
          hours_to_kickoff: hoursToKickoff.toFixed(1),
          match: { fixture_id: match.fixture_id, opponent: match.opponent, date: match.date, time: match.time },
          h2h_count: h2h.length,
          h2h_lines: h2hLines,
          weather: weatherLine,
          note: 'dry run — no Supabase save. Hit /force-t01 to generate and save the real article.',
        }, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
      return Response.json({ error: 'unknown template id' }, { headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (url.pathname === '/force-t02') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const fixture = await getNextFixture(env);
        const match = fixture
          ? { ...NEXT_MATCH, ...fixture, venue_lat: NEXT_MATCH.venue_lat, venue_lon: NEXT_MATCH.venue_lon, tv: NEXT_MATCH.tv }
          : NEXT_MATCH;
        const opponentId = match.opponent_id || NEXT_MATCH.opponent_id;
        const h2h = await getH2H(opponentId, env);
        if (!h2h || h2h.length < 2) return Response.json({ error: `Not enough H2H data (${h2h?.length ?? 0} matches)` }, { headers });
        const card = await generateH2HHistory(match, h2h, site, env);
        if (!card) return Response.json({ error: 'generateH2HHistory returned null' }, { headers, status: 500 });
        await env.PITCHOS_CACHE.put(`flag:t02:${match.date}`, '1', { expirationTtl: 86400 });
        const cached = await env.PITCHOS_CACHE.get('articles:BJK');
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || '', full_body: card.full_body || '',
          source_name: 'Kartalix', source: 'Kartalix', category: 'Match',
          nvs: 72, nvs_score: 72, golden_score: null,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: 'T02',
          slug: card.slug, publish_mode: 'template_h2h', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== 'T02')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true, title: card.title, slug: card.slug,
          h2h_matches: h2h.length,
          words: (card.full_body || '').split(/\s+/).length,
          preview: (card.full_body || '').slice(0, 500),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-t01') {
      // Synchronous T01 generation — bypasses cron/backgroundWork, runs directly in request scope.
      // Uses the same logic as backgroundWork but waits for the result and returns it.
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const fixture = await getNextFixture(env);
        const match = fixture
          ? { ...NEXT_MATCH, ...fixture, venue_lat: NEXT_MATCH.venue_lat, venue_lon: NEXT_MATCH.venue_lon, tv: NEXT_MATCH.tv }
          : NEXT_MATCH;
        const [h2h, weather, table] = await Promise.all([
          match.opponent_id ? getH2H(match.opponent_id, env) : Promise.resolve([]),
          getMatchWeather(match.venue_lat, match.venue_lon),
          getStandings(env),
        ]);
        const standingsCtx = buildStandingsContext(table);
        const card = await generateMatchPreview(match, h2h, weather, standingsCtx, site, env);
        if (!card) return Response.json({ error: 'generateMatchPreview returned null' }, { headers, status: 500 });
        // Set dedup flag so backgroundWork skips it
        await env.PITCHOS_CACHE.put(`flag:t01:${match.date}`, '1', { expirationTtl: 86400 });
        // Push to KV cache
        const cached = await env.PITCHOS_CACHE.get('articles:BJK');
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || '', full_body: card.full_body || '',
          source_name: 'Kartalix', source: 'Kartalix', category: 'Match',
          nvs: card.nvs_score || 82, nvs_score: card.nvs_score || 82, golden_score: 5,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: 'T01',
          slug: card.slug, publish_mode: 'template_preview', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== 'T01')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true,
          title: card.title,
          slug: card.slug,
          words: (card.full_body || '').split(/\s+/).length,
          preview: (card.full_body || '').slice(0, 500),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-t10') {
      // Simulate a BJK goal flash. Pass ?scorer=Name&minute=67&assist=Name&own=true&penalty=true
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const scorer  = url.searchParams.get('scorer')  || 'El Bilal Touré';
        const minute  = parseInt(url.searchParams.get('minute') || '67');
        const assist  = url.searchParams.get('assist')  || 'Orkun Kökçü';
        const isOwn   = url.searchParams.get('own')     === 'true';
        const isPen   = url.searchParams.get('penalty') === 'true';
        const goalEvent = {
          time:   { elapsed: minute },
          player: { name: scorer },
          assist: { name: assist },
          type:   'Goal',
          detail: isOwn ? 'Own Goal' : isPen ? 'Penalty' : 'Normal Goal',
        };
        const matchObj = { ...NEXT_MATCH, score_bjk: 1, score_opp: 0 };
        const card = await generateGoalFlash(matchObj, goalEvent, site, env);
        if (!card) return Response.json({ error: 'generateGoalFlash returned null' }, { headers, status: 500 });
        // Push to KV
        const cached = await env.PITCHOS_CACHE.get('articles:BJK');
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || card.full_body?.slice(0,200) || '',
          full_body: card.full_body || '', source_name: 'Kartalix', source: 'Kartalix',
          category: 'Match', nvs: 90, nvs_score: 90, golden_score: 5,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: 'T10',
          slug: card.slug, publish_mode: 'template_goal_flash', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== 'T10')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true, title: card.title, slug: card.slug,
          words: (card.full_body || '').split(/\s+/).length,
          preview: (card.full_body || '').slice(0, 500),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-yt') {
      // Debug: check what YouTube videos would qualify right now.
      // ?channel_id=UC... — limit to one channel (omit for all 5)
      // ?publish=1 — actually generate embeds and push to KV/Supabase
      // ?since=2026-05-01T00:00:00Z — override 48h lookback window
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site  = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });

        const filterChannel = url.searchParams.get('channel_id');
        const doPublish     = url.searchParams.get('publish') === '1';
        const since         = url.searchParams.has('since')
          ? new Date(url.searchParams.get('since'))
          : new Date(Date.now() - 48 * 60 * 60 * 1000);

        const channels = filterChannel
          ? YOUTUBE_CHANNELS.filter(c => c.id === filterChannel)
          : YOUTUBE_CHANNELS;
        if (channels.length === 0) return Response.json({ error: 'channel_id not found' }, { headers, status: 404 });

        const seenUrls    = await getSeenUrls(env, site.id);
        const nextMatch   = await getNextFixture(env).catch(() => null);
        const recentFix   = await getLastFixtures(env, 3).catch(() => []);
        const recentMatch = recentFix.find(f => f.league?.includes('Süper Lig')) || null;
        const results     = [];
        let published     = 0;

        for (const channel of channels) {
          const videos    = await fetchYouTubeChannel(channel, since).catch(() => []);
          const hardFiltered = videos.filter(v => qualifyYouTubeVideo(v));
          const hardSkipped  = videos.filter(v => !qualifyYouTubeVideo(v)).map(v => v.title);
          const unseen       = hardFiltered.filter(v => !seenUrls.has(`https://www.youtube.com/watch?v=${v.video_id}`));

          // Score broadcast/digital through same scorer as RSS
          const official2 = unseen.filter(v => v.channel_tier === 'official');
          const others2   = unseen.filter(v => v.channel_tier !== 'official');
          let relevantOthers2 = others2;
          if (others2.length > 0) {
            const { articles: scored2 } = await scoreArticles(
              others2.map(v => ({ title: v.title, summary: v.description || '', source_name: v.channel_name, published_at: v.published_at, trust_tier: 'broadcast' })),
              site, env
            ).catch(() => ({ articles: [] }));
            relevantOthers2 = others2.filter((_, idx) =>
              scored2[idx]?.relevant !== false && !scored2[idx]?.rival_pov && (scored2[idx]?.nvs ?? 50) >= 20
            );
          }
          const qualified = [...official2, ...relevantOthers2];
          const skipped   = hardSkipped;

          if (doPublish) {
            for (const video of qualified.slice(0, 2)) {
              try {
                const matchType = classifyMatchVideo(video, nextMatch, recentMatch);
                const matchCtx  = matchType ? (nextMatch?.league?.includes('Süper Lig') ? nextMatch : recentMatch) : null;
                const card = matchType
                  ? await generateMatchVideoEmbed(video, matchType, matchCtx, site, env)
                  : await generateVideoEmbed(video, site, env);
                if (card) {
                  const raw     = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const current = raw ? JSON.parse(raw) : [];
                  const kvCard  = toKVShape({ ...card, nvs: card.nvs_score || 72, fixture_id: (matchCtx || nextMatch)?.fixture_id || null, is_kartalix_content: true, is_template: true });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...current], 100));
                  published++;
                }
              } catch (e) { console.error(`force-yt embed failed [${video.video_id}]:`, e.message); }
            }
          }

          results.push({
            channel: channel.name, tier: channel.tier,
            fetched: videos.length, qualified: qualified.length,
            next_match: nextMatch ? { opponent: nextMatch.opponent, league: nextMatch.league } : null,
            recent_super_lig: recentMatch ? { opponent: recentMatch.opponent, date: recentMatch.date } : null,
            videos: qualified.slice(0, 5).map(v => ({
              id: v.video_id, title: v.title, published_at: v.published_at,
              match_type: classifyMatchVideo(v, nextMatch, recentMatch) || 'T-VID',
            })),
            skipped_titles: skipped.slice(0, 5),
          });
        }

        return Response.json({
          success: true, since: since.toISOString(),
          published: doPublish ? published : 'dry-run (add ?publish=1 to actually embed)',
          channels: results,
        }, { headers });
      } catch (e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-tvid') {
      // Publish a specific YouTube video with an explicit template type.
      // Required: ?video_id=Y&channel_id=UC...
      // Optional: ?type=press_conf|highlights|interview|referee|goal_bjk  (default: auto-classify)
      // Add ?publish=1 to actually write to KV (dry-run otherwise).
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const videoId   = url.searchParams.get('video_id');
        const channelId = url.searchParams.get('channel_id');
        const typeParam = url.searchParams.get('type');  // explicit override
        const doPublish = url.searchParams.get('publish') === '1';
        if (!videoId || !channelId) return Response.json({ error: 'video_id and channel_id are required' }, { headers, status: 400 });

        const channel = YOUTUBE_CHANNELS.find(c => c.id === channelId);
        if (!channel) return Response.json({ error: 'channel_id not in YOUTUBE_CHANNELS' }, { headers, status: 404 });

        const sites = await getActiveSites(env);
        const site  = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });

        // Fetch a generous window so the target video is in the feed
        const since  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const videos = await fetchYouTubeChannel(channel, since);
        const video  = videos.find(v => v.video_id === videoId);
        if (!video) return Response.json({ error: `video ${videoId} not found in feed (may be older than 7d)` }, { headers, status: 404 });

        const nextMatch   = await getNextFixture(env).catch(() => null);
        const recentFix2  = await getLastFixtures(env, 3).catch(() => []);
        const recentMatch = recentFix2.find(f => f.league?.includes('Süper Lig')) || null;
        const matchType   = typeParam || classifyMatchVideo(video, nextMatch, recentMatch);
        const matchCtx    = matchType ? (nextMatch?.league?.includes('Süper Lig') ? nextMatch : recentMatch) : null;

        let card = null;
        if (doPublish) {
          card = matchType
            ? await generateMatchVideoEmbed(video, matchType, matchCtx, site, env)
            : await generateVideoEmbed(video, site, env);
          if (card) {
            const raw     = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const current = raw ? JSON.parse(raw) : [];
            const kvCard  = toKVShape({ ...card, nvs: card.nvs_score || 72, fixture_id: (matchCtx || nextMatch)?.fixture_id || null, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...current], 100));
          }
        }

        return Response.json({
          success: true,
          video_id: videoId, title: video.title, published_at: video.published_at,
          match_type: matchType || 'T-VID',
          match_context: matchCtx ? { opponent: matchCtx.opponent, league: matchCtx.league } : null,
          published: doPublish ? !!card : 'dry-run (add ?publish=1)',
          template_id: card?.template_id || null,
          headline: card?.headline || null,
        }, { headers });
      } catch (e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-synthesis') {
      // Debug: test original news synthesis from top P4 sources currently in KV/Supabase.
      // ?publish=1 — write the synthesized article to KV
      // ?nvs=50 — NVS floor (default 55)
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        if (!sites?.length) return Response.json({ error: 'No active sites' }, { headers, status: 500 });
        const site = sites[0];
        const publish = url.searchParams.get('publish') === '1';
        const nvsFloor = parseInt(url.searchParams.get('nvs') || '55');

        // Fetch recent scored articles from Supabase (last 48h) to act as synthesis inputs
        const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const rows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${site.id}&status=in.(published,pending)&created_at=gte.${since48h}&order=nvs_score.desc&limit=50&select=*`
        );
        const allRecent = (rows || []).filter(a => a.source_name !== 'Kartalix');

        // Exclude stories already covered by a Kartalix article in the feed
        const existingFeed = await getCachedArticles(env, site.short_code);
        const kartalixTitles = new Set(
          existingFeed.filter(a => a.is_kartalix_content).map(a => normalizeTitle(a.title || ''))
        );
        const fresh = allRecent.filter(a =>
          !kartalixTitles.has(normalizeTitle(a.title || '')) &&
          !existingFeed.some(k => k.is_kartalix_content &&
            titleSimilarity(normalizeTitle(k.title || ''), normalizeTitle(a.title || '')) > 0.25)
        );
        const SYNTHESIS_SKIP = new Set(['match_result', 'squad']);
        const candidates = fresh.filter(a =>
          (a.nvs_score || 0) >= nvsFloor && !SYNTHESIS_SKIP.has(a.content_type)
        );

        if (candidates.length === 0) {
          return Response.json({
            message: 'No new candidates above NVS floor',
            nvsFloor,
            total_recent: allRecent.length,
            already_covered: allRecent.length - fresh.length,
            below_floor: fresh.filter(a => (a.nvs_score || 0) < nvsFloor).length,
            all_recent_titles: allRecent.map(a => ({ title: a.title, nvs: a.nvs_score, source: a.source_name })),
          }, { headers });
        }

        // Group by story: pick top candidate, find related duplicates for multi-source context
        const storyDeduped = dedupeByStory(candidates);
        const results = [];
        for (const primary of storyDeduped.slice(0, 3)) {
          const related = candidates.filter(a =>
            a !== primary &&
            titleSimilarity(normalizeTitle(a.title || ''), normalizeTitle(primary.title || '')) > 0.25
          ).slice(0, 2);

          const origNews = await generateOriginalNews(
            [primary, ...related].map(a => ({ ...a, nvs: a.nvs_score, category: a.category })),
            site, env
          );

          if (publish && origNews) {
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : [];
            const kvCard = toKVShape(origNews);
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
          }

          results.push({
            sources: [primary, ...related].map(a => ({ title: a.title, source: a.source_name, nvs: a.nvs_score })),
            result: origNews ? { title: origNews.title, body_length: origNews.full_body?.length } : null,
            published: publish && !!origNews,
          });
        }

        return Response.json({
          total_recent: allRecent.length,
          already_covered: allRecent.length - fresh.length,
          new_candidates: candidates.length,
          stories: results,
        }, { headers });
      } catch (e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-t11') {
      // Simulate a full-time result flash. Pass ?bjk=2&opp=1 to override score,
      // or omit to fetch actual score from API.
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        let bjkScore, oppScore;
        if (url.searchParams.has('bjk') && url.searchParams.has('opp')) {
          bjkScore = parseInt(url.searchParams.get('bjk'));
          oppScore = parseInt(url.searchParams.get('opp'));
        } else {
          // Fetch actual score from API
          const liveF = await getFixture(NEXT_MATCH.fixture_id, env);
          bjkScore = liveF?.score_bjk ?? 0;
          oppScore = liveF?.score_opp ?? 0;
        }
        const fixture = {
          ...NEXT_MATCH,
          score_bjk:   bjkScore,
          score_opp:   oppScore,
          is_finished: true,
          status:      'FT',
        };
        const [players, events] = await Promise.all([
          getFixturePlayers(NEXT_MATCH.fixture_id, env).catch(() => []),
          getFixtureEvents(NEXT_MATCH.fixture_id, env).catch(() => []),
        ]);
        const card = await generateResultFlash(fixture, players, site, env, events);
        if (!card) return Response.json({ error: 'generateResultFlash returned null' }, { headers, status: 500 });
        // Push to KV
        const cached = await env.PITCHOS_CACHE.get('articles:BJK');
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || '', full_body: card.full_body || '',
          source_name: 'Kartalix', source: 'Kartalix', category: 'Match',
          nvs: 88, nvs_score: 88, golden_score: 5,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: 'T11',
          slug: card.slug, publish_mode: 'template_result', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== 'T11')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true, title: card.title, slug: card.slug,
          words: (card.full_body || '').split(/\s+/).length,
          preview: (card.full_body || '').slice(0, 500),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-t13') {
      // Simulate a post-match T13. Pass ?bjk=2&opp=1 for score context.
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const bjkScore = parseInt(url.searchParams.get('bjk') || '2');
        const oppScore = parseInt(url.searchParams.get('opp') || '1');
        const fixture = { ...NEXT_MATCH, score_bjk: bjkScore, score_opp: oppScore, is_finished: true, status: 'FT' };
        // Try real player data first, fall back to fake
        let players = [];
        try { players = await getFixturePlayers(NEXT_MATCH.fixture_id, env); } catch(e) {}
        if (!players.length) {
          players = [
            { name: 'El Bilal Touré',   rating: 8.2, goals: 1, assists: 0, minutesPlayed: 90 },
            { name: 'Orkun Kökçü',      rating: 7.8, goals: 0, assists: 1, minutesPlayed: 90 },
            { name: 'Ersin Destanoğlu', rating: 7.5, goals: 0, assists: 0, minutesPlayed: 90 },
          ];
        }
        const card = await generateManOfTheMatch(fixture, players, site, env);
        if (!card) return Response.json({ error: 'generateManOfTheMatch returned null (need ≥3 rated players, min rating 6.0)' }, { headers, status: 500 });
        const cached = await env.PITCHOS_CACHE.get('articles:BJK');
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || '', full_body: card.full_body || '',
          source_name: 'Kartalix', source: 'Kartalix', category: 'Match',
          nvs: 80, nvs_score: 80, golden_score: null,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: 'T13',
          slug: card.slug, publish_mode: 'template_motm', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== 'T13')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true, title: card.title, slug: card.slug,
          mom: players[0]?.name, rating: players[0]?.rating,
          words: (card.full_body || '').split(/\s+/).length,
          preview: (card.full_body || '').slice(0, 500),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-t07') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const fixture = await getNextFixture(env);
        const match = fixture
          ? { ...NEXT_MATCH, ...fixture, venue_lat: NEXT_MATCH.venue_lat, venue_lon: NEXT_MATCH.venue_lon, tv: NEXT_MATCH.tv }
          : NEXT_MATCH;
        const fixtureId = match.fixture_id || NEXT_MATCH.fixture_id;
        const injuries = await getInjuries(env, fixtureId);
        const cached = await env.PITCHOS_CACHE.get('articles:BJK');
        const rssArticles = (cached ? JSON.parse(cached) : [])
          .filter(a => a.template_id !== 'T07' && !a.is_kartalix_content);
        const card = await generateInjuryReport(match, injuries, rssArticles, site, env);
        if (!card) return Response.json({ error: 'generateInjuryReport returned null' }, { headers, status: 500 });
        await env.PITCHOS_CACHE.put(`flag:t07:${match.date}`, '1', { expirationTtl: 86400 });
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || '', full_body: card.full_body || '',
          source_name: 'Kartalix', source: 'Kartalix', category: 'Match',
          nvs: 75, nvs_score: 75, golden_score: null,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: 'T07',
          slug: card.slug, publish_mode: 'template_injury_report', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== 'T07')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true, title: card.title, slug: card.slug,
          injuries_from_api: injuries.length,
          words: (card.full_body || '').split(/\s+/).length,
          preview: (card.full_body || '').slice(0, 500),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-t03') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const fixture = await getNextFixture(env);
        const match = fixture
          ? { ...NEXT_MATCH, ...fixture, venue_lat: NEXT_MATCH.venue_lat, venue_lon: NEXT_MATCH.venue_lon, tv: NEXT_MATCH.tv }
          : NEXT_MATCH;
        const [recent, table] = await Promise.all([
          getLastFixtures(env, 5),
          getStandings(env),
        ]);
        if (!recent || recent.length < 3) return Response.json({ error: `Not enough recent fixtures (${recent?.length ?? 0})` }, { headers });
        const bjkRow = table ? table.find(r => r.team?.id === 549) : null;
        const card = await generateFormGuide(match, recent, bjkRow, site, env);
        if (!card) return Response.json({ error: 'generateFormGuide returned null' }, { headers, status: 500 });
        await env.PITCHOS_CACHE.put(`flag:t03:${match.date}`, '1', { expirationTtl: 86400 });
        const cached = await env.PITCHOS_CACHE.get('articles:BJK');
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || '', full_body: card.full_body || '',
          source_name: 'Kartalix', source: 'Kartalix', category: 'Match',
          nvs: 70, nvs_score: 70, golden_score: null,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: 'T03',
          slug: card.slug, publish_mode: 'template_form_guide', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== 'T03')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true, title: card.title, slug: card.slug,
          recent_count: recent.length, standing: bjkRow ? `${bjkRow.rank}. sıra` : 'N/A',
          words: (card.full_body || '').split(/\s+/).length,
          preview: (card.full_body || '').slice(0, 500),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-t12') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        let bjkScore, oppScore;
        if (url.searchParams.has('bjk') && url.searchParams.has('opp')) {
          bjkScore = parseInt(url.searchParams.get('bjk'));
          oppScore = parseInt(url.searchParams.get('opp'));
        } else {
          const liveF = await getFixture(NEXT_MATCH.fixture_id, env);
          bjkScore = liveF?.score_bjk ?? 0;
          oppScore = liveF?.score_opp ?? 0;
        }
        const fixture  = { ...NEXT_MATCH, score_bjk: bjkScore, score_opp: oppScore, is_finished: true, status: 'FT' };
        const [players, stats, events] = await Promise.all([
          getFixturePlayers(NEXT_MATCH.fixture_id, env).catch(() => []),
          getFixtureStats(NEXT_MATCH.fixture_id, env).catch(() => null),
          getFixtureEvents(NEXT_MATCH.fixture_id, env).catch(() => []),
        ]);
        const card = await generateMatchReport(fixture, players, stats, site, env, events);
        if (!card) return Response.json({ error: 'generateMatchReport returned null' }, { headers, status: 500 });
        const cached  = await env.PITCHOS_CACHE.get('articles:BJK');
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || '', full_body: card.full_body || '',
          source_name: 'Kartalix', source: 'Kartalix', category: 'Match',
          nvs: 85, nvs_score: 85, golden_score: null,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: 'T12',
          slug: card.slug, publish_mode: 'template_match_report', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== 'T12')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true, title: card.title, slug: card.slug,
          stats_available: !!stats, players_real: players.length > 0,
          words: (card.full_body || '').split(/\s+/).length,
          preview: (card.full_body || '').slice(0, 500),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-t09') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const fixtureId = parseInt(url.searchParams.get('fixture') || String(NEXT_MATCH.fixture_id));
        const lineup = await getFixtureLineup(fixtureId, env);
        if (!lineup) return Response.json({ error: 'lineup not available from API yet', fixture_id: fixtureId }, { headers, status: 404 });
        const card = await generateConfirmedLineup(NEXT_MATCH, lineup, site, env);
        if (!card) return Response.json({ error: 'generateConfirmedLineup returned null', formation: lineup.formation, players: lineup.startXI.length }, { headers, status: 500 });
        const cached   = await env.PITCHOS_CACHE.get('articles:BJK');
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || '', full_body: card.full_body || '',
          source_name: 'Kartalix', source: 'Kartalix', category: 'Match',
          nvs: 88, nvs_score: 88, golden_score: 5,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: '09',
          slug: card.slug, publish_mode: 'lineup_template', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== '09')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true, title: card.title, slug: card.slug,
          formation: lineup.formation, players: lineup.startXI.map(p => p.name),
          bench: lineup.substitutes.map(p => p.name),
          words: (card.full_body || '').split(/\s+/).length,
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-txgdelta') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const bjkScore = parseInt(url.searchParams.get('bjk') || '3');
        const oppScore = parseInt(url.searchParams.get('opp') || '1');
        const fixture  = { ...NEXT_MATCH, score_bjk: bjkScore, score_opp: oppScore, is_finished: true, status: 'FT' };
        const realStats = await getFixtureStats(NEXT_MATCH.fixture_id, env).catch(() => null);
        // Stub with delta > 1.2 if no real stats available yet
        const stats = realStats || { xg: '1.4', possession: '55%', shots_total: 18, shots_on_target: 8 };
        const xg    = parseFloat(stats.xg ?? '1.4');
        const delta = bjkScore - xg;
        const card = await generateXGDelta(fixture, stats, site, env);
        if (!card) return Response.json({ error: `generateXGDelta returned null (xG=${xg.toFixed(2)}, goals=${bjkScore}, delta=${delta.toFixed(2)})` }, { headers, status: 500 });
        const cached  = await env.PITCHOS_CACHE.get('articles:BJK');
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || '', full_body: card.full_body || '',
          source_name: 'Kartalix', source: 'Kartalix', category: 'Match',
          nvs: 78, nvs_score: 78, golden_score: null,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: 'T-XG',
          slug: card.slug, publish_mode: 'template_xg_delta', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== 'T-XG')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true, title: card.title, slug: card.slug,
          xg: xg.toFixed(2), goals: bjkScore, delta: delta.toFixed(2),
          stats_real: !!realStats,
          words: (card.full_body || '').split(/\s+/).length,
          preview: (card.full_body || '').slice(0, 500),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-tref') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const referee = url.searchParams.get('referee') || NEXT_MATCH.referee || 'Ali Palabıyık';
        const recentFixtures = await getLastFixtures(env, 10).catch(() => []);
        const refMatches = recentFixtures.filter(f => f.referee === referee);
        const refStats = refMatches.length > 0 ? {
          bjk_games:  refMatches.length,
          bjk_wins:   refMatches.filter(f => f.score_bjk > f.score_opp).length,
          bjk_draws:  refMatches.filter(f => f.score_bjk === f.score_opp).length,
          bjk_losses: refMatches.filter(f => f.score_bjk < f.score_opp).length,
        } : null;
        const card = await generateRefereeProfile(NEXT_MATCH, referee, refStats, site, env);
        if (!card) return Response.json({ error: 'generateRefereeProfile returned null' }, { headers, status: 500 });
        const cached  = await env.PITCHOS_CACHE.get('articles:BJK');
        const existing = cached ? JSON.parse(cached) : [];
        const kvCard = {
          title: card.title, summary: card.summary || '', full_body: card.full_body || '',
          source_name: 'Kartalix', source: 'Kartalix', category: 'Match',
          nvs: 65, nvs_score: 65, golden_score: null,
          published_at: card.published_at || new Date().toISOString(),
          is_kartalix_content: true, is_template: true, template_id: 'T-REF',
          slug: card.slug, publish_mode: 'template_referee', sport: 'football',
          url: '', source_url: '', is_fresh: true, is_p4: false, image_url: '',
        };
        const updated = [kvCard, ...existing.filter(a => a.template_id !== 'T-REF')].slice(0, 100);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 7200 });
        return Response.json({
          success: true, title: card.title, referee,
          ref_matches_found: refMatches.length,
          words: (card.full_body || '').split(/\s+/).length,
          preview: (card.full_body || '').slice(0, 400),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/watcher') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        await matchWatcher(env);
        const fixture = await getNextFixture(env).catch(() => null);
        const matchDateTime  = fixture ? new Date(`${fixture.date}T${fixture.time}:00+03:00`) : null;
        const hoursToKickoff = matchDateTime ? (matchDateTime - new Date()) / (1000 * 60 * 60) : null;
        return Response.json({
          triggered: true,
          fixture_id:      fixture?.fixture_id,
          opponent:        fixture?.opponent,
          date:            fixture?.date,
          time:            fixture?.time,
          hoursToKickoff:  hoursToKickoff?.toFixed(2),
          referee:         fixture?.referee,
          message: 'matchWatcher executed — check Worker logs for WATCHER lines',
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/test-firewall') {
      const { extractFacts, writeTransfer } = await import('./src/firewall.js');
      const testArticle = {
        id:          null,
        site_id:     null,
        title:       'Milot Rashica Beşiktaş\'a transfer oldu',
        summary:     'Kosovalı kanat oyuncusu Milot Rashica, 3.5 milyon euro bonservis bedeliyle Werder Bremen\'den Beşiktaş\'a transfer oldu. 28 yaşındaki futbolcu, 3 yıllık sözleşme imzaladı.',
        is_p4:       true,
        source_name: 'Fotomaç (test)',
        url:         'https://test.kartalix.com/firewall-test',
      };
      try {
        const facts   = await extractFacts(testArticle, env);
        const written = await writeTransfer(facts, env);
        return Response.json({
          status:         'ok',
          facts,
          article_body:   written.full_body,
          supabase_check: 'Check facts + fact_lineage tables for a new row with source_name = "Fotomaç (test)"',
        }, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      } catch (e) {
        return Response.json({ status: 'error', message: e.message }, { status: 500 });
      }
    }
    // ── COST MONITOR ─────────────────────────────────────────
    if (url.pathname === '/admin/cost') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const now = new Date();
      const monthKey = now.toISOString().slice(0, 7);
      const kvKey = `cost:${monthKey}`;
      const current = parseFloat((await env.PITCHOS_CACHE.get(kvKey)) || '0');
      const cap = parseFloat(env.MONTHLY_CLAUDE_CAP || '8');
      const pct = cap > 0 ? (current / cap * 100).toFixed(1) : null;
      // Also show last 3 months if available
      const months = [monthKey];
      for (let i = 1; i <= 2; i++) {
        const d = new Date(now);
        d.setMonth(d.getMonth() - i);
        months.push(d.toISOString().slice(0, 7));
      }
      const history = await Promise.all(months.map(async m => ({
        month: m,
        usd: parseFloat((await env.PITCHOS_CACHE.get(`cost:${m}`)) || '0'),
      })));
      return Response.json({ current_month: monthKey, current_usd: +current.toFixed(4), cap_usd: cap, pct_used: pct, blocked: current >= cap, history }, { headers });
    }

    // ── KV CACHE MANAGEMENT ───────────────────────────────────
    // DELETE /admin/kv-remove?template_id=T12 — removes test/stale articles by template_id
    // DELETE /admin/kv-remove?slug=2026-05-01-... — removes by slug
    if (url.pathname === '/admin/kv-remove') {
      if (request.method !== 'DELETE' && request.method !== 'POST') return new Response('DELETE or POST only', { status: 405 });
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const tid  = url.searchParams.get('template_id');
      const slug = url.searchParams.get('slug');
      if (!tid && !slug) return Response.json({ error: 'template_id or slug required' }, { headers, status: 400 });
      const cached = await env.PITCHOS_CACHE.get('articles:BJK');
      const articles = cached ? JSON.parse(cached) : [];
      const before = articles.length;
      const filtered = tid
        ? articles.filter(a => a.template_id !== tid)
        : articles.filter(a => a.slug !== slug);
      await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(filtered), { expirationTtl: 7200 });
      return Response.json({ removed: before - filtered.length, remaining: filtered.length, filter: tid || slug }, { headers });
    }

    // ── EDITORIAL NOTES API (structured guidelines) ──────────
    if (url.pathname === '/admin/notes') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      if (request.method === 'GET') {
        const notes = await listEditorialNotes(env);
        return Response.json(notes, { headers });
      }
      if (request.method === 'POST') {
        const body = await request.json();
        if (body.action === 'delete') {
          if (!body.id) return Response.json({ error: 'id required' }, { headers, status: 400 });
          await deleteEditorialNote(env, body.id);
          return Response.json({ deleted: body.id }, { headers });
        }
        const { scope, text } = body;
        if (!scope || !text?.trim()) return Response.json({ error: 'scope and text required' }, { headers, status: 400 });
        const note = await saveEditorialNote(env, scope, text);
        return Response.json(note, { headers });
      }
      return new Response('Method not allowed', { status: 405 });
    }
    // ── RAW ARTICLE FEEDBACK API ──────────────────────────────
    if (url.pathname === '/article/feedback') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      if (request.method === 'GET') {
        const items = await getRawFeedbacks(env);
        return Response.json(items, { headers });
      }
      if (request.method === 'POST') {
        const body = await request.json();
        if (body.action === 'delete') {
          if (!body.id) return Response.json({ error: 'id required' }, { headers, status: 400 });
          await deleteRawFeedback(env, body.id);
          return Response.json({ deleted: body.id }, { headers });
        }
        const { article_slug, article_title, template_id, comment } = body;
        if (!comment?.trim()) return Response.json({ error: 'comment required' }, { headers, status: 400 });
        const item = await saveRawFeedback(env, { article_slug, article_title, template_id, comment });
        return Response.json(item, { headers });
      }
      return new Response('Method not allowed', { status: 405 });
    }
    // ── DISTILL FEEDBACK → GUIDELINES ────────────────────────
    if (url.pathname === '/admin/references') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      if (request.method === 'GET') {
        return Response.json(await getReferenceArticles(env), { headers });
      }
      if (request.method === 'POST') {
        const body = await request.json();
        if (body.action === 'delete') {
          await deleteReferenceArticle(env, body.id);
          return Response.json({ deleted: body.id }, { headers });
        }
        const { source, text } = body;
        if (!text?.trim()) return Response.json({ error: 'text required' }, { headers, status: 400 });
        const item = await saveReferenceArticle(env, { source, text });
        return Response.json(item, { headers });
      }
      return new Response('Method not allowed', { status: 405 });
    }
    if (url.pathname === '/admin/distill' && request.method === 'POST') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const pending = await getRawFeedbacks(env, { unprocessedOnly: true });
      if (!pending.length) return Response.json({ message: 'İşlenecek yorum yok', added: 0 }, { headers });

      const refs = await getReferenceArticles(env);
      const feedbackText = pending.map(f =>
        `Haber: "${f.article_title || f.article_slug}"\nYorum: "${f.comment}"`
      ).join('\n\n');
      const refsText = refs.length
        ? '\n\nSTİL REFERANSLARI (beğenilen haberler — bunlardan genelleştirilebilir prensipler çıkar):\n' +
          refs.map(r => `--- ${r.source || 'Referans'} ---\n${r.text.slice(0, 1000)}`).join('\n\n')
        : '';

      const prompt = `Sen Kartalix'in baş editörüsün. Aşağıda belirli haberler hakkında editörden gelen ham yorumlar${refs.length ? ' ve beğenilen referans haberler' : ''} var.

HAM YORUMLAR:
${feedbackText}${refsText}

Bu verileri analiz et ve tüm haberler için geçerli, tekrar kullanılabilir editöryal yönergeler çıkar.
Şunları ATLA: özel isimlere özgü bilgi eksiklikleri, o ana özgü spesifik düzeltmeler, tek seferlik bilgi talepleri.
Şunları ÇIKAR: ton, yazım üslubu, yapı, içerik tercihleri, kaçınılacak kalıplar hakkında kurallar.
Her kural tek cümle, emredici Türkçe. En dar geçerli kapsamı seç.
Kapsamlar: global (her haber), news (genel haberler), transfer, match.

Sadece JSON döndür:
[{"scope":"...","text":"..."}]`;

      const res = await callClaude(env, MODEL_SCORE, prompt, false, 1000);
      const text = extractText(res.content);
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return Response.json({ error: 'Claude yanıt vermedi', raw: text.slice(0, 200) }, { headers, status: 500 });

      let rules;
      try { rules = JSON.parse(jsonMatch[0]); } catch (e) { return Response.json({ error: 'JSON ayrıştırılamadı' }, { headers, status: 500 }); }

      for (const rule of rules) {
        if (rule.scope && rule.text) await saveEditorialNote(env, rule.scope, rule.text.trim());
      }
      await markFeedbacksProcessed(env, pending.map(f => f.id));
      return Response.json({ added: rules.length, rules }, { headers });
    }

    if (url.pathname === '/admin/redistill' && request.method === 'POST') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        await redistillEditorialNotes(env);
        const notes = await listEditorialNotes(env);
        return Response.json({ ok: true, count: notes.length }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    // ── SOURCES ADMIN ─────────────────────────────────────────────
    if (url.pathname === '/admin/sources') {
      const cookie = request.headers.get('cookie') || '';
      const authed = cookie.split(';').some(c => c.trim() === 'kx-editor=1');
      if (!authed) return Response.redirect(new URL('/admin', request.url).toString(), 302);
      const rssFeeds = await getRssConfig(env);
      const ytChannels = await getYtConfig(env);
      return new Response(renderSourcesPage(rssFeeds, ytChannels), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/sources/list') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const rss = await getRssConfig(env);
      const yt  = await getYtConfig(env);
      return Response.json({ rss, yt }, { headers });
    }

    if (url.pathname === '/admin/sources/add' && request.method === 'POST') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const body = await request.json();
        if (body.type === 'rss') {
          const feeds = await getRssConfig(env);
          if (feeds.find(f => f.url === body.url)) return Response.json({ error: 'URL already exists' }, { headers, status: 400 });
          feeds.push({ url: body.url, name: body.name, trust: body.trust || 'press', sport: 'football', is_p4: body.is_p4 ?? true, keywordFilter: body.keywordFilter ?? true, proxy: body.proxy ?? false });
          await env.PITCHOS_CACHE.put('config:rss_feeds', JSON.stringify(feeds));
          return Response.json({ ok: true, count: feeds.length }, { headers });
        }
        if (body.type === 'youtube') {
          const channels = await getYtConfig(env);
          if (channels.find(c => c.id === body.id)) return Response.json({ error: 'Channel ID already exists' }, { headers, status: 400 });
          channels.push({ id: body.id, name: body.name, tier: body.tier || 'broadcast', all_qualify: false, embed_qualify: body.embed_qualify ?? true, transcript_qualify: body.transcript_qualify ?? true });
          await env.PITCHOS_CACHE.put('config:yt_channels', JSON.stringify(channels));
          return Response.json({ ok: true, count: channels.length }, { headers });
        }
        return Response.json({ error: 'type must be rss or youtube' }, { headers, status: 400 });
      } catch(e) { return Response.json({ error: e.message }, { headers, status: 500 }); }
    }

    if (url.pathname === '/admin/sources/delete' && request.method === 'POST') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const { type, key } = await request.json();
        if (type === 'rss') {
          const feeds = (await getRssConfig(env)).filter(f => f.url !== key && f.name !== key);
          await env.PITCHOS_CACHE.put('config:rss_feeds', JSON.stringify(feeds));
          return Response.json({ ok: true, count: feeds.length }, { headers });
        }
        if (type === 'youtube') {
          const channels = (await getYtConfig(env)).filter(c => c.id !== key && c.name !== key);
          await env.PITCHOS_CACHE.put('config:yt_channels', JSON.stringify(channels));
          return Response.json({ ok: true, count: channels.length }, { headers });
        }
        return Response.json({ error: 'type must be rss or youtube' }, { headers, status: 400 });
      } catch(e) { return Response.json({ error: e.message }, { headers, status: 500 }); }
    }

    if (url.pathname === '/admin/sources/test') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const type      = url.searchParams.get('type') || 'rss';
        const targetUrl = url.searchParams.get('url')  || '';
        const channelId = url.searchParams.get('id')   || '';

        if (type === 'youtube' && channelId) {
          const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          const ch = { id: channelId, name: 'Test', tier: 'broadcast' };
          const videos = await fetchYouTubeChannel(ch, since);
          return Response.json({ ok: true, count: videos.length, items: videos.slice(0, 5).map(v => ({ title: v.title, published_at: v.published_at, video_id: v.video_id })) }, { headers });
        }

        if (type === 'transcript' && channelId) {
          // channelId may be a channel ID (UCxxx) or a direct video ID
          let videoId = channelId;
          if (channelId.startsWith('UC')) {
            // Fetch the channel's Atom feed to get the latest video ID
            const ch = { id: channelId, name: 'Test', tier: 'broadcast' };
            const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const videos = await fetchYouTubeChannel(ch, since);
            if (!videos.length) return Response.json({ ok: false, error: 'No recent videos found for channel' }, { headers });
            videoId = videos[0].video_id;
          }
          const transcript = await fetchYouTubeTranscript(videoId);
          return Response.json({ ok: !!transcript, video_id: videoId, length: transcript?.length || 0, preview: transcript?.slice(0, 300) || null }, { headers });
        }

        if (type === 'rss' && targetUrl) {
          // Try direct first, then proxy
          let items = [];
          let method = 'direct';
          try {
            const res = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            items = (text.match(/<item[\s\S]*?<\/item>/g) || text.match(/<entry[\s\S]*?<\/entry>/g) || []).slice(0, 5).map(i => {
              const title = i.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)?.[1] || i.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
              const pub   = i.match(/<pubDate>([^<]+)<\/pubDate>/i)?.[1] || i.match(/<published>([^<]+)<\/published>/i)?.[1] || '';
              return { title: title.trim(), published_at: pub.trim() };
            });
          } catch {
            method = 'proxy';
            const feed = { url: targetUrl, name: 'Test', trust: 'press', sport: 'football', is_p4: true };
            items = (await fetchViaRss2Json(feed)).slice(0, 5).map(a => ({ title: a.title, published_at: a.published_at }));
          }
          return Response.json({ ok: true, method, count: items.length, items }, { headers });
        }

        return Response.json({ error: 'provide type=rss&url=... or type=youtube&id=... or type=transcript&id=VIDEO_ID' }, { headers, status: 400 });
      } catch(e) { return Response.json({ error: e.message }, { headers, status: 500 }); }
    }

    if (url.pathname === '/admin/login' && request.method === 'POST') {
      const { pin } = await request.json().catch(() => ({}));
      const adminPin = env.ADMIN_PIN || 'kartalix2026';
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      if (!pin || pin !== adminPin) return Response.json({ error: 'Hatalı PIN' }, { status: 401, headers });
      return Response.json({ ok: true }, {
        headers: { ...headers, 'Set-Cookie': 'kx-editor=1; Path=/; Max-Age=604800; SameSite=Lax' },
      });
    }
    if (url.pathname === '/admin') {
      const cookie = request.headers.get('cookie') || '';
      const authed = cookie.split(';').some(c => c.trim() === 'kx-editor=1');
      if (!authed) {
        return new Response(renderPinPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      }
      const cached = await env.PITCHOS_CACHE.get('articles:BJK');
      const articles = cached ? JSON.parse(cached) : [];
      return new Response(renderAdminPage(articles), {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'Set-Cookie': 'kx-editor=1; Path=/; Max-Age=604800; SameSite=Lax',
        },
      });
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
    const cron = event.cron;
    if (cron === '*/5 * * * *') {
      ctx.waitUntil(matchWatcher(env));
    } else if (cron === '0 4 * * *') {
      ctx.waitUntil(runDailyArchival(env));
    } else if (cron === '0 3 * * 1') {
      ctx.waitUntil(redistillEditorialNotes(env));
    } else {
      ctx.waitUntil(runAllSites(env, ctx));
    }
  },
};

// ─── DAILY ARCHIVAL ──────────────────────────────────────────
async function runDailyArchival(env) {
  const sites = await getActiveSites(env);
  if (!sites || sites.length === 0) return;
  for (const site of sites) {
    try {
      const { archived } = await archiveStaleStories(site.id, env);
      console.log(`Archival [${site.short_code}]: ${archived} stories archived`);
    } catch (e) {
      console.error(`Archival failed [${site.short_code}]:`, e.message);
    }
  }
}

// ─── WEEKLY EDITORIAL NOTES RE-DISTILL ───────────────────────
// Runs every Monday 03:00. Reads all current notes, sends to Claude Sonnet
// to merge overlaps and remove redundancies, then replaces the full set.
async function redistillEditorialNotes(env) {
  const notes = await listEditorialNotes(env);
  const refs  = await getReferenceArticles(env);
  if (notes.length < 3) {
    console.log('REDISTILL: fewer than 3 notes, skipping');
    return;
  }

  const notesText = notes.map(n => `[${n.scope}] ${n.text}`).join('\n');
  const refsText  = refs.length
    ? '\n\nSTİL REFERANSLARI (beğenilen haberlerden çıkarılacak ek prensipler):\n' +
      refs.map(r => `--- ${r.source || 'Referans'} ---\n${r.text.slice(0, 1500)}`).join('\n\n')
    : '';

  const prompt = `Sen Kartalix'in baş editörüsün. Aşağıda birikmiş editöryal yönergeler ve beğenilen referans haberler var.

Görevlerin:
1. Mevcut kuralları sıkıştır: tekrarlananları birleştir, çakışanları en kapsamlı olanla değiştir, başka kurallara dahil olanları sil
2. Referans haberlerden genelleştirilebilir yeni stil/ton/yapı prensipleri çıkar ve ekle
3. Orijinal emredici Türkçe tonunu ve kapsam mantığını koru

MEVCUT KURALLAR:
${notesText}${refsText}

Kapsamlar: global, news, match, transfer, T01, T05, T08b, T09, T10, T11

Sadece JSON döndür — temizlenmiş ve zenginleştirilmiş kural listesi:
[{"scope":"...","text":"..."}]`;

  const res = await callClaude(env, MODEL_GENERATE, prompt, false, 2000);
  const text = extractText(res.content);
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('REDISTILL: no JSON in Claude response');
    return;
  }

  let cleaned;
  try { cleaned = JSON.parse(jsonMatch[0]); } catch(e) {
    console.error('REDISTILL: JSON parse failed');
    return;
  }

  const newNotes = cleaned
    .filter(r => r.scope && r.text?.trim())
    .map(r => ({
      id: crypto.randomUUID(),
      scope: r.scope,
      text: r.text.trim(),
      active: true,
      created_at: new Date().toISOString(),
    }));

  await env.PITCHOS_CACHE.put('editorial:notes', JSON.stringify(newNotes));
  console.log(`REDISTILL: ${notes.length} notes → ${newNotes.length} after consolidation`);
}

// ─── ORCHESTRATOR ────────────────────────────────────────────
async function runAllSites(env, ctx) {
  // Quiet period: 00:00–06:30 Istanbul (UTC+3) — no RSS runs overnight
  const now = new Date();
  const istMin = ((now.getUTCHours() + 3) % 24) * 60 + now.getUTCMinutes();
  if (istMin < 390) { // 390 = 06:30 in minutes
    const hh = String(Math.floor(istMin / 60)).padStart(2, '0');
    const mm = String(istMin % 60).padStart(2, '0');
    console.log(`QUIET PERIOD: ${hh}:${mm} Istanbul — skipping RSS run`);
    return { processed: 0, skipped: 'quiet_period' };
  }

  const { blocked: capBlocked, current: capCurrent, cap: capLimit } = await checkCostCap(env);
  if (capBlocked) {
    console.warn(`COST CAP REACHED: $${capCurrent.toFixed(4)} >= $${capLimit.toFixed(2)} — RSS run skipped`);
    return { processed: 0, skipped: 'cost_cap' };
  }

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

// ─── STANDINGS CONTEXT BUILDER ────────────────────────────────
// Returns a one-paragraph Turkish summary of BJK's standing and the relevant gaps.
function buildStandingsContext(table) {
  if (!table || !Array.isArray(table)) return '';
  const bjk = table.find(r => r.team?.id === 549);
  if (!bjk) return '';
  const rank = bjk.rank;
  const pts  = bjk.points;
  const above = table.find(r => r.rank === rank - 1);
  const below1 = table.find(r => r.rank === rank + 1);
  const below2 = table.find(r => r.rank === rank + 2);

  const gapAbove = above ? above.points - pts : null;
  const gapBelow1 = below1 ? pts - below1.points : null;
  const gapBelow2 = below2 ? pts - below2.points : null;

  const aboveLine = above && gapAbove !== null
    ? `${rank - 1}. ${above.team.name} ${gapAbove} puan önde`
    : '';
  const belowLine = [
    below1 && gapBelow1 !== null ? `${rank + 1}. ${below1.team.name} ${gapBelow1} puan geride` : '',
    below2 && gapBelow2 !== null ? `${rank + 2}. ${below2.team.name} ${gapBelow2} puan geride` : '',
  ].filter(Boolean).join(', ');

  return [
    `Puan durumu: Beşiktaş ${rank}. sırada, ${pts} puan.`,
    aboveLine ? `Üst sıra: ${aboveLine}${gapAbove >= 7 ? ' (erişilemez)' : ' (yetişilebilir)'}` : '',
    belowLine ? `Alt sıralar: ${belowLine}${(gapBelow1 !== null && gapBelow1 <= 6) ? ' — kötü sonuç pozisyon kaybına yol açabilir' : ''}` : '',
  ].filter(Boolean).join(' | ');
}

// ─── OPEN-METEO WEATHER (no auth) ────────────────────────────
async function getMatchWeather(lat, lon) {
  if (!lat || !lon) return null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,windspeed_10m,weathercode&timezone=Europe/Istanbul`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.current || null;
  } catch(e) {
    console.error('getMatchWeather failed:', e.message);
    return null;
  }
}

// ─── GOAL EVENTS (for T10 scorer name) ───────────────────────
async function fetchGoalEvents(fixtureId, env) {
  if (!env.API_FOOTBALL_KEY || !fixtureId) return [];
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures/events?fixture=${fixtureId}&team=549&type=Goal`,
      { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.response || [];
  } catch(e) {
    console.error('fetchGoalEvents failed:', e.message);
    return [];
  }
}

// ─── ALL EVENTS (for Sprint A: T-HT, T-RED, T-VAR, T-OG, T-PEN) ──────────
async function fetchAllEvents(fixtureId, env) {
  if (!env.API_FOOTBALL_KEY || !fixtureId) return [];
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures/events?fixture=${fixtureId}`,
      { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.response || [];
  } catch(e) {
    console.error('fetchAllEvents failed:', e.message);
    return [];
  }
}

// Stable composite ID for a match event — used to track which events have been processed.
function mkEventId(e) {
  return `${e.time?.elapsed || 0}_${e.time?.extra || 0}_${e.type || ''}_${e.detail || ''}_${e.player?.id || e.player?.name || ''}`;
}

// ─── BJK SQUAD KV HELPERS ────────────────────────────────────
// Tokenized player name parts stored after each lineup/player fetch.
// Used by qualifyYouTubeVideo to match broadcast titles without explicit BJK terms.
async function saveBjkSquadTerms(env, players) {
  if (!players || !players.length) return;
  const terms = [...new Set(
    players
      .flatMap(p => (p.name || '').toLowerCase().split(/\s+/))
      .filter(tok => tok.length >= 4)
  )];
  await env.PITCHOS_CACHE.put('bjk:squad', JSON.stringify(terms), { expirationTtl: 86400 });
}

async function getBjkSquadTerms(env) {
  const raw = await env.PITCHOS_CACHE.get('bjk:squad');
  return raw ? JSON.parse(raw) : [];
}

// ─── SOURCE CONFIG (KV-backed, falls back to hardcoded) ──────
async function getRssConfig(env) {
  try {
    const raw = await env.PITCHOS_CACHE.get('config:rss_feeds');
    if (raw) return JSON.parse(raw);
  } catch {}
  return RSS_FEEDS; // fallback to hardcoded
}
async function getYtConfig(env) {
  try {
    const raw = await env.PITCHOS_CACHE.get('config:yt_channels');
    if (raw) return JSON.parse(raw);
  } catch {}
  return YOUTUBE_CHANNELS; // fallback to hardcoded
}

// ─── KV SHAPE HELPERS ────────────────────────────────────────
const P4_SOURCES = new Set([
  'Fotomaç', 'A Haber', 'Sabah Spor', 'Hürriyet', 'Habertürk Spor',
  'A Spor', 'NTV Spor', 'Fanatik', 'Milliyet Spor', 'Sporx', 'Ajansspor',
  'Duhuliye',
]);
const isP4 = a => !!(a.is_p4 || P4_SOURCES.has(a.source_name || a.source || ''));
const toKVShape = a => ({
  title:               a.title        || '',
  summary:             a.summary      || a.description || '',
  full_body:           a.full_body && a.full_body.length > 300
    ? sanitizeBodyHtml(a.full_body).slice(0, 8000)
    : (a.summary || a.description || ''),
  source:              a.source       || a.source_name || '',
  source_name:         a.source_name  || a.source || '',
  source_emoji:        a.source_emoji || '',
  source_url:          a.url          || a.original_url || '',
  url:                 a.url          || a.original_url || '',
  category:            a.category     || 'Haber',
  nvs:                 a.nvs          || a.nvs_score   || 0,
  golden_score:        a.golden_score || null,
  published_at:        a.published_at || a.fetched_at  || new Date().toISOString(),
  is_fresh:            a.is_fresh     ?? true,
  is_kartalix_content: a.is_kartalix_content || false,
  is_p4:               isP4(a),
  sport:               a.sport        || 'football',
  publish_mode:        a.publish_mode || 'rss_summary',
  image_url:           '',
  template_id:         a.template_id  || null,
  fixture_id:          a.fixture_id   || null,
  slug:                a.slug || generateSlug(a.title, a.published_at || a.fetched_at),
});

// ─── MATCH WATCHER ────────────────────────────────────────────
// Runs every 5 minutes. Active only in the 3h-before to 2h-after match window.
// Fires T09 (lineup), T10 (goals), T11/T12/T13/T-XG (FT) as soon as API reflects them.
async function matchWatcher(env) {
  // Strategy: try getLiveFixture first (covers match-in-progress where getNextFixture
  // returns the NEXT scheduled match, not tonight's). Fall back to getNextFixture for
  // the pre-match window, then to NEXT_MATCH hardcoded config.
  let nextMatch = NEXT_MATCH;
  let knownLiveFixture = null; // set if already live — avoids double getLiveFixture call

  try {
    const live = await getLiveFixture(env);
    if (live) {
      knownLiveFixture = live;
      nextMatch = {
        ...NEXT_MATCH,
        home:        live.home,
        opponent:    live.opponent,
        opponent_id: live.opponent_id,
        league:      live.league,
        date:        live.date,
        time:        live.time,
        venue:       live.venue       || NEXT_MATCH.venue,
        venue_city:  live.venue_city  || NEXT_MATCH.venue_city,
        match_day:   live.date,
        fixture_id:  live.fixture_id,
        referee:     live.referee     || null,
      };
    } else {
      const fixture = await getNextFixture(env);
      if (fixture) {
        // Only adopt the upcoming fixture if it's within the pre-match window (≤ 3h).
        // If it's further away (e.g. getNextFixture returned next week's match because
        // tonight's match just kicked off), stick with NEXT_MATCH hardcoded fallback.
        const upcomingKickoff = new Date(`${fixture.date}T${fixture.time}:00+03:00`);
        const hrsAway = (upcomingKickoff - new Date()) / (1000 * 60 * 60);
        if (hrsAway <= 3) {
          nextMatch = {
            ...NEXT_MATCH,
            home:        fixture.home,
            opponent:    fixture.opponent,
            opponent_id: fixture.opponent_id,
            league:      fixture.league,
            date:        fixture.date,
            time:        fixture.time,
            venue:       fixture.venue       || NEXT_MATCH.venue,
            venue_city:  fixture.venue_city  || NEXT_MATCH.venue_city,
            match_day:   fixture.date,
            fixture_id:  fixture.fixture_id,
            referee:     fixture.referee     || null,
          };
        }
      }
    }
  } catch(e) { console.error('matchWatcher: fixture lookup failed:', e.message); }

  const matchDateTime   = new Date(`${nextMatch.date}T${nextMatch.time}:00+03:00`);
  const hoursToKickoff  = (matchDateTime - new Date()) / (1000 * 60 * 60);

  if (hoursToKickoff > 3 || hoursToKickoff < -2) {
    console.log(`WATCHER: outside window (${hoursToKickoff.toFixed(1)}h to kickoff), skip`);
    return;
  }

  const { blocked: capBlocked } = await checkCostCap(env);
  if (capBlocked) {
    console.warn('COST CAP REACHED — match watcher skipping template generation');
    return;
  }

  console.log(`WATCHER: active — ${hoursToKickoff.toFixed(2)}h to kickoff (fixture ${nextMatch.fixture_id})${knownLiveFixture ? ' [LIVE]' : ''}`);

  const sites = await getActiveSites(env);
  if (!sites || sites.length === 0) return;
  const site = sites[0];

  // T09 — Confirmed Lineup (API, window: 2h pre to 30min post kickoff)
  if (hoursToKickoff <= 2 && hoursToKickoff >= -0.5) {
    try {
      const t09Key    = `flag:t09:${nextMatch.date}`;
      const t09Exists = await env.PITCHOS_CACHE.get(t09Key);
      if (!t09Exists && nextMatch.fixture_id) {
        console.log('WATCHER T09: querying lineup API...');
        const lineup = await getFixtureLineup(nextMatch.fixture_id, env);
        if (lineup) {
          await saveBjkSquadTerms(env, lineup.startXI || []).catch(() => {});
          const card = await generateConfirmedLineup(nextMatch, lineup, site, env);
          if (card) {
            await env.PITCHOS_CACHE.put(t09Key, '1', { expirationTtl: 86400 });
            const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = raw ? JSON.parse(raw) : [];
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 88, fixture_id: nextMatch.fixture_id, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
            console.log('WATCHER KV WRITE T09: done');
          }
        } else {
          console.log('WATCHER T09: lineup not yet available');
        }
      }
    } catch(e) { console.error('WATCHER T09 failed:', e.message); }
  }

  // T-REF — Referee Profile (check in window if still unfired)
  if (hoursToKickoff > 0 && hoursToKickoff <= 3) {
    try {
      const trefKey    = `flag:tref:${nextMatch.date}`;
      const trefExists = await env.PITCHOS_CACHE.get(trefKey);
      if (!trefExists && nextMatch.referee) {
        console.log(`WATCHER T-REF: referee ${nextMatch.referee}, generating profile...`);
        const recentFixtures = await getLastFixtures(env, 10);
        const refMatches = recentFixtures.filter(f => f.referee === nextMatch.referee);
        const refStats = refMatches.length > 0 ? {
          bjk_games:  refMatches.length,
          bjk_wins:   refMatches.filter(f => f.score_bjk > f.score_opp).length,
          bjk_draws:  refMatches.filter(f => f.score_bjk === f.score_opp).length,
          bjk_losses: refMatches.filter(f => f.score_bjk < f.score_opp).length,
        } : null;
        const card = await generateRefereeProfile(nextMatch, nextMatch.referee, refStats, site, env);
        if (card) {
          await env.PITCHOS_CACHE.put(trefKey, '1', { expirationTtl: 86400 });
          const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
          const latest = raw ? JSON.parse(raw) : [];
          const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 65, fixture_id: nextMatch.fixture_id, is_kartalix_content: true, is_template: true });
          await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
          console.log('WATCHER KV WRITE T-REF: done');
        }
      }
    } catch(e) { console.error('WATCHER T-REF failed:', e.message); }
  }

  // T10/T11/T12/T13/T-XG — live + post-match (window: 30min pre to 2h post kickoff)
  if (hoursToKickoff <= 0.5) {
    try {
      // knownLiveFixture is set if we already fetched it above; avoids double API call
      let liveFixture = knownLiveFixture || await getLiveFixture(env);

      // ?live=all drops FT matches — once the whistle blows, getLiveFixture returns null.
      // Fall back to direct fixture lookup so we can detect is_finished and fire T11/T12/T13.
      if (!liveFixture && hoursToKickoff < 0 && nextMatch.fixture_id) {
        const liveStateRaw = await env.PITCHOS_CACHE.get('match:BJK:live');
        const priorState   = liveStateRaw ? JSON.parse(liveStateRaw) : null;
        if (priorState && !priorState.result_published) {
          const ftCheck = await getFixture(nextMatch.fixture_id, env);
          if (ftCheck?.is_finished) {
            console.log('WATCHER: FT detected via direct fixture lookup (was not in ?live=all)');
            liveFixture = ftCheck;
          }
        }
      }

      if (liveFixture) {
        const liveStateRaw = await env.PITCHOS_CACHE.get('match:BJK:live');
        const liveState    = liveStateRaw
          ? JSON.parse(liveStateRaw)
          : { score_bjk: 0, score_opp: 0, result_published: false };

        // T10 — BJK goal detected
        if ((liveFixture.score_bjk ?? 0) > (liveState.score_bjk ?? 0)) {
          console.log(`WATCHER T10: BJK scored! ${liveState.score_bjk} → ${liveFixture.score_bjk}`);
          const goalEvents = await fetchGoalEvents(liveFixture.fixture_id, env);
          if (goalEvents.length === 0) {
            // Events API hasn't caught up yet — hold score_bjk in KV so the next tick
            // re-triggers this block. Guard: if we've waited ≥ 3 ticks (15 min), give up.
            const waitTicks = (liveState.goal_wait_ticks || 0) + 1;
            if (waitTicks < 3) {
              console.log(`WATCHER T10: events not ready yet (tick ${waitTicks}/3), holding score — retry next tick`);
              liveState._hold_score = true;
              liveState.goal_wait_ticks = waitTicks;
            } else {
              console.log('WATCHER T10: events still empty after 3 ticks — skipping goal flash to avoid bad article');
              liveState.goal_wait_ticks = 0;
            }
          } else {
            liveState.goal_wait_ticks = 0;
            const latestGoal = goalEvents[goalEvents.length - 1];
            const matchObj = { ...nextMatch, score_bjk: liveFixture.score_bjk, score_opp: liveFixture.score_opp };
            const card = await generateGoalFlash(matchObj, latestGoal, site, env);
            if (card) {
              const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const latest = raw ? JSON.parse(raw) : [];
              const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 90, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true });
              await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
              console.log('WATCHER KV WRITE T10: done');
            }
          }
        }

        // ── Sprint A: T-HT, T-RED, T-VAR, T-OG, T-PEN ────────────
        // Fetch all events once; reuse for all Sprint A checks.
        if (!liveFixture.is_finished) {
          try {
            const allEvents   = await fetchAllEvents(liveFixture.fixture_id, env);
            const seenIds     = new Set(liveState.seen_event_ids || []);
            const matchObj    = { ...nextMatch, score_bjk: liveFixture.score_bjk, score_opp: liveFixture.score_opp };
            const newSeenIds  = [];

            // T-HT — halftime status
            if (liveFixture.status === 'HT' && !liveState.ht_published) {
              try {
                const htCard = await generateHalftimeReport(matchObj, allEvents, site, env);
                if (htCard) {
                  liveState.ht_published = true;
                  const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = raw ? JSON.parse(raw) : [];
                  await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...htCard, nvs: 85, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true }), ...latest], 100));
                  console.log('WATCHER KV WRITE T-HT: done');
                }
              } catch(e) { console.error('WATCHER T-HT failed:', e.message); }
            }

            // Scan events for T-RED, T-VAR, T-OG, T-PEN
            for (const ev of allEvents) {
              const eid = mkEventId(ev);
              if (seenIds.has(eid)) continue;
              newSeenIds.push(eid);

              try {
                // T-RED — red card (any team)
                if (ev.type === 'Card' && (ev.detail === 'Red Card' || ev.detail === 'Yellow Red Card')) {
                  const card = await generateRedCardFlash(matchObj, ev, site, env);
                  if (card) {
                    const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                    const latest = raw ? JSON.parse(raw) : [];
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 88, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true }), ...latest], 100));
                    console.log(`WATCHER KV WRITE T-RED: ${ev.player?.name}`);
                  }
                }
                // T-VAR — any VAR event
                else if (ev.type === 'Var') {
                  const card = await generateVARFlash(matchObj, ev, site, env);
                  if (card) {
                    const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                    const latest = raw ? JSON.parse(raw) : [];
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 85, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true }), ...latest], 100));
                    console.log(`WATCHER KV WRITE T-VAR: ${ev.detail}`);
                  }
                }
                // T-OG — BJK player scoring an own goal (opponent benefits, score_opp increases)
                else if (ev.type === 'Goal' && ev.detail === 'Own Goal' && ev.team?.id !== 549) {
                  const card = await generateGoalFlash(matchObj, ev, site, env);
                  if (card) {
                    const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                    const latest = raw ? JSON.parse(raw) : [];
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 85, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true }), ...latest], 100));
                    console.log(`WATCHER KV WRITE T-OG: ${ev.player?.name}`);
                  }
                }
                // T-PEN — missed penalty (any team)
                else if (ev.type === 'Goal' && ev.detail === 'Missed Penalty') {
                  const card = await generateMissedPenaltyFlash(matchObj, ev, site, env);
                  if (card) {
                    const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                    const latest = raw ? JSON.parse(raw) : [];
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 82, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true }), ...latest], 100));
                    console.log(`WATCHER KV WRITE T-PEN: ${ev.player?.name}`);
                  }
                }
              } catch(e) { console.error(`WATCHER Sprint A event failed [${eid}]:`, e.message); }
            }

            // Merge new event IDs into seen set for KV persistence
            liveState.seen_event_ids = [...seenIds, ...newSeenIds];
          } catch(e) { console.error('WATCHER Sprint A block failed:', e.message); }
        }

        // T11 + T12 + T13 + T-XG — fired once on FT
        if (liveFixture.is_finished && !liveState.result_published) {
          console.log('WATCHER T11: match finished, generating post-match suite...');
          const [players, stats, events] = await Promise.all([
            getFixturePlayers(liveFixture.fixture_id, env),
            getFixtureStats(liveFixture.fixture_id, env),
            getFixtureEvents(liveFixture.fixture_id, env).catch(() => []),
          ]);
          await saveBjkSquadTerms(env, players).catch(() => {});

          const t11card = await generateResultFlash(liveFixture, players, site, env, events);
          if (t11card) {
            liveState.result_published = true;
            const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = raw ? JSON.parse(raw) : [];
            const kvCard = toKVShape({ ...t11card, nvs: t11card.nvs_score || 88, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
            console.log('WATCHER KV WRITE T11: done');
          }

          try {
            const t13card = await generateManOfTheMatch(liveFixture, players, site, env);
            if (t13card) {
              const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const latest = raw ? JSON.parse(raw) : [];
              const kvCard = toKVShape({ ...t13card, nvs: t13card.nvs_score || 80, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true });
              await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
              console.log('WATCHER KV WRITE T13: done');
            }
          } catch(e) { console.error('WATCHER T13 failed:', e.message); }

          try {
            const t12card = await generateMatchReport(liveFixture, players, stats, site, env, events);
            if (t12card) {
              const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const latest = raw ? JSON.parse(raw) : [];
              const kvCard = toKVShape({ ...t12card, nvs: t12card.nvs_score || 85, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true });
              await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
              console.log('WATCHER KV WRITE T12: done');
            }
          } catch(e) { console.error('WATCHER T12 failed:', e.message); }

          try {
            if (stats?.xg != null) {
              const xgDelta = Math.abs((liveFixture.score_bjk ?? 0) - parseFloat(stats.xg));
              console.log(`WATCHER T-XG: delta=${xgDelta.toFixed(2)}`);
              if (xgDelta > 1.2) {
                const xgCard = await generateXGDelta(liveFixture, stats, site, env);
                if (xgCard) {
                  const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = raw ? JSON.parse(raw) : [];
                  const kvCard = toKVShape({ ...xgCard, nvs: xgCard.nvs_score || 78, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
                  console.log('WATCHER KV WRITE T-XG: done');
                }
              }
            }
          } catch(e) { console.error('WATCHER T-XG failed:', e.message); }
        }

        await env.PITCHOS_CACHE.put('match:BJK:live', JSON.stringify({
          fixture_id:       liveFixture.fixture_id,
          // Hold the previous score if events weren't ready, so next tick re-triggers T10
          score_bjk:        liveState._hold_score ? (liveState.score_bjk ?? 0) : (liveFixture.score_bjk ?? 0),
          score_opp:        liveFixture.score_opp ?? 0,
          status:           liveFixture.status,
          result_published: liveState.result_published,
          goal_wait_ticks:  liveState.goal_wait_ticks || 0,
          ht_published:     liveState.ht_published    || false,
          seen_event_ids:   liveState.seen_event_ids  || [],
        }));
      } else {
        console.log('WATCHER: no live fixture found');
      }
    } catch(e) { console.error('WATCHER live detection failed:', e.message); }
  }

  // ── MATCH-WINDOW YOUTUBE INTAKE ────────────────────────────
  // During ±2h of kickoff, run YouTube every ~10 min (WATCHER fires every 5 min;
  // KV gate prevents running more often than requested).
  if (hoursToKickoff >= -2 && hoursToKickoff <= 2) {
    try {
      const throttleKey = 'yt:watcher_last_fetch';
      const lastFetch   = await env.PITCHOS_CACHE.get(throttleKey);
      if (!lastFetch) {
        await env.PITCHOS_CACHE.put(throttleKey, '1', { expirationTtl: 600 }); // 10-min TTL
        const seenUrls        = await getSeenUrls(env, site.id);
        const watcherRecent   = await getLastFixtures(env, 3).catch(() => []);
        const watcherSuperLig = watcherRecent.find(f => f.league?.includes('Süper Lig')) || null;
        const published = await processYouTubeVideos(site, env, seenUrls, nextMatch, watcherSuperLig).catch(e => {
          console.error('WATCHER YT intake failed:', e.message);
          return 0;
        });
        console.log(`WATCHER YT: ${published} video(s) embedded`);
      } else {
        console.log('WATCHER YT: throttled, next fetch in ~10 min');
      }
    } catch(e) { console.error('WATCHER YT throttle failed:', e.message); }
  }
}

// ─── YOUTUBE INTAKE ──────────────────────────────────────────
// Runs once per processSite call. Fetches all 5 channels in parallel,
// qualifies by keyword rules, generates embed articles for new videos.
// Max 2 embeds per channel per run to avoid feed flooding.
// nextMatch:   upcoming fixture — enables match-specific templates for Süper Lig.
// recentMatch: last completed Süper Lig fixture — catches post-match content when nextMatch is cup/other.
async function processYouTubeVideos(site, env, seenUrls, nextMatch = null, recentMatch = null) {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const ytChannels = await getYtConfig(env);
  const feeds = await Promise.all(ytChannels.map(ch => fetchYouTubeChannel(ch, since).catch(() => [])));

  let published = 0;
  for (let i = 0; i < ytChannels.length; i++) {
    const channel = ytChannels[i];
    const videos  = feeds[i];

    // Hard filter: drop #shorts, archive re-uploads, already-seen
    const candidates = videos.filter(v => {
      return qualifyYouTubeVideo(v) && !seenUrls.has(`https://www.youtube.com/watch?v=${v.video_id}`);
    });

    // Official channel: always qualifies — all content is BJK
    const official = candidates.filter(v => v.channel_tier === 'official');

    // Broadcast/digital: run through scoreArticles (same scorer as RSS)
    // relevant:false → drop; rival_pov or nvs < 20 → drop
    const others = candidates.filter(v => v.channel_tier !== 'official');
    let relevantOthers = [];
    if (others.length > 0) {
      const asArticles = others.map(v => ({
        title:        v.title,
        summary:      v.description || '',
        source_name:  v.channel_name,
        published_at: v.published_at,
        trust_tier:   'broadcast',
      }));
      const { articles: scored } = await scoreArticles(asArticles, site, env).catch(() => ({ articles: [] }));
      relevantOthers = others.filter((_, idx) =>
        scored[idx]?.relevant !== false && !scored[idx]?.rival_pov && (scored[idx]?.nvs ?? 50) >= 20
      );
    }

    const newVids = [...official, ...relevantOthers];
    console.log(`YT ${channel.name}: ${videos.length} fetched → ${newVids.length} qualified`);

    for (const video of newVids.slice(0, 2)) {
      const ytUrl = `https://www.youtube.com/watch?v=${video.video_id}`;

      // ── PATH A: Embed article (iframe + short intro) ──────────
      if (video.embed_qualify !== false) {
        try {
          const matchType = classifyMatchVideo(video, nextMatch, recentMatch);
          const matchCtx  = matchType
            ? (nextMatch?.league?.includes('Süper Lig') ? nextMatch : recentMatch)
            : null;
          const card = matchType
            ? await generateMatchVideoEmbed(video, matchType, matchCtx, site, env)
            : await generateVideoEmbed(video, site, env);
          if (card) {
            const raw     = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const current = raw ? JSON.parse(raw) : [];
            const kvCard  = toKVShape({ ...card, nvs: card.nvs_score || 72, fixture_id: (matchCtx || nextMatch)?.fixture_id || null, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...current], 100));
            published++;
            if (matchType) console.log(`YT embed [${matchType}]: ${video.title}`);
          }
        } catch (e) {
          console.error(`YT embed failed [${video.video_id}]:`, e.message);
        }
      }

      // ── PATH B: Description → synthesis source ────────────────
      // Uses video.description from the Atom feed — no extra request needed.
      // YouTube blocks transcript access from cloud IPs; description has enough
      // context (match result, key facts) for synthesis on broadcast channels.
      // Skip if description is too short (e.g. "join channel" boilerplate).
      if (video.transcript_qualify && !seenUrls.has(ytUrl)) {
        try {
          const synthKey = `synth:yt:${video.video_id}`;
          const already  = await env.PITCHOS_CACHE.get(synthKey);
          const desc = (video.description || '').trim();
          if (!already && desc.length >= 80) {
            const source = {
              title:        video.title,
              summary:      `${video.title}\n${desc}`,
              source_name:  video.channel_name,
              published_at: video.published_at,
              nvs:          70,
              category:     'Match',
              is_p4:        false,
            };
            const origNews = await generateOriginalNews([source], site, env);
            if (origNews) {
              await env.PITCHOS_CACHE.put(synthKey, '1', { expirationTtl: 86400 });
              const raw     = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const current = raw ? JSON.parse(raw) : [];
              await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape(origNews), ...current], 100));
              console.log(`YT desc synthesis: "${video.title?.slice(0, 50)}"`);
              published++;
            }
          }
        } catch (e) {
          console.error(`YT desc synthesis failed [${video.video_id}]:`, e.message);
        }
      }

      seenUrls.add(ytUrl);
    }
  }
  console.log(`YT INTAKE: ${published} embed/synthesis articles`);
  return published;
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
  // fetchBJKOfficial disabled — bjk.com.tr blocks all datacenter IPs (direct, pitchos-proxy, allorigins).
  // Official BJK content will arrive via @Besiktas Twitter in Slice 4.
  const rssFeeds = await getRssConfig(env);
  const [{ articles: rssArticles, bySource }, { articles: webArticles, usage: fetchUsage }, { articles: beINArticles, usage: beINUsage }, { articles: twitterArticles, usage: twitterUsage }] = await Promise.all([
    fetchRSSArticles(site, rssFeeds),
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
    category:     scored[i]?.category     || orig.category || 'Club',
    content_type: scored[i]?.content_type || 'unknown',
    nvs_notes:    scored[i]?.nvs_notes    || '',
    golden_score: scored[i]?.golden_score || null,
  }));
  stats.claudeCalls++;
  addUsagePhase(stats, scoreUsage, MODEL_SCORE, 'scout');

  const sortedScored = mergedScored.sort((a, b) => (b.nvs || 0) - (a.nvs || 0));
  const storyDeduped = dedupeByStory(sortedScored);
  const top100 = storyDeduped.slice(0, 100);
  stats.scored           = top100.length;
  stats.rejected         = mergedScored.length - storyDeduped.length + (storyDeduped.length > 100 ? storyDeduped.length - 100 : 0);
  funnelStats.scored     = mergedScored.length;
  funnelStats.after_story_dedup = storyDeduped.length;
  console.log(`${site.short_code}: scored ${mergedScored.length} → story-deduped ${storyDeduped.length} → top 100 NVS: ${top100.map(a => a.nvs).join(', ')}`);

  // ── IT3 BLOCK ─────────────────────────────────────────────────
  // All scraped RSS images are stripped until Slice 5 ships the IT-tier system.
  // Only defensible images are IT2 embeds (official social media iframes) and IT6
  // generated cards — neither comes from scraped image_url fields.
  // P4 flag is still tracked for firewall/lineage purposes.

  // ── KV WRITE IMMEDIATELY (before templates, enrichment, Supabase) ──
  // Only Kartalix-generated content (templates + original synthesis) appears in the feed.
  // Raw RSS/P4 articles are inputs only — they go to Supabase for processing but not to KV.
  const existing = await getCachedArticles(env, site.short_code);
  let existingKartalix = existing.filter(a => a.is_kartalix_content || a.is_template);

  // Bootstrap guard: if KV is empty (first run after migration, or TTL expiry),
  // pull recent published Kartalix articles from Supabase to reseed the feed.
  if (existingKartalix.length === 0) {
    try {
      const recentRows = await supabase(env, 'GET',
        `/rest/v1/content_items?site_id=eq.${site.id}&source_name=eq.Kartalix&status=eq.published&order=published_at.desc&limit=30&select=*`
      );
      if (recentRows?.length) {
        existingKartalix = recentRows.map(a => toKVShape({
          ...a, nvs: a.nvs_score, is_kartalix_content: true,
          publish_mode: a.publish_mode || 'original_synthesis',
        }));
        console.log(`KV BOOTSTRAP: reseeded ${existingKartalix.length} articles from Supabase`);
      }
    } catch(e) { console.error('KV bootstrap failed:', e.message); }
  }

  const immediateKV = existingKartalix.slice(0, 100);
  await cacheToKV(env, site.short_code, immediateKV);
  console.log('KV WRITE IMMEDIATE: done', immediateKV.length, 'kartalix articles (raw RSS excluded)');

  // ── BACKGROUND WORK: templates + supabase (after KV is safe) ─
  const backgroundWork = async () => {
    // Fetch next fixture from API-Football (replaces hardcoded NEXT_MATCH)
    let nextMatch = NEXT_MATCH; // fallback to hardcoded if API fails
    try {
      const liveFixture = await getNextFixture(env);
      if (liveFixture) {
        nextMatch = {
          home:           liveFixture.home,
          team:           'Beşiktaş',
          team_short:     'BJK',
          opponent:       liveFixture.opponent,
          opponent_short: liveFixture.opponent,
          league:         liveFixture.league,
          week:           parseInt((liveFixture.round || '').match(/(\d+)/)?.[1] || '0') || NEXT_MATCH.week,
          date:           liveFixture.date,
          time:           liveFixture.time,
          venue:          liveFixture.venue || NEXT_MATCH.venue,
          venue_city:     liveFixture.venue_city || NEXT_MATCH.venue_city,
          venue_lat:      NEXT_MATCH.venue_lat,  // API-Football doesn't provide coords
          venue_lon:      NEXT_MATCH.venue_lon,
          tv:             NEXT_MATCH.tv,          // not in API, keep hardcoded
          match_day:      liveFixture.date,
          cup:            null,
          fixture_id:     liveFixture.fixture_id,
          opponent_id:    liveFixture.opponent_id,
          referee:        liveFixture.referee || null,
        };
        console.log(`NEXT MATCH (API): ${nextMatch.opponent} on ${nextMatch.date} ${nextMatch.time}`);
      }
    } catch(e) { console.error('getNextFixture failed, using fallback:', e.message); }

    // Template 05 — Match Day Card (API injuries, not RSS)
    try {
      const today = new Date().toISOString().split('T')[0];
      if (nextMatch.match_day === today && !immediateKV.find(a => a.template_id === '05')) {
        console.log('TEMPLATE 05: generating...');
        const injuries = nextMatch.fixture_id ? await getInjuries(env, nextMatch.fixture_id) : [];
        const card = await generateMatchDayCard(nextMatch, preFiltered, site, env, injuries);
        if (card) {
          const withT = mergeAndDedupe([toKVShape(card), ...immediateKV], 100);
          await cacheToKV(env, site.short_code, withT);
          console.log('KV WRITE WITH TEMPLATE 05: done');
        }
      }
    } catch(e) { console.error('Template 05 failed:', e.message); }

    // Template 08b — Probable Lineup (RSS-driven, stays RSS — API has no probable lineups)
    try {
      const matchDateTime = new Date(`${nextMatch.date}T${nextMatch.time}:00+03:00`);
      const hoursToKickoff = (matchDateTime - new Date()) / (1000 * 60 * 60);

      if (hoursToKickoff <= 24 && hoursToKickoff > 3 && !immediateKV.find(a => a.template_id === '08b')) {
        console.log('TEMPLATE 08b: checking for muhtemel 11...');
        const card = await generateMuhtemel11(nextMatch, preFiltered, site, env);
        if (card) {
          const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
          const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
          await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape(card), ...latest], 100));
          console.log('KV WRITE WITH TEMPLATE 08b: done');
        }
      }

      // Template 09 — Confirmed Lineup (API-driven — no RSS scanning)
      // getFixtureLineup returns null until teams submit (~60min before kickoff).
      // Window extends to -0.5h (30 min into match) to catch late cron ticks.
      if (hoursToKickoff <= 2 && hoursToKickoff >= -0.5 && !immediateKV.find(a => a.template_id === '09')) {
        console.log('TEMPLATE 09: querying API for confirmed lineup...');
        const lineup = nextMatch.fixture_id ? await getFixtureLineup(nextMatch.fixture_id, env) : null;
        if (lineup) {
          const card = await generateConfirmedLineup(nextMatch, lineup, site, env);
          if (card) {
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, fixture_id: nextMatch.fixture_id }), ...latest], 100));
            console.log('KV WRITE WITH TEMPLATE 09: done');
          }
        } else {
          console.log('TEMPLATE 09: lineup not yet available from API');
        }
      }
    } catch(e) { console.error('Template 08b/09 failed:', e.message); }

    // T02 H2H History — fires once per match in the 24–72h window
    try {
      const t02Key = `flag:t02:${nextMatch.date}`;
      const t02Exists = await env.PITCHOS_CACHE.get(t02Key);
      if (!t02Exists && nextMatch.opponent_id) {
        const matchDateTime = new Date(`${nextMatch.date}T${nextMatch.time}:00+03:00`);
        const hoursToKickoff = (matchDateTime - new Date()) / (1000 * 60 * 60);
        if (hoursToKickoff > 0 && hoursToKickoff <= 72) {
          console.log(`TEMPLATE T02: ${hoursToKickoff.toFixed(1)}h to kickoff — generating H2H history...`);
          const h2h = await getH2H(nextMatch.opponent_id, env);
          const card = await generateH2HHistory(nextMatch, h2h, site, env);
          if (card) {
            await env.PITCHOS_CACHE.put(t02Key, '1', { expirationTtl: 86400 });
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 72, fixture_id: nextMatch.fixture_id, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
            console.log('KV WRITE WITH T02: done');
          }
        }
      }
    } catch(e) { console.error('Template T02 failed:', e.message); }

    // T07 Injury & Suspension Report — fires once per match in the 24–48h window
    try {
      const t07Key = `flag:t07:${nextMatch.date}`;
      const t07Exists = await env.PITCHOS_CACHE.get(t07Key);
      if (!t07Exists) {
        const matchDateTime = new Date(`${nextMatch.date}T${nextMatch.time}:00+03:00`);
        const hoursToKickoff = (matchDateTime - new Date()) / (1000 * 60 * 60);
        if (hoursToKickoff > 0 && hoursToKickoff <= 48) {
          console.log(`TEMPLATE T07: ${hoursToKickoff.toFixed(1)}h to kickoff — generating injury report...`);
          const injuries = await getInjuries(env, nextMatch.fixture_id);
          const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
          const rssArticles = (latestRaw ? JSON.parse(latestRaw) : immediateKV)
            .filter(a => a.template_id !== 'T07' && !a.is_kartalix_content);
          const card = await generateInjuryReport(nextMatch, injuries, rssArticles, site, env);
          if (card) {
            await env.PITCHOS_CACHE.put(t07Key, '1', { expirationTtl: 86400 });
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 75, fixture_id: nextMatch.fixture_id, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...rssArticles], 100));
            console.log('KV WRITE WITH T07: done');
          }
        }
      }
    } catch(e) { console.error('Template T07 failed:', e.message); }

    // T-REF Referee Profile — fires once per match in the 24–48h window
    try {
      const trefKey = `flag:tref:${nextMatch.date}`;
      const trefExists = await env.PITCHOS_CACHE.get(trefKey);
      if (!trefExists) {
        const matchDateTime = new Date(`${nextMatch.date}T${nextMatch.time}:00+03:00`);
        const hoursToKickoff = (matchDateTime - new Date()) / (1000 * 60 * 60);
        if (hoursToKickoff > 0 && hoursToKickoff <= 48) {
          const referee = nextMatch.referee || null;
          if (referee) {
            console.log(`TEMPLATE T-REF: ${hoursToKickoff.toFixed(1)}h to kickoff — referee: ${referee}`);
            // Compute ref stats from last 10 BJK fixtures
            const recentFixtures = await getLastFixtures(env, 10);
            const refMatches = recentFixtures.filter(f => f.referee === referee);
            const refStats = refMatches.length > 0 ? {
              bjk_games:  refMatches.length,
              bjk_wins:   refMatches.filter(f => f.score_bjk > f.score_opp).length,
              bjk_draws:  refMatches.filter(f => f.score_bjk === f.score_opp).length,
              bjk_losses: refMatches.filter(f => f.score_bjk < f.score_opp).length,
            } : null;
            const card = await generateRefereeProfile(nextMatch, referee, refStats, site, env);
            if (card) {
              await env.PITCHOS_CACHE.put(trefKey, '1', { expirationTtl: 86400 });
              const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
              const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 65, fixture_id: nextMatch.fixture_id, is_kartalix_content: true, is_template: true });
              await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
              console.log('KV WRITE WITH T-REF: done');
            }
          } else {
            console.log('T-REF: referee not yet assigned for this fixture, skipping');
          }
        }
      }
    } catch(e) { console.error('Template T-REF failed:', e.message); }

    // T03 Form Guide — fires once per match in the 48–72h window
    try {
      const t03Key = `flag:t03:${nextMatch.date}`;
      const t03Exists = await env.PITCHOS_CACHE.get(t03Key);
      if (!t03Exists) {
        const matchDateTime = new Date(`${nextMatch.date}T${nextMatch.time}:00+03:00`);
        const hoursToKickoff = (matchDateTime - new Date()) / (1000 * 60 * 60);
        if (hoursToKickoff > 0 && hoursToKickoff <= 72) {
          console.log(`TEMPLATE T03: ${hoursToKickoff.toFixed(1)}h to kickoff — generating form guide...`);
          const [recent, table] = await Promise.all([
            getLastFixtures(env, 5),
            getStandings(env),
          ]);
          const bjkRow = table ? table.find(r => r.team?.id === 549) : null;
          const card = await generateFormGuide(nextMatch, recent, bjkRow, site, env);
          if (card) {
            await env.PITCHOS_CACHE.put(t03Key, '1', { expirationTtl: 86400 });
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 70, fixture_id: nextMatch.fixture_id, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
            console.log('KV WRITE WITH T03: done');
          }
        }
      }
    } catch(e) { console.error('Template T03 failed:', e.message); }

    // T01 Match Preview — fires once per match in the 0–48h window
    try {
      const t01Key = `flag:t01:${nextMatch.date}`;
      const t01Exists = await env.PITCHOS_CACHE.get(t01Key);
      if (!t01Exists) {
        const matchDateTime = new Date(`${nextMatch.date}T${nextMatch.time}:00+03:00`);
        const hoursToKickoff = (matchDateTime - new Date()) / (1000 * 60 * 60);
        if (hoursToKickoff > 0 && hoursToKickoff <= 48) {
          console.log(`TEMPLATE T01: ${hoursToKickoff.toFixed(1)}h to kickoff — generating match preview...`);
          const [h2h, weather, table] = await Promise.all([
            nextMatch.opponent_id ? getH2H(nextMatch.opponent_id, env) : Promise.resolve([]),
            getMatchWeather(nextMatch.venue_lat, nextMatch.venue_lon),
            getStandings(env),
          ]);
          const standingsCtx = buildStandingsContext(table);
          const card = await generateMatchPreview(nextMatch, h2h, weather, standingsCtx, site, env);
          if (card) {
            await env.PITCHOS_CACHE.put(t01Key, '1', { expirationTtl: 86400 });
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 82, fixture_id: nextMatch.fixture_id, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
            console.log('KV WRITE WITH TEMPLATE T01: done');
          }
        }
      }
    } catch(e) { console.error('Template T01 failed:', e.message); }

    // T10 Goal Flash + T11 Result Flash — live match detection
    try {
      const today = new Date().toISOString().split('T')[0];
      if (nextMatch.date === today) {
        const matchStart = new Date(`${nextMatch.date}T${nextMatch.time}:00+03:00`);
        const hoursFromKickoff = (new Date() - matchStart) / (1000 * 60 * 60);
        // Only poll during the match window (-0.5h pre-kickoff to +3h post)
        if (hoursFromKickoff >= -0.5 && hoursFromKickoff <= 3) {
          const liveFixture = await getLiveFixture(env);
          if (liveFixture) {
            const liveStateRaw = await env.PITCHOS_CACHE.get('match:BJK:live');
            const liveState = liveStateRaw
              ? JSON.parse(liveStateRaw)
              : { score_bjk: 0, score_opp: 0, result_published: false };

            // T10 — new BJK goal detected
            if ((liveFixture.score_bjk ?? 0) > (liveState.score_bjk ?? 0)) {
              console.log(`T10: BJK scored! ${liveState.score_bjk} → ${liveFixture.score_bjk}`);
              const goalEvents = await fetchGoalEvents(liveFixture.fixture_id, env);
              if (goalEvents.length === 0) {
                // Events API lag — hold score in KV so watcher's next 5-min tick re-triggers
                console.log('T10: events not ready yet, holding score for watcher retry');
                liveState._hold_score = true;
              } else {
                const latestGoal = goalEvents[goalEvents.length - 1];
                const matchObj = { ...nextMatch, score_bjk: liveFixture.score_bjk, score_opp: liveFixture.score_opp };
                const card = await generateGoalFlash(matchObj, latestGoal, site, env);
                if (card) {
                  const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                  const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 90, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
                  console.log('KV WRITE WITH TEMPLATE T10: done');
                }
              }
            }

            // T11 + T12 + T13 — match finished, fire once
            if (liveFixture.is_finished && !liveState.result_published) {
              console.log('T11: match finished — generating result flash...');
              const [players, stats, events] = await Promise.all([
                getFixturePlayers(liveFixture.fixture_id, env),
                getFixtureStats(liveFixture.fixture_id, env),
                getFixtureEvents(liveFixture.fixture_id, env).catch(() => []),
              ]);
              await saveBjkSquadTerms(env, players).catch(() => {});
              const card = await generateResultFlash(liveFixture, players, site, env, events);
              if (card) {
                liveState.result_published = true;
                const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 88, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true });
                await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
                console.log('KV WRITE WITH TEMPLATE T11: done');
              }

              // T13 — Man of the Match
              try {
                console.log('T13: generating man of the match...');
                const motmCard = await generateManOfTheMatch(liveFixture, players, site, env);
                if (motmCard) {
                  const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                  const kvCard = toKVShape({ ...motmCard, nvs: motmCard.nvs_score || 80, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
                  console.log('KV WRITE WITH TEMPLATE T13: done');
                }
              } catch(e) { console.error('T13 failed:', e.message); }

              // T12 — Full match report (xG + stats + ratings)
              try {
                console.log('T12: generating match report...');
                const reportCard = await generateMatchReport(liveFixture, players, stats, site, env, events);
                if (reportCard) {
                  const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                  const kvCard = toKVShape({ ...reportCard, nvs: reportCard.nvs_score || 85, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
                  console.log('KV WRITE WITH TEMPLATE T12: done');
                }
              } catch(e) { console.error('T12 failed:', e.message); }

              // T-xG Delta — only when |BJK goals − xG| > 1.2
              try {
                if (stats?.xg != null) {
                  const xgDelta = Math.abs((liveFixture.score_bjk ?? 0) - parseFloat(stats.xg));
                  console.log(`T-XG: delta=${xgDelta.toFixed(2)}`);
                  if (xgDelta > 1.2) {
                    const xgCard = await generateXGDelta(liveFixture, stats, site, env);
                    if (xgCard) {
                      const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                      const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                      const kvCard = toKVShape({ ...xgCard, nvs: xgCard.nvs_score || 78, fixture_id: liveFixture.fixture_id, is_kartalix_content: true, is_template: true });
                      await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
                      console.log('KV WRITE WITH TEMPLATE T-XG: done');
                    }
                  } else {
                    console.log(`T-XG: delta ${xgDelta.toFixed(2)} ≤ 1.2 — threshold not met, skipping`);
                  }
                } else {
                  console.log('T-XG: no xG data available, skipping');
                }
              } catch(e) { console.error('T-XG failed:', e.message); }
            }

            // Update KV live state — hold score if events weren't ready (so watcher retries T10)
            await env.PITCHOS_CACHE.put('match:BJK:live', JSON.stringify({
              fixture_id:       liveFixture.fixture_id,
              score_bjk:        liveState._hold_score ? (liveState.score_bjk ?? 0) : (liveFixture.score_bjk ?? 0),
              score_opp:        liveFixture.score_opp ?? 0,
              status:           liveFixture.status,
              result_published: liveState.result_published,
              goal_wait_ticks:  liveState.goal_wait_ticks || 0,
              ht_published:     liveState.ht_published    || false,
              seen_event_ids:   liveState.seen_event_ids  || [],
            }));
          }
        }
      }
    } catch(e) { console.error('Live match detection failed:', e.message); }

    // Save to Supabase (best effort) — RSS/P4 articles are inputs only, not published to feed
    try {
      const top100forWrite = top100.slice(0, 100);
      const allWritten = await writeArticles(top100forWrite, site, env);
      console.log(`Write phase: ${allWritten.map(a => a.publish_mode).join(', ')}`);

      const publishThreshold = site.auto_publish_threshold || 30;
      const toPublish = allWritten.filter(a => a.nvs >= publishThreshold && a.publish_mode !== 'hot_news_hold');
      const toQueue   = allWritten.filter(a => a.nvs >= site.review_threshold && a.nvs < publishThreshold && a.publish_mode !== 'hot_news_hold');
      stats.published = toPublish.length;
      stats.queued    = toQueue.length;

      if (toPublish.length > 0) await saveArticles(env, site.id, toPublish, 'published');
      if (toQueue.length > 0)   await saveArticles(env, site.id, toQueue,   'pending');
      await saveSeenHashes(env, site.short_code, toPublish);

      // ── STORY MATCHING ───────────────────────────────────────
      const articlesWithFacts = allWritten.filter(a => a._facts).slice(0, 5);
      if (articlesWithFacts.length > 0) {
        console.log(`Story matching: ${articlesWithFacts.length} articles with extracted facts`);
        let openStories = await getOpenStories(site.id, env);
        for (const article of articlesWithFacts) {
          try {
            const { story, isNew } = await matchOrCreateStory(article, article._facts, site.id, env, openStories);
            console.log(`Story match [${article.title?.slice(0, 40)}]: ${isNew ? 'NEW' : 'MATCHED'} → ${story.id} (conf:${story.confidence} state:${story.state})`);
            if (isNew) openStories = [...openStories, story];
          } catch (e) {
            console.error('Story match failed:', e.message, '| article:', article.title?.slice(0, 40));
          }
        }
      }
    } catch(e) { console.error('Supabase save failed:', e.message); }

    // ── ORIGINAL NEWS SYNTHESIS ────────────────────────────────
    // Generate original Kartalix articles from top P4 sources.
    // Each synthesis call covers one distinct story (storyDeduped already one-per-story).
    // Multi-source: collects any duplicates from mergedScored to give Claude richer context.
    // Cap: 3 new articles per run. Skip match_result/squad (covered by templates).
    const SYNTHESIS_SKIP = new Set(['match_result', 'squad']);
    const p4Pool = storyDeduped.filter(a =>
      (a.nvs || 0) >= 55 && !SYNTHESIS_SKIP.has(a.content_type) && !a.is_kartalix_content
    );
    let synthesisCount = 0;
    for (const primary of p4Pool.slice(0, 8)) {
      if (synthesisCount >= 5) break;
      try {
        const today = new Date().toISOString().slice(0, 10);
        const storyKey = `synth:${simpleHash(primary.title)}:${today}`;
        const already = await env.PITCHOS_CACHE.get(storyKey);
        if (already) continue;

        // Gather related P4 articles on the same story for multi-source context
        const related = mergedScored.filter(a =>
          a !== primary && isP4(a) &&
          titleSimilarity(normalizeTitle(a.title), normalizeTitle(primary.title)) > 0.25
        ).slice(0, 2);

        const origNews = await generateOriginalNews([primary, ...related], site, env);
        if (origNews) {
          await env.PITCHOS_CACHE.put(storyKey, '1', { expirationTtl: 86400 });
          const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
          const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
          const kvCard = toKVShape(origNews);
          await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
          synthesisCount++;
        }
      } catch(e) { console.error('Original synthesis failed:', e.message, '|', primary.title?.slice(0, 50)); }
      await new Promise(r => setTimeout(r, 500));
    }
    if (synthesisCount > 0) console.log(`ORIGINAL NEWS SYNTHESIS: ${synthesisCount} new article(s) published`);

    await logFetch(env, site.id, 'success', stats, null, funnelStats);
    if (stats.costEur > 0) await addCost(env, stats.costEur);

    // ── YOUTUBE INTAKE ─────────────────────────────────────────
    const recentFixtures  = await getLastFixtures(env, 3).catch(() => []);
    const recentSuperLig  = recentFixtures.find(f => f.league?.includes('Süper Lig')) || null;
    await processYouTubeVideos(site, env, seenUrls, nextMatch, recentSuperLig).catch(e => console.error('YT intake failed:', e.message));

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

// ─── MATCH STATS BUILDER ─────────────────────────────────────

const MATCH_STATS_KEYS = [
  { key: 'Ball Possession',   label: 'Top Sahipliği',  bar: true  },
  { key: 'Total Shots',       label: 'Şut',            bar: false },
  { key: 'Shots on Goal',     label: 'İsabetli Şut',   bar: false },
  { key: 'Blocked Shots',     label: 'Engellenen Şut', bar: false },
  { key: 'Goalkeeper Saves',  label: 'Kurtarış',       bar: false },
  { key: 'Corner Kicks',      label: 'Köşe Vuruşu',    bar: false },
  { key: 'Offsides',          label: 'Ofsayt',         bar: false },
  { key: 'Total passes',      label: 'Pas',            bar: false },
  { key: 'Passes accurate',   label: 'İsabetli Pas',   bar: false },
  { key: 'Passes %',          label: 'Pas %',          bar: false },
  { key: 'Fouls',             label: 'Faul',           bar: false },
  { key: 'Yellow Cards',      label: 'Sarı Kart',      bar: false },
  { key: 'Red Cards',         label: 'Kırmızı Kart',   bar: false },
  { key: 'expected_goals',    label: 'xG',             bar: false },
];

async function buildMatchStats(fixtureId, env) {
  const H = { 'x-apisports-key': env.API_FOOTBALL_KEY || '', 'Origin': 'https://app.kartalix.com', 'Referer': 'https://app.kartalix.com/' };
  const apiFetch2 = url => fetch(url, { headers: H, signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null).catch(() => null);

  const [statsRes, eventsRes] = await Promise.all([
    apiFetch2(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`),
    apiFetch2(`https://v3.football.api-sports.io/fixtures/events?fixture=${fixtureId}`),
  ]);

  const teams = statsRes?.response || [];
  if (teams.length < 2) return null;

  // Score from bjk-fixtures KV (free — no extra API call)
  const fixturesRaw = await env.PITCHOS_CACHE.get('widget:bjk-fixtures');
  const allFixtures = fixturesRaw ? [...(JSON.parse(fixturesRaw).past || []), ...(JSON.parse(fixturesRaw).upcoming || [])] : [];
  const fx = allFixtures.find(f => f.id == fixtureId);
  const homeIsFirst = !fx || fx.home?.name === teams[0]?.team?.name;
  const homeScore = fx ? (homeIsFirst ? fx.score?.home : fx.score?.away) : null;
  const awayScore = fx ? (homeIsFirst ? fx.score?.away : fx.score?.home) : null;

  // Events: goals, cards, VAR only
  const rawEvents = eventsRes?.response || [];
  const events = rawEvents
    .filter(e => e.type === 'Goal' || e.type === 'Card' || e.type === 'Var')
    .map(e => {
      const min = `${e.time?.elapsed}${e.time?.extra ? '+' + e.time.extra : ''}`;
      if (e.type === 'Goal') return {
        min, type: 'goal', detail: e.detail,
        icon: e.detail === 'Missed Penalty' ? '❌' : e.detail === 'Own Goal' ? '⚽ (OG)' : e.detail === 'Penalty' ? '⚽ (P)' : '⚽',
        player: e.player?.name || '', assist: e.assist?.name || null,
        team: e.team?.name || '',
      };
      if (e.type === 'Card') return {
        min, type: 'card', detail: e.detail,
        icon: e.detail === 'Red Card' ? '🟥' : e.detail === 'Yellow Card Second Yellow Card' ? '🟥 (2.S)' : '🟨',
        player: e.player?.name || '', team: e.team?.name || '',
        suspended: e.detail === 'Red Card' || e.detail === 'Yellow Card Second Yellow Card',
      };
      if (e.type === 'Var') return {
        min, type: 'var', detail: e.detail,
        icon: '📺', player: e.player?.name || '', team: e.team?.name || '',
      };
      return null;
    })
    .filter(Boolean);

  const pick = (t, key) => t?.statistics?.find(s => s.type === key)?.value ?? 0;
  return JSON.stringify({
    home: { name: teams[0]?.team?.name, logo: teams[0]?.team?.logo, score: homeScore },
    away: { name: teams[1]?.team?.name, logo: teams[1]?.team?.logo, score: awayScore },
    stats: MATCH_STATS_KEYS.map(s => ({ label: s.label, bar: s.bar, home: pick(teams[0], s.key), away: pick(teams[1], s.key) })),
    events,
  });
}

// ─── SPRINT 4: ARTICLE PAGES ─────────────────────────────────

const BASE_URL = 'https://app.kartalix.com';

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

  // Fixture widget: resolve current fixture_id for match template articles
  let fixtureId = null;
  if (article.is_kartalix_content && article.template_id) {
    const liveStateRaw = await env.PITCHOS_CACHE.get('match:BJK:live');
    const liveState = liveStateRaw ? JSON.parse(liveStateRaw) : null;
    fixtureId = liveState?.fixture_id || NEXT_MATCH.fixture_id || null;
  }

  return new Response(renderArticleHTML(article, env.API_FOOTBALL_KEY || '', fixtureId), {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'private, max-age=120',
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
function renderArticleHTML(a, apiKey = '', fixtureId = null) {
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
  const srcUrl      = a.url && a.url.startsWith('http') ? a.url : null;
  const templateId  = a.template_id || null;
  // Derive default admin note scope from article type
  const feedbackScope = templateId || (a.publish_mode?.includes('transfer') ? 'transfer' : a.publish_mode?.includes('match') ? 'match' : 'news');

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
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:16px;line-height:1.7}
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
.article-body p{margin-bottom:1.6rem}
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
.reaction-bar{display:flex;gap:1rem;align-items:center;margin-top:2rem;padding:1rem 1.25rem;background:#222;border:1px solid #333;border-radius:6px}
.rxn-btn{display:flex;align-items:center;gap:.5rem;background:#2a2a2a;border:1px solid #444;color:#ccc;padding:.5rem 1.1rem;border-radius:20px;cursor:pointer;font-size:.9rem;transition:all .15s;user-select:none}
.rxn-btn:hover{border-color:#666;color:#fff;background:#333}
.rxn-btn.active-like{background:#1a3a1a;border-color:#4a4;color:#6d6}
.rxn-btn.active-dislike{background:#3a1a1a;border-color:#a44;color:#e66}
.rxn-count{font-size:.82rem;font-weight:700;min-width:1ch}
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
    ${fixtureId && templateId ? `<div id="matchStatsBox" style="margin:1.5rem 0"></div>
    <script>
    (async function(){
      try {
        const r = await fetch('https://app.kartalix.com/widgets/bjk-match-stats?fixture=${fixtureId}');
        const d = await r.json();
        if (!d.stats || !d.stats.length) return;
        const pct = v => typeof v==='string' && v.includes('%') ? parseInt(v) : null;
        const rows = d.stats.map(s => {
          const hv = s.home ?? 0; const av = s.away ?? 0;
          const hp = pct(hv); const ap = pct(av);
          const barRow = hp !== null ? \`<div style="display:flex;align-items:center;gap:6px;margin-top:3px">
            <div style="flex:1;background:#1a1a1a;border-radius:3px;height:5px;overflow:hidden">
              <div style="width:\${hp}%;background:#E30A17;height:100%"></div></div>
            <div style="flex:1;background:#1a1a1a;border-radius:3px;height:5px;overflow:hidden;transform:scaleX(-1)">
              <div style="width:\${ap}%;background:#555;height:100%"></div></div>
          </div>\` : '';
          return \`<tr>
            <td style="text-align:right;font-weight:600;color:#fff;padding:5px 8px">\${hv}</td>
            <td style="text-align:center;color:#888;font-size:0.72rem;padding:5px 4px;white-space:nowrap">
              \${s.label}\${barRow}</td>
            <td style="text-align:left;font-weight:600;color:#fff;padding:5px 8px">\${av}</td>
          </tr>\`;
        }).join('');
        document.getElementById('matchStatsBox').innerHTML = \`
          <div style="border:1px solid #222;border-radius:6px;overflow:hidden;background:#111">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#161616;border-bottom:1px solid #222">
              <div style="display:flex;align-items:center;gap:8px">
                <img src="\${d.home.logo}" style="height:22px;width:22px;object-fit:contain" onerror="this.style.display='none'">
                <span style="font-size:0.8rem;font-weight:700;color:#fff">\${d.home.name}</span>
              </div>
              <span style="font-size:0.65rem;color:#666;letter-spacing:0.08em;text-transform:uppercase">Maç İstatistikleri</span>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:0.8rem;font-weight:700;color:#fff">\${d.away.name}</span>
                <img src="\${d.away.logo}" style="height:22px;width:22px;object-fit:contain" onerror="this.style.display='none'">
              </div>
            </div>
            <table style="width:100%;border-collapse:collapse">\${rows}</table>
          </div>\`;
      } catch(e){}
    })();
    </script>` : ''}
    <div class="source-attr">Kaynak: <a href="${escHtml(srcUrl || '#')}" target="_blank" rel="noopener"><strong>${escHtml(source)}</strong> →</a>
    ${srcUrl ? `<span style="color:#555;font-size:0.7rem;display:block;margin-top:4px">Kartalix, bu haberdeki olgusal bilgileri bağımsız olarak derlemiştir. Orijinal haber için yukarıdaki kaynağı ziyaret edin.</span>` : ''}
    </div>
  </article>
  <div class="reaction-bar">
    <button id="btnLike" class="rxn-btn" onclick="react('like')">👍 <span id="likeCount" class="rxn-count">0</span></button>
    <button id="btnDislike" class="rxn-btn" onclick="react('dislike')">👎 <span id="dislikeCount" class="rxn-count">0</span></button>
  </div>
  <div class="share-box">
    <div class="share-title">Bu haberi paylaş</div>
    <div class="share-btns">
      <a class="share-btn btn-wa" href="https://wa.me/?text=${waText}" target="_blank" rel="noopener">WhatsApp</a>
      <a class="share-btn btn-tw" href="https://twitter.com/intent/tweet?${twParams}" target="_blank" rel="noopener">Twitter / X</a>
      <button class="share-btn btn-copy" onclick="copyLink(this)">Linki Kopyala</button>
    </div>
  </div>
  <a href="/" class="home-link">← Kartalix — Tüm Haberler</a>

  <!-- Editor-only feedback panel: visible only when kx-editor cookie is set (via /admin visit) -->
  <div id="fbPanel" style="display:none;margin-top:1.5rem;background:#111;border:1px solid #1a3a1a;border-radius:6px;padding:1.25rem">
    <p style="font-size:.7rem;color:#3a6a3a;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.5rem">Editör Notu — Sadece Siz Görürsünüz</p>
    <p style="font-size:.72rem;color:#555;margin-bottom:.75rem">Ton, eksik bilgi, yapı, üslup — aklınıza ne geliyorsa yazın. Diğer okuyucular bu alanı göremez.</p>
    <textarea id="fbText" style="width:100%;background:#1a1a1a;border:1px solid #333;color:#e8e6e0;border-radius:4px;padding:.6rem .75rem;font-size:.875rem;font-family:inherit;height:80px;resize:vertical;outline:none" placeholder="Örn: 'Puan kaybı durumunda ne olacağına dair hiç söz yok', 'Ton çok resmi', 'Njie transferi hiç geçmiyor'…"></textarea>
    <div style="display:flex;gap:.75rem;margin-top:.6rem;align-items:center">
      <button onclick="submitFb()" style="background:#2a5a2a;color:#fff;border:none;padding:.5rem 1rem;border-radius:4px;font-size:.78rem;font-weight:700;cursor:pointer">Gönder</button>
      <button onclick="document.getElementById('fbPanel').style.display='none'" style="background:transparent;border:1px solid #333;color:#666;padding:.5rem 1rem;border-radius:4px;font-size:.78rem;cursor:pointer">İptal</button>
      <span id="fbStatus" style="font-size:.75rem;color:#3a6a3a"></span>
    </div>
  </div>
  <button id="editorBtn" style="display:none;margin-top:1rem;background:transparent;border:1px solid #1a3a1a;color:#3a6a3a;padding:.45rem 1rem;border-radius:4px;font-size:.72rem;cursor:pointer" onclick="document.getElementById('fbPanel').style.display=document.getElementById('fbPanel').style.display==='none'?'block':'none'">✏ Editör Notu</button>
</main>
<script>
const PAGE_URL = ${JSON.stringify(pageUrl)};
let currentReaction = null;

function copyLink(btn){
  navigator.clipboard.writeText(window.location.href).then(()=>{
    btn.textContent='Kopyalandı!';
    setTimeout(()=>btn.textContent='Linki Kopyala',2500);
  });
}

// Show editor controls only when kx-editor cookie is present (set by /admin)
if (document.cookie.split(';').some(c => c.trim() === 'kx-editor=1')) {
  document.getElementById('editorBtn').style.display = 'block';
}

async function loadReactions() {
  try {
    const res = await fetch('/comments?article_url=' + encodeURIComponent(PAGE_URL));
    if (!res.ok) return;
    const d = await res.json();
    document.getElementById('likeCount').textContent = d.likes || 0;
    document.getElementById('dislikeCount').textContent = d.dislikes || 0;
  } catch(e) {}
}

async function react(type) {
  const reaction = currentReaction === type ? null : type;
  currentReaction = reaction;
  document.getElementById('btnLike').className = 'rxn-btn' + (reaction === 'like' ? ' active-like' : '');
  document.getElementById('btnDislike').className = 'rxn-btn' + (reaction === 'dislike' ? ' active-dislike' : '');
  try {
    const res = await fetch('/react', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ article_url: PAGE_URL, reaction })
    });
    if (res.ok) {
      const d = await res.json();
      document.getElementById('likeCount').textContent = d.likes || 0;
      document.getElementById('dislikeCount').textContent = d.dislikes || 0;
    }
  } catch(e) {}
}

async function submitFb(){
  const text = document.getElementById('fbText').value.trim();
  const st = document.getElementById('fbStatus');
  if (!text) { st.textContent = 'Yorum boş olamaz.'; return; }
  st.textContent = 'Gönderiliyor...';
  const res = await fetch('/article/feedback', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      article_slug: ${JSON.stringify(a.slug || '')},
      article_title: ${JSON.stringify(a.title || '')},
      template_id: ${JSON.stringify(templateId || '')},
      comment: text,
    })
  });
  if (res.ok) {
    st.textContent = '✓ Kaydedildi.';
    document.getElementById('fbText').value = '';
    setTimeout(() => { st.textContent = ''; document.getElementById('fbPanel').style.display='none'; }, 2000);
  } else { st.textContent = 'Hata oluştu.'; }
}

loadReactions();
</script>
</body>
</html>`;
}

function renderSourcesPage(rssFeeds = [], ytChannels = []) {
  const rssRows = rssFeeds.map(f => `
    <tr>
      <td>${f.name}</td>
      <td style="font-size:11px;color:#888;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.url}</td>
      <td>${f.trust}</td>
      <td>${f.is_p4 ? '✓' : ''}</td>
      <td>${f.proxy ? '🔀' : ''}${f.keywordFilter ? '🔍' : ''}</td>
      <td>
        <button onclick="testRss('${encodeURIComponent(f.url)}')" style="padding:2px 8px;cursor:pointer">Test</button>
        <button onclick="deleteSource('rss','${encodeURIComponent(f.url)}')" style="padding:2px 8px;background:#c00;color:#fff;border:none;cursor:pointer">✕</button>
      </td>
    </tr>`).join('');

  const ytRows = ytChannels.map(c => `
    <tr>
      <td>${c.name}</td>
      <td style="font-size:11px;color:#888">${c.id}</td>
      <td>${c.tier}</td>
      <td>${c.embed_qualify ? '📺' : ''}${c.transcript_qualify ? '📝' : ''}</td>
      <td>
        <button onclick="testYt('${c.id}')" style="padding:2px 8px;cursor:pointer">Test Feed</button>
        <button onclick="testTranscript('${c.id}')" style="padding:2px 8px;cursor:pointer">Test Transcript</button>
        <button onclick="deleteSource('youtube','${c.id}')" style="padding:2px 8px;background:#c00;color:#fff;border:none;cursor:pointer">✕</button>
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kartalix — Sources</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0f1117; color:#e0e0e0; margin:0; padding:20px; }
  h1 { color:#fff; margin-bottom:4px; } h2 { color:#aaa; font-size:14px; margin:24px 0 8px; }
  a { color:#6af; text-decoration:none; } a:hover { text-decoration:underline; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-bottom:24px; }
  th { background:#1a1d26; color:#888; text-align:left; padding:6px 8px; border-bottom:1px solid #333; }
  td { padding:6px 8px; border-bottom:1px solid #222; vertical-align:middle; }
  tr:hover td { background:#1a1d26; }
  .card { background:#1a1d26; border-radius:8px; padding:16px; margin-bottom:16px; }
  input, select { background:#0f1117; color:#e0e0e0; border:1px solid #333; padding:6px 10px; border-radius:4px; font-size:13px; }
  input { width:100%; box-sizing:border-box; margin-bottom:8px; }
  button.add { background:#1e6b3f; color:#fff; border:none; padding:8px 20px; border-radius:4px; cursor:pointer; font-size:13px; }
  button.add:hover { background:#28924f; }
  #result { background:#0a0c12; border:1px solid #333; border-radius:6px; padding:12px; font-size:12px; white-space:pre-wrap; max-height:300px; overflow-y:auto; margin-top:12px; display:none; }
  .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  label { font-size:12px; color:#888; display:block; margin-bottom:2px; }
  .checks { display:flex; gap:16px; align-items:center; font-size:13px; margin-bottom:8px; }
  .checks input[type=checkbox] { width:auto; margin:0 4px 0 0; }
</style>
</head>
<body>
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
  <h1 style="margin:0">📡 Sources</h1>
  <nav style="display:flex;gap:16px;font-size:13px">
    <a href="/admin">✏️ Editorial</a>
    <a href="/admin/sources">📡 Sources</a>
    <a href="/report" target="_blank">📊 Report</a>
    <a href="/run" target="_blank">▶ Run</a>
    <a href="/force-synthesis" target="_blank">🧪 Synthesis</a>
    <a href="/">← Site</a>
  </nav>
</div>

<h2>RSS FEEDS (${rssFeeds.length})</h2>
<table>
  <thead><tr><th>Name</th><th>URL</th><th>Trust</th><th>P4</th><th>Flags</th><th>Actions</th></tr></thead>
  <tbody>${rssRows || '<tr><td colspan="6" style="color:#666">No feeds configured</td></tr>'}</tbody>
</table>

<h2>YOUTUBE CHANNELS (${ytChannels.length})</h2>
<table>
  <thead><tr><th>Name</th><th>Channel ID</th><th>Tier</th><th>Modes</th><th>Actions</th></tr></thead>
  <tbody>${ytRows || '<tr><td colspan="5" style="color:#666">No channels configured</td></tr>'}</tbody>
</table>

<div class="row2">
  <div class="card">
    <h2 style="margin-top:0">➕ Add RSS Feed</h2>
    <label>Feed URL</label><input id="rss-url" placeholder="https://..." />
    <label>Display Name</label><input id="rss-name" placeholder="Source Name" />
    <label>Trust tier</label>
    <select id="rss-trust" style="width:100%;margin-bottom:8px">
      <option value="press">press</option>
      <option value="broadcast">broadcast</option>
      <option value="journalist">journalist</option>
      <option value="official">official</option>
    </select>
    <div class="checks">
      <label><input type="checkbox" id="rss-p4" checked> P4 source</label>
      <label><input type="checkbox" id="rss-kw" checked> Keyword filter</label>
      <label><input type="checkbox" id="rss-proxy"> Via proxy</label>
    </div>
    <div style="display:flex;gap:8px">
      <button class="add" onclick="testRssNew()">🧪 Test URL</button>
      <button class="add" onclick="addRss()">✓ Add Feed</button>
    </div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">➕ Add YouTube Channel</h2>
    <label>Channel ID (UCxxx…)</label><input id="yt-id" placeholder="UCxxxxxxxxxxxxxxx" />
    <label>Display Name</label><input id="yt-name" placeholder="Channel Name" />
    <label>Tier</label>
    <select id="yt-tier" style="width:100%;margin-bottom:8px">
      <option value="broadcast">broadcast</option>
      <option value="official">official</option>
      <option value="digital">digital</option>
      <option value="press">press</option>
    </select>
    <div class="checks">
      <label><input type="checkbox" id="yt-embed" checked> Embed articles</label>
      <label><input type="checkbox" id="yt-transcript" checked> Transcript synthesis</label>
    </div>
    <div style="display:flex;gap:8px">
      <button class="add" onclick="testYtNew()">🧪 Test Channel</button>
      <button class="add" onclick="addYt()">✓ Add Channel</button>
    </div>
  </div>
</div>

<div id="result"></div>

<script>
const show = (data) => {
  const el = document.getElementById('result');
  el.style.display = 'block';
  el.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

async function api(path, method='GET', body=null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  return r.json();
}

async function testRss(encodedUrl) {
  show('Testing…');
  show(await api('/admin/sources/test?type=rss&url=' + encodedUrl));
}
async function testRssNew() {
  const u = document.getElementById('rss-url').value.trim();
  if (!u) return show('Enter a URL first');
  show('Testing…');
  show(await api('/admin/sources/test?type=rss&url=' + encodeURIComponent(u)));
}
async function testYt(id) {
  show('Testing…');
  show(await api('/admin/sources/test?type=youtube&id=' + id));
}
async function testYtNew() {
  const id = document.getElementById('yt-id').value.trim();
  if (!id) return show('Enter a Channel ID first');
  show('Testing…');
  show(await api('/admin/sources/test?type=youtube&id=' + id));
}
async function testTranscript(videoId) {
  show('Fetching transcript…');
  show(await api('/admin/sources/test?type=transcript&id=' + videoId));
}
async function addRss() {
  const url = document.getElementById('rss-url').value.trim();
  const name = document.getElementById('rss-name').value.trim();
  if (!url || !name) return show('URL and name are required');
  const r = await api('/admin/sources/add', 'POST', {
    type: 'rss', url, name,
    trust: document.getElementById('rss-trust').value,
    is_p4: document.getElementById('rss-p4').checked,
    keywordFilter: document.getElementById('rss-kw').checked,
    proxy: document.getElementById('rss-proxy').checked,
  });
  show(r);
  if (r.ok) setTimeout(() => location.reload(), 800);
}
async function addYt() {
  const id = document.getElementById('yt-id').value.trim();
  const name = document.getElementById('yt-name').value.trim();
  if (!id || !name) return show('Channel ID and name are required');
  const r = await api('/admin/sources/add', 'POST', {
    type: 'youtube', id, name,
    tier: document.getElementById('yt-tier').value,
    embed_qualify: document.getElementById('yt-embed').checked,
    transcript_qualify: document.getElementById('yt-transcript').checked,
  });
  show(r);
  if (r.ok) setTimeout(() => location.reload(), 800);
}
async function deleteSource(type, key) {
  if (!confirm('Delete this source?')) return;
  show(await api('/admin/sources/delete', 'POST', { type, key: decodeURIComponent(key) }));
  setTimeout(() => location.reload(), 800);
}
</script>
</body></html>`;
}

function renderPinPage() {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Giriş</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#111;border:1px solid #222;border-radius:8px;padding:2.5rem 2rem;width:100%;max-width:320px;text-align:center}
.logo{font-size:1.4rem;font-weight:900;color:#fff;margin-bottom:2rem}.logo span{color:#E30A17}
input[type=password]{width:100%;background:#1a1a1a;border:1px solid #333;color:#e8e6e0;border-radius:4px;padding:.75rem 1rem;font-size:1rem;font-family:inherit;outline:none;text-align:center;letter-spacing:.2em;margin-bottom:1rem}
input:focus{border-color:#555}
button{width:100%;background:#E30A17;color:#fff;border:none;padding:.75rem;border-radius:4px;font-size:.9rem;font-weight:700;cursor:pointer;letter-spacing:.06em}
button:hover{opacity:.85}
.err{color:#E30A17;font-size:.8rem;margin-top:.75rem;min-height:1.2em}
</style>
</head>
<body>
<div class="box">
  <div class="logo">Kartal<span>ix</span></div>
  <input type="password" id="pin" placeholder="PIN" autofocus autocomplete="off"/>
  <button onclick="login()">Giriş</button>
  <p class="err" id="err"></p>
</div>
<script>
document.getElementById('pin').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
async function login() {
  const pin = document.getElementById('pin').value;
  const err = document.getElementById('err');
  err.textContent = '';
  const res = await fetch('/admin/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pin }) });
  if (res.ok) { location.href = '/admin'; }
  else { err.textContent = 'Hatalı PIN.'; document.getElementById('pin').select(); }
}
</script>
</body>
</html>`;
}

function renderAdminPage(articles = []) {
  const SCOPES = ['global','match','transfer','news','T01','T05','T08b','T09','T10','T11','T-REF'];
  const scopeDesc = {
    global: 'Her içerik (tüm Claude çağrıları)',
    match: 'Tüm maç içeriği',
    transfer: 'Transfer haberleri',
    news: 'Genel haberler',
    T01: 'Maç Önü Analizi',
    T05: 'Maç Günü Kartı',
    T08b: 'Muhtemel 11',
    T09: 'Kesin Kadro',
    T10: 'Gol Flash',
    T11: 'Sonuç Flash',
  };
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Editör Paneli</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.6}
header{background:#111;border-bottom:1px solid #222;padding:0 1.5rem;height:52px;display:flex;align-items:center;gap:1.5rem}
.logo{font-size:1.1rem;font-weight:900;color:#fff}.logo span{color:#E30A17}
main{max-width:960px;margin:2rem auto;padding:0 1.5rem;display:grid;grid-template-columns:1fr 1fr;gap:2rem}
.full-row{grid-column:1/-1}
@media(max-width:700px){main{grid-template-columns:1fr}}
.panel{min-width:0}
h2{font-size:.85rem;font-weight:700;color:#fff;margin-bottom:1rem;border-bottom:1px solid #222;padding-bottom:.5rem;display:flex;align-items:center;justify-content:space-between}
h2 span{font-size:.65rem;color:#555;font-weight:400}
.card{background:#111;border:1px solid #222;border-radius:6px;padding:1rem;margin-bottom:.75rem}
.card-title{font-size:.72rem;color:#888;margin-bottom:.4rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-body{font-size:.875rem;color:#d0cec8;line-height:1.55}
.card-meta{font-size:.63rem;color:#555;margin-top:.4rem;display:flex;gap:.75rem;align-items:center}
.badge{background:#1a1a1a;border:1px solid #333;color:#aaa;font-size:.6rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:1px 7px;border-radius:10px}
.badge.processed{color:#3a3;border-color:#3a3}
.del-btn{background:transparent;border:1px solid #333;color:#666;padding:3px 9px;border-radius:4px;cursor:pointer;font-size:.68rem;margin-left:auto}
.del-btn:hover{border-color:#E30A17;color:#E30A17}
.distill-bar{background:#111;border:1px solid #222;border-radius:6px;padding:.875rem 1rem;margin-bottom:1rem;display:flex;gap:.75rem;align-items:center}
.distill-btn{background:#E30A17;color:#fff;border:none;padding:.5rem 1.1rem;border-radius:4px;font-size:.78rem;font-weight:700;cursor:pointer;white-space:nowrap}
.distill-btn:hover{opacity:.85}
.distill-btn:disabled{opacity:.45;cursor:default}
#distillStatus{font-size:.75rem;color:#aaa;flex:1}
.add-form{background:#111;border:1px solid #222;border-radius:6px;padding:1rem;margin-bottom:1rem}
.add-form label{display:block;font-size:.68rem;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.35rem}
.add-form select,.add-form textarea{width:100%;background:#1a1a1a;border:1px solid #333;color:#e8e6e0;border-radius:4px;padding:.5rem .65rem;font-size:.875rem;font-family:inherit;outline:none}
.add-form select{height:34px;margin-bottom:.75rem}
.add-form textarea{height:70px;resize:vertical;margin-bottom:.75rem}
.add-form .save-btn{background:#333;color:#e8e6e0;border:none;padding:.45rem 1rem;border-radius:4px;font-size:.75rem;font-weight:600;cursor:pointer}
.add-form .save-btn:hover{background:#444}
.status{font-size:.72rem;color:#E30A17;margin-top:.4rem;min-height:1.1em}
.empty{color:#555;font-size:.85rem;padding:1rem 0}
</style>
</head>
<body>
<header>
  <div class="logo">Kartal<span>ix</span> <span style="font-size:.7rem;color:#555;font-weight:400">Editör Paneli</span></div>
  <nav style="display:flex;gap:1.25rem;margin-left:auto;align-items:center">
    <a href="/admin" style="color:#aaa;font-size:.75rem;text-decoration:none" title="Editorial panel">✏️ Editorial</a>
    <a href="/admin/sources" style="color:#aaa;font-size:.75rem;text-decoration:none" title="Manage sources">📡 Sources</a>
    <a href="/report" style="color:#aaa;font-size:.75rem;text-decoration:none" title="Fetch report" target="_blank">📊 Report</a>
    <a href="/run" style="color:#aaa;font-size:.75rem;text-decoration:none" title="Trigger fetch run" target="_blank">▶ Run</a>
    <a href="/force-synthesis" style="color:#aaa;font-size:.75rem;text-decoration:none" title="Test synthesis" target="_blank">🧪 Synthesis</a>
    <a href="/" style="color:#666;font-size:.75rem;text-decoration:none">← Site</a>
  </nav>
</header>
<main>

  <!-- LEFT: News list + submitted feedback -->
  <div class="panel">
    <h2>Haberler <span id="fbCount"></span></h2>
    <div class="distill-bar">
      <button class="distill-btn" id="distillBtn" onclick="distill()">Talimat Üret</button>
      <button class="distill-btn" id="redistillBtn" onclick="redistill()" style="background:#444">Sıkıştır</button>
      <span id="distillStatus">Bekleyen notları kurala dönüştür.</span>
    </div>
    <div id="newsList"><p class="empty">Yükleniyor...</p></div>
  </div>

  <!-- RIGHT: Structured editorial guidelines -->
  <div class="panel">
    <h2>Editör Talimatları <span id="noteCount"></span></h2>
    <div class="add-form">
      <label>Kapsam</label>
      <select id="scope">
        ${SCOPES.map(s => `<option value="${s}">${s} — ${scopeDesc[s] || ''}</option>`).join('')}
      </select>
      <label>Talimat</label>
      <textarea id="noteText" placeholder="Örn: Haberler özgün cümlelerle başlamalı, klişe girişlerden kaçın."></textarea>
      <button class="save-btn" onclick="addNote()">Manuel Ekle</button>
      <p class="status" id="addStatus"></p>
    </div>
    <div id="notesList"><p class="empty">Yükleniyor...</p></div>
  </div>

  <!-- BOTTOM: Reference articles -->
  <div class="panel full-row">
    <h2>Referans Haberler <span id="refCount"></span></h2>
    <p style="font-size:.75rem;color:#555;margin-bottom:1rem">Beğendiğin başka kanalların haberlerini buraya yapıştır. Sıkıştır çalıştığında Claude bu metinlerden stil ve ton prensipleri çıkarır.</p>
    <div class="add-form" style="display:grid;grid-template-columns:1fr 3fr;gap:.75rem;align-items:start">
      <div>
        <label>Kaynak adı</label>
        <input type="text" id="refSource" placeholder="örn. NTV Spor" style="width:100%;background:#1a1a1a;border:1px solid #333;color:#e8e6e0;border-radius:4px;padding:.5rem .65rem;font-size:.875rem;font-family:inherit;outline:none"/>
      </div>
      <div>
        <label>Haber metni</label>
        <textarea id="refText" style="width:100%;background:#1a1a1a;border:1px solid #333;color:#e8e6e0;border-radius:4px;padding:.5rem .65rem;font-size:.875rem;font-family:inherit;height:100px;resize:vertical;outline:none" placeholder="Beğendiğin haberin metnini buraya yapıştır…"></textarea>
      </div>
      <div></div>
      <div style="display:flex;gap:.75rem;align-items:center">
        <button class="save-btn" onclick="addRef()">Ekle</button>
        <p class="status" id="refStatus"></p>
      </div>
    </div>
    <div id="refList" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.75rem;margin-top:.5rem"></div>
  </div>

</main>
<script>
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

const ARTICLES = ${JSON.stringify(articles.slice(0, 40))};
let feedbacks = [];

async function loadNewsList() {
  const fbRes = await fetch('/article/feedback');
  feedbacks = fbRes.ok ? await fbRes.json() : [];

  const pending = feedbacks.filter(f => !f.processed);
  document.getElementById('fbCount').textContent = pending.length ? \`\${pending.length} not bekliyor\` : '';

  const list = document.getElementById('newsList');
  if (!ARTICLES.length) { list.innerHTML = '<p class="empty">Henüz haber yok. /run deneyin.</p>'; return; }

  // Build a map of slug → feedback items
  const fbBySlug = {};
  for (const f of feedbacks) {
    const key = f.article_slug || f.article_title || '';
    if (!fbBySlug[key]) fbBySlug[key] = [];
    fbBySlug[key].push(f);
  }

  list.innerHTML = ARTICLES.map((a, i) => {
    const slug = a.slug || '';
    const title = a.title || '(başlık yok)';
    const tmpl = a.template_id || '';
    const date = a.published_at ? new Date(a.published_at).toLocaleDateString('tr-TR', { day:'numeric', month:'short' }) : '';
    const existingFb = (fbBySlug[slug] || fbBySlug[title] || []);
    const fbHtml = existingFb.map(f => \`
      <div style="background:#1a2a1a;border-left:2px solid #3a5a3a;padding:.4rem .6rem;margin-top:.4rem;font-size:.78rem;color:#9a9;border-radius:0 3px 3px 0;display:flex;justify-content:space-between;gap:.5rem">
        <span>\${escHtml(f.comment)}</span>
        <button onclick="delFb('\${f.id}')" style="background:transparent;border:none;color:#555;cursor:pointer;font-size:.7rem;white-space:nowrap">✕</button>
      </div>
    \`).join('');
    return \`
      <div class="card" id="art-\${i}" data-slug="\${escHtml(slug)}" data-title="\${escHtml(title)}" data-tmpl="\${escHtml(tmpl)}">
        <div style="display:flex;align-items:flex-start;gap:.5rem;justify-content:space-between">
          <div style="flex:1;min-width:0">
            \${tmpl ? \`<span class="badge" style="margin-bottom:.3rem;display:inline-block">\${escHtml(tmpl)}</span>\` : ''}
            <div class="card-title" style="font-size:.82rem;color:#ccc;white-space:normal">\${escHtml(title)}</div>
            <div class="card-meta" style="margin-top:.25rem">\${date}\${slug ? \` · <a href="/haber/\${escHtml(slug)}" target="_blank" style="color:#555;font-size:.65rem">Haberi aç ↗</a>\` : ''}</div>
          </div>
          <button class="del-btn" style="border-color:#2a3a2a;color:#4a6a4a" onclick="toggleNote(\${i})">+ Not</button>
        </div>
        \${fbHtml}
        <div id="note-\${i}" style="display:none;margin-top:.6rem">
          <textarea id="ntext-\${i}" style="width:100%;background:#1a1a1a;border:1px solid #333;color:#e8e6e0;border-radius:4px;padding:.5rem .65rem;font-size:.82rem;font-family:inherit;height:64px;resize:vertical;outline:none" placeholder="Ton, eksik bilgi, üslup…"></textarea>
          <div style="display:flex;gap:.5rem;margin-top:.4rem;align-items:center">
            <button onclick="submitNote(\${i})" style="background:#2a5a2a;color:#fff;border:none;padding:.4rem .85rem;border-radius:4px;font-size:.75rem;font-weight:700;cursor:pointer">Kaydet</button>
            <button onclick="document.getElementById('note-\${i}').style.display='none'" style="background:transparent;border:1px solid #333;color:#666;padding:.4rem .75rem;border-radius:4px;font-size:.75rem;cursor:pointer">İptal</button>
            <span id="nst-\${i}" style="font-size:.72rem;color:#3a6a3a"></span>
          </div>
        </div>
      </div>
    \`;
  }).join('');
}

function toggleNote(i) {
  const el = document.getElementById('note-' + i);
  const shown = el.style.display !== 'none';
  el.style.display = shown ? 'none' : 'block';
  if (!shown) document.getElementById('ntext-' + i)?.focus();
}

async function submitNote(i) {
  const card = document.getElementById('art-' + i);
  const slug = card?.dataset.slug || '';
  const title = card?.dataset.title || '';
  const templateId = card?.dataset.tmpl || '';
  const text = document.getElementById('ntext-' + i)?.value.trim();
  const st = document.getElementById('nst-' + i);
  if (!text) { st.textContent = 'Boş olamaz.'; return; }
  st.textContent = 'Kaydediliyor…';
  const res = await fetch('/article/feedback', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ article_slug: slug, article_title: title, template_id: templateId, comment: text })
  });
  if (res.ok) {
    st.textContent = '✓';
    document.getElementById('ntext-' + i).value = '';
    document.getElementById('note-' + i).style.display = 'none';
    await loadNewsList();
  } else { st.textContent = 'Hata.'; }
}

async function delFb(id) {
  await fetch('/article/feedback', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'delete', id }) });
  await loadNewsList();
}

async function redistill() {
  const btn = document.getElementById('redistillBtn');
  const st  = document.getElementById('distillStatus');
  btn.disabled = true;
  st.textContent = 'Kurallar sıkıştırılıyor…';
  try {
    const res = await fetch('/admin/redistill', { method:'POST' });
    const data = await res.json();
    if (!res.ok) { st.textContent = 'Hata: ' + (data.error || res.status); return; }
    st.textContent = \`Sıkıştırıldı — \${data.count} kural kaldı.\`;
    await loadNotes();
  } catch(e) {
    st.textContent = 'Bağlantı hatası.';
  } finally {
    btn.disabled = false;
  }
}

async function distill() {
  const btn = document.getElementById('distillBtn');
  const st  = document.getElementById('distillStatus');
  btn.disabled = true;
  st.textContent = 'Claude analiz ediyor…';
  try {
    const res = await fetch('/admin/distill', { method:'POST' });
    const data = await res.json();
    if (!res.ok) { st.textContent = 'Hata: ' + (data.error || res.status); return; }
    if (data.message) { st.textContent = data.message; return; }
    st.textContent = \`\${data.added} kural eklendi.\`;
    await loadNewsList();
    await loadNotes();
  } catch(e) {
    st.textContent = 'Bağlantı hatası.';
  } finally {
    btn.disabled = false;
  }
}

async function loadNotes() {
  const res = await fetch('/admin/notes');
  const notes = await res.json();
  const list = document.getElementById('notesList');
  document.getElementById('noteCount').textContent = notes.length ? \`\${notes.length} aktif\` : '';
  if (!notes.length) { list.innerHTML = '<p class="empty">Henüz talimat yok.</p>'; return; }
  list.innerHTML = notes.map(n => \`
    <div class="card" id="n-\${n.id}">
      <div class="card-body">\${escHtml(n.text)}</div>
      <div class="card-meta">
        <span class="badge">\${escHtml(n.scope)}</span>
        <span>\${new Date(n.created_at).toLocaleString('tr-TR')}</span>
        <button class="del-btn" onclick="delNote('\${n.id}')">Sil</button>
      </div>
    </div>
  \`).join('');
}

async function addNote() {
  const scope = document.getElementById('scope').value;
  const text  = document.getElementById('noteText').value.trim();
  const st    = document.getElementById('addStatus');
  if (!text) { st.textContent = 'Talimat boş olamaz.'; return; }
  st.textContent = 'Kaydediliyor…';
  const res = await fetch('/admin/notes', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ scope, text }) });
  if (res.ok) {
    document.getElementById('noteText').value = '';
    st.textContent = 'Eklendi.';
    await loadNotes();
    setTimeout(() => st.textContent = '', 3000);
  } else { st.textContent = 'Hata.'; }
}

async function delNote(id) {
  await fetch('/admin/notes', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'delete', id }) });
  document.getElementById('n-' + id)?.remove();
  const list = document.getElementById('notesList');
  if (!list.children.length) list.innerHTML = '<p class="empty">Henüz talimat yok.</p>';
}

async function loadRefs() {
  const res = await fetch('/admin/references');
  const refs = res.ok ? await res.json() : [];
  document.getElementById('refCount').textContent = refs.length ? \`\${refs.length} referans\` : '';
  const list = document.getElementById('refList');
  if (!refs.length) { list.innerHTML = '<p class="empty">Henüz referans haber yok.</p>'; return; }
  list.innerHTML = refs.map(r => \`
    <div class="card" id="ref-\${r.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
        <div style="font-size:.7rem;color:#888;font-weight:700;text-transform:uppercase;letter-spacing:.06em">\${escHtml(r.source || 'Referans')}</div>
        <button onclick="delRef('\${r.id}')" class="del-btn">Sil</button>
      </div>
      <div class="card-body" style="margin-top:.4rem;font-size:.78rem;max-height:80px;overflow:hidden;text-overflow:ellipsis">\${escHtml(r.text.slice(0, 200))}…</div>
      <div class="card-meta" style="margin-top:.3rem">\${new Date(r.created_at).toLocaleDateString('tr-TR')}</div>
    </div>
  \`).join('');
}

async function addRef() {
  const source = document.getElementById('refSource').value.trim();
  const text   = document.getElementById('refText').value.trim();
  const st     = document.getElementById('refStatus');
  if (!text) { st.textContent = 'Metin boş olamaz.'; return; }
  st.textContent = 'Ekleniyor…';
  const res = await fetch('/admin/references', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ source, text })
  });
  if (res.ok) {
    document.getElementById('refSource').value = '';
    document.getElementById('refText').value = '';
    st.textContent = 'Eklendi.';
    setTimeout(() => st.textContent = '', 2500);
    await loadRefs();
  } else { st.textContent = 'Hata.'; }
}

async function delRef(id) {
  await fetch('/admin/references', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'delete', id }) });
  document.getElementById('ref-' + id)?.remove();
}

loadNewsList();
loadNotes();
loadRefs();
</script>
</body>
</html>`;
}

function renderArticleNotFound(slug) {
  return `<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"/><title>Haber Bulunamadı | Kartalix</title>
<style>body{background:#181818;color:#888;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:1rem}a{color:#E30A17}</style>
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
