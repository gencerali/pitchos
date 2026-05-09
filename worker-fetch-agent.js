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
import { fetchRSSArticles, fetchArticles, fetchBeIN, fetchTwitterSources, fetchBJKOfficial, RSS_FEEDS, fetchSourceConfigs, configsToRSSFeeds, configsToYTChannels } from './src/fetcher.js';
import { preFilter, dedupeByTitle, scoreArticles, getSeenHashes, saveSeenHashes, getSeenUrls, dedupeByStory } from './src/processor.js';
import { writeArticles, saveArticles, cacheToKV, getCachedArticles, logFetch, mergeAndDedupe, generateMatchDayCard, generateMuhtemel11, generateConfirmedLineup, generateMatchPreview, generateH2HHistory, generateFormGuide, generateInjuryReport, generateGoalFlash, generateResultFlash, generateManOfTheMatch, generateMatchReport, generateXGDelta, generateRefereeProfile, generateHalftimeReport, generateRedCardFlash, generateVARFlash, generateMissedPenaltyFlash, generateVideoEmbed, generateRabonaDigest, buildGroundingContext, verifyArticle } from './src/publisher.js';
import { matchOrCreateStory, getOpenStories, archiveStaleStories, createMatchStory, getMatchStory, advanceMatchStoryStates } from './src/story-matcher.js';
import { extractFactsForStory, SKIP_STORY_TYPES } from './src/firewall.js';
import { apiFetch, getNextFixture, getLiveFixture, getFixture, getH2H, getFixturePlayers, getFixtureStats, getFixtureEvents, getLastFixtures, getInjuries, getFixtureLineup, getStandings } from './src/api-football.js';
import { YOUTUBE_CHANNELS, fetchYouTubeChannel, qualifyYouTubeVideo, fetchYouTubeTranscript } from './src/youtube.js';

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
      let article_url = url.searchParams.get('article_url');
      if (!article_url && request.method === 'POST') {
        try { ({ article_url } = await request.json()); } catch { /* ignore */ }
      }
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
        { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://kartalix.com', 'Cache-Control': 'private, max-age=3600' } }
      );
    }

    if (url.pathname === '/widgets/bjk-fixtures') {
      const CORS = { 'Access-Control-Allow-Origin': 'https://kartalix.com' };
      const cacheKey = 'widget:bjk-fixtures';
      const cached = await env.PITCHOS_CACHE.get(cacheKey);
      if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json', ...CORS } });
      const widgetFetch = async (path) => {
        try {
          const r = await fetch(`https://v3.football.api-sports.io${path}`, {
            headers: { 'x-apisports-key': env.API_FOOTBALL_KEY || '', 'Origin': 'https://kartalix.com', 'Referer': 'https://kartalix.com/' },
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
      const CORS = { 'Access-Control-Allow-Origin': 'https://kartalix.com' };
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
      const CORS = { 'Access-Control-Allow-Origin': 'https://kartalix.com' };
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
      const corsHeaders = { 'Access-Control-Allow-Origin': 'https://kartalix.com' };
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
          'Origin':  request.headers.get('Origin')  || 'https://kartalix.com',
          'Referer': request.headers.get('Referer') || 'https://kartalix.com/',
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
          `/rest/v1/content_items?site_id=eq.${site.id}&publish_mode=neq.rss_summary&order=published_at.desc&limit=100&select=title,summary,full_body,source_name,original_url,category,nvs_score,golden_score,published_at,sport,publish_mode,image_url,slug,content_type`
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
    if (url.pathname === '/test-verifier') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site  = sites?.[0] || null;
        const groundingCtx = await buildGroundingContext(env, site);
        if (!groundingCtx) {
          return Response.json({ error: 'No grounding data available — API-Football returned nothing' }, { headers });
        }
        // Test 1: deliberately wrong claims — should fail
        const wrongBody = `Beşiktaş bu sezon Süper Lig'de 1. sırada yer alıyor ve 90 puanla liderliğini sürdürüyor. Son 5 maçta 5 galibiyet aldı.`;
        // Test 2: neutral/safe body — should pass
        const safeBody  = `Beşiktaş, teknik direktörü gözetiminde bu hafta yoğun antrenman temposunu sürdürdü. Takım, önümüzdeki maça odaklanmış durumda.`;

        const [wrongResult, safeResult] = await Promise.all([
          verifyArticle(wrongBody, groundingCtx, env),
          verifyArticle(safeBody,  groundingCtx, env),
        ]);

        return Response.json({
          grounding_preview: groundingCtx.slice(0, 400),
          test_wrong: { body: wrongBody, result: wrongResult },
          test_safe:  { body: safeBody,  result: safeResult },
        }, { headers });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500, headers });
      }
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

        const seenUrls = await getSeenUrls(env, site.id);
        const results  = [];
        let published  = 0;

        for (const channel of channels) {
          const videos    = await fetchYouTubeChannel(channel, since).catch(() => []);
          const qualified = videos.filter(v => {
            const watchUrl = `https://www.youtube.com/watch?v=${v.video_id}`;
            return qualifyYouTubeVideo(v) && !seenUrls.has(watchUrl);
          });
          const skipped   = videos.filter(v => !qualifyYouTubeVideo(v)).map(v => v.title);

          if (doPublish) {
            for (const video of qualified.slice(0, 2)) {
              try {
                const card = await generateVideoEmbed(video, site, env);
                if (card) {
                  const raw     = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const current = raw ? JSON.parse(raw) : [];
                  const kvCard  = toKVShape({ ...card, nvs: card.nvs_score || 72, is_kartalix_content: true, is_template: true });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...current], 100));
                  published++;
                }
              } catch (e) { console.error(`force-yt embed failed [${video.video_id}]:`, e.message); }
            }
          }

          results.push({
            channel: channel.name, tier: channel.tier,
            fetched: videos.length, qualified: qualified.length,
            videos: qualified.slice(0, 5).map(v => ({ id: v.video_id, title: v.title, published_at: v.published_at })),
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
      const cookie = request.headers.get('cookie') || '';
      const authed = cookie.split(';').some(c => c.trim() === 'kx-editor=1');
      if (!authed) return new Response(renderPinPage(url.pathname), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      const now = new Date();
      const monthKey = now.toISOString().slice(0, 7);
      const current = parseFloat((await env.PITCHOS_CACHE.get(`cost:${monthKey}`)) || '0');
      const cap = parseFloat(env.MONTHLY_CLAUDE_CAP || '8');
      const pct = cap > 0 ? (current / cap * 100).toFixed(1) : '0';
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
      const data = { current_month: monthKey, current_usd: +current.toFixed(4), cap_usd: cap, pct_used: pct, blocked: current >= cap, history };
      if (url.searchParams.get('json') === '1') return Response.json(data, { headers: { 'Content-Type': 'application/json' } });
      return new Response(renderCostPage(data), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    // ── FINANCIALS PAGE ───────────────────────────────────────
    if (url.pathname === '/admin/financials') {
      const cookie = request.headers.get('cookie') || '';
      const authed = cookie.split(';').some(c => c.trim() === 'kx-editor=1');
      if (!authed) return new Response(renderPinPage(url.pathname), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

      const FIXED_ITEMS = [
        { item: 'API-Football Pro',      amount: 19.00, notes: 'Stats & fixtures API' },
        { item: 'Cloudflare Workers',    amount:  5.00, notes: 'Paid plan (KV + Workers)' },
        { item: 'Supabase',              amount:  0.00, notes: 'Free tier' },
        { item: 'Render',                amount:  0.00, notes: 'pitchos-proxy — confirm plan' },
        { item: 'Domain (kartalix.com)', amount:  0.00, notes: 'Annual — enter monthly equivalent' },
      ];
      const FIXED_TOTAL = FIXED_ITEMS.reduce((s, r) => s + r.amount, 0);

      // All months from project start to now
      const months = [];
      const cur = new Date();
      let d = new Date('2026-04-01');
      while (d.toISOString().slice(0,7) <= cur.toISOString().slice(0,7)) {
        months.push(d.toISOString().slice(0,7));
        d.setMonth(d.getMonth() + 1);
      }
      const currentMonth = months[months.length - 1];

      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { action, month } = body;
        if (!month) return Response.json({ error: 'month required' }, { status: 400 });
        const existing = await env.PITCHOS_CACHE.get(`financials:${month}`);
        const snap = existing ? JSON.parse(existing) : {};
        if (action === 'revenue') {
          snap.revenue = parseFloat(body.revenue) || 0;
        } else if (action === 'add_cost') {
          if (!snap.manual_costs) snap.manual_costs = [];
          snap.manual_costs.push({ id: Date.now().toString(36), item: body.item, amount: parseFloat(body.amount) || 0, notes: body.notes || '' });
        } else if (action === 'del_cost') {
          snap.manual_costs = (snap.manual_costs || []).filter(c => c.id !== body.id);
        }
        snap.updated_at = new Date().toISOString();
        await env.PITCHOS_CACHE.put(`financials:${month}`, JSON.stringify(snap));
        return Response.json({ ok: true });
      }

      // Read all months in parallel
      const [claudeKV, snapKV] = await Promise.all([
        Promise.all(months.map(m => env.PITCHOS_CACHE.get(`cost:${m}`))),
        Promise.all(months.map(m => env.PITCHOS_CACHE.get(`financials:${m}`))),
      ]);

      // Persist current month snapshot (preserve revenue + manual_costs)
      const currentSnap = snapKV[snapKV.length - 1] ? JSON.parse(snapKV[snapKV.length - 1]) : {};
      const claudeNow   = parseFloat(claudeKV[claudeKV.length - 1] || '0');
      await env.PITCHOS_CACHE.put(`financials:${currentMonth}`, JSON.stringify({
        ...currentSnap, fixed: FIXED_TOTAL, variable: claudeNow, updated_at: new Date().toISOString(),
      }));

      const monthsData = months.map((m, i) => {
        const snap   = snapKV[i] ? JSON.parse(snapKV[i]) : {};
        const claude = m === currentMonth ? claudeNow : parseFloat(claudeKV[i] || '0');
        const manual = snap.manual_costs || [];
        return { month: m, fixed: FIXED_TOTAL, claude, manual, revenue: snap.revenue ?? 0 };
      });

      return new Response(
        renderFinancialsPage(monthsData, FIXED_ITEMS),
        { headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
      );
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
    if (url.pathname === '/admin/season-notes') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const teamId = url.searchParams.get('team_id') || '549';
      if (request.method === 'GET') {
        const notes = await env.PITCHOS_CACHE.get(`season:notes:${teamId}`);
        return Response.json({ team_id: teamId, notes: notes || '' }, { headers });
      }
      if (request.method === 'POST') {
        const { notes } = await request.json();
        if (notes?.trim()) {
          await env.PITCHOS_CACHE.put(`season:notes:${teamId}`, notes.trim(), { expirationTtl: 86400 * 90 });
        } else {
          await env.PITCHOS_CACHE.delete(`season:notes:${teamId}`);
        }
        // Invalidate league context cache so next synthesis picks up new notes
        await env.PITCHOS_CACHE.delete(`league-context:203:2025:${teamId}`);
        return Response.json({ ok: true, team_id: teamId }, { headers });
      }
      return new Response('Method not allowed', { status: 405 });
    }
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
    // ── SOURCE CONFIG CRUD ────────────────────────────────────
    if (url.pathname === '/admin/sources') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = sites?.[0];
      if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });

      if (request.method === 'GET') {
        const rows = await supabase(env, 'GET',
          `/rest/v1/source_configs?site_id=eq.${site.id}&order=source_type,name&select=*`
        );
        return Response.json(rows || [], { headers });
      }
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const allowed = ['name','source_type','url','channel_id','trust_tier','treatment','sport','is_p4','nvs_hint','bjk_filter','all_qualify','proxy','notes','is_active'];
        const row = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
        if (!row.name || !row.source_type) return Response.json({ error: 'name and source_type required' }, { headers, status: 400 });
        row.site_id    = site.id;
        row.is_active  = row.is_active ?? true;
        row.created_at = new Date().toISOString();
        row.updated_at = row.created_at;
        const result = await supabase(env, 'POST', '/rest/v1/source_configs', [row]);
        if (!result) return Response.json({ error: 'Insert failed' }, { headers, status: 500 });
        return Response.json({ ok: true }, { headers });
      }
      if (request.method === 'PATCH') {
        const { id, ...fields } = await request.json().catch(() => ({}));
        if (!id) return Response.json({ error: 'id required' }, { headers, status: 400 });
        const allowed = ['name','is_active','trust_tier','treatment','nvs_hint','bjk_filter','all_qualify','notes'];
        const patch   = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
        patch.updated_at = new Date().toISOString();
        await supabase(env, 'PATCH', `/rest/v1/source_configs?id=eq.${id}`, patch);
        return Response.json({ ok: true }, { headers });
      }
      if (request.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return Response.json({ error: 'id required' }, { headers, status: 400 });
        await supabase(env, 'DELETE', `/rest/v1/source_configs?id=eq.${id}`);
        return Response.json({ ok: true }, { headers });
      }
      return new Response('Method not allowed', { status: 405 });
    }

    // ── SOURCE TEST (single) ──────────────────────────────────
    if (url.pathname === '/admin/sources/test' && request.method === 'GET') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const id = url.searchParams.get('id');
      if (!id) return Response.json({ error: 'id required' }, { headers, status: 400 });
      const rows = await supabase(env, 'GET', `/rest/v1/source_configs?id=eq.${id}&select=*`);
      const src  = rows?.[0];
      if (!src) return Response.json({ error: 'source not found' }, { headers, status: 404 });
      const result = await testSourceConfig(src, env);
      // Persist result so UI picks it up
      await env.PITCHOS_CACHE.put(`source_test:${id}`, JSON.stringify({ ...result, tested_at: new Date().toISOString() }), { expirationTtl: 86400 * 3 });
      return Response.json(result, { headers });
    }

    // ── SOURCE TEST RESULTS (batch) ───────────────────────────
    if (url.pathname === '/admin/sources/tests' && request.method === 'GET') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = sites?.[0];
      if (!site) return Response.json({}, { headers });
      const sources = await supabase(env, 'GET', `/rest/v1/source_configs?site_id=eq.${site.id}&select=id`) || [];
      const results = await Promise.all(sources.map(async s => {
        const raw = await env.PITCHOS_CACHE.get(`source_test:${s.id}`);
        return [s.id, raw ? JSON.parse(raw) : null];
      }));
      return Response.json(Object.fromEntries(results.filter(([,v]) => v)), { headers });
    }

    // ── SOURCE CONFIG SEED ────────────────────────────────────
    // POST /admin/sources/seed — writes hardcoded RSS_FEEDS + YOUTUBE_CHANNELS to DB.
    // Idempotent: skips sources that already exist (matched by url or channel_id).
    if (url.pathname === '/admin/sources/seed' && request.method === 'POST') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = sites?.[0];
      if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });

      const existing = await supabase(env, 'GET',
        `/rest/v1/source_configs?site_id=eq.${site.id}&select=url,channel_id`
      ) || [];
      const existingUrls     = new Set(existing.map(r => r.url).filter(Boolean));
      const existingChannels = new Set(existing.map(r => r.channel_id).filter(Boolean));

      const rssRows = RSS_FEEDS
        .filter(f => !existingUrls.has(f.url))
        .map(f => ({
          site_id:    site.id,
          name:       f.name,
          source_type:'rss',
          url:        f.url,
          trust_tier: f.trust,
          treatment:  'publish',
          sport:      f.sport || 'football',
          is_p4:      f.is_p4 ?? true,
          bjk_filter: f.keywordFilter ?? false,
          proxy:      f.proxy ?? false,
          is_active:  true,
        }));

      const ytNvsHint = { official: 88, broadcast: 78, digital: 74, press: 60 };
      const ytRows = YOUTUBE_CHANNELS
        .filter(ch => !existingChannels.has(ch.id))
        .map(ch => ({
          site_id:    site.id,
          name:       ch.name,
          source_type:'youtube',
          channel_id: ch.id,
          trust_tier: ch.tier,
          treatment:  ch.transcript_qualify && !ch.embed_qualify ? 'synthesize'
                    : ch.embed_qualify && ch.transcript_qualify  ? 'embed_and_synthesize'
                    : 'embed',
          nvs_hint:   ytNvsHint[ch.tier] || 72,
          all_qualify: ch.all_qualify ?? false,
          is_p4:      false,
          is_active:  true,
        }));

      const toInsert = [...rssRows, ...ytRows];
      let inserted = 0;
      const sbInsert = async (rows) => {
        if (!rows.length) return true;
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/source_configs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify(rows),
        });
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
        return true;
      };
      try {
        await sbInsert(rssRows);
        await sbInsert(ytRows);
        inserted = toInsert.length;
      } catch (e) {
        return Response.json({ error: `Insert failed: ${e.message}` }, { headers, status: 500 });
      }
      return Response.json({ seeded: inserted, skipped: existing.length }, { headers });
    }

    // ── SOURCES ADMIN PAGE ────────────────────────────────────
    if (url.pathname === '/admin/sources/ui') {
      const cookie = request.headers.get('cookie') || '';
      const authed = cookie.split(';').some(c => c.trim() === 'kx-editor=1');
      if (!authed) return new Response(renderPinPage(url.pathname), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      return new Response(renderSourcesPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/report') {
      const cookie = request.headers.get('cookie') || '';
      const authed = cookie.split(';').some(c => c.trim() === 'kx-editor=1');
      if (!authed) return new Response(renderPinPage('/admin/report'), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      return new Response(renderAdminReportPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/report-data') {
      const cookie = request.headers.get('cookie') || '';
      const authed = cookie.split(';').some(c => c.trim() === 'kx-editor=1');
      if (!authed) return new Response('Unauthorized', { status: 401 });
      const from = url.searchParams.get('from') || null;
      const to   = url.searchParams.get('to')   || null;
      const report = await buildReport(env, from, to);
      return new Response(JSON.stringify(report), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/admin/roadmap') {
      const cookie = request.headers.get('cookie') || '';
      const authed = cookie.split(';').some(c => c.trim() === 'kx-editor=1');
      if (!authed) return new Response(renderPinPage(url.pathname), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      return new Response(renderAdminRoadmapPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/releases') {
      const cookie = request.headers.get('cookie') || '';
      const authed = cookie.split(';').some(c => c.trim() === 'kx-editor=1');
      if (!authed) return new Response(renderPinPage(url.pathname), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      return new Response(renderAdminReleasesPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
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
    if (url.pathname === '/hakkimizda') {
      return new Response(renderAboutPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=86400' } });
    }
    if (url.pathname === '/iletisim') {
      return new Response(renderContactPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=86400' } });
    }
    if (url.pathname === '/gizlilik') {
      return new Response(renderPrivacyPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=86400' } });
    }
    if (url.pathname === '/kaynak-atif') {
      return new Response(renderAttributionPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=86400' } });
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
      ctx.waitUntil(Promise.all([runDailyArchival(env), runSourceTests(env)]));
    } else if (cron === '0 3 * * 1') {
      ctx.waitUntil(redistillEditorialNotes(env));
    } else {
      ctx.waitUntil(runAllSites(env, ctx));
    }
  },
};

// ─── SOURCE TEST ─────────────────────────────────────────────
async function testSourceConfig(src, env) {
  try {
    if (src.source_type === 'rss') {
      const proxyBase = env.PROXY_URL || '';
      const fetchUrl  = src.proxy && proxyBase ? `${proxyBase}?url=${encodeURIComponent(src.url)}` : src.url;
      const res = await fetch(fetchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const xml   = await res.text();
      const items = (xml.match(/<item[\s>]|<entry[\s>]/g) || []).length;
      const titles = [...xml.matchAll(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gs)]
        .map(m => m[1].trim()).filter(t => t && t.length > 3).slice(1, 6);
      return { ok: true, type: 'rss', items, sample: titles };
    }
    if (src.source_type === 'youtube') {
      const atomUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${src.channel_id}`;
      const res = await fetch(atomUrl, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const xml    = await res.text();
      const titles = [...xml.matchAll(/<media:title>(.*?)<\/media:title>/gs)].map(m => m[1].trim()).slice(0, 8);
      const videoIds = [...xml.matchAll(/<yt:videoId>(.*?)<\/yt:videoId>/g)].map(m => m[1]);
      const videos   = titles.map((title, i) => ({ title, video_id: videoIds[i] || '', channel_id: src.channel_id, channel_tier: src.trust_tier }));
      const qualified = videos.filter(v => qualifyYouTubeVideo({ ...v, channel_name: src.name, all_qualify: src.all_qualify }));
      return { ok: true, type: 'youtube', total: titles.length, qualified: qualified.length, sample: titles };
    }
    return { ok: false, error: 'unsupported source_type' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function runSourceTests(env) {
  const sites = await getActiveSites(env);
  if (!sites?.length) return;
  for (const site of sites) {
    const sources = await supabase(env, 'GET',
      `/rest/v1/source_configs?site_id=eq.${site.id}&is_active=eq.true&select=*`
    ) || [];
    let passed = 0, failed = 0;
    for (const src of sources) {
      const result = await testSourceConfig(src, env);
      await env.PITCHOS_CACHE.put(`source_test:${src.id}`, JSON.stringify({
        ...result, tested_at: new Date().toISOString(),
      }), { expirationTtl: 86400 * 3 });
      result.ok ? passed++ : failed++;
    }
    console.log(`Source tests [${site.short_code}]: ${passed} passed, ${failed} failed`);
  }
}

// ─── DAILY ARCHIVAL ──────────────────────────────────────────
async function runDailyArchival(env) {
  const sites = await getActiveSites(env);
  if (!sites || sites.length === 0) return;
  for (const site of sites) {
    try {
      const [{ archived }, { advanced }] = await Promise.all([
        archiveStaleStories(site.id, env),
        advanceMatchStoryStates(site.id, env),
      ]);
      console.log(`Archival [${site.short_code}]: ${archived} stories archived, ${advanced} match stories advanced`);
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
          const card = await generateConfirmedLineup(nextMatch, lineup, site, env);
          if (card) {
            await env.PITCHOS_CACHE.put(t09Key, '1', { expirationTtl: 86400 });
            const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = raw ? JSON.parse(raw) : [];
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 88, is_kartalix_content: true, is_template: true });
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
          const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 65, is_kartalix_content: true, is_template: true });
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
              const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 90, is_kartalix_content: true, is_template: true });
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
                  await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...htCard, nvs: 85, is_kartalix_content: true, is_template: true }), ...latest], 100));
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
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 88, is_kartalix_content: true, is_template: true }), ...latest], 100));
                    console.log(`WATCHER KV WRITE T-RED: ${ev.player?.name}`);
                  }
                }
                // T-VAR — any VAR event
                else if (ev.type === 'Var') {
                  const card = await generateVARFlash(matchObj, ev, site, env);
                  if (card) {
                    const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                    const latest = raw ? JSON.parse(raw) : [];
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 85, is_kartalix_content: true, is_template: true }), ...latest], 100));
                    console.log(`WATCHER KV WRITE T-VAR: ${ev.detail}`);
                  }
                }
                // T-OG — BJK player scoring an own goal (opponent benefits, score_opp increases)
                else if (ev.type === 'Goal' && ev.detail === 'Own Goal' && ev.team?.id !== 549) {
                  const card = await generateGoalFlash(matchObj, ev, site, env);
                  if (card) {
                    const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                    const latest = raw ? JSON.parse(raw) : [];
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 85, is_kartalix_content: true, is_template: true }), ...latest], 100));
                    console.log(`WATCHER KV WRITE T-OG: ${ev.player?.name}`);
                  }
                }
                // T-PEN — missed penalty (any team)
                else if (ev.type === 'Goal' && ev.detail === 'Missed Penalty') {
                  const card = await generateMissedPenaltyFlash(matchObj, ev, site, env);
                  if (card) {
                    const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                    const latest = raw ? JSON.parse(raw) : [];
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 82, is_kartalix_content: true, is_template: true }), ...latest], 100));
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

          const t11card = await generateResultFlash(liveFixture, players, site, env, events);
          if (t11card) {
            liveState.result_published = true;
            const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = raw ? JSON.parse(raw) : [];
            const kvCard = toKVShape({ ...t11card, nvs: t11card.nvs_score || 88, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
            console.log('WATCHER KV WRITE T11: done');
          }

          try {
            const t13card = await generateManOfTheMatch(liveFixture, players, site, env);
            if (t13card) {
              const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const latest = raw ? JSON.parse(raw) : [];
              const kvCard = toKVShape({ ...t13card, nvs: t13card.nvs_score || 80, is_kartalix_content: true, is_template: true });
              await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
              console.log('WATCHER KV WRITE T13: done');
            }
          } catch(e) { console.error('WATCHER T13 failed:', e.message); }

          try {
            const t12card = await generateMatchReport(liveFixture, players, stats, site, env, events);
            if (t12card) {
              const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const latest = raw ? JSON.parse(raw) : [];
              const kvCard = toKVShape({ ...t12card, nvs: t12card.nvs_score || 85, is_kartalix_content: true, is_template: true });
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
                  const kvCard = toKVShape({ ...xgCard, nvs: xgCard.nvs_score || 78, is_kartalix_content: true, is_template: true });
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
}

// ─── YOUTUBE INTAKE ──────────────────────────────────────────
// Runs once per processSite call. Fetches all channels in parallel,
// qualifies by keyword rules, generates embed articles for new videos.
// NVS hint values by channel tier — no Claude scoring needed for videos
const YT_NVS_HINT = { official: 88, broadcast: 78, digital: 74, press: 60 };

// Normalize a YouTube video to an article-like shape for story matching
function videoToArticle(video) {
  return {
    title:        video.title,
    url:          `https://www.youtube.com/watch?v=${video.video_id}`,
    summary:      video.description || video.title,
    source_name:  video.channel_name,
    source_type:  'youtube',
    trust_tier:   video.channel_tier,
    nvs_hint:     YT_NVS_HINT[video.channel_tier] || 60,
    treatment:    video.embed_qualify ? 'embed' : 'synthesize',
    _video:       video,
    published_at: video.published_at,
    category:     'Match',
  };
}

// Max 2 embeds per channel per run to avoid feed flooding.
// Rabona Digital videos go to daily digest instead of embed.
async function processYouTubeVideos(site, env, seenUrls, channelOverride = null) {
  const channels = channelOverride || YOUTUBE_CHANNELS;
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const feeds = await Promise.all(channels.map(ch => fetchYouTubeChannel(ch, since).catch(() => [])));

  let published = 0;
  let storyMatchCount = 0;   // cap Claude calls: 3 story-match attempts per run
  const rabonaQueue = [];

  // Pre-fetch open stories once for the whole YouTube pass
  let openStories = null;

  for (let i = 0; i < channels.length; i++) {
    const channel  = channels[i];
    const videos   = feeds[i];
    const newVids  = videos.filter(v => {
      const watchUrl = `https://www.youtube.com/watch?v=${v.video_id}`;
      return qualifyYouTubeVideo(v) && !seenUrls.has(watchUrl);
    });
    console.log(`YT ${channel.name}: ${videos.length} fetched → ${newVids.length} qualified`);

    for (const video of newVids.slice(0, 2)) {
      // Transcript-only channels go to digest queue, not embed
      if (video.transcript_qualify && !video.embed_qualify) {
        rabonaQueue.push(video);
        seenUrls.add(`https://www.youtube.com/watch?v=${video.video_id}`);
        continue;
      }
      if (!video.embed_qualify) continue;
      try {
        const card = await generateVideoEmbed(video, site, env);
        if (!card) continue;
        const raw     = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
        const current = raw ? JSON.parse(raw) : [];
        const kvCard  = toKVShape({ ...card, nvs: card.nvs_score || 72, is_kartalix_content: true, is_template: true });
        await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...current], 100));
        seenUrls.add(`https://www.youtube.com/watch?v=${video.video_id}`);
        published++;

        // Story matching — video contributes to story system (capped at 3/run)
        if (storyMatchCount < 3) {
          try {
            if (!openStories) openStories = await getOpenStories(site.id, env);
            const videoArticle = videoToArticle(video);
            const facts = await extractFactsForStory(videoArticle, env);
            if (!SKIP_STORY_TYPES.has(facts.story_type)) {
              const { story, isNew } = await matchOrCreateStory(videoArticle, facts, site.id, env, openStories);
              if (isNew) openStories = [...openStories, story];
              console.log(`YT story match [${video.title?.slice(0, 40)}]: ${isNew ? 'NEW' : 'MATCHED'} → ${story.id} (${story.state})`);
            }
            storyMatchCount++;
          } catch (e) {
            console.error(`YT story match failed [${video.video_id}]:`, e.message);
          }
        }
      } catch (e) {
        console.error(`YT embed failed [${video.video_id}]:`, e.message);
      }
    }
  }

  // ── RABONA DAILY DIGEST ────────────────────────────────────────
  // One digest article per day from Fırat Günayer's videos.
  if (rabonaQueue.length > 0) {
    const today   = new Date().toISOString().slice(0, 10);
    const dayKey  = `rabona:digest:${today}`;
    const already = await env.PITCHOS_CACHE.get(dayKey);
    if (!already) {
      try {
        const transcripts = [];
        const usedVideos  = [];
        for (const video of rabonaQueue) {
          const text = await fetchYouTubeTranscript(video.video_id);
          if (text) { transcripts.push(text); usedVideos.push(video); }

          // Story matching for transcript-qualified videos (within cap)
          if (storyMatchCount < 3) {
            try {
              if (!openStories) openStories = await getOpenStories(site.id, env);
              const videoArticle = videoToArticle(video);
              const facts = await extractFactsForStory(videoArticle, env);
              if (!SKIP_STORY_TYPES.has(facts.story_type)) {
                const { story, isNew } = await matchOrCreateStory(videoArticle, facts, site.id, env, openStories);
                if (isNew) openStories = [...openStories, story];
                console.log(`YT story match [Rabona/${video.title?.slice(0, 30)}]: ${isNew ? 'NEW' : 'MATCHED'} → ${story.id} (${story.state})`);
              }
              storyMatchCount++;
            } catch (e) {
              console.error(`YT story match failed [Rabona/${video.video_id}]:`, e.message);
            }
          }
        }
        if (transcripts.length > 0) {
          const card = await generateRabonaDigest(usedVideos, transcripts, site, env);
          if (card) {
            const raw     = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const current = raw ? JSON.parse(raw) : [];
            const kvCard  = toKVShape({ ...card, nvs: card.nvs || 74, is_kartalix_content: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...current], 100));
            await env.PITCHOS_CACHE.put(dayKey, '1', { expirationTtl: 86400 });
            published++;
            console.log(`RABONA DIGEST published: ${usedVideos.length} video(s)`);
          }
        } else {
          console.log(`RABONA DIGEST: ${rabonaQueue.length} video(s) queued but no transcripts returned`);
        }
      } catch (e) {
        console.error('Rabona digest failed:', e.message);
      }
    } else {
      console.log(`RABONA DIGEST: already published today (${today}), skipping`);
    }
  }

  console.log(`YT INTAKE: ${published} items published`);
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
  // ── DYNAMIC SOURCE CONFIGS ────────────────────────────────────
  // Read from Supabase source_configs table. Falls back to hardcoded arrays if empty.
  const sourceConfigs = await fetchSourceConfigs(site.id, env).catch(() => []);
  const dynamicRSSFeeds = sourceConfigs.length > 0 ? configsToRSSFeeds(sourceConfigs) : null;
  const dynamicYTChannels = sourceConfigs.length > 0 ? configsToYTChannels(sourceConfigs) : null;
  if (sourceConfigs.length > 0) {
    console.log(`SOURCE CONFIGS: ${sourceConfigs.length} active (${dynamicRSSFeeds?.length || 0} RSS, ${dynamicYTChannels?.length || 0} YT)`);
  } else {
    console.log('SOURCE CONFIGS: none in DB, using hardcoded defaults');
  }

  // fetchBJKOfficial disabled — bjk.com.tr blocks all datacenter IPs (direct, pitchos-proxy, allorigins).
  // Official BJK content will arrive via @Besiktas Twitter in Slice 4.
  const [{ articles: rssArticles, bySource }, { articles: webArticles, usage: fetchUsage }, { articles: beINArticles, usage: beINUsage }, { articles: twitterArticles, usage: twitterUsage }] = await Promise.all([
    fetchRSSArticles(site, dynamicRSSFeeds),
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
  const existing = await getCachedArticles(env, site.short_code);
  const immediateKV = mergeAndDedupe([...top100, ...existing], 100).map(toKVShape);
  await cacheToKV(env, site.short_code, immediateKV);
  console.log('KV WRITE IMMEDIATE: done', immediateKV.length, 'articles');

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

    // ── MATCH STORY — proactive creation / state advancement ──────
    // Creates the story container for this fixture so all pipeline agents
    // (templates, press, video) can attach their content_items to it.
    let matchStory = null;
    if (nextMatch.fixture_id) {
      try {
        matchStory = await createMatchStory(nextMatch, site.id, env);
      } catch(e) { console.error('createMatchStory failed:', e.message); }
    }
    // Helper: link a saved content_item to the match story
    const linkToMatchStory = async (card) => {
      if (card?.id && matchStory?.id) {
        await supabase(env, 'PATCH', `/rest/v1/content_items?id=eq.${card.id}`, { story_id: matchStory.id })
          .catch(e => console.error('story_id link failed:', e.message));
      }
    };

    // Template 05 — Match Day Card (API injuries, not RSS)
    try {
      const today = new Date().toISOString().split('T')[0];
      if (nextMatch.match_day === today && !immediateKV.find(a => a.template_id === '05')) {
        console.log('TEMPLATE 05: generating...');
        const injuries = nextMatch.fixture_id ? await getInjuries(env, nextMatch.fixture_id) : [];
        const card = await generateMatchDayCard(nextMatch, preFiltered, site, env, injuries);
        if (card) {
          await linkToMatchStory(card);
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
          await linkToMatchStory(card);
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
            await linkToMatchStory(card);
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape(card), ...latest], 100));
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
            await linkToMatchStory(card);
            await env.PITCHOS_CACHE.put(t02Key, '1', { expirationTtl: 86400 });
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 72, is_kartalix_content: true, is_template: true });
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
            await linkToMatchStory(card);
            await env.PITCHOS_CACHE.put(t07Key, '1', { expirationTtl: 86400 });
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 75, is_kartalix_content: true, is_template: true });
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
              await linkToMatchStory(card);
              await env.PITCHOS_CACHE.put(trefKey, '1', { expirationTtl: 86400 });
              const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
              const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 65, is_kartalix_content: true, is_template: true });
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
            await linkToMatchStory(card);
            await env.PITCHOS_CACHE.put(t03Key, '1', { expirationTtl: 86400 });
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 70, is_kartalix_content: true, is_template: true });
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
            await linkToMatchStory(card);
            await env.PITCHOS_CACHE.put(t01Key, '1', { expirationTtl: 86400 });
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 82, is_kartalix_content: true, is_template: true });
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
                  await linkToMatchStory(card);
                  const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                  const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 90, is_kartalix_content: true, is_template: true });
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
              const card = await generateResultFlash(liveFixture, players, site, env, events);
              if (card) {
                await linkToMatchStory(card);
                liveState.result_published = true;
                const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 88, is_kartalix_content: true, is_template: true });
                await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
                console.log('KV WRITE WITH TEMPLATE T11: done');
              }

              // T13 — Man of the Match
              try {
                console.log('T13: generating man of the match...');
                const motmCard = await generateManOfTheMatch(liveFixture, players, site, env);
                if (motmCard) {
                  await linkToMatchStory(motmCard);
                  const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                  const kvCard = toKVShape({ ...motmCard, nvs: motmCard.nvs_score || 80, is_kartalix_content: true, is_template: true });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 100));
                  console.log('KV WRITE WITH TEMPLATE T13: done');
                }
              } catch(e) { console.error('T13 failed:', e.message); }

              // T12 — Full match report (xG + stats + ratings)
              try {
                console.log('T12: generating match report...');
                const reportCard = await generateMatchReport(liveFixture, players, stats, site, env, events);
                if (reportCard) {
                  await linkToMatchStory(reportCard);
                  const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                  const kvCard = toKVShape({ ...reportCard, nvs: reportCard.nvs_score || 85, is_kartalix_content: true, is_template: true });
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
                      await linkToMatchStory(xgCard);
                      const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                      const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                      const kvCard = toKVShape({ ...xgCard, nvs: xgCard.nvs_score || 78, is_kartalix_content: true, is_template: true });
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

    // Save to Supabase (best effort)
    try {
      const top100forWrite = top100.slice(0, 100);
      const allWritten = await writeArticles(top100forWrite, site, env);
      console.log(`Write phase: ${allWritten.map(a => a.publish_mode).join(', ')}`);

      // Patch KV with synthesized bodies so the page shows full articles
      const synthesized = allWritten.filter(a => a.publish_mode === 'synthesis' && a.full_body?.length > 200);
      if (synthesized.length > 0) {
        const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
        const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
        const urlMap = new Map(synthesized.map(a => [a.url || a.original_url, a]));
        const patched = latest.map(a => {
          const syn = urlMap.get(a.url || a.original_url);
          return syn ? { ...a, full_body: syn.full_body, publish_mode: 'synthesis' } : a;
        });
        await cacheToKV(env, site.short_code, patched);
        console.log(`KV PATCH WITH SYNTHESIS: ${synthesized.length} articles updated`);
      }

      const publishThreshold = site.auto_publish_threshold || 30;
      const toPublish = allWritten.filter(a => a.nvs >= publishThreshold && a.publish_mode !== 'hot_news_hold');
      const toQueue   = allWritten.filter(a => a.nvs >= site.review_threshold && a.nvs < publishThreshold && a.publish_mode !== 'hot_news_hold');
      stats.published = toPublish.length;
      stats.queued    = toQueue.length;

      if (toPublish.length > 0) await saveArticles(env, site.id, toPublish, 'published');
      if (toQueue.length > 0)   await saveArticles(env, site.id, toQueue,   'pending');
      await saveSeenHashes(env, site.short_code, toPublish);

      // ── STORY MATCHING ───────────────────────────────────────
      // Capped at 5 per run — each article requires 2 Claude calls (extractFacts + judge).
      // Cron runs every 30 min so all articles get processed across multiple ticks.
      // Fetch open stories once, reuse to avoid N×Supabase reads.
      const articlesWithFacts = allWritten.filter(a => a._facts).slice(0, 5);
      if (articlesWithFacts.length > 0) {
        console.log(`Story matching: ${articlesWithFacts.length} articles with extracted facts`);
        let openStories = await getOpenStories(site.id, env);
        for (const article of articlesWithFacts) {
          try {
            const { story, isNew } = await matchOrCreateStory(article, article._facts, site.id, env, openStories);
            console.log(`Story match [${article.title?.slice(0, 40)}]: ${isNew ? 'NEW' : 'MATCHED'} → ${story.id} (conf:${story.confidence} state:${story.state})`);
            // Add newly created stories to the in-memory list so subsequent articles can match against them
            if (isNew) openStories = [...openStories, story];
          } catch (e) {
            console.error('Story match failed:', e.message, '| article:', article.title?.slice(0, 40));
          }
        }
      }
    } catch(e) { console.error('Supabase save failed:', e.message); }

    await logFetch(env, site.id, 'success', stats, null, funnelStats);
    if (stats.costEur > 0) await addCost(env, stats.costEur);

    // ── YOUTUBE INTAKE ─────────────────────────────────────────
    await processYouTubeVideos(site, env, seenUrls, dynamicYTChannels).catch(e => console.error('YT intake failed:', e.message));

    stats.durationMs = Date.now() - startTime;
  };

  if (ctx) ctx.waitUntil(backgroundWork());
  else await backgroundWork();

  return { ...stats, cached: immediateKV.length };
}

// ─── REPORT ──────────────────────────────────────────────────
async function buildReport(env, from, to) {
  const SITE = '2b5cfe49-b69a-4143-8323-ca29fff6502e';
  const iF = (from ? `&fetched_at=gte.${encodeURIComponent(from)}` : '') + (to ? `&fetched_at=lte.${encodeURIComponent(to)}` : '');
  const lF = (from ? `&created_at=gte.${encodeURIComponent(from)}` : '') + (to ? `&created_at=lte.${encodeURIComponent(to)}` : '');

  const [runs, contentItems, cachedRaw, sourceConfigs, storiesRaw] = await Promise.all([
    supabase(env, 'GET', `/rest/v1/fetch_logs?site_id=eq.${SITE}&order=created_at.desc&limit=100${lF}&select=created_at,status,items_fetched,items_published,items_queued,items_rejected,items_scored,estimated_cost_eur,duration_ms,claude_calls,error_message`),
    supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${SITE}&order=fetched_at.desc&limit=500${iF}&select=id,title,source_name,category,content_type,nvs_score,status,fetched_at,reviewed_at,original_url,nvs_notes,needs_review,publish_mode`),
    env.PITCHOS_CACHE.get('articles:BJK'),
    supabase(env, 'GET', `/rest/v1/source_configs?site_id=eq.${SITE}&select=name,source_type,trust_tier,is_active`),
    supabase(env, 'GET', `/rest/v1/stories?site_id=eq.${SITE}&select=id,story_type,state,created_at&order=created_at.desc&limit=200`),
  ]);

  const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
  const items = contentItems || [];
  const published = items.filter(a => a.status === 'published');
  const pending   = items.filter(a => a.status === 'pending');
  const rejected  = items.filter(a => a.status === 'rejected');

  // ─── source type distribution ─────────────────────────────
  const srcMap = {};
  (sourceConfigs || []).forEach(sc => { srcMap[sc.name] = { type: sc.source_type, tier: sc.trust_tier }; });
  const byTypeM = {}, byTierM = {};
  items.forEach(a => {
    const cfg = srcMap[a.source_name];
    const type = cfg ? cfg.type : 'unknown';
    const tier = cfg ? cfg.tier : 'unknown';
    byTypeM[type] = (byTypeM[type] || 0) + 1;
    byTierM[tier] = (byTierM[tier] || 0) + 1;
  });
  const source_type_dist = Object.entries(byTypeM).map(([type,count]) => ({ type,count })).sort((a,b) => b.count-a.count);
  const trust_tier_dist  = Object.entries(byTierM).map(([tier,count]) => ({ tier,count })).sort((a,b) => b.count-a.count);

  // ─── story stats ──────────────────────────────────────────
  const stateM = {}, storyTypeM = {};
  (storiesRaw || []).forEach(s => {
    stateM[s.state]           = (stateM[s.state] || 0) + 1;
    storyTypeM[s.story_type]  = (storyTypeM[s.story_type] || 0) + 1;
  });
  const story_stats = {
    total:    (storiesRaw || []).length,
    by_state: Object.entries(stateM).map(([state,count]) => ({ state,count })).sort((a,b) => b.count-a.count),
    by_type:  Object.entries(storyTypeM).map(([type,count]) => ({ type,count })).sort((a,b) => b.count-a.count),
  };

  // ─── by source / cat / type ───────────────────────────────
  const bySource = {};
  items.forEach(a => {
    const s = a.source_name || 'Unknown';
    if (!bySource[s]) bySource[s] = { source_name:s, contributed:0, published:0, rejected:0, nvs_total:0, last_article_at:null };
    bySource[s].contributed++;
    if (a.status === 'published') bySource[s].published++;
    if (a.status === 'rejected')  bySource[s].rejected++;
    bySource[s].nvs_total += (a.nvs_score || 0);
    if (!bySource[s].last_article_at || a.fetched_at > bySource[s].last_article_at) bySource[s].last_article_at = a.fetched_at;
  });
  const by_source = Object.values(bySource).map(s => ({ ...s, avg_nvs: s.contributed>0?Math.round(s.nvs_total/s.contributed):0 })).sort((a,b) => b.contributed-a.contributed);

  const byCat = {};
  items.forEach(a => {
    const c = a.category || 'Unknown';
    if (!byCat[c]) byCat[c] = { category:c, count_published:0, count_rejected:0, nvs_total:0, count:0 };
    byCat[c].count++;
    byCat[c].nvs_total += (a.nvs_score || 0);
    if (a.status === 'published') byCat[c].count_published++;
    if (a.status === 'rejected')  byCat[c].count_rejected++;
  });
  const by_category = Object.values(byCat).map(c => ({ ...c, avg_nvs:c.count>0?Math.round(c.nvs_total/c.count):0 })).sort((a,b) => b.count_published-a.count_published);

  const byType = {};
  items.forEach(a => {
    const t = a.content_type || 'unknown';
    if (!byType[t]) byType[t] = { content_type:t, count:0, count_published:0, nvs_total:0 };
    byType[t].count++;
    byType[t].nvs_total += (a.nvs_score || 0);
    if (a.status === 'published') byType[t].count_published++;
  });
  const by_content_type = Object.values(byType).map(t => ({ ...t, avg_nvs:t.count>0?Math.round(t.nvs_total/t.count):0 }));

  const dist = { nvs_90_100:0, nvs_70_89:0, nvs_50_69:0, nvs_30_49:0, nvs_0_29:0 };
  items.forEach(a => {
    const n = a.nvs_score || 0;
    if (n>=90) dist.nvs_90_100++;
    else if (n>=70) dist.nvs_70_89++;
    else if (n>=50) dist.nvs_50_69++;
    else if (n>=30) dist.nvs_30_49++;
    else dist.nvs_0_29++;
  });

  // ─── aggregate funnel across all runs in range ────────────
  let agg = { raw:0, fetched:0, date:0, kw:0, hash:0, title:0, pub:0, q:0, rej:0, cost:0, calls:0 };
  let hasDetailedFunnel = false;
  (runs || []).forEach(run => {
    agg.fetched += run.items_fetched   || 0;
    agg.pub     += run.items_published || 0;
    agg.q       += run.items_queued    || 0;
    agg.rej     += run.items_rejected  || 0;
    agg.cost    += run.estimated_cost_eur || 0;
    agg.calls   += run.claude_calls    || 0;
    if (run.error_message) {
      try {
        const d = JSON.parse(run.error_message);
        if (d.raw_fetched) {
          hasDetailedFunnel = true;
          agg.raw   += d.raw_fetched   || 0;
          agg.date  += d.after_date    || 0;
          agg.kw    += d.after_keyword || 0;
          agg.hash  += d.after_hash    || 0;
          agg.title += d.after_title   || 0;
        }
      } catch(e) {}
    }
  });
  if (!hasDetailedFunnel) agg.raw = agg.fetched;

  return {
    funnel: {
      total_fetched:        agg.raw,
      after_date_filter:    hasDetailedFunnel ? agg.date  : agg.raw,
      after_keyword_filter: hasDetailedFunnel ? agg.kw    : agg.raw,
      after_hash_dedup:     hasDetailedFunnel ? agg.hash  : agg.raw,
      after_title_dedup:    hasDetailedFunnel ? agg.title : agg.raw,
      auto_published:       agg.pub,
      queued_for_review:    agg.q,
      rejected:             agg.rej,
      final_in_cache:       cached.length,
      total_cost:           agg.cost,
      total_calls:          agg.calls,
    },
    by_source,
    by_category,
    by_content_type,
    scoring_distribution:  dist,
    last_runs:             (runs || []).slice(0, 20),
    top_published:         published.slice(0, 30),
    top_rejected:          rejected.slice(0, 10),
    all_fetched:           items,
    queued_items:          pending,
    published_count:       published.length,
    source_type_dist,
    trust_tier_dist,
    source_type_map:       srcMap,
    story_stats,
    needs_review_items:    published.filter(a => a.needs_review),
    runs_in_range:         (runs || []).length,
    time_range:            { from: from || null, to: to || null },
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
  const H = { 'x-apisports-key': env.API_FOOTBALL_KEY || '', 'Origin': 'https://kartalix.com', 'Referer': 'https://kartalix.com/' };
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
    <source url="${escXml(BASE_URL)}">Kartalix</source>
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
  <url><loc>${BASE_URL}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>
  <url><loc>${BASE_URL}/hakkimizda</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>
  <url><loc>${BASE_URL}/iletisim</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>
  <url><loc>${BASE_URL}/gizlilik</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>
${articleUrls}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml;charset=UTF-8',
      'Cache-Control': 'public, max-age=1800',
    },
  });
}

// ─── STATIC PAGE SHELL ───────────────────────────────────────
function renderStaticPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escHtml(title)} | Kartalix</title>
<link rel="canonical" href="${BASE_URL}"/>
<link rel="alternate" type="application/rss+xml" title="Kartalix RSS" href="${BASE_URL}/rss"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:16px;line-height:1.7}
a{color:#E30A17;text-decoration:none}a:hover{text-decoration:underline}
header{background:#111;border-bottom:1px solid #222;padding:0 1.5rem;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.logo{font-size:1.25rem;font-weight:900;letter-spacing:-0.03em;color:#fff}
.logo span{color:#E30A17}
.back-link{font-size:0.75rem;color:#888;letter-spacing:0.06em}
.back-link:hover{color:#E30A17;text-decoration:none}
main{max-width:720px;margin:0 auto;padding:2.5rem 1.5rem 5rem}
h1{font-size:1.65rem;font-weight:800;color:#fff;margin-bottom:1.5rem;line-height:1.25}
h2{font-size:1.1rem;font-weight:700;color:#fff;margin:2rem 0 0.6rem}
p{color:#c8c6c0;margin-bottom:1.2rem}
ul{padding-left:1.5rem;margin-bottom:1.2rem}
li{color:#c8c6c0;margin-bottom:0.4rem}
footer{border-top:1px solid #222;padding:2rem 1.5rem;text-align:center;font-size:0.75rem;color:#555}
footer a{color:#666;margin:0 0.75rem}
footer a:hover{color:#E30A17;text-decoration:none}
@media(max-width:600px){main{padding:1.5rem 1rem 3rem}h1{font-size:1.3rem}}
</style>
</head>
<body>
<header>
  <a href="/" class="logo">Kartal<span>ix</span></a>
  <a href="/" class="back-link">← Ana Sayfa</a>
</header>
<main>${bodyHtml}</main>
<footer>
  <a href="/hakkimizda">Hakkımızda</a>
  <a href="/iletisim">İletişim</a>
  <a href="/gizlilik">Gizlilik Politikası</a>
  <a href="/kaynak-atif">Kaynak Atıf</a>
  <a href="/impressum">Impressum</a>
  <a href="/rss">RSS</a>
</footer>
</body>
</html>`;
}

function renderAboutPage() {
  return renderStaticPage('Hakkımızda', `
<h1>Hakkımızda</h1>
<p>Kartalix, Beşiktaş JK taraftarları için bağımsız bir haber ve analiz platformudur. Kulüp haberciliğini olgulara dayalı, özgün gazetecilik anlayışıyla ele alıyoruz.</p>
<h2>Ne Yapıyoruz?</h2>
<p>Süper Lig maç analizleri, transfer takibi, sakatlık raporları ve kulüp haberciliğini veri odaklı bir perspektifle sunuyoruz. Yayımladığımız tüm içerik Kartalix editörleri tarafından üretilmektedir; herhangi bir kaynaktan birebir alıntı yapılmamaktadır.</p>
<h2>Bağımsızlık</h2>
<p>Kartalix, Beşiktaş JK ile resmi bir bağlantısı bulunmayan bağımsız bir yayın organıdır. Sponsorlu içerik veya kulüp yönlendirmesiyle değil, taraftar bakış açısıyla yazıyoruz.</p>
<h2>Editoryal Yaklaşım</h2>
<p>Haberlerimizde doğrulanmış verilere (istatistikler, resmi açıklamalar, API kaynaklı skor ve sıralama bilgileri) dayanıyoruz. Spekülatif içerikleri net biçimde belirtiyoruz.</p>
<h2>İletişim</h2>
<p>Görüş, öneri ve düzeltme talepleriniz için: <a href="/iletisim">iletişim sayfamızı</a> ziyaret edin.</p>
`);
}

function renderContactPage() {
  return renderStaticPage('İletişim', `
<h1>İletişim</h1>
<p>Kartalix ile iletişime geçmek için aşağıdaki e-posta adresini kullanabilirsiniz.</p>
<h2>E-posta</h2>
<p><a href="mailto:iletisim@kartalix.com">iletisim@kartalix.com</a></p>
<h2>Ne Zaman Yanıt Alırsınız?</h2>
<p>Mesajlarınıza genellikle 2–3 iş günü içinde yanıt veriyoruz.</p>
<h2>Hangi Konularda Yazabilirsiniz?</h2>
<ul>
  <li>Haber düzeltme talepleri</li>
  <li>İçerik önerileri</li>
  <li>Reklam ve iş birliği teklifleri</li>
  <li>Teknik sorunlar</li>
</ul>
<p>Kartalix, Beşiktaş JK ile resmi bir bağlantısı bulunmayan bağımsız bir yayın organıdır.</p>
`);
}

function renderAttributionPage() {
  return renderStaticPage('Kaynak Atıf', `
<h1>Kaynak Atıf</h1>
<p>Kartalix, Beşiktaş JK haberlerini takip eden bağımsız bir yayın organıdır. Yayımladığımız tüm içerik Kartalix editörleri tarafından özgün olarak üretilmektedir.</p>
<h2>Haber Kaynakları</h2>
<p>Haberlerimiz; kamuya açık spor veri sağlayıcıları, resmi kulüp açıklamaları ve lisanslı haber ajanslarından derlenen bilgilere dayanılarak özgün biçimde kaleme alınmaktadır. Kaynak metinleri birebir kopyalanmaz; yalnızca olgusal veriler (oyuncu adları, skorlar, tarihler, transfer bedelleri) kullanılır.</p>
<h2>İstatistik Verileri</h2>
<p>Maç istatistikleri ve sıralama verileri <a href="https://www.api-football.com" target="_blank" rel="noopener">API-Football</a> aracılığıyla sağlanmaktadır.</p>
<h2>Video İçerikleri</h2>
<p>Sitemizde yer alan YouTube videolarının tüm hakları ilgili kanallara aittir. Kartalix bu videoları yayımlamaz; yalnızca resmi YouTube kanalları üzerinden gömülü (embed) olarak sunar.</p>
<h2>Hata Bildirimi</h2>
<p>Bir haber hatasını veya yanlış bilgiyi bildirmek için <a href="/iletisim">iletişim sayfamızı</a> kullanabilirsiniz. Doğrulanmış düzeltmeleri en kısa sürede yayımlarız.</p>
`);
}

function renderPrivacyPage() {
  const date = '9 Mayıs 2025';
  return renderStaticPage('Gizlilik Politikası', `
<h1>Gizlilik Politikası</h1>
<p>Son güncelleme: ${date}</p>
<p>Kartalix ("biz", "bizim") olarak gizliliğinize saygı duyuyoruz. Bu politika, sitemizi ziyaret ettiğinizde hangi verilerin toplandığını ve nasıl kullanıldığını açıklamaktadır.</p>
<h2>Toplanan Veriler</h2>
<p>Sitemizi ziyaret ettiğinizde tarayıcınız tarafından standart sunucu günlükleri (IP adresi, tarayıcı türü, ziyaret edilen sayfa, ziyaret tarihi) oluşturulabilir. Bu veriler yalnızca teknik sorun giderme amacıyla kullanılır ve üçüncü taraflarla paylaşılmaz.</p>
<h2>Çerezler (Cookies)</h2>
<p>Sitemiz, reklam hizmetleri ve içerik kişiselleştirme amacıyla çerezler kullanmaktadır. Bu çerezler üçüncü taraf sağlayıcılar tarafından yerleştirilebilir.</p>
<h2>Google AdSense ve Reklamlar</h2>
<p>Kartalix, reklam göstermek için Google AdSense hizmetini kullanmaktadır. Google ve ortakları, siteye yönelik önceki ziyaretlerinize veya diğer web sitelerine dayalı reklamlar sunmak amacıyla çerez kullanabilir.</p>
<p>Google'ın reklam çerezlerini devre dışı bırakmak için <a href="https://www.google.com/settings/ads" target="_blank" rel="noopener">Google Reklam Ayarları</a> sayfasını ziyaret edebilirsiniz. Ayrıca <a href="https://www.aboutads.info" target="_blank" rel="noopener">aboutads.info</a> üzerinden üçüncü taraf çerezlerini devre dışı bırakabilirsiniz.</p>
<h2>Üçüncü Taraf Bağlantıları</h2>
<p>Sitemizde yer alan dış bağlantılar, kendi gizlilik politikalarına sahip üçüncü taraf sitelere yönlendirebilir. Bu sitelerin içerik ve uygulamalarından sorumlu değiliz.</p>
<h2>Veri Güvenliği</h2>
<p>Kişisel verilerinizi toplamıyor veya satmıyoruz. Reklam teknolojileri aracılığıyla oluşturulan anonim kullanım verileri, hizmet iyileştirme amacıyla kullanılabilir.</p>
<h2>Değişiklikler</h2>
<p>Bu politikayı zaman zaman güncelleyebiliriz. Değişiklikler bu sayfada yayımlandığı tarihten itibaren geçerlidir.</p>
<h2>İletişim</h2>
<p>Gizlilik politikamızla ilgili sorularınız için: <a href="mailto:iletisim@kartalix.com">iletisim@kartalix.com</a></p>
`);
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
<meta name="ai-generated" content="true"/>
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
      <span style="color:#555;font-size:0.68rem">YZ destekli</span>
    </div>
    ${image ? `<img class="article-img" src="${escHtml(image)}" alt="${escHtml(title)}" loading="lazy"/>` : ''}
    <div class="article-body">${bodyHtml}</div>
    ${fixtureId && templateId ? `<div id="matchStatsBox" style="margin:1.5rem 0"></div>
    <script>
    (async function(){
      try {
        const r = await fetch('https://kartalix.com/widgets/bjk-match-stats?fixture=${fixtureId}');
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
<footer style="border-top:1px solid #222;padding:1.5rem;text-align:center;font-size:0.75rem;color:#555;margin-top:2rem">
  <a href="/hakkimizda" style="color:#666;margin:0 0.75rem;text-decoration:none">Hakkımızda</a>
  <a href="/iletisim" style="color:#666;margin:0 0.75rem;text-decoration:none">İletişim</a>
  <a href="/gizlilik" style="color:#666;margin:0 0.75rem;text-decoration:none">Gizlilik Politikası</a>
  <a href="/kaynak-atif" style="color:#666;margin:0 0.75rem;text-decoration:none">Kaynak Atıf</a>
  <a href="/impressum" style="color:#666;margin:0 0.75rem;text-decoration:none">Impressum</a>
  <a href="/rss" style="color:#666;margin:0 0.75rem;text-decoration:none">RSS</a>
</footer>
</body>
</html>`;
}

function adminNav(active) {
  const links = [
    { href: '/admin',             label: 'Haberler',   key: 'news'       },
    { href: '/admin/sources/ui',  label: 'Sources',    key: 'sources'    },
    { href: '/admin/financials',  label: 'Financials', key: 'financials' },
    { href: '/admin/report',      label: 'Report',     key: 'report'     },
    { href: '/admin/roadmap',     label: 'Roadmap',    key: 'roadmap'    },
    { href: '/admin/releases',    label: 'Releases',   key: 'releases'   },
  ];
  const navLinks = links.map(l => {
    const isActive = active === l.key;
    return `<a href="${l.href}" style="display:flex;align-items:center;padding:0 1rem;height:100%;font-size:.78rem;font-weight:${isActive ? '700' : '400'};color:${isActive ? '#fff' : '#666'};text-decoration:none;border-bottom:${isActive ? '2px solid #E30A17' : '2px solid transparent'}">${l.label}</a>`;
  }).join('');
  return `<header style="background:#111;border-bottom:1px solid #222;padding:0 1.5rem;height:48px;display:flex;align-items:center;gap:0;position:sticky;top:0;z-index:10">
  <a href="/" style="font-size:1rem;font-weight:900;color:#fff;text-decoration:none;margin-right:1rem">Kartal<span style="color:#E30A17">ix</span></a>
  <nav style="display:flex;height:100%">${navLinks}</nav>
  <a href="/" style="color:#555;font-size:.72rem;text-decoration:none;margin-left:auto">← Site</a>
</header>`;
}

function renderCostPage(data) {
  const { current_usd, cap_usd, pct_used, blocked, history } = data;
  const barPct = Math.min(parseFloat(pct_used || 0), 100);
  const barColor = barPct >= 100 ? '#E30A17' : barPct >= 80 ? '#f0a500' : '#3a9a3a';
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Cost Monitor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.6}
main{max-width:640px;margin:2rem auto;padding:0 1.5rem}
.card{background:#111;border:1px solid #222;border-radius:6px;padding:1.25rem 1.5rem;margin-bottom:1.25rem}
h2{font-size:.78rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:1rem}
.big-num{font-size:2.2rem;font-weight:900;color:#fff;line-height:1}
.big-sub{font-size:.75rem;color:#666;margin-top:.3rem}
.bar-wrap{background:#1a1a1a;border-radius:4px;height:8px;margin:1rem 0 .5rem;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .3s}
.bar-label{font-size:.72rem;color:#888;display:flex;justify-content:space-between}
.status-ok{color:#3a9a3a;font-weight:700}
.status-warn{color:#f0a500;font-weight:700}
.status-blocked{color:#E30A17;font-weight:700}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:.7rem;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:4px 0;border-bottom:1px solid #222}
td{padding:6px 0;border-bottom:1px solid #1a1a1a;font-size:.85rem}
td:last-child{text-align:right;color:#888}
</style>
</head>
<body>
${adminNav('cost')}
<main>
  <div class="card">
    <h2>This Month</h2>
    <div class="big-num">$${current_usd.toFixed(4)}</div>
    <div class="big-sub">of $${cap_usd.toFixed(2)} cap — <span class="${blocked ? 'status-blocked' : barPct >= 80 ? 'status-warn' : 'status-ok'}">${blocked ? 'BLOCKED' : barPct >= 80 ? 'WARNING' : 'OK'}</span></div>
    <div class="bar-wrap"><div class="bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
    <div class="bar-label"><span>${barPct.toFixed(1)}% used</span><span>$${(cap_usd - current_usd).toFixed(4)} remaining</span></div>
  </div>
  <div class="card">
    <h2>History</h2>
    <table>
      <thead><tr><th>Month</th><th>Spend (USD)</th></tr></thead>
      <tbody>
        ${history.map(h => `<tr><td>${h.month}</td><td style="text-align:right">$${h.usd.toFixed(4)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>
  <p style="font-size:.7rem;color:#555;text-align:center">Cap configurable via MONTHLY_CLAUDE_CAP env var (default $8). Refreshes each page load.</p>
</main>
</body>
</html>`;
}

function renderFinancialsPage(monthsData, fixedItems) {
  const allMonths    = monthsData.map(d => d.month);
  const currentMonth = allMonths[allMonths.length - 1] || '';
  // All manual entries tagged with their start month (for rendering the table)
  const allManual = monthsData.flatMap(d => d.manual.map(c => ({ ...c, startMonth: d.month })));

  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Financials</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.6}
main{max-width:900px;margin:2rem auto;padding:0 1.5rem}
.range-bar{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin-bottom:1.25rem}
.rbtn{background:#1a1a1a;border:1px solid #2a2a2a;color:#888;padding:.35rem .85rem;border-radius:4px;font-size:.75rem;cursor:pointer;font-family:inherit}
.rbtn:hover{border-color:#444;color:#ccc}
.rbtn.active{background:#1a1a2a;border-color:#4466aa;color:#aad}
.custom-range{display:none;gap:.5rem;align-items:center;font-size:.78rem;color:#666}
.custom-range input{background:#1a1a1a;border:1px solid #333;color:#e8e6e0;border-radius:4px;padding:.3rem .5rem;font-size:.78rem;font-family:inherit}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem;margin-bottom:1.5rem}
@media(max-width:640px){.summary{grid-template-columns:1fr 1fr}}
.kpi{background:#111;border:1px solid #222;border-radius:6px;padding:.9rem 1.1rem}
.kpi-label{font-size:.62rem;color:#555;text-transform:uppercase;letter-spacing:.1em;margin-bottom:.25rem}
.kpi-value{font-size:1.45rem;font-weight:900;line-height:1;font-variant-numeric:tabular-nums}
.kpi-sub{font-size:.62rem;color:#444;margin-top:.2rem}
.red{color:#E30A17}.green{color:#3a9a3a}.dim{color:#888}
.chart-wrap{background:#111;border:1px solid #222;border-radius:6px;padding:1.1rem 1.25rem;margin-bottom:1.5rem}
.section{margin-bottom:1.5rem}
.section-head{display:flex;align-items:center;gap:.75rem;margin-bottom:.7rem;padding-bottom:.4rem;border-bottom:1px solid #1e1e1e}
h2{font-size:.68rem;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.1em;flex:1}
.month-pick{background:#1a1a1a;border:1px solid #2a2a2a;color:#aaa;border-radius:4px;padding:.25rem .5rem;font-size:.75rem;font-family:inherit}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:.62rem;color:#444;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:5px 8px;border-bottom:1px solid #1e1e1e}
td{padding:6px 8px;border-bottom:1px solid #161616;vertical-align:middle;font-size:.82rem}
.num{text-align:right;font-variant-numeric:tabular-nums}
.nc{color:#444;font-size:.72rem}
.badge{font-size:.52rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 6px;border-radius:10px;border:1px solid;white-space:nowrap}
.bf{background:#1a2030;color:#6af;border-color:#2a3a50}
.bv{background:#2a1a10;color:#f93;border-color:#3a2a10}
.bm{background:#251808;color:#fa7;border-color:#3a2808}
.br{background:#0a2010;color:#3a9;border-color:#1a3020}
.brt{background:#0a1a20;color:#39a;border-color:#1a2a30}
.total-row td{border-top:1px solid #2a2a2a;font-weight:700;font-size:.78rem;color:#aaa}
.entry-form{background:#111;border:1px solid #222;border-radius:6px;padding:.9rem 1.1rem;margin-bottom:.75rem;display:flex;gap:.6rem;align-items:flex-end;flex-wrap:wrap}
.entry-form label{font-size:.6rem;color:#555;text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:.25rem}
.entry-form input,.entry-form select{background:#1a1a1a;border:1px solid #2a2a2a;color:#e8e6e0;border-radius:4px;padding:.35rem .55rem;font-size:.82rem;font-family:inherit;outline:none}
.entry-form input:focus,.entry-form select:focus{border-color:#444}
.btn-save{background:#1a2a1a;color:#7ec87e;border:1px solid #2a3a2a;padding:.35rem .9rem;border-radius:4px;font-size:.75rem;font-weight:600;cursor:pointer;white-space:nowrap}
.btn-save:hover{background:#2a3a2a}
.btn-del{background:transparent;border:1px solid #2a2a2a;color:#555;padding:2px 8px;border-radius:3px;font-size:.68rem;cursor:pointer}
.btn-del:hover{border-color:#E30A17;color:#E30A17}
.st{font-size:.7rem;color:#3a9a3a;align-self:center;min-width:50px}
.page-note{font-size:.65rem;color:#333;text-align:center;margin-top:1.25rem}
</style>
</head>
<body>
${adminNav('financials')}
<main>

<div class="range-bar">
  <button class="rbtn active" onclick="setRange('month',this)">This Month</button>
  <button class="rbtn" onclick="setRange('ytd',this)">YTD</button>
  <button class="rbtn" onclick="setRange('12m',this)">Last 12M</button>
  <button class="rbtn" onclick="setRange('all',this)">All Time</button>
  <button class="rbtn" onclick="setRange('custom',this)">Custom</button>
  <div class="custom-range" id="customRange">
    <input type="month" id="fromM" min="${allMonths[0]}" max="${currentMonth}" value="${allMonths[0]}"/> to
    <input type="month" id="toM"   min="${allMonths[0]}" max="${currentMonth}" value="${currentMonth}"/>
    <button class="rbtn" onclick="applyCustom()">Apply</button>
  </div>
</div>

<div class="summary">
  <div class="kpi"><div class="kpi-label">Burn</div><div class="kpi-value red" id="kBurn">—</div><div class="kpi-sub" id="kBurnSub"></div></div>
  <div class="kpi"><div class="kpi-label">Revenue</div><div class="kpi-value green" id="kRev">—</div><div class="kpi-sub" id="kRevSub"></div></div>
  <div class="kpi"><div class="kpi-label">Margin</div><div class="kpi-value" id="kMargin">—</div><div class="kpi-sub" id="kMarginSub"></div></div>
  <div class="kpi"><div class="kpi-label">Months</div><div class="kpi-value dim" id="kMonths">—</div><div class="kpi-sub" id="kRange"></div></div>
</div>

<div class="chart-wrap">
  <canvas id="chart" height="80"></canvas>
</div>

<!-- COST BREAKDOWN PER MONTH -->
<div class="section">
  <div class="section-head">
    <h2>Cost Breakdown</h2>
    <select class="month-pick" id="bdMonth" onchange="renderBreakdown(this.value)">
      ${allMonths.map(m => `<option value="${m}"${m===currentMonth?' selected':''}>${m}</option>`).join('')}
    </select>
  </div>
  <div id="bdTable"></div>
</div>

<!-- ADD COST ENTRY -->
<div class="section">
  <div class="section-head"><h2>Add Cost Entry</h2></div>
  <div class="entry-form">
    <div><label>Month (start)</label><select id="costMonth">${allMonths.map(m => `<option value="${m}"${m===currentMonth?' selected':''}>${m}</option>`).join('')}</select></div>
    <div><label>Item</label><input type="text" id="costItem" placeholder="e.g. Claude API April" style="width:160px"/></div>
    <div><label>Amount (USD)</label><input type="number" id="costAmt" step="0.01" min="0" style="width:85px" placeholder="0.00"/></div>
    <div><label>Type</label>
      <select id="costType">
        <option value="one_time">One-time</option>
        <option value="recurring">Recurring</option>
      </select>
    </div>
    <div><label>Notes</label><input type="text" id="costNotes" placeholder="optional" style="width:130px"/></div>
    <button class="btn-save" onclick="addCost()">Add</button>
    <span class="st" id="costSt"></span>
  </div>
</div>

<!-- REVENUE ENTRY -->
<div class="section">
  <div class="section-head"><h2>Revenue Entry</h2></div>
  <div class="entry-form">
    <div><label>Month</label><select id="revMonth">${allMonths.map(m => `<option value="${m}"${m===currentMonth?' selected':''}>${m}</option>`).join('')}</select></div>
    <div><label>Amount (USD)</label><input type="number" id="revAmt" step="0.01" min="0" style="width:110px" placeholder="0.00"/></div>
    <button class="btn-save" onclick="saveRevenue()">Save</button>
    <span class="st" id="revSt"></span>
  </div>
</div>

<p class="page-note">Fixed costs hardcoded — ask Claude to update when plans change. Recurring manual entries propagate forward from their start month.</p>
</main>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script>
const ALL_DATA    = ${JSON.stringify(monthsData)};
const FIXED_ITEMS = ${JSON.stringify(fixedItems)};
const ALL_MANUAL  = ${JSON.stringify(allManual)};

let chart       = null;
let activeRange = 'month';
let customFrom  = '${allMonths[0]}', customTo = '${currentMonth}';

// Returns manual costs effective for a given month:
// - one_time: only in their startMonth
// - recurring: in startMonth and all months after
function effectiveCosts(month) {
  return ALL_MANUAL.filter(c =>
    c.type === 'recurring' ? c.startMonth <= month : c.startMonth === month
  );
}

function burnOf(d) {
  return d.fixed + d.claude + effectiveCosts(d.month).reduce((s,c)=>s+c.amount,0);
}

function getFiltered(range, cf, ct) {
  const now  = ALL_DATA[ALL_DATA.length-1]?.month || '';
  const year = now.slice(0,4);
  if (range==='month')  return ALL_DATA.filter(d=>d.month===now);
  if (range==='ytd')    return ALL_DATA.filter(d=>d.month.startsWith(year));
  if (range==='12m')  { const d=new Date(now+'-01');d.setMonth(d.getMonth()-11);const f=d.toISOString().slice(0,7);return ALL_DATA.filter(d=>d.month>=f); }
  if (range==='custom') return ALL_DATA.filter(d=>d.month>=cf&&d.month<=ct);
  return ALL_DATA;
}

function fmt(n){ return (n<0?'-':'')+'$'+Math.abs(n).toFixed(2); }

function render() {
  const fd = getFiltered(activeRange, customFrom, customTo);
  if (!fd.length) return;

  const totalBurn = fd.reduce((s,d)=>s+burnOf(d),0);
  const totalRev  = fd.reduce((s,d)=>s+d.revenue,0);
  const margin    = totalRev - totalBurn;
  const n         = fd.length;

  document.getElementById('kBurn').textContent     = fmt(totalBurn);
  document.getElementById('kBurnSub').textContent  = n>1?'avg '+fmt(totalBurn/n)+'/mo':'this month';
  document.getElementById('kRev').textContent      = fmt(totalRev);
  document.getElementById('kRevSub').textContent   = n>1?'avg '+fmt(totalRev/n)+'/mo':'this month';
  document.getElementById('kMargin').textContent   = fmt(margin);
  document.getElementById('kMargin').className     = 'kpi-value '+(margin>=0?'green':'red');
  document.getElementById('kMarginSub').textContent= margin>=0?'profitable':'burning';
  document.getElementById('kMonths').textContent   = n;
  document.getElementById('kRange').textContent    = fd[0].month+(n>1?' → '+fd[n-1].month:'');

  const labels  = fd.map(d=>d.month);
  const dFixed  = fd.map(d=>+d.fixed.toFixed(2));
  const dClaude = fd.map(d=>+d.claude.toFixed(4));
  const dManual = fd.map(d=>+effectiveCosts(d.month).reduce((s,c)=>s+c.amount,0).toFixed(2));
  const dRev    = fd.map(d=>+d.revenue.toFixed(2));
  const dMargin = fd.map(d=>+(d.revenue-burnOf(d)).toFixed(2));

  const datasets = [
    {type:'bar', label:'Fixed',   data:dFixed,  backgroundColor:'#6b1a1a', stack:'c'},
    {type:'bar', label:'Claude',  data:dClaude, backgroundColor:'#b04010', stack:'c'},
    {type:'bar', label:'Manual',  data:dManual, backgroundColor:'#8a5000', stack:'c'},
    {type:'bar', label:'Revenue', data:dRev,    backgroundColor:'#1a5a2a', stack:'r'},
    {type:'line',label:'Margin',  data:dMargin, borderColor:'#555',borderWidth:1.5,pointRadius:3,pointBackgroundColor:'#555',tension:.3},
  ];

  if (chart) {
    chart.data.labels = labels;
    datasets.forEach((ds,i)=>{ chart.data.datasets[i].data = ds.data; });
    chart.update();
  } else {
    chart = new Chart(document.getElementById('chart').getContext('2d'), {
      data:{labels, datasets},
      options:{
        responsive:true, interaction:{mode:'index',intersect:false},
        scales:{
          x:{ticks:{color:'#555',font:{size:11}},grid:{color:'#1a1a1a'}},
          y:{ticks:{color:'#555',font:{size:11},callback:v=>'$'+v},grid:{color:'#1e1e1e'}},
        },
        plugins:{
          legend:{labels:{color:'#666',font:{size:10},boxWidth:10,padding:12}},
          tooltip:{callbacks:{label:c=>' '+c.dataset.label+': $'+c.parsed.y.toFixed(2)}},
        }
      }
    });
  }
}

function renderBreakdown(month) {
  const d = ALL_DATA.find(x=>x.month===month);
  if (!d) return;
  const ec = effectiveCosts(month);
  const manualTotal = ec.reduce((s,c)=>s+c.amount,0);
  const total = d.fixed + d.claude + manualTotal;

  let rows = '';
  FIXED_ITEMS.forEach(fi => {
    rows += \`<tr><td>\${fi.item}</td><td><span class="badge bf">fixed</span></td><td class="num">\${fmt(fi.amount)}</td><td class="nc">\${fi.notes}</td><td></td></tr>\`;
  });
  rows += \`<tr><td>Claude API (auto-tracked)</td><td><span class="badge bv">variable</span></td><td class="num">\${fmt(d.claude)}</td><td class="nc">KV accumulator</td><td></td></tr>\`;
  ec.forEach(c => {
    const badge = c.type==='recurring'?'<span class="badge brt">recurring</span>':'<span class="badge bm">one-time</span>';
    const origin = c.startMonth!==month?' <span style="color:#444;font-size:.65rem">(from '+c.startMonth+')</span>':'';
    rows += \`<tr><td>\${c.item}\${origin}</td><td>\${badge}</td><td class="num">\${fmt(c.amount)}</td><td class="nc">\${c.notes||''}</td><td><button class="btn-del" onclick="delCost('\${c.startMonth}','\${c.id}')">×</button></td></tr>\`;
  });
  rows += \`<tr class="total-row"><td colspan="2">TOTAL BURN</td><td class="num">\${fmt(total)}</td><td></td><td></td></tr>\`;

  document.getElementById('bdTable').innerHTML =
    '<table><thead><tr><th>Item</th><th>Type</th><th style="text-align:right">Amount</th><th>Notes</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function setRange(r, btn) {
  activeRange = r;
  document.querySelectorAll('.rbtn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('customRange').style.display = r==='custom'?'flex':'none';
  if (r !== 'custom') render();
}

function applyCustom() {
  customFrom = document.getElementById('fromM').value;
  customTo   = document.getElementById('toM').value;
  render();
}

async function post(body) {
  const r = await fetch('/admin/financials',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return r.json();
}

async function addCost() {
  const item = document.getElementById('costItem').value.trim();
  const amt  = parseFloat(document.getElementById('costAmt').value)||0;
  if (!item||!amt) { document.getElementById('costSt').textContent='Fill item + amount'; return; }
  const st = document.getElementById('costSt');
  st.textContent='Saving…';
  const d = await post({
    action:'add_cost', month:document.getElementById('costMonth').value,
    item, amount:amt, type:document.getElementById('costType').value,
    notes:document.getElementById('costNotes').value.trim()
  });
  st.textContent = d.ok?'Added ✓':'Error';
  setTimeout(()=>{ if(d.ok) location.reload(); },900);
}

async function delCost(month, id) {
  if (!confirm('Delete this entry?')) return;
  const d = await post({ action:'del_cost', month, id });
  if (d.ok) location.reload();
}

async function saveRevenue() {
  const month = document.getElementById('revMonth').value;
  const rev   = parseFloat(document.getElementById('revAmt').value)||0;
  const st    = document.getElementById('revSt');
  st.textContent='Saving…';
  const d = await post({ action:'revenue', month, revenue:rev });
  st.textContent = d.ok?'Saved ✓':'Error';
  setTimeout(()=>{ if(d.ok) location.reload(); },900);
}

// Init
const curData = ALL_DATA.find(d=>d.month==='${currentMonth}');
if (curData) document.getElementById('revAmt').value = curData.revenue.toFixed(2);
render();
renderBreakdown('${currentMonth}');
</script>
</body>
</html>`;
}

function renderSourcesPage() {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Sources</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;line-height:1.5}
a{color:#888;text-decoration:none}a:hover{color:#fff}
main{max-width:1200px;margin:1.5rem auto;padding:0 1.5rem}
.toolbar{display:flex;gap:.5rem;align-items:center;margin-bottom:1rem;flex-wrap:wrap}
.btn{background:#333;color:#e8e6e0;border:none;padding:5px 12px;border-radius:3px;cursor:pointer;font-size:12px;font-family:inherit}
.btn:hover{background:#444}
.btn-green{background:#2a3a2a;color:#7ec87e;border:1px solid #3a4a3a}
.btn-green:hover{background:#3a4a3a}
.btn-blue{background:#1a2a3a;color:#7ac;border:1px solid #2a3a4a}
.btn-blue:hover{background:#2a3a4a}
.btn-red{background:transparent;color:#844;border:1px solid #433;padding:3px 8px}
.btn-red:hover{border-color:#E30A17;color:#E30A17}
.btn-sm{padding:3px 8px;font-size:11px}
/* Add form panel */
.add-panel{background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:1rem 1.25rem;margin-bottom:1rem;display:none}
.add-panel.open{display:block}
.add-panel h3{font-size:.72rem;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.1em;margin-bottom:.9rem}
.form-row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:.6rem}
.form-row label{font-size:.6rem;color:#555;text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:.2rem}
.form-row input,.form-row select{background:#1a1a1a;border:1px solid #2a2a2a;color:#e8e6e0;border-radius:3px;padding:.35rem .55rem;font-size:12px;font-family:inherit;outline:none}
.form-row input:focus,.form-row select:focus{border-color:#444}
/* Table */
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:6px 8px;border-bottom:1px solid #2a2a2a;color:#666;font-weight:600;white-space:nowrap;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
td{padding:5px 8px;border-bottom:1px solid #1a1a1a;vertical-align:middle}
tr.src-row:hover > td{background:#151515}
input[type=text],input[type=number]{background:#1e1e1e;border:1px solid #2a2a2a;color:#e8e6e0;padding:3px 6px;border-radius:3px;font-size:12px;font-family:inherit}
input[type=checkbox]{accent-color:#E30A17;width:13px;height:13px;cursor:pointer}
select{background:#1e1e1e;border:1px solid #2a2a2a;color:#e8e6e0;padding:3px 5px;border-radius:3px;font-size:12px;font-family:inherit}
.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600}
.badge-rss{background:#1a2a3a;color:#7aa}
.badge-yt{background:#3a1a1a;color:#f77}
.saved{color:#7ec87e;font-size:11px;margin-left:4px}
/* Test result panel */
.test-row td{background:#0e1a0e;padding:.6rem 1rem;font-size:11px;color:#888}
.test-row.error td{background:#1a0e0e}
.test-ok{color:#3a9}
.test-err{color:#E30A17}
.test-sample{margin-top:.4rem;color:#aaa;line-height:1.6}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle;flex-shrink:0}
.dot-ok{background:#3a9a3a}.dot-fail{background:#E30A17}.dot-none{background:#333}
</style>
</head>
<body>
${adminNav('sources')}
<main>
  <div class="toolbar">
    <button class="btn btn-green" onclick="toggleAdd()">+ Add Source</button>
    <button class="btn btn-blue" onclick="seedSources()">Seed Defaults</button>
    <button class="btn" onclick="testAll(this)">Test All</button>
    <span id="testAllSt" style="font-size:11px;color:#666;margin-left:.25rem"></span>
  </div>

  <!-- ADD FORM -->
  <div class="add-panel" id="addPanel">
    <h3>New Source</h3>
    <div class="form-row">
      <div><label>Name *</label><input type="text" id="aName" style="width:180px" placeholder="Fanatik RSS"/></div>
      <div><label>Type *</label>
        <select id="aType" onchange="toggleTypeFields()">
          <option value="rss">RSS</option>
          <option value="youtube">YouTube</option>
        </select>
      </div>
      <div id="fUrl"><label>Feed URL</label><input type="text" id="aUrl" style="width:280px" placeholder="https://..."/></div>
      <div id="fChan" style="display:none"><label>Channel ID</label><input type="text" id="aChan" style="width:200px" placeholder="UCxxxxxxxx"/></div>
    </div>
    <div class="form-row">
      <div><label>Trust Tier</label>
        <select id="aTier"><option>official</option><option>broadcast</option><option selected>press</option><option>journalist</option><option>digital</option><option>aggregator</option></select>
      </div>
      <div><label>Treatment</label>
        <select id="aTreat"><option selected>publish</option><option>embed</option><option>synthesize</option><option>embed_and_synthesize</option><option>signal_only</option></select>
      </div>
      <div><label>NVS Hint</label><input type="number" id="aNvs" style="width:70px" placeholder="auto"/></div>
      <div style="display:flex;gap:1rem;align-items:flex-end;padding-bottom:4px">
        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#666;cursor:pointer">
          <input type="checkbox" id="aBjk"/> BJK Filter
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#666;cursor:pointer">
          <input type="checkbox" id="aAllQ"/> All Qualify
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#666;cursor:pointer">
          <input type="checkbox" id="aProxy"/> Proxy
        </label>
        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#666;cursor:pointer">
          <input type="checkbox" id="aP4" checked/> P4
        </label>
      </div>
      <div><label>Notes</label><input type="text" id="aNotes" style="width:160px" placeholder="optional"/></div>
    </div>
    <div class="form-row">
      <button class="btn btn-green" onclick="addSource()">Save &amp; Add</button>
      <button class="btn btn-green" onclick="addAndTest()">Save &amp; Test</button>
      <button class="btn" onclick="toggleAdd()">Cancel</button>
      <span id="addSt" style="font-size:11px;color:#3a9;margin-left:.5rem"></span>
    </div>
  </div>

  <!-- TABLE -->
  <table>
    <thead>
      <tr>
        <th>On</th><th>Name / URL</th><th>Type</th><th>Trust</th><th>Treatment</th>
        <th>NVS</th><th>Notes</th><th style="text-align:right">Actions</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</main>
<script>
const TIERS      = ['official','broadcast','press','journalist','digital','aggregator'];
const TREATMENTS = ['publish','embed','synthesize','embed_and_synthesize','signal_only'];

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function load() {
  const [rows, tests] = await Promise.all([
    fetch('/admin/sources').then(r=>r.json()),
    fetch('/admin/sources/tests').then(r=>r.json()).catch(()=>({})),
  ]);
  document.getElementById('tbody').innerHTML = rows.map(r => {
    const t   = tests[r.id];
    const dot = t ? (t.ok ? 'dot-ok' : 'dot-fail') : 'dot-none';
    const tip = t ? (t.ok
      ? \`Last test: \${t.tested_at?.slice(0,16).replace('T',' ')} UTC — OK\`
      : \`Last test: \${t.tested_at?.slice(0,16).replace('T',' ')} UTC — FAILED: \${t.error}\`)
      : 'Never tested';
    return \`
    <tr class="src-row" id="row-\${r.id}">
      <td><input type="checkbox" \${r.is_active?'checked':''} onchange="markDirty('\${r.id}')"/></td>
      <td>
        <div style="display:flex;align-items:center;gap:4px">
          <span class="dot \${dot}" title="\${esc(tip)}"></span>
          <input type="text" value="\${esc(r.name)}" style="width:150px;font-weight:600" onchange="markDirty('\${r.id}')"/>
        </div>
        <div style="color:#444;font-size:10px;margin-top:2px;padding-left:13px">\${esc(r.url||r.channel_id||'')}</div>
      </td>
      <td><span class="badge \${r.source_type==='rss'?'badge-rss':'badge-yt'}">\${r.source_type}</span></td>
      <td><select onchange="markDirty('\${r.id}')">\${TIERS.map(t=>\`<option \${t===r.trust_tier?'selected':''}>\${t}</option>\`).join('')}</select></td>
      <td><select onchange="markDirty('\${r.id}')">\${TREATMENTS.map(t=>\`<option \${t===r.treatment?'selected':''}>\${t}</option>\`).join('')}</select></td>
      <td><input type="number" style="width:52px" value="\${r.nvs_hint??''}" placeholder="auto" onchange="markDirty('\${r.id}')"/></td>
      <td><input type="text" value="\${esc(r.notes||'')}" placeholder="notes" onchange="markDirty('\${r.id}')"/></td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" onclick="save('\${r.id}')">Save</button>
        <span class="saved" id="saved-\${r.id}" style="display:none">✓</span>
        <button class="btn btn-blue btn-sm" onclick="testSource('\${r.id}')">Test</button>
        <button class="btn btn-red btn-sm" onclick="delSource('\${r.id}')">Del</button>
      </td>
    </tr>
    <tr class="test-row" id="test-\${r.id}" style="display:none"><td colspan="8"><span id="test-out-\${r.id}"></span></td></tr>
  \`;}).join('');
}

function markDirty(id) {
  document.getElementById('saved-'+id).style.display = 'none';
}

async function save(id) {
  const row = document.getElementById('row-'+id);
  const inputs  = [...row.querySelectorAll('input,select')];
  const active  = inputs[0];
  const name    = inputs[1];
  const tier    = inputs[2];
  const treat   = inputs[3];
  const nvs     = inputs[4];
  const notes   = inputs[5];
  await fetch('/admin/sources', { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
    id, is_active: active.checked, name: name.value,
    trust_tier: tier.value, treatment: treat.value,
    nvs_hint: nvs.value ? parseInt(nvs.value) : null,
    notes: notes.value,
  })});
  const s = document.getElementById('saved-'+id);
  s.style.display='inline'; setTimeout(()=>s.style.display='none', 2000);
}

async function delSource(id) {
  if (!confirm('Delete this source? This cannot be undone.')) return;
  await fetch('/admin/sources?id='+id, { method:'DELETE' });
  document.getElementById('row-'+id)?.remove();
  document.getElementById('test-'+id)?.remove();
}

async function testSource(id) {
  const panel = document.getElementById('test-'+id);
  const out   = document.getElementById('test-out-'+id);
  panel.style.display = 'table-row';
  panel.className = 'test-row';
  out.innerHTML = '<span style="color:#555">Testing…</span>';
  try {
    const res  = await fetch('/admin/sources/test?id='+id);
    const data = await res.json();
    // Update status dot
    const dot = document.querySelector(\`#row-\${id} .dot\`);
    if (dot) { dot.className = 'dot '+(data.ok?'dot-ok':'dot-fail'); dot.title = data.ok?'Just tested — OK':'Just tested — FAILED: '+(data.error||''); }
    if (!data.ok) {
      panel.className = 'test-row error';
      out.innerHTML = \`<span class="test-err">✗ \${esc(data.error)}</span>\`;
      return;
    }
    if (data.type === 'rss') {
      out.innerHTML = \`<span class="test-ok">✓ RSS reachable — \${data.items} items in feed</span>
        <div class="test-sample">\${data.sample.map(t=>'· '+esc(t)).join('<br>')}</div>\`;
    } else {
      out.innerHTML = \`<span class="test-ok">✓ YouTube reachable — \${data.total} videos, \${data.qualified} qualify</span>
        <div class="test-sample">\${data.sample.map(t=>'· '+esc(t)).join('<br>')}</div>\`;
    }
  } catch(e) {
    panel.className = 'test-row error';
    out.innerHTML = \`<span class="test-err">✗ \${esc(e.message)}</span>\`;
  }
}

function toggleAdd() {
  const p = document.getElementById('addPanel');
  p.classList.toggle('open');
}

function toggleTypeFields() {
  const t = document.getElementById('aType').value;
  document.getElementById('fUrl').style.display  = t==='rss'     ?'block':'none';
  document.getElementById('fChan').style.display = t==='youtube' ?'block':'none';
}

async function addSource() {
  const type = document.getElementById('aType').value;
  const name = document.getElementById('aName').value.trim();
  if (!name) { document.getElementById('addSt').textContent='Name required'; return; }
  const body = {
    name, source_type: type,
    url:        type==='rss'     ? document.getElementById('aUrl').value.trim()  : undefined,
    channel_id: type==='youtube' ? document.getElementById('aChan').value.trim() : undefined,
    trust_tier: document.getElementById('aTier').value,
    treatment:  document.getElementById('aTreat').value,
    nvs_hint:   document.getElementById('aNvs').value ? parseInt(document.getElementById('aNvs').value) : null,
    bjk_filter: document.getElementById('aBjk').checked,
    all_qualify:document.getElementById('aAllQ').checked,
    proxy:      document.getElementById('aProxy').checked,
    is_p4:      document.getElementById('aP4').checked,
    notes:      document.getElementById('aNotes').value.trim(),
  };
  document.getElementById('addSt').textContent='Saving…';
  const res = await fetch('/admin/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d   = await res.json();
  if (d.error) { document.getElementById('addSt').textContent='Error: '+d.error; return; }
  document.getElementById('addSt').textContent='Added ✓';
  setTimeout(()=>{ document.getElementById('addPanel').classList.remove('open'); load(); },800);
  return d;
}

async function addAndTest() {
  await addSource();
  // reload then test last row
  setTimeout(async()=>{
    const rows = await (await fetch('/admin/sources')).json();
    if (rows.length) testSource(rows[rows.length-1].id);
  }, 1200);
}

async function testAll(btn) {
  const st = document.getElementById('testAllSt');
  btn.disabled = true;
  const rows = await fetch('/admin/sources').then(r=>r.json());
  const active = rows.filter(r=>r.is_active);
  st.textContent = \`Testing 0 / \${active.length}…\`;
  let done = 0;
  for (const r of active) {
    await testSource(r.id);
    st.textContent = \`Testing \${++done} / \${active.length}…\`;
  }
  st.textContent = \`Done — \${active.length} tested\`;
  btn.disabled = false;
  setTimeout(()=>{ st.textContent=''; },4000);
}

async function seedSources() {
  if (!confirm('Seed default sources? Existing sources will not be overwritten.')) return;
  const res  = await fetch('/admin/sources/seed',{method:'POST'});
  const data = await res.json();
  if (data.error) { alert('Error: '+data.error); return; }
  alert('Seeded '+data.seeded+' sources ('+data.skipped+' already existed)');
  load();
}

load();
</script>
</body>
</html>`;
}

function renderPinPage(next = '/admin') {
  const safeNext = (next.startsWith('/admin') || next === '/report') ? next : '/admin';
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
  if (res.ok) { location.href = '${safeNext}'; }
  else { err.textContent = 'Hatalı PIN.'; document.getElementById('pin').select(); }
}
</script>
</body>
</html>`;
}

function renderAdminReportPage() {
  const nav = adminNav('report');
  const shell = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Report</title>
<script type="text/javascript" src="https://www.gstatic.com/charts/loader.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.5}
.toolbar{background:#111;border-bottom:1px solid #222;padding:.6rem 1.5rem;display:flex;align-items:center;gap:1rem;position:sticky;top:48px;z-index:9}
.toolbar input{flex:1;max-width:380px;background:#1a1a1a;border:1px solid #333;color:#e8e6e0;padding:.45rem .75rem;font-size:.82rem;font-family:inherit;outline:none}
.toolbar input:focus{border-color:#555}
.toolbar-right{display:flex;align-items:center;gap:1rem;margin-left:auto;font-size:.72rem;color:#555}
.refresh-btn{background:transparent;border:1px solid #333;color:#aaa;padding:.3rem .85rem;cursor:pointer;font-size:.72rem;font-family:inherit}
.refresh-btn:hover{border-color:#666;color:#fff}
.refresh-btn:disabled{opacity:.4;cursor:not-allowed}
.range-bar{background:#111;border-bottom:1px solid #222;padding:.45rem 1.5rem;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;position:sticky;top:88px;z-index:8}
.range-btn{background:transparent;border:1px solid #2a2a2a;color:#666;padding:.28rem .6rem;cursor:pointer;font-size:.7rem;font-family:inherit;line-height:1}
.range-btn:hover{border-color:#555;color:#ddd}
.range-btn.active{background:#1a2a1a;border-color:#3a5a3a;color:#5a9a5a}
.range-sep{color:#2a2a2a;margin:0 .2rem;font-size:.8rem}
.range-input{background:#1a1a1a;border:1px solid #2a2a2a;color:#aaa;padding:.26rem .5rem;font-size:.68rem;font-family:inherit;width:148px}
.range-apply{background:transparent;border:1px solid #2a2a2a;color:#777;padding:.26rem .55rem;cursor:pointer;font-size:.68rem;font-family:inherit}
.range-apply:hover{border-color:#555;color:#fff}
.range-label{margin-left:auto;font-size:.65rem;color:#555}
main{max-width:1200px;margin:1.5rem auto;padding:0 1.5rem}
#sankey-wrap{background:#111;border:1px solid #222;margin-bottom:1.25rem;padding:.85rem 1.1rem}
.sankey-title{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:#555;margin-bottom:.6rem;font-weight:400}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#222;border:1px solid #222;margin-bottom:1.25rem}
.grid4 .cell,.grid2 .cell{background:#111;padding:1.1rem 1.25rem}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.25rem}
.stat-lbl{font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#666;margin-bottom:.4rem}
.stat-val{font-size:1.9rem;font-weight:900;line-height:1;color:#fff}
.stat-val.g{color:#5a9a5a}.stat-val.b{color:#4488ff}.stat-val.a{color:#d4a000}
.stat-sub{font-size:.65rem;color:#555;margin-top:.3rem}
.section{background:#111;border:1px solid #222;margin-bottom:1rem}
.sec-head{display:flex;align-items:center;justify-content:space-between;padding:.75rem 1.1rem;cursor:pointer;user-select:none}
.sec-head:hover{background:#141414}
.sec-title{font-size:.82rem;font-weight:700;display:flex;align-items:center;gap:.6rem}
.badge{font-size:.62rem;background:#1a1a1a;border:1px solid #333;color:#888;padding:1px 7px}
.badge.g{background:#1a2a1a;border-color:#3a5a3a;color:#5a9a5a}
.badge.r{background:#2a1a1a;border-color:#5a3a3a;color:#9a5a5a}
.badge.a{background:#2a2010;border-color:#5a4020;color:#d4a000}
.chev{font-size:.65rem;color:#444;transition:transform .15s}
.section.open .chev{transform:rotate(180deg)}
.sec-body{display:none}
.section.open .sec-body{display:block}
.funnel-row{display:flex;align-items:center;padding:.6rem 1.1rem;border-bottom:1px solid #1a1a1a;gap:.75rem;cursor:pointer}
.funnel-row:hover{background:#141414}
.funnel-row:last-child{border-bottom:none}
.f-lbl{width:160px;flex-shrink:0;font-size:.72rem;color:#ccc}
.f-bar-w{flex:1;height:5px;background:#1a1a1a}
.f-bar{height:100%}.f-bar.removed,.f-bar.rejected{background:#7a3a3a}.f-bar.queued{background:#7a6a30}.f-bar{background:#3a6a3a}
.f-num{width:36px;text-align:right;font-size:.78rem;font-weight:600;flex-shrink:0}
.f-delta{width:90px;text-align:right;font-size:.62rem;color:#555;flex-shrink:0}
.f-expand{width:50px;text-align:right;font-size:.6rem;color:#5a9a5a;flex-shrink:0}
.art-list{padding:.6rem 1.1rem}
.art-card{border:1px solid #1e1e1e;padding:.7rem .85rem;margin-bottom:.4rem;font-size:.78rem}
.art-card.hidden{display:none}
.art-meta{display:flex;align-items:center;gap:.4rem;margin-bottom:.35rem;flex-wrap:wrap}
.tag{font-size:.58rem;letter-spacing:.08em;text-transform:uppercase;padding:1px 5px}
.tag.src{background:#1a1a1a;border:1px solid #2a2a2a;color:#777}
.tag.cat{background:#0a1a2a;border:1px solid #1a2a3a;color:#5a8aaa}
.nvs{font-size:.62rem;padding:1px 5px;font-weight:700}
.nvs.hi{background:#1a2a1a;color:#5a9a5a}.nvs.md{background:#2a2010;color:#d4a000}.nvs.lo{background:#2a1a1a;color:#9a5a5a}
.art-title{font-size:.82rem;font-weight:600;margin-bottom:.3rem;line-height:1.35}
.art-note{font-size:.67rem;color:#666;font-style:italic;margin-bottom:.3rem}
.art-ts{display:flex;gap:1.2rem;flex-wrap:wrap}
.ts{font-size:.6rem;color:#555}
.ts strong{color:#888;font-weight:400}
.src-table,.runs-table{width:100%;border-collapse:collapse}
.src-table th,.runs-table th{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:#555;text-align:left;padding:.55rem 1.1rem;border-bottom:1px solid #1e1e1e;font-weight:400}
.src-table td,.runs-table td{padding:.6rem 1.1rem;border-bottom:1px solid #1a1a1a;font-size:.78rem}
.src-table tr:last-child td,.runs-table tr:last-child td{border-bottom:none}
.src-table tr,.runs-table tr{cursor:pointer}
.src-table tr:hover td,.runs-table tr:hover td{background:#141414}
.mini-bar-w{width:60px;height:3px;background:#1a1a1a;display:inline-block;vertical-align:middle;margin-right:.4rem}
.mini-bar{height:100%;background:#3a6a3a}
.cat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#222}
.cat-cell{background:#111;padding:.85rem 1.1rem;cursor:pointer}
.cat-cell:hover{background:#141414}
.cat-name{font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;color:#555;margin-bottom:.3rem}
.cat-num{font-size:1.5rem;font-weight:900;color:#5a9a5a;line-height:1}
.cat-sub{font-size:.6rem;color:#555;margin-top:.2rem}
.dist-row{display:flex;align-items:center;gap:.6rem;padding:.45rem 1.1rem;border-bottom:1px solid #1a1a1a}
.dist-row:last-child{border-bottom:none}
.dist-lbl{width:55px;font-size:.62rem;color:#666;flex-shrink:0}
.dist-bw{flex:1;height:4px;background:#1a1a1a}
.dist-b{height:100%}
.dist-n{width:28px;text-align:right;font-size:.72rem;font-weight:600;flex-shrink:0}
.ok{color:#5a9a5a;font-weight:700}.fail{color:#9a5a5a;font-weight:700}.partial{color:#d4a000;font-weight:700}
.load-more{text-align:center;padding:.6rem;border-top:1px solid #1e1e1e}
.load-more button{background:transparent;border:1px solid #2a2a2a;color:#666;padding:.35rem .85rem;cursor:pointer;font-size:.65rem;font-family:inherit}
.load-more button:hover{border-color:#555;color:#aaa}
.loading-state{text-align:center;padding:4rem 2rem;color:#555}
.spinner{width:18px;height:18px;border:2px solid #222;border-top-color:#5a9a5a;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto .75rem}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:900px){.grid4{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}.cat-grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
${nav}
<div class="toolbar">
  <input type="text" id="search-input" placeholder="Search articles..." oninput="filterArticles(this.value)"/>
  <div class="toolbar-right">
    <span id="search-hint">Type to filter</span>
    <span id="last-updated">—</span>
    <button class="refresh-btn" id="refresh-btn" onclick="loadReport()">&#8635; Refresh</button>
  </div>
</div>
<div class="range-bar">
  <button class="range-btn" data-range="1h" onclick="setRange(this.dataset.range)">1h</button>
  <button class="range-btn" data-range="6h" onclick="setRange(this.dataset.range)">6h</button>
  <button class="range-btn active" data-range="24h" onclick="setRange(this.dataset.range)">24h</button>
  <button class="range-btn" data-range="7d" onclick="setRange(this.dataset.range)">7d</button>
  <button class="range-btn" data-range="all" onclick="setRange(this.dataset.range)">All time</button>
  <span class="range-sep">|</span>
  <input type="datetime-local" class="range-input" id="range-from"/>
  <input type="datetime-local" class="range-input" id="range-to"/>
  <button class="range-apply" onclick="applyCustomRange()">Apply</button>
  <span class="range-label" id="range-label">Last 24h</span>
</div>
<main>
  <div id="sankey-wrap" style="display:none"><div class="sankey-title">Pipeline Flow</div><div id="sankey-chart" style="height:200px"></div></div>
  <div id="content" class="loading-state"><div class="spinner"></div><div>Loading report...</div></div>
</main>
</body>
</html>`;

  // Script block is concatenated separately so client-side template literals don't conflict
  const script = '<script>\n' + reportDashboardJs() + '\n<\/script>';
  return shell.replace('</body>', script + '\n</body>');
}

function reportDashboardJs() {
  const lines = [
    'var REPORT_URL="/admin/report-data";',
    'var reportData=null,searchTerm="",currentFrom=null,currentTo=null;',
    '',
    'function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}',
    'function slug(s){return String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"-");}',
    'function pct(a,b){if(!b)return 0;return Math.round(((a||0)/b)*100);}',
    'function fmtTime(ts){if(!ts)return"—";try{return new Date(ts).toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit"});}catch(e){return"—";}}',
    'function fmtDate(ts){if(!ts)return"—";try{var d=new Date(ts);return d.toLocaleDateString("tr-TR",{day:"2-digit",month:"2-digit"})+" "+d.toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});}catch(e){return"—";}}',
    'function nvsBadge(n){if(n==null&&n!==0)return"";var c=n>=70?"hi":n>=45?"md":"lo";return\'<span class="nvs \'+c+\'">NVS \'+n+"</span>";}',
    'function nvsBadgeInline(n){if(n==null)return"—";var c=n>=70?"hi":n>=45?"md":"lo";return\'<span class="nvs \'+c+\'">\'+Math.round(n)+"</span>";}',
    'function golden(gs){if(!gs||gs==="N/A")return"";var n=parseInt(gs)||0;return n>0?"⚡".repeat(Math.min(n,5)):""}',
    '',
    'function funnelRow(label,val,max,delta,id,articles,barClass){',
    '  var p=Math.round(((val||0)/max)*100);',
    '  var has=articles&&articles.length>0;',
    '  var bc=barClass||"";',
    '  var h=\'<div class="funnel-row" data-fid="funnel-\'+id+\'" onclick="toggleFA(this.dataset.fid)">\';',
    '  h+=\'<div class="f-lbl">\'+label+"</div>";',
    '  h+=\'<div class="f-bar-w"><div class="f-bar \'+bc+\'" style="width:\'+p+\'%"></div></div>\';',
    '  h+=\'<div class="f-num">\'+( val||0)+"</div>";',
    '  h+=\'<div class="f-delta">\'+delta+"</div>";',
    '  h+=\'<div class="f-expand">\'+( has?"&#9660; show":"")+"</div></div>";',
    '  if(has){',
    '    h+=\'<div id="funnel-\'+id+\'" style="display:none;border-bottom:1px solid #1a1a1a">\';',
    '    h+=\'<div class="art-list">\'+articleCards(articles,20)+"</div></div>";',
    '  }',
    '  return h;',
    '}',
    '',
    'function articleCards(items,limit){',
    '  if(!items||!items.length)return\'<div style="padding:.75rem;color:#555;font-size:.72rem">No articles</div>\';',
    '  var vis=items.slice(0,limit),rem=items.length-limit,h="";',
    '  vis.forEach(function(a,i){',
    '    var dsearch=esc((a.title||"")+" "+(a.source_name||"")+" "+(a.category||"")+" "+(a.nvs_notes||"")).toLowerCase();',
    '    h+=\'<div class="art-card" style="animation-delay:\'+( i*0.025)+\'s" data-search="\'+dsearch+\'">\';',
    '    h+=\'<div class="art-meta">\';',
    '    h+=\'<span class="tag src">\'+esc(a.source_name||"Unknown")+"</span>";',
    '    if(a.category)h+=\'<span class="tag cat">\'+esc(a.category)+"</span>";',
    '    h+=nvsBadge(a.nvs_score);',
    '    h+=\'<span style="font-size:.72rem">\'+golden(a.golden_score)+"</span>";',
    '    h+="</div>";',
    '    h+=\'<div class="art-title">\'+esc(a.title||"Untitled")+"</div>";',
    '    if(a.nvs_notes)h+=\'<div class="art-note">&quot;\'+esc(a.nvs_notes)+\'&quot;</div>\';',
    '    h+=\'<div class="art-ts">\';',
    '    if(a.fetched_at)h+=\'<div class="ts">Fetched <strong>\'+fmtDate(a.fetched_at)+"</strong></div>";',
    '    if(a.reviewed_at)h+=\'<div class="ts">Published <strong>\'+fmtDate(a.reviewed_at)+"</strong></div>";',
    '    if(a.original_url&&a.original_url!="#")h+=\'<a href="\'+esc(a.original_url)+\'" target="_blank" rel="noopener" style="font-size:.6rem;color:#5a9a5a;text-decoration:none">&nearr; Source</a>\';',
    '    h+="</div></div>";',
    '  });',
    '  if(rem>0){',
    '    var moreData=JSON.stringify(items.slice(limit));',
    '    h+=\'<div class="load-more"><button data-items="\'+esc(moreData)+\'" onclick="loadMore(this)">Load \'+rem+" more</button></div>";',
    '  }',
    '  return h;',
    '}',
    '',
    'function loadMore(btn){',
    '  var items=JSON.parse(btn.dataset.items||"[]");',
    '  var wrap=btn.parentElement.parentElement;',
    '  var div=document.createElement("div");',
    '  div.innerHTML=articleCards(items,items.length);',
    '  btn.parentElement.remove();',
    '  wrap.appendChild(div);',
    '}',
    '',
    'function distRow(label,val,total,color){',
    '  var w=total>0?Math.round(((val||0)/total)*100):0;',
    '  return \'<div class="dist-row"><div class="dist-lbl">\'+label+\'</div><div class="dist-bw"><div class="dist-b" style="width:\'+w+\'%;background:\'+color+\'"></div></div><div class="dist-n">\'+( val||0)+"</div></div>";',
    '}',
    '',
    'function toggleSrc(id){var el=document.getElementById(id);if(el)el.style.display=el.style.display==="none"?"table-row":"none";}',
    'function toggleCat(id){var el=document.getElementById(id);if(el)el.style.display=el.style.display==="none"?"block":"none";}',
    'function toggleFA(id){var el=document.getElementById(id);if(el)el.style.display=el.style.display==="none"?"block":"none";}',
    'function toggleSec(id){document.getElementById(id).classList.toggle("open");}',
    '',
    'function filterArticles(term){',
    '  searchTerm=term.toLowerCase().trim();',
    '  var cards=document.querySelectorAll(".art-card");',
    '  var vis=0;',
    '  cards.forEach(function(c){var match=!searchTerm||c.getAttribute("data-search").includes(searchTerm);c.classList.toggle("hidden",!match);if(match)vis++;});',
    '  document.getElementById("search-hint").textContent=searchTerm?vis+" match":"Type to filter";',
    '}',
    '',
    'function setRange(r){',
    '  var now=new Date(),from=new Date(now);',
    '  if(r==="1h")from.setHours(now.getHours()-1);',
    '  else if(r==="6h")from.setHours(now.getHours()-6);',
    '  else if(r==="24h")from.setDate(now.getDate()-1);',
    '  else if(r==="7d")from.setDate(now.getDate()-7);',
    '  if(r==="all"){currentFrom=null;currentTo=null;}',
    '  else{currentFrom=from.toISOString();currentTo=null;}',
    '  document.querySelectorAll(".range-btn").forEach(function(b){b.classList.toggle("active",b.dataset.range===r);});',
    '  document.getElementById("range-label").textContent=r==="all"?"All time":"Last "+r;',
    '  document.getElementById("range-from").value="";',
    '  document.getElementById("range-to").value="";',
    '  loadReport();',
    '}',
    '',
    'function applyCustomRange(){',
    '  var f=document.getElementById("range-from").value;',
    '  var t=document.getElementById("range-to").value;',
    '  if(!f&&!t){setRange("all");return;}',
    '  currentFrom=f?new Date(f).toISOString():null;',
    '  currentTo=t?new Date(t).toISOString():null;',
    '  document.querySelectorAll(".range-btn").forEach(function(b){b.classList.remove("active");});',
    '  document.getElementById("range-label").textContent="Custom";',
    '  loadReport();',
    '}',
    '',
    'google.charts.load("current",{packages:["sankey"]});',
    '',
    'function drawSankey(f){',
    '  var wrap=document.getElementById("sankey-wrap");',
    '  if(!f||!f.total_fetched){wrap.style.display="none";return;}',
    '  wrap.style.display="block";',
    '  google.charts.setOnLoadCallback(function(){',
    '    var data=new google.visualization.DataTable();',
    '    data.addColumn("string","From");',
    '    data.addColumn("string","To");',
    '    data.addColumn("number","Weight");',
    '    var total=f.total_fetched||0;',
    '    var aDate=f.after_date_filter||0;',
    '    var aKw=f.after_keyword_filter||0;',
    '    var aHash=f.after_hash_dedup||0;',
    '    var aTitle=f.after_title_dedup||0;',
    '    var pub=f.auto_published||0;',
    '    var q=f.queued_for_review||0;',
    '    var rej=f.rejected||0;',
    '    var rDate=total-aDate,rKw=aDate-aKw,rHash=aKw-aHash,rTitle=aHash-aTitle;',
    '    var scored=pub+q+rej,lost=Math.max(0,aTitle-scored);',
    '    var nF="Fetched ("+total+")",nD="After Date ("+aDate+")",nK="After KW ("+aKw+")",nH="After Dedup ("+aHash+")",nS="Qualified ("+aTitle+")";',
    '    var rows=[];',
    '    if(aDate>0)rows.push([nF,nD,aDate]);',
    '    if(rDate>0)rows.push([nF,"Too Old",rDate]);',
    '    if(aKw>0)rows.push([nD,nK,aKw]);',
    '    if(rKw>0)rows.push([nD,"Off-Topic",rKw]);',
    '    if(aHash>0)rows.push([nK,nH,aHash]);',
    '    if(rHash>0)rows.push([nK,"Seen Before",rHash]);',
    '    if(aTitle>0)rows.push([nH,nS,aTitle]);',
    '    if(rTitle>0)rows.push([nH,"Near-Dupe",rTitle]);',
    '    if(pub>0)rows.push([nS,"Published",pub]);',
    '    if(q>0)rows.push([nS,"Queued",q]);',
    '    if(rej>0)rows.push([nS,"Rejected",rej]);',
    '    if(lost>0)rows.push([nS,"Unscored",lost]);',
    '    if(!rows.length){wrap.style.display="none";return;}',
    '    data.addRows(rows);',
    '    var opts={width:"100%",height:200,sankey:{node:{label:{color:"#bbb",fontSize:10},nodePadding:15},link:{colorMode:"gradient"}},backgroundColor:{fill:"#111"}};',
    '    var chart=new google.visualization.Sankey(document.getElementById("sankey-chart"));',
    '    chart.draw(data,opts);',
    '  });',
    '}',
    '',
    'async function loadReport(){',
    '  var btn=document.getElementById("refresh-btn");',
    '  btn.disabled=true;btn.textContent="↻ Loading...";',
    '  try{',
    '    var url=REPORT_URL;',
    '    var params=[];',
    '    if(currentFrom)params.push("from="+encodeURIComponent(currentFrom));',
    '    if(currentTo)params.push("to="+encodeURIComponent(currentTo));',
    '    if(params.length)url+="?"+params.join("&");',
    '    var res=await fetch(url);',
    '    if(!res.ok)throw new Error("HTTP "+res.status);',
    '    reportData=await res.json();',
    '    renderReport(reportData);',
    '    drawSankey(reportData.funnel);',
    '    document.getElementById("last-updated").textContent="Updated "+new Date().toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});',
    '  }catch(e){',
    '    document.getElementById("content").innerHTML=\'<div class="loading-state" style="color:#9a5a5a">⚠ Could not load report: \'+e.message+"</div>";',
    '  }finally{btn.disabled=false;btn.textContent="↻ Refresh";}',
    '}',
    '',
    'function renderReport(d){',
    '  var f=d.funnel||{};',
    '  var sources=d.by_source||[];',
    '  var cats=d.by_category||[];',
    '  var types=d.by_content_type||[];',
    '  var dist=d.scoring_distribution||{};',
    '  var runs=d.last_runs||[];',
    '  var pub=d.top_published||[];',
    '  var rej=d.top_rejected||[];',
    '  var all=d.all_fetched||[];',
    '  var needsReview=d.needs_review_items||[];',
    '  var pubCount=d.published_count!=null?d.published_count:pub.length;',
    '  var maxF=f.total_fetched||1;',
    '  var stDist=d.source_type_dist||[];',
    '  var ttDist=d.trust_tier_dist||[];',
    '  var stories=d.story_stats||{total:0,by_state:[],by_type:[]};',
    '  var srcTypeMap=d.source_type_map||{};',
    '  var runs_in_range=d.runs_in_range||0;',
    '  var h="";',
    '',
    '  h+=\'<div class="grid4">\';',
    '  h+=\'<div class="cell"><div class="stat-lbl">Total Fetched</div><div class="stat-val b">\'+( f.total_fetched||0)+\'</div><div class="stat-sub">\'+runs_in_range+" runs in range</div></div>";',
    '  h+=\'<div class="cell"><div class="stat-lbl">After Filtering</div><div class="stat-val">\'+( f.after_title_dedup||0)+\'</div><div class="stat-sub">\'+pct(f.after_title_dedup,f.total_fetched)+"% passed</div></div>";',
    '  h+=\'<div class="cell"><div class="stat-lbl">Published (range)</div><div class="stat-val g">\'+pubCount+\'</div><div class="stat-sub">\'+pct(f.auto_published,f.after_title_dedup)+"% of filtered</div></div>";',
    '  h+=\'<div class="cell"><div class="stat-lbl">Total Cost</div><div class="stat-val a">€\'+parseFloat(f.total_cost||0).toFixed(4)+\'</div><div class="stat-sub">\'+runs_in_range+" runs · "+( f.total_calls||0)+" calls</div></div>";',
    '  h+="</div>";',
    '',
    '  h+=\'<div class="grid2">\';',
    '',
    '  h+=\'<div class="section open" id="sec-stypes" style="margin:0">\';',
    '  h+=\'<div class="sec-head" data-sec="sec-stypes" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">📡 Sources<span class="badge">\'+stDist.length+" channels · "+ttDist.length+" tiers</span></div>";',
    '  h+=\'<div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body">\';',
    '  var stTotal=stDist.reduce(function(s,x){return s+x.count;},0);',
    '  if(stDist.length){',
    '    h+=\'<div style="padding:.45rem 1.1rem .2rem;font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:#444">Channel</div>\';',
    '    stDist.forEach(function(x){h+=distRow(x.type,x.count,stTotal,"#4488ff");});',
    '  }',
    '  if(ttDist.length){',
    '    h+=\'<div style="padding:.45rem 1.1rem .2rem;font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:#444">Trust Tier</div>\';',
    '    ttDist.forEach(function(x){h+=distRow(x.tier,x.count,stTotal,"#aa6688");});',
    '  }',
    '  h+="</div></div>";',
    '',
    '  h+=\'<div class="section open" id="sec-stories" style="margin:0">\';',
    '  h+=\'<div class="sec-head" data-sec="sec-stories" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">📖 Story Intelligence<span class="badge">\'+stories.total+" stories</span></div>";',
    '  h+=\'<div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body">\';',
    '  stories.by_state.forEach(function(x){h+=distRow(x.state,x.count,stories.total,"#5a9a5a");});',
    '  h+="</div></div>";',
    '',
    '  h+="</div>";',
    '',
    '  h+=\'<div class="section open" id="sec-funnel">\';',
    '  h+=\'<div class="sec-head" data-sec="sec-funnel" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">📥 News Funnel<span class="badge">\'+( f.total_fetched||0)+" in &rarr; "+(f.auto_published||0)+" out</span></div>";',
    '  h+=\'<div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body">\';',
    '  h+=funnelRow("Fetched",f.total_fetched,maxF,"","all_fetched",all);',
    '  h+=funnelRow("After date filter (72h)",f.after_date_filter,maxF,"-"+((f.total_fetched||0)-(f.after_date_filter||0))+" too old","after_date",d.removed_old);',
    '  h+=funnelRow("After keyword filter",f.after_keyword_filter,maxF,"-"+((f.after_date_filter||0)-(f.after_keyword_filter||0))+" not BJK","after_keyword",d.removed_keyword);',
    '  h+=funnelRow("After hash dedup",f.after_hash_dedup,maxF,"-"+((f.after_keyword_filter||0)-(f.after_hash_dedup||0))+" seen before","after_hash",d.removed_hash);',
    '  h+=funnelRow("After title dedup",f.after_title_dedup,maxF,"-"+((f.after_hash_dedup||0)-(f.after_title_dedup||0))+" near-dupes","after_title",d.removed_dupes);',
    '  h+=funnelRow("Published ✅",f.auto_published,maxF,"NVS ≥ threshold","published",pub,"g");',
    '  h+=funnelRow("Queued ⏳",f.queued_for_review,maxF,"NVS mid-range","queued",d.queued_items,"queued");',
    '  h+=funnelRow("Rejected ❌",f.rejected,maxF,"NVS too low","rejected",rej,"rejected");',
    '  h+="</div></div>";',
    '',
    '  h+=\'<div class="section" id="sec-sources">\';',
    '  h+=\'<div class="sec-head" data-sec="sec-sources" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">📡 By Source<span class="badge">\'+sources.length+" sources</span></div>";',
    '  h+=\'<div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body"><table class="src-table"><thead><tr><th>Source</th><th>Type</th><th>Tier</th><th>In</th><th>Pub</th><th>Rej</th><th>Rate</th><th>Avg NVS</th><th>Last</th></tr></thead><tbody>\';',
    '  sources.forEach(function(s){',
    '    var sid="src-"+slug(s.source_name);',
    '    var cfg=srcTypeMap[s.source_name]||{};',
    '    h+=\'<tr data-sid="\'+sid+\'" onclick="toggleSrc(this.dataset.sid)">\';',
    '    h+=\'<td><strong>\'+esc(s.source_name)+"</strong></td>";',
    '    h+=\'<td style="color:#4488ff;font-size:.68rem">\'+esc(cfg.type||"—")+"</td>";',
    '    h+=\'<td style="color:#aa6688;font-size:.68rem">\'+esc(cfg.tier||"—")+"</td>";',
    '    h+="<td>"+(s.contributed||0)+"</td>";',
    '    h+=\'<td style="color:#5a9a5a">\'+( s.published||0)+"</td>";',
    '    h+=\'<td style="color:#9a5a5a">\'+( s.rejected||0)+"</td>";',
    '    h+=\'<td><div class="mini-bar-w"><div class="mini-bar" style="width:\'+pct(s.published,s.contributed)+\'%"></div></div>\'+pct(s.published,s.contributed)+"%</td>";',
    '    h+="<td>"+nvsBadgeInline(s.avg_nvs)+"</td>";',
    '    h+=\'<td style="color:#555">\'+fmtTime(s.last_article_at)+"</td></tr>";',
    '    h+=\'<tr id="\'+sid+\'" style="display:none"><td colspan="9" style="padding:0"><div class="art-list">\'+articleCards(all.filter(function(a){return a.source_name===s.source_name;}),10)+"</div></td></tr>";',
    '  });',
    '  h+="</tbody></table></div></div>";',
    '',
    '  h+=\'<div class="section" id="sec-cats">\';',
    '  h+=\'<div class="sec-head" data-sec="sec-cats" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">⚽ By Category<span class="badge">\'+cats.length+" categories</span></div>";',
    '  h+=\'<div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body"><div class="cat-grid">\';',
    '  cats.forEach(function(c){',
    '    h+=\'<div class="cat-cell" data-cid="cat-\'+slug(c.category)+\'" onclick="toggleCat(this.dataset.cid)">\';',
    '    h+=\'<div class="cat-name">\'+esc(c.category)+"</div>";',
    '    h+=\'<div class="cat-num">\'+( c.count_published||0)+"</div>";',
    '    h+=\'<div class="cat-sub">published · \'+( c.count_rejected||0)+" rej · avg "+Math.round(c.avg_nvs||0)+"</div>";',
    '    h+="</div>";',
    '  });',
    '  h+="</div>";',
    '  cats.forEach(function(c){',
    '    h+=\'<div id="cat-\'+slug(c.category)+\'" style="display:none;border-top:1px solid #1a1a1a">\';',
    '    h+=\'<div class="art-list">\'+articleCards(all.filter(function(a){return a.category===c.category;}),10)+"</div></div>";',
    '  });',
    '  h+="</div></div>";',
    '',
    '  h+=\'<div class="grid2">\';',
    '  h+=\'<div class="section" id="sec-types" style="margin:0"><div class="sec-head" data-sec="sec-types" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">🔬 By Content Type</div><div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body"><table class="src-table"><thead><tr><th>Type</th><th>Count</th><th>Avg NVS</th><th>Pub Rate</th></tr></thead><tbody>\';',
    '  types.forEach(function(t){h+=\'<tr><td><span class="tag src">\'+esc(t.content_type||"unknown")+"</span></td><td>"+(t.count||0)+"</td><td>"+nvsBadgeInline(t.avg_nvs)+"</td><td>"+pct(t.count_published,t.count)+"%</td></tr>";});',
    '  h+="</tbody></table></div></div>";',
    '  h+=\'<div class="section" id="sec-dist" style="margin:0"><div class="sec-head" data-sec="sec-dist" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">🎯 Score Distribution</div><div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body">\';',
    '  var dTot=(dist.nvs_90_100||0)+(dist.nvs_70_89||0)+(dist.nvs_50_69||0)+(dist.nvs_30_49||0)+(dist.nvs_0_29||0);',
    '  h+=distRow("90–99",dist.nvs_90_100,dTot,"#5a9a5a");',
    '  h+=distRow("70–89",dist.nvs_70_89,dTot,"#88cc44");',
    '  h+=distRow("50–69",dist.nvs_50_69,dTot,"#d4a000");',
    '  h+=distRow("30–49",dist.nvs_30_49,dTot,"#cc7722");',
    '  h+=distRow("0–29",dist.nvs_0_29,dTot,"#9a5a5a");',
    '  h+="</div></div></div>";',
    '',
    '  h+=\'<div class="section" id="sec-runs">\';',
    '  h+=\'<div class="sec-head" data-sec="sec-runs" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">🕐 Fetch Runs<span class="badge">\'+runs.length+" runs</span></div>";',
    '  h+=\'<div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body"><table class="runs-table"><thead><tr><th>Time</th><th>Status</th><th>Fetched</th><th>Published</th><th>Queued</th><th>Rejected</th><th>Calls</th><th>Cost</th><th>Duration</th></tr></thead><tbody>\';',
    '  runs.forEach(function(r){',
    '    var sc=r.status==="success"?"ok":r.status==="failed"?"fail":"partial";',
    '    h+="<tr>";',
    '    h+=\'<td style="color:#555">\'+fmtDate(r.created_at)+"</td>";',
    '    h+=\'<td class="\'+sc+\'">\'+r.status+"</td>";',
    '    h+="<td>"+(r.items_fetched||0)+"</td>";',
    '    h+=\'<td style="color:#5a9a5a">\'+( r.items_published||0)+"</td>";',
    '    h+=\'<td style="color:#d4a000">\'+( r.items_queued||0)+"</td>";',
    '    h+=\'<td style="color:#9a5a5a">\'+( r.items_rejected||0)+"</td>";',
    '    h+="<td>"+(r.claude_calls||0)+"</td>";',
    '    h+="<td>€"+(r.estimated_cost_eur||0).toFixed(4)+"</td>";',
    '    h+="<td>"+(r.duration_ms?Math.round(r.duration_ms/1000)+"s":"—")+"</td></tr>";',
    '  });',
    '  h+="</tbody></table></div></div>";',
    '',
    '  if(needsReview.length){',
    '    h+=\'<div class="section open" id="sec-review">\';',
    '    h+=\'<div class="sec-head" data-sec="sec-review" onclick="toggleSec(this.dataset.sec)">\';',
    '    h+=\'<div class="sec-title">⚠️ Needs Review<span class="badge" style="background:#b45309;color:#fff">\'+needsReview.length+"</span></div>";',
    '    h+=\'<div class="chev">▼</div></div>\';',
    '    h+=\'<div class="sec-body"><div class="art-list">\'+articleCards(needsReview,20)+"</div></div></div>";',
    '  }',
    '  h+=\'<div class="section open" id="sec-pub">\';',
    '  h+=\'<div class="sec-head" data-sec="sec-pub" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">✅ Published (range)<span class="badge g">\'+pub.length+"</span></div>";',
    '  h+=\'<div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body"><div class="art-list">\'+articleCards(pub,20)+"</div></div></div>";',
    '',
    '  h+=\'<div class="section" id="sec-rej">\';',
    '  h+=\'<div class="sec-head" data-sec="sec-rej" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">❌ Rejected (range)<span class="badge r">\'+rej.length+"</span></div>";',
    '  h+=\'<div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body"><div class="art-list">\'+articleCards(rej,10)+"</div></div></div>";',
    '',
    '  document.getElementById("content").innerHTML=h;',
    '}',
    '',
    'setInterval(loadReport, 5*60*1000);',
    'setRange("24h");',
  ];
  return lines.join('\n');
}

function renderAdminRoadmapPage() {
  const nav = adminNav('roadmap');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Roadmap</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}
.content{max-width:900px;margin:0 auto;padding:2rem 1.5rem}
.loading{text-align:center;padding:4rem 2rem;color:#555}
.spinner{width:20px;height:20px;border:2px solid #222;border-top-color:#c8f135;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 1rem}
@keyframes spin{to{transform:rotate(360deg)}}
.md-body{font-family:'JetBrains Mono',monospace,sans-serif;font-size:14px;line-height:1.75;color:#ccc}
.md-body h1{font-size:24px;font-weight:800;margin:36px 0 14px;padding-bottom:10px;border-bottom:2px solid #c8f135;color:#fff}
.md-body h2{font-size:18px;font-weight:700;margin:32px 0 10px;color:#fff}
.md-body h3{font-size:15px;font-weight:700;margin:24px 0 8px;color:#e8e6e0}
.md-body h4{font-size:12px;font-weight:600;margin:18px 0 6px;color:#666;text-transform:uppercase;letter-spacing:.5px}
.md-body p{margin-bottom:12px}
.md-body ul,.md-body ol{padding-left:24px;margin-bottom:12px}
.md-body li{margin-bottom:4px}
.md-body strong{color:#fff;font-weight:600}
.md-body em{color:#666}
.md-body code{background:#1e1e1e;border:1px solid #2a2a2a;padding:2px 6px;font-size:12px;color:#c8f135}
.md-body pre{background:#161616;border:1px solid #222;padding:16px;overflow-x:auto;margin-bottom:14px}
.md-body pre code{background:none;border:none;padding:0;color:#a8d8a8}
.md-body hr{border:none;border-top:1px solid #222;margin:28px 0}
.md-body blockquote{border-left:3px solid #c8f135;padding:8px 14px;background:#161616;margin-bottom:12px;color:#888}
.md-body table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:13px}
.md-body th{background:#161616;padding:8px 12px;text-align:left;font-weight:600;color:#fff;border-bottom:1px solid #222}
.md-body td{padding:7px 12px;border-bottom:1px solid #1a1a1a}
.md-body tr:hover td{background:#111}
.sprint-done{color:#c8f135 !important}
.sprint-next{color:#ffaa00 !important}
</style>
</head>
<body>
${nav}
<div class="content">
  <div id="roadmap-content" class="loading">
    <div class="spinner"></div>
    <div>Loading roadmap...</div>
  </div>
</div>
<script>
async function load() {
  const el = document.getElementById('roadmap-content');
  try {
    const r = await fetch('https://raw.githubusercontent.com/gencerali/pitchos/main/ROADMAP.md?t=' + Date.now());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const md = await r.text();
    el.innerHTML = marked.parse(md);
    el.className = 'md-body';
    el.querySelectorAll('h3').forEach(h => {
      if (h.textContent.includes('\\u2705')) h.classList.add('sprint-done');
      if (h.textContent.includes('\\uD83D\\uDCCB')) h.classList.add('sprint-next');
    });
  } catch(e) {
    el.innerHTML = '<p style="color:#ff4444;padding:2rem">Could not load roadmap: ' + e.message + '<br><small style="color:#555">Check GitHub repo visibility or ROADMAP.md exists at repo root.</small></p>';
  }
}
load();
<\/script>
</body>
</html>`;
}

function renderAdminReleasesPage() {
  const nav = adminNav('releases');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Releases</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.6}
.content{max-width:860px;margin:0 auto;padding:2rem 1.5rem}
h1{font-size:22px;font-weight:800;margin-bottom:6px;color:#fff}
.subtitle{color:#555;font-size:12px;letter-spacing:.06em;margin-bottom:2rem}
.card{background:#111;border:1px solid #222;padding:22px;margin-bottom:14px}
.card h3{font-size:15px;font-weight:700;margin-bottom:4px;color:#fff}
.date{color:#555;font-size:12px;margin-bottom:14px;letter-spacing:.04em}
.card ul{padding-left:18px}
.card li{color:#ccc;font-size:13px;margin-bottom:5px;line-height:1.5}
.rtag{display:inline-block;font-size:.6rem;font-weight:700;padding:1px 6px;margin-right:5px;vertical-align:middle;letter-spacing:.08em}
.feat{background:#1d4ed818;color:#4488ff;border:1px solid #1d4ed850}
.fix{background:#c8f13518;color:#c8f135;border:1px solid #c8f13550}
.perf{background:#ffaa0018;color:#ffaa00;border:1px solid #ffaa0050}
</style>
</head>
<body>
${nav}
<div class="content">
  <h1>Release Notes</h1>
  <p class="subtitle">Sprint changelog — updated per deployment.</p>

  <div class="card">
    <h3>Sprints F — Source Intelligence Layer</h3>
    <div class="date">May 5, 2026</div>
    <ul>
      <li><span class="rtag feat">feat</span> F1: Source independence gate — press-only cite chains blocked from "confirmed"</li>
      <li><span class="rtag feat">feat</span> F2: YouTube into unified pipeline — story matching + NVS hint scoring</li>
      <li><span class="rtag feat">feat</span> F3: source_configs Supabase table — sources editable without deploy</li>
      <li><span class="rtag feat">feat</span> Sources admin UI — add, test, delete, activate/deactivate sources</li>
      <li><span class="rtag feat">feat</span> Daily source auto-test cron + status dots in UI</li>
      <li><span class="rtag feat">feat</span> Financials page — monthly cost/revenue chart + manual cost entries</li>
      <li><span class="rtag feat">feat</span> Admin nav unified across all pages + Report/Roadmap/Releases tabs</li>
    </ul>
  </div>

  <div class="card">
    <h3>Sprint E — Source Expansion</h3>
    <div class="date">May 4, 2026</div>
    <ul>
      <li><span class="rtag feat">feat</span> Scorer updated: national team + multi-sport BJK scoring bands</li>
      <li><span class="rtag feat">feat</span> Synthesis prompt: national team / other-sport context injection</li>
      <li><span class="rtag feat">feat</span> RSS cron moved to hourly (was 2-hourly)</li>
    </ul>
  </div>

  <div class="card">
    <h3>Sprint D — Original News Synthesis</h3>
    <div class="date">May 2, 2026</div>
    <ul>
      <li><span class="rtag feat">feat</span> generateOriginalNews: multi-source, 300–400 word Kartalix voice synthesis</li>
      <li><span class="rtag feat">feat</span> Synthesis dedup: synth:{hash}:{date} KV key prevents re-synthesis same day</li>
      <li><span class="rtag feat">feat</span> Raw RSS/P4 articles removed from KV frontend — only templates + synthesis</li>
      <li><span class="rtag fix">fix</span> Multi-source context via titleSimilarity(>0.25) for richer Claude input</li>
    </ul>
  </div>

  <div class="card">
    <h3>Sprint C — YouTube Embed</h3>
    <div class="date">May 2, 2026</div>
    <ul>
      <li><span class="rtag feat">feat</span> 5 YouTube channels live (Beşiktaş JK, beIN Sports TR, A Spor, Rabona, TRT)</li>
      <li><span class="rtag feat">feat</span> Match-specific video templates: T-VID-HLT, T-VID-GOL, T-VID-BP, T-VID-INT, T-VID-REF</li>
      <li><span class="rtag feat">feat</span> classifyMatchVideo: routes to match templates; falls back to generic T-VID</li>
    </ul>
  </div>

  <div class="card">
    <h3>Sprint 3 — Pipeline Reliability + Content Quality</h3>
    <div class="date">April 17, 2026 &nbsp;·&nbsp; 12 commits</div>
    <ul>
      <li><span class="rtag fix">fix</span> KV ceiling raised 8 → 50 articles — no more silent article drops</li>
      <li><span class="rtag perf">perf</span> Permanent URL dedup against Supabase — eliminated re-scoring cost (~€17/mo saved)</li>
      <li><span class="rtag fix">fix</span> pubDate: original RSS published_at stored in KV + Supabase</li>
      <li><span class="rtag feat">feat</span> Scoring: 7-band NVS, age penalty (−15 @ 24h, −30 @ 48h), story-aware dedup</li>
      <li><span class="rtag feat">feat</span> Post-scoring story dedup — one article per story cluster (highest NVS wins)</li>
      <li><span class="rtag feat">feat</span> Match templates T05/T08b/T09 rewritten as Haiku-generated Turkish news prose</li>
    </ul>
  </div>

  <div class="card">
    <h3>Sprint 2 — Content Quality</h3>
    <div class="date">April 6, 2026 &nbsp;·&nbsp; 18 commits</div>
    <ul>
      <li><span class="rtag feat">feat</span> 12 RSS sources with BJK keyword filter</li>
      <li><span class="rtag feat">feat</span> Render.com proxy for blocked feeds (Fotomaç, A Spor)</li>
      <li><span class="rtag feat">feat</span> Golden Score + NVS scoring (Haiku, batch 10)</li>
      <li><span class="rtag feat">feat</span> Hero carousel + article grid + modal</li>
      <li><span class="rtag feat">feat</span> Transfer Radar + Fan Pulse from real article data</li>
    </ul>
  </div>

  <div class="card">
    <h3>Sprint 1 — Live Pipeline</h3>
    <div class="date">March 2026</div>
    <ul>
      <li><span class="rtag feat">feat</span> Cloudflare Worker fetch agent live</li>
      <li><span class="rtag feat">feat</span> Claude API connected (Haiku scoring)</li>
      <li><span class="rtag feat">feat</span> KV cache → fan site reads live news</li>
      <li><span class="rtag feat">feat</span> Cron trigger, Supabase logging, NVS scoring</li>
    </ul>
  </div>
</div>
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
${adminNav('news')}
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
