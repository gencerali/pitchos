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
import { preFilter, dedupeByTitle, scoreArticles, getSeenHashes, saveSeenHashes, getSeenUrls, dedupeByStory, getOffTopicHashes, saveOffTopicHashes, getSynthesisFailedHashes, saveSynthesisFailedHashes } from './src/processor.js';
import { writeArticles, saveArticles, cacheToKV, getCachedArticles, logFetch, mergeAndDedupe, rankAndEvict, drainRewriteQueue, generateMatchDayCard, generateMuhtemel11, generateConfirmedLineup, generateMatchPreview, generateH2HHistory, generateFormGuide, generateInjuryReport, generateGoalFlash, generateResultFlash, generateManOfTheMatch, generateMatchReport, generateXGDelta, generateRefereeProfile, generateHalftimeReport, generateRedCardFlash, generateVARFlash, generateMissedPenaltyFlash, generateVideoEmbed, generateRabonaDigest, buildGroundingContext, verifyArticle, synthesizeArticle, generateLineupCard, tierToTrustScore, classifyVideoType, SCORING_CONFIG_DEFAULTS, loadSiteConfig, HARD_TTL_BY_TEMPLATE, HARD_TTL_BY_MODE, getEffectiveNVS, getHalfLife, getTrustMultiplier, computeScore } from './src/publisher.js';
import { matchOrCreateStory, getOpenStories, archiveStaleStories, createMatchStory, getMatchStory, advanceMatchStoryStates, synthesizeStory } from './src/story-matcher.js';
import { extractFactsForStory, SKIP_STORY_TYPES } from './src/firewall.js';
import { apiFetch, getNextFixture, getLiveFixture, getFixture, getH2H, getFixturePlayers, getFixtureStats, getFixtureEvents, getLastFixtures, getInjuries, getFixtureLineup, getStandings, getBJKLastLineupData, getOpponentLastLineup } from './src/api-football.js';
import { YOUTUBE_CHANNELS, fetchYouTubeChannel, qualifyYouTubeVideo, fetchYouTubeTranscript } from './src/youtube.js';

// ─── CRON INTERVAL HELPER ────────────────────────────────────
function cronToIntervalMs(cron) {
  if (!cron) return 60 * 60 * 1000;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 60 * 60 * 1000;
  const [min, hour] = parts;
  if (/^\*\/(\d+)$/.test(min) && hour === '*') return parseInt(min.slice(2)) * 60 * 1000;
  if (min === '0' && /^\*\/(\d+)$/.test(hour)) return parseInt(hour.slice(2)) * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

// ─── PIPELINE FAILURE LOG ────────────────────────────────────
const FAILURES_KEY = 'pipeline:failures';
const FAILURES_TTL = 7 * 24 * 3600; // 7 days

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

const ALLOWED_ORIGINS = new Set(['https://kartalix.com', 'https://app.kartalix.com', 'https://www.kartalix.com']);
function corsOrigin(request) {
  const o = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.has(o) ? o : 'https://kartalix.com';
}

async function checkAdminAuth(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const tokenPart = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('kx-session='));
  if (!tokenPart) return false;
  const token = tokenPart.slice('kx-session='.length);
  if (!token) return false;
  const valid = await env.PITCHOS_CACHE.get(`admin:session:${token}`).catch(() => null);
  return valid !== null;
}

// Returns a 401 Response if the session token is invalid, null if authenticated.
async function requireOps(request, env) {
  if (await checkAdminAuth(request, env)) return null;
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// ─── H5 SYNTHESIS GATE ───────────────────────────────────────
// Module-level so it's accessible from both processSite and force-h5 endpoint.
async function checkH5SynthGate(storyId, env, sourceConfigMap = null) {
  const since6h = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  // Count total contributions from story_contributions table
  const contribs = await supabase(env, 'GET',
    `/rest/v1/story_contributions?story_id=eq.${storyId}&order=added_at.desc&limit=100&select=added_at`
  ) || [];
  if (contribs.length < 3) return { eligible: false, reason: `${contribs.length} contributions (need ≥3)` };
  const recentCount = contribs.filter(c => c.added_at && c.added_at >= since6h).length;
  if (recentCount < 2) return { eligible: false, reason: `${recentCount} contributions in last 6h (need ≥2)` };
  // Check NVS + source family diversity from linked content_items (if available)
  const items = await supabase(env, 'GET',
    `/rest/v1/content_items?story_id=eq.${storyId}&select=nvs_score,source_name&limit=20`
  ) || [];
  let maxNvs = 0;
  let uniqueFamilies = new Set();
  // Exclude our own synthesized articles — Kartalix output is not an independent source
  const externalItems = items.filter(i => i.source_name !== 'Kartalix');
  if (externalItems.length >= 2) {
    maxNvs = externalItems.reduce((m, i) => Math.max(m, i.nvs_score || 0), 0);
    if (maxNvs < 60) return { eligible: false, reason: `max NVS ${maxNvs} below 60` };
    // Map source_name → source_family if available; fall back to source_name (each unmapped source counts as its own family)
    const toFamily = name => (sourceConfigMap && name && sourceConfigMap[name]) || name;
    uniqueFamilies = new Set(externalItems.map(i => toFamily(i.source_name)).filter(Boolean));
    if (uniqueFamilies.size < 2) return { eligible: false, reason: `only ${uniqueFamilies.size} distinct source family — need ≥2 independent families` };
  }
  // No linked items yet — story state reached confirmed/active naturally (already quality-gated by state machine)
  const today = new Date().toISOString().slice(0, 10);
  const alreadySynth = await env.PITCHOS_CACHE.get(`synth:${storyId}:${today}`);
  if (alreadySynth) return { eligible: false, reason: 'already synthesized today' };
  return {
    eligible: true,
    reason: `${contribs.length} contribs (${recentCount} recent), max_nvs=${maxNvs}, families=${uniqueFamilies.size}`,
    stats: { contribs: contribs.length, recentCount, maxNvs, families: [...uniqueFamilies] },
  };
}

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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
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
          await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(fixed), { expirationTtl: 43200 });
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      // Pre-flight: check if there are active sites and cap status before spawning background work
      const [sites, capStatus] = await Promise.all([
        getActiveSites(env).catch(e => ({ error: e.message })),
        checkCostCap(env).catch(() => ({ blocked: false, current: 0, cap: 8 })),
      ]);
      const sitesArr = Array.isArray(sites) ? sites : [];
      const preflight = {
        sites_found: sitesArr.length,
        site_codes: sitesArr.map(s => s.short_code),
        cost_blocked: capStatus.blocked,
        cost_current: capStatus.current,
        cost_cap: capStatus.cap,
        sites_error: !Array.isArray(sites) ? sites?.error : undefined,
      };
      if (sitesArr.length === 0) {
        return Response.json({ status: 'blocked', reason: 'no_active_sites', preflight });
      }
      if (capStatus.blocked) {
        return Response.json({ status: 'blocked', reason: 'cost_cap', preflight });
      }
      await env.PITCHOS_CACHE.put('run:requested', new Date().toISOString(), { expirationTtl: 900 });
      return Response.json({ status: 'queued', preflight, message: 'Pipeline queued — fires within 5 min on next cron tick. Check /cache after ~5 min.' });
    }
    if (url.pathname === '/widgets/config') {
      return Response.json(
        { apiKey: env.API_FOOTBALL_KEY || '', league: 203, season: 2025, team: 549 },
        { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }
      );
    }

    if (url.pathname === '/widgets/bjk-fixtures') {
      const CORS = { 'Access-Control-Allow-Origin': '*' };
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
      const CORS = { 'Access-Control-Allow-Origin': '*' };
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

    if (url.pathname === '/widgets/tr.json') {
      const TR = {
        "all":"Tümü","live":"Canlı","finished":"Bitti","scheduled":"Planlandı","favorites":"Favoriler",
        "home":"Ev","away":"Deplasman","rank":"Sıra","team":"Takım",
        "played":"O","wins":"G","draws":"B","losses":"M",
        "goals_for":"+G","goals_against":"-G","goal_diff":"A","points":"P",
        "form":"Form","league":"Lig","season":"Sezon","round":"Tur",
        "venue":"Stadyum","referee":"Hakem",
        "lineup":"Kadro","bench":"Yedekler","substitutions":"Değişiklikler",
        "goals":"Goller","goal":"Gol","own_goal":"Kendi Kalesine",
        "assist":"Asist","var":"VAR",
        "yellow_card":"Sarı Kart","red_card":"Kırmızı Kart","missed_penalty":"Kaçırılan Penaltı",
        "player":"Oyuncu","coach":"Teknik Direktör","formation":"Diziliş",
        "stats":"İstatistikler","events":"Olaylar",
        "h2h":"Karşılıklı","head_to_head":"Karşılıklı Maçlar",
        "standing":"Puan Durumu","standings":"Puan Durumu",
        "last_5":"Son 5","last_matches":"Son Maçlar",
        "no_data":"Veri bulunamadı","loading":"Yükleniyor...","error":"Hata oluştu",
        "half_time":"Devre Arası","full_time":"Maç Sonu","extra_time":"Uzatmalar","penalties":"Penaltılar",
        "NS":"Başlamadı","TBD":"Belirsiz","1H":"1. Yarı","HT":"Devre Arası","2H":"2. Yarı",
        "ET":"Uzatmalar","BT":"Penaltılar","P":"Penaltılar","SUSP":"Askıya Alındı",
        "INT":"Durduruldu","FT":"Bitti","AET":"Uzatmalarda Bitti","PEN":"Penaltılarda Bitti",
        "PST":"Ertelendi","CANC":"İptal","ABD":"Terk Edildi","AWD":"Hükmen","WO":"Rakipsiz",
        "LIVE":"Canlı",
        "G":"Kaleci","D":"Defans","M":"Orta Saha","F":"Forvet",
        "shots_on_goal":"İsabetli Şut","shots_off_goal":"İsabetsiz Şut","total_shots":"Toplam Şut",
        "blocked_shots":"Engellenen Şut","corner_kicks":"Köşe Vuruşu","offsides":"Ofsayt",
        "ball_possession":"Top Hakimiyeti","yellow_cards":"Sarı Kart","red_cards":"Kırmızı Kart",
        "goalkeeper_saves":"Kaleci Kurtarışı","total_passes":"Toplam Pas",
        "passes_accurate":"İsabetli Pas","passes_percent":"Pas %","fouls":"Faul",
        "expected_goals":"Beklenen Gol (xG)"
      };
      return new Response(JSON.stringify(TR), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    if (url.pathname === '/widgets/current-match-stats') {
      const CORS = { 'Access-Control-Allow-Origin': '*' };
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
      const corsHeaders = { 'Access-Control-Allow-Origin': '*' };
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
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' };
      const [cached, config] = await Promise.all([
        env.PITCHOS_CACHE.get(`articles:${siteCode}`),
        loadSiteConfig(env, siteCode).catch(() => null),
      ]);
      const articles = cached ? JSON.parse(cached) : [];
      const fallbackSlugs = config?.rail_fallback_video_slugs || [];
      let rail_fallback = [];
      if (fallbackSlugs.length > 0) {
        const kvBySlug = new Map(articles.filter(a => a.slug).map(a => [a.slug, a]));
        const fromKV = [];
        const needFromDb = [];
        for (const slug of fallbackSlugs) {
          if (kvBySlug.has(slug)) fromKV.push(kvBySlug.get(slug));
          else needFromDb.push(slug);
        }
        let fromDb = [];
        if (needFromDb.length > 0) {
          const rows = await supabase(env, 'GET',
            `/rest/v1/content_items?slug=in.(${needFromDb.join(',')})&select=slug,title,image_url,published_at,source_name,publish_mode,category`
          ).catch(() => []);
          fromDb = rows || [];
        }
        const allBySlug = new Map([...fromKV.map(a => [a.slug, a]), ...fromDb.map(a => [a.slug, a])]);
        rail_fallback = fallbackSlugs.map(s => allBySlug.get(s)).filter(Boolean);
      }
      return new Response(JSON.stringify({ articles, rail_fallback }), { headers: h });
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
      await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(articles), { expirationTtl: 43200 });
      return Response.json({ updated: articles.length });
    }
    if (url.pathname === '/admin/find-duplicates') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site  = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });
        const rows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${site.id}&status=eq.published&select=id,title,slug,nvs_score,publish_mode,published_at,original_url&order=title.asc&limit=2000`);
        if (!Array.isArray(rows)) return Response.json({ error: 'supabase error' }, { status: 500, headers: h });
        const byTitle = {};
        for (const r of rows) {
          const key = (r.title || '').trim().toLowerCase();
          if (!key) continue;
          if (!byTitle[key]) byTitle[key] = [];
          byTitle[key].push(r);
        }
        const dupes = Object.values(byTitle)
          .filter(g => g.length > 1)
          .sort((a, b) => b.length - a.length)
          .map(g => ({ title: g[0].title, count: g.length, rows: g.map(r => ({ id: r.id, slug: r.slug, nvs: r.nvs_score, mode: r.publish_mode, published_at: r.published_at, url: r.original_url })) }));
        return Response.json({ total_dupes: dupes.length, total_extra_rows: dupes.reduce((s, d) => s + d.count - 1, 0), dupes: dupes.slice(0, 50) }, { headers: h });
      } catch(e) { return Response.json({ error: e.message }, { status: 500, headers: h }); }
    }

    if (url.pathname === '/admin/cleanup-orphans' && request.method === 'POST') {
      // Deletes slug-null copy_source rows (orphaned, no article page) and same-slug lower-NVS dupes.
      // POST /admin/cleanup-orphans?dry=true  → count only, no deletes
      // POST /admin/cleanup-orphans           → actually delete
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const dry = url.searchParams.get('dry') === 'true';
      try {
        const sites = await getActiveSites(env);
        const site  = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });

        // 1. Find all slug-null copy_source rows
        const nullSlugRows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${site.id}&publish_mode=eq.copy_source&slug=is.null&select=id&limit=500`);
        const nullSlugIds = (Array.isArray(nullSlugRows) ? nullSlugRows : []).map(r => r.id).filter(Boolean);

        // 2. Find same-slug duplicates across ALL statuses: keep highest NVS, delete the rest
        const allRows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${site.id}&select=id,slug,nvs_score,status&slug=not.is.null&limit=5000`);
        const bySlug = {};
        for (const r of (Array.isArray(allRows) ? allRows : [])) {
          if (!r.slug) continue;
          if (!bySlug[r.slug]) bySlug[r.slug] = [];
          bySlug[r.slug].push(r);
        }
        const dupeSlugIds = [];
        for (const rows of Object.values(bySlug)) {
          if (rows.length < 2) continue;
          // Prefer published > pending > others; within same status prefer higher NVS
          const statusRank = s => s === 'published' ? 2 : s === 'pending' ? 1 : 0;
          rows.sort((a, b) => statusRank(b.status) - statusRank(a.status) || (b.nvs_score || 0) - (a.nvs_score || 0));
          dupeSlugIds.push(...rows.slice(1).map(r => r.id));
        }

        const allToDelete = [...new Set([...nullSlugIds, ...dupeSlugIds])];
        if (dry) {
          return Response.json({ dry: true, null_slug_count: nullSlugIds.length, dupe_slug_count: dupeSlugIds.length, total: allToDelete.length }, { headers: h });
        }

        let deleted = 0;
        // Delete in batches of 100 (PostgREST IN clause limit)
        for (let i = 0; i < allToDelete.length; i += 100) {
          const batch = allToDelete.slice(i, i + 100);
          await supabase(env, 'DELETE', `/rest/v1/content_items?id=in.(${batch.join(',')})`, null);
          deleted += batch.length;
        }
        return Response.json({ deleted, null_slug_deleted: nullSlugIds.length, dupe_slug_deleted: dupeSlugIds.length }, { headers: h });
      } catch(e) { return Response.json({ error: e.message }, { status: 500, headers: h }); }
    }

    if (url.pathname === '/clear-cache') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      await Promise.all([
        env.PITCHOS_CACHE.delete('articles:BJK'),
        env.PITCHOS_CACHE.delete('seen:BJK'),
      ]);
      return Response.json({ cleared: ['articles:BJK', 'seen:BJK'] });
    }
    if (url.pathname === '/rebuild-cache') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      // Restores KV display cache after a wipe.
      // Strategy 1: pull from Supabase content_items (any status).
      // Strategy 2: fetch RSS feeds directly, skip url-dedup. Forced with ?rss=1.
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { status: 500 });

        // Strategy 1 — Supabase
        const rows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${site.id}&publish_mode=neq.rss_summary&order=created_at.desc&limit=300&select=title,summary,full_body,source_name,source_type,original_url,category,nvs_score,golden_score,published_at,fetched_at,created_at,sport,publish_mode,image_url,slug,template_id`
        );

        if (rows && rows.length > 0) {
          const articles = rows.filter(r => r.slug).map(r => toKVShape({
            title:               r.title        || '',
            summary:             r.summary      || '',
            full_body:           r.full_body    || r.summary || '',
            source_name:         r.source_name  || 'Kartalix',
            source:              r.source_name  || 'Kartalix',
            url:                 r.original_url || '',
            original_url:        r.original_url || '',
            category:            r.category     || 'Haber',
            nvs:                 r.nvs_score    || 0,
            golden_score:        r.golden_score || null,
            published_at:        r.published_at || r.created_at || r.fetched_at,
            fetched_at:          r.created_at   || r.fetched_at,
            is_fresh:            false,
            is_kartalix_content: r.source_type === 'kartalix',
            sport:               r.sport        || 'football',
            publish_mode:        r.publish_mode || 'rss_summary',
            image_url:           r.image_url    || '',
            slug:                r.slug,
            template_id:         r.template_id  || null,
          }));
          await cacheToKV(env, site.short_code, articles);
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
        await env.PITCHOS_CACHE.put(`articles:${site.short_code}`, JSON.stringify(top), { expirationTtl: 43200 });
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
      await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(enriched), { expirationTtl: 43200 });
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
        const site = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { headers: { 'Access-Control-Allow-Origin': '*' } });
        const fixture = await getNextFixture(env);
        const match = fixture
          ? { ...NEXT_MATCH, ...fixture, ...await resolveVenueCoords(fixture.venue, fixture.venue_city).then(c => ({ venue_lat: c.lat, venue_lon: c.lon })), tv: NEXT_MATCH.tv }
          : NEXT_MATCH;
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const fixture = await getNextFixture(env);
        const match = fixture
          ? { ...NEXT_MATCH, ...fixture, ...await resolveVenueCoords(fixture.venue, fixture.venue_city).then(c => ({ venue_lat: c.lat, venue_lon: c.lon })), tv: NEXT_MATCH.tv }
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      // Synchronous T01 generation — bypasses cron/backgroundWork, runs directly in request scope.
      // Uses the same logic as backgroundWork but waits for the result and returns it.
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const fixture = await getNextFixture(env);
        const match = fixture
          ? { ...NEXT_MATCH, ...fixture, ...await resolveVenueCoords(fixture.venue, fixture.venue_city).then(c => ({ venue_lat: c.lat, venue_lon: c.lon })), tv: NEXT_MATCH.tv }
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      // Simulate a BJK goal flash. Pass ?scorer=Name&minute=67&assist=Name&own=true&penalty=true
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      // Debug: check what YouTube videos would qualify right now.
      // ?channel_id=UC... — limit to one channel (omit for all 5)
      // ?publish=1 — actually generate embeds and push to KV/Supabase
      // ?since=2026-05-01T00:00:00Z — override 48h lookback window
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site  = resolveSite(url, sites);
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
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...current], 300));
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      // Simulate a full-time result flash. Pass ?bjk=2&opp=1 to override score,
      // or omit to fetch actual score from API.
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      // Simulate a post-match T13. Pass ?bjk=2&opp=1 for score context.
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const fixture = await getNextFixture(env);
        const match = fixture
          ? { ...NEXT_MATCH, ...fixture, ...await resolveVenueCoords(fixture.venue, fixture.venue_city).then(c => ({ venue_lat: c.lat, venue_lon: c.lon })), tv: NEXT_MATCH.tv }
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const fixture = await getNextFixture(env);
        const match = fixture
          ? { ...NEXT_MATCH, ...fixture, ...await resolveVenueCoords(fixture.venue, fixture.venue_city).then(c => ({ venue_lat: c.lat, venue_lon: c.lon })), tv: NEXT_MATCH.tv }
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
    if (url.pathname === '/force-t08c') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const fixture = await getNextFixture(env);
        const match = fixture
          ? { ...NEXT_MATCH, ...fixture, ...await resolveVenueCoords(fixture.venue, fixture.venue_city).then(c => ({ venue_lat: c?.lat, venue_lon: c?.lon })), tv: NEXT_MATCH.tv }
          : NEXT_MATCH;
        const [bjkLastLineup, oppLastLineup, injuries, predHistory] = await Promise.all([
          getBJKLastLineupData(env),
          match.opponent_id ? getOpponentLastLineup(match.opponent_id, env) : Promise.resolve(null),
          getInjuries(env, match.fixture_id),
          env.PITCHOS_CACHE.get('lineup_history', 'json').catch(() => null),
        ]);
        const card = await generateLineupCard(match, bjkLastLineup, oppLastLineup, injuries, predHistory || [], site, env);
        if (!card) return Response.json({ error: 'generateLineupCard returned null — check BJK last lineup data' }, { headers, status: 500 });
        // Write to KV so article is immediately visible on site
        const cachedRaw = await env.PITCHOS_CACHE.get('articles:' + (site.short_code || 'BJK'));
        const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
        const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 75, is_kartalix_content: true, is_template: true });
        await cacheToKV(env, site.short_code || 'BJK', mergeAndDedupe([kvCard, ...cached.filter(a => a.template_id !== 'T08c')], 300));
        return Response.json({
          success: true, title: card.title, slug: card.slug,
          url: `https://kartalix.com/haber/${card.slug}`,
          predicted_players: card.predicted_players,
          formation: card.formation,
          opp_formation: oppLastLineup?.formation || null,
          opp_players: oppLastLineup?.startXI?.length || 0,
          injuries_excluded: (injuries || []).map(i => i.name),
          bjk_lineup_subs: bjkLastLineup?.substitutes?.length || 0,
          history_entries: (predHistory || []).length,
          svg_length: card.full_body?.length,
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-t12') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
    if (url.pathname === '/force-story-synthesis') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const storyId = url.searchParams.get('story_id');
      if (!storyId) return Response.json({ error: 'story_id required' }, { headers, status: 400 });
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const rows = await supabase(env, 'GET',
          `/rest/v1/stories?id=eq.${storyId}&select=*&limit=1`);
        const story = rows?.[0];
        if (!story) return Response.json({ error: 'story not found' }, { headers, status: 404 });
        // Clear dedup key so force always runs
        const today = new Date().toISOString().slice(0, 10);
        await env.PITCHOS_CACHE.delete(`synth:${storyId}:${today}`);
        const result = await synthesizeStory(story, site.id, env, site.short_code);
        // Also show h5 gate state for diagnosis
        const gate = await checkH5SynthGate(storyId, env);
        return Response.json({ ok: true, published: !!result, title: result?.title || null, story_state: story.state, gate }, { headers });
      } catch (e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }

    // ── /force-h5 — test H5 synthesis gate without waiting for cron ────
    // ?fire=1 to actually fire synthesis; omit to dry-run only.
    // ?story_id=X to check a single story; omit to scan all confirmed/active.
    if (url.pathname === '/force-h5') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const fire = url.searchParams.get('fire') === '1';
      const targetId = url.searchParams.get('story_id') || null;
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });

        const allSites = url.searchParams.get('all') === '1';
        const stateFilter = targetId
          ? `id=eq.${targetId}`
          : allSites
            ? `state=in.(confirmed,active,developing)`
            : `site_id=eq.${site.id}&state=in.(confirmed,active,developing)`;
        const stories = await supabase(env, 'GET',
          `/rest/v1/stories?${stateFilter}&order=last_contribution_at.desc&limit=20&select=id,title,state,confidence,last_contribution_at`
        ) || [];

        const scRows = await supabase(env, 'GET', `/rest/v1/source_configs?select=name,source_family&is_active=eq.true`) || [];
        const scMap = Object.fromEntries(scRows.filter(r => r.source_family).map(r => [r.name, r.source_family]));
        const results = [];
        let fired = 0;
        for (const story of stories) {
          const gate = await checkH5SynthGate(story.id, env, scMap);
          const entry = {
            story_id: story.id,
            title: story.title?.slice(0, 60),
            state: story.state,
            confidence: story.confidence,
            last_contribution_at: story.last_contribution_at,
            eligible: gate.eligible,
            reason: gate.reason,
            stats: gate.stats || null,
            fired: false,
          };
          if (gate.eligible && fire && fired < 2) {
            await env.PITCHOS_CACHE.delete(`synth:${story.id}:${new Date().toISOString().slice(0, 10)}`);
            const result = await synthesizeStory(story, site.id, env, site.short_code);
            entry.fired = true;
            entry.published_title = result?.title || null;
            fired++;
          }
          results.push(entry);
        }
        return Response.json({
          ok: true,
          fire_mode: fire,
          stories_checked: stories.length,
          eligible_count: results.filter(r => r.eligible).length,
          fired_count: fired,
          results,
        }, { headers });
      } catch (e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }

    if (url.pathname === '/force-txgdelta') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
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
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(updated), { expirationTtl: 43200 });
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
    if (url.pathname === '/admin/rewrite-article' && request.method === 'POST') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const body = await request.json().catch(() => ({}));
        const slug = body.slug || url.searchParams.get('slug');
        if (!slug) return Response.json({ error: 'slug required' }, { headers, status: 400 });
        const SITE = '2b5cfe49-b69a-4143-8323-ca29fff6502e';
        const rows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${SITE}&slug=eq.${encodeURIComponent(slug)}&select=id,title,summary,original_url,nvs_score,publish_mode&limit=1`
        );
        if (!rows?.length) return Response.json({ error: 'article not found', slug }, { headers, status: 404 });
        const article = rows[0];
        const sites = await getActiveSites(env);
        const site  = resolveSite(url, sites);
        const result = await synthesizeArticle({
          title: article.title, summary: article.summary || '',
          url: article.original_url || '', original_url: article.original_url || '',
          nvs: article.nvs_score,
        }, env, site);
        if (!result?.body || result.body.length < 150)
          return Response.json({ error: 'synthesis empty', title: article.title }, { headers, status: 500 });
        await supabase(env, 'PATCH', `/rest/v1/content_items?id=eq.${article.id}`, {
          full_body: result.body, publish_mode: 'rewrite', needs_review: result.needs_review || false,
        });
        // Rebuild KV so the corrected body is live immediately
        const GOOD_MODES = ['rewrite','copy_source','template_matchday','template_postmatch','template_lineup','template_h2h','template_form_guide','template_injury','template_official','youtube_embed','synthesis_generated','manual','original_synthesis','video_embed'];
        const dbRows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${SITE}&status=eq.published&publish_mode=in.(${GOOD_MODES.join(',')})&order=published_at.desc&limit=100&select=slug,title,summary,full_body,category,source_name,source_type,original_url,nvs_score,golden_score,publish_mode,published_at,fetched_at,created_at,template_id,sport`
        );
        if (Array.isArray(dbRows) && dbRows.length > 0 && site) {
          const kvArticles = dbRows.filter(r => r.slug && (r.full_body || r.summary)).map(r => toKVShape({
            title: r.title || '', summary: r.summary || '', full_body: r.full_body || r.summary || '',
            source_name: r.source_name || '', source: r.source_name || '',
            url: r.original_url || '', original_url: r.original_url || '',
            category: r.category || 'Haber', nvs: r.nvs_score || 0,
            golden_score: r.golden_score || null,
            published_at: r.published_at || r.created_at || r.fetched_at,
            fetched_at: r.created_at || r.fetched_at, is_fresh: false,
            is_kartalix_content: r.source_type === 'kartalix',
            publish_mode: r.publish_mode || 'rss_summary',
            template_id: r.template_id || null, sport: r.sport || 'football', slug: r.slug,
          }));
          await cacheToKV(env, site.short_code, kvArticles);
        }
        return Response.json({
          ok: true, slug, title: article.title, words: result.body.split(/\s+/).length,
          needs_review: result.needs_review, preview: result.body.slice(0, 400),
        }, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }

    if (url.pathname === '/force-synthesis') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const publish = url.searchParams.get('publish') === '1';
        const sites = await getActiveSites(env);
        const site = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });

        // Pull recent high-NVS articles that aren't already synthesized
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const params = new URLSearchParams({
          select: 'id,title,summary,original_url,nvs_score,publish_mode,fetched_at',
          site_id: `eq.${site.id}`,
          nvs_score: 'gte.55',
          fetched_at: `gte.${since}`,
          publish_mode: 'not.in.(rewrite,original_synthesis)',
          order: 'nvs_score.desc',
          limit: '10',
        });
        const candidates = await supabase(env, 'GET', `/rest/v1/content_items?${params}`);

        if (!candidates?.length) return Response.json({ error: 'no candidates in last 24h with NVS≥55' }, { headers, status: 404 });

        const article = candidates[0];
        const articleForSynth = {
          title: article.title,
          summary: article.summary || '',
          url: article.original_url || '',
          original_url: article.original_url || '',
          nvs: article.nvs_score,
        };

        const result = await synthesizeArticle(articleForSynth, env, site);
        if (!result?.body || result.body.length < 150) {
          return Response.json({ error: 'synthesis returned empty body', article: article.title }, { headers, status: 500 });
        }

        const preview = {
          total_candidates: candidates.length,
          picked: article.title,
          nvs: article.nvs_score,
          publish_mode_was: article.publish_mode,
          words: result.body.split(/\s+/).length,
          needs_review: result.needs_review,
          preview: result.body.slice(0, 600),
        };

        if (publish) {
          const upRes = await supabase(env, 'PATCH', `/rest/v1/content_items?id=eq.${article.id}`, {
            full_body: result.body, publish_mode: 'rewrite', needs_review: result.needs_review || false,
          });
          if (upRes?.error) return Response.json({ ...preview, publish_error: upRes.error }, { headers });
          preview.published = true;
          preview.updated_id = article.id;
        }

        return Response.json(preview, { headers });
      } catch(e) {
        return Response.json({ error: e.message }, { headers, status: 500 });
      }
    }
    if (url.pathname === '/force-tht') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const sites = await getActiveSites(env);
        const site  = resolveSite(url, sites);
        if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });
        const liveKV    = await env.PITCHOS_CACHE.get('match:BJK:live').then(r => r ? JSON.parse(r) : null).catch(() => null);
        const fid = url.searchParams.get('fixture_id')
          ? parseInt(url.searchParams.get('fixture_id'))
          : liveKV?.fixture_id || (await getNextFixture(env).catch(() => null))?.fixture_id || NEXT_MATCH.fixture_id;
        const apiFixture = await getFixture(fid, env).catch(() => null);
        const scoreBjk = parseInt(url.searchParams.get('bjk') ?? apiFixture?.score_bjk ?? 0);
        const scoreOpp = parseInt(url.searchParams.get('opp') ?? apiFixture?.score_opp ?? 0);
        const matchObj = apiFixture
          ? { ...NEXT_MATCH, ...apiFixture, match_day: apiFixture.date, score_bjk: scoreBjk, score_opp: scoreOpp }
          : { ...NEXT_MATCH, score_bjk: scoreBjk, score_opp: scoreOpp };
        const allEvents = await fetchAllEvents(fid, env);
        const card = await generateHalftimeReport(matchObj, allEvents, site, env);
        if (!card) return Response.json({ error: 'generateHalftimeReport returned null' }, { headers, status: 500 });
        const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
        const latest = raw ? JSON.parse(raw) : [];
        await cacheToKV(env, site.short_code, mergeAndDedupe([
          toKVShape({ ...card, nvs: card.nvs_score || 85, is_kartalix_content: true, is_template: true, fixture_id: fid }),
          ...latest,
        ], 300));
        return Response.json({ ok: true, title: card.title, fixture_id: fid, score: `${scoreBjk}-${scoreOpp}`, words: (card.full_body || '').split(/\s+/).length }, { headers });
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
      const authed = await checkAdminAuth(request, env);
      if (!authed) return new Response(renderPinPage(url.pathname), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
        if (body.action === 'reset') {
          const monthKey2 = new Date().toISOString().slice(0, 7);
          await Promise.all([
            env.PITCHOS_CACHE.put(`cost:${monthKey2}`, '0'),
            env.PITCHOS_CACHE.delete(`cost:alarm:80:${monthKey2}`),
            env.PITCHOS_CACHE.delete(`cost:alarm:90:${monthKey2}`),
            env.PITCHOS_CACHE.delete(`cost:alarm:100:${monthKey2}`),
          ]);
          return Response.json({ ok: true }, { headers: h });
        }
        if (body.action === 'set-cap') {
          const val = parseFloat(body.cap);
          if (!val || val <= 0) return Response.json({ error: 'invalid cap' }, { status: 400, headers: h });
          await env.PITCHOS_CACHE.put('cost:cap', String(val.toFixed(2)));
          return Response.json({ ok: true }, { headers: h });
        }
        return Response.json({ error: 'unknown action' }, { status: 400, headers: h });
      }

      const now = new Date();
      const monthKey = now.toISOString().slice(0, 7);
      const [currentRaw, capOverride, alarm80, alarm90, alarm100] = await Promise.all([
        env.PITCHOS_CACHE.get(`cost:${monthKey}`),
        env.PITCHOS_CACHE.get('cost:cap'),
        env.PITCHOS_CACHE.get(`cost:alarm:80:${monthKey}`),
        env.PITCHOS_CACHE.get(`cost:alarm:90:${monthKey}`),
        env.PITCHOS_CACHE.get(`cost:alarm:100:${monthKey}`),
      ]);
      const current = parseFloat(currentRaw || '0');
      const cap = parseFloat(capOverride || env.MONTHLY_CLAUDE_CAP || '8');
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
      const alarms = { 80: alarm80, 90: alarm90, 100: alarm100 };
      const data = { current_month: monthKey, current_usd: +current.toFixed(4), cap_usd: cap, cap_is_override: !!capOverride, pct_used: pct, blocked: current >= cap, history, alarms };
      if (url.searchParams.get('json') === '1') return Response.json(data, { headers: { 'Content-Type': 'application/json' } });
      const dest = `/admin/financials?tab=cost${url.searchParams.get('site') ? '&site='+url.searchParams.get('site') : ''}`;
      return Response.redirect(`https://${url.hostname}${dest}`, 302);
    }

    // ── FINANCIALS PAGE ───────────────────────────────────────
    if (url.pathname === '/admin/financials') {
      const cookie = request.headers.get('cookie') || '';
      const authed = await checkAdminAuth(request, env);
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

      const now2 = new Date();
      const monthKey2 = now2.toISOString().slice(0, 7);
      const [costRaw, costCap, a80, a90, a100] = await Promise.all([
        env.PITCHOS_CACHE.get(`cost:${monthKey2}`),
        env.PITCHOS_CACHE.get('cost:cap'),
        env.PITCHOS_CACHE.get(`cost:alarm:80:${monthKey2}`),
        env.PITCHOS_CACHE.get(`cost:alarm:90:${monthKey2}`),
        env.PITCHOS_CACHE.get(`cost:alarm:100:${monthKey2}`),
      ]);
      const costCur = parseFloat(costRaw || '0');
      const costCapV = parseFloat(costCap || env.MONTHLY_CLAUDE_CAP || '8');
      const costPct = costCapV > 0 ? (costCur / costCapV * 100).toFixed(1) : '0';
      const costMonths = [monthKey2];
      for (let i = 1; i <= 2; i++) { const d2 = new Date(now2); d2.setMonth(d2.getMonth()-i); costMonths.push(d2.toISOString().slice(0,7)); }
      const costHistory = await Promise.all(costMonths.map(async m => ({ month: m, usd: parseFloat((await env.PITCHOS_CACHE.get(`cost:${m}`)) || '0') })));
      const costData = { current_month: monthKey2, current_usd: +costCur.toFixed(4), cap_usd: costCapV, cap_is_override: !!costCap, pct_used: costPct, blocked: costCur >= costCapV, history: costHistory, alarms: { 80: a80, 90: a90, 100: a100 } };
      const activeTab = url.searchParams.get('tab') === 'cost' ? 'cost' : 'fin';
      const allSites = await getActiveSites(env);
      const currentSite = resolveSite(url, allSites);
      return new Response(
        renderFinancialsPage(monthsData, FIXED_ITEMS, costData, activeTab, currentSite.short_code, allSites),
        { headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
      );
    }

    // ── GOLDEN FIXTURE VERIFIER ───────────────────────────────
    // GET /admin/golden-fixtures — verifies Slice 2 acceptance criteria against live data
    if (url.pathname === '/admin/golden-fixtures') {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const SITE_ID = env.SITE_ID || (await getActiveSites(env))?.[0]?.id;

      const [storiesRaw, contribsRaw, transitionsRaw] = await Promise.all([
        supabase(env, 'GET', `/rest/v1/stories?site_id=eq.${SITE_ID}&select=id,title,state,confidence,story_type,first_contribution_at,last_contribution_at&order=last_contribution_at.desc&limit=200`),
        supabase(env, 'GET', `/rest/v1/story_contributions?select=story_id,contribution_type,confidence_delta,added_at&order=added_at.desc&limit=500`),
        supabase(env, 'GET', `/rest/v1/story_state_transitions?select=story_id,from_state,to_state,trigger,triggered_at&order=triggered_at.desc&limit=200`),
      ]);

      const stories = storiesRaw || [];
      const contribs = contribsRaw || [];
      const transitions = transitionsRaw || [];

      // GF1: rashica_transfer_5_contribs — at least one story with ≥2 contributions (dedup working)
      const contribsByStory = {};
      contribs.forEach(c => { contribsByStory[c.story_id] = (contribsByStory[c.story_id] || 0) + 1; });
      const multiContribStories = stories
        .filter(s => (contribsByStory[s.id] || 0) >= 2)
        .map(s => ({ id: s.id, title: s.title, state: s.state, type: s.story_type, contributions: contribsByStory[s.id] }))
        .sort((a, b) => b.contributions - a.contributions)
        .slice(0, 5);
      const gf1Pass = multiContribStories.length > 0 && multiContribStories[0].contributions >= 2;

      // GF2: story_state_transitions — at least one story that advanced beyond 'emerging'
      const advancedTransitions = transitions.filter(t => t.from_state && t.from_state !== t.to_state);
      const uniqueAdvanced = [...new Set(advancedTransitions.map(t => t.story_id))];
      const gf2Pass = uniqueAdvanced.length > 0;
      const transitionSample = advancedTransitions.slice(0, 5).map(t => ({
        story_id: t.story_id.slice(0, 8),
        from: t.from_state,
        to: t.to_state,
        trigger: t.trigger,
        at: t.triggered_at,
      }));

      // GF3: confidence_scoring — at least one story reached 'active' (means confidence hit threshold)
      const activeStories = stories.filter(s => s.state === 'active' || s.state === 'confirmed');
      const gf3Pass = activeStories.length > 0;

      return Response.json({
        gf1_multi_contribution_dedup: {
          pass: gf1Pass,
          description: 'Multiple articles about same story → single story row (not duplicated)',
          top_stories: multiContribStories,
        },
        gf2_state_transitions: {
          pass: gf2Pass,
          description: 'State machine fires and records transitions',
          stories_with_transitions: uniqueAdvanced.length,
          sample: transitionSample,
        },
        gf3_confidence_scoring: {
          pass: gf3Pass,
          description: 'Confidence math reaches publication threshold',
          active_stories: activeStories.length,
          sample: activeStories.slice(0, 3).map(s => ({ title: s.title?.slice(0, 50), state: s.state, confidence: s.confidence })),
        },
        summary: {
          total_stories: stories.length,
          all_pass: gf1Pass && gf2Pass && gf3Pass,
        },
      }, { headers });
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
      await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(filtered), { expirationTtl: 43200 });
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
      const site  = resolveSite(url, sites);
      if (!site) return Response.json({ error: 'no active site' }, { headers, status: 500 });

      if (request.method === 'GET') {
        const rows = await supabase(env, 'GET',
          `/rest/v1/source_configs?site_id=eq.${site.id}&order=source_type,name&select=*`
        );
        return Response.json(rows || [], { headers });
      }
      if (request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const allowed = ['name','source_type','url','channel_id','trust_tier','treatment','sport','is_p4','nvs_hint','all_qualify','proxy','notes','is_active'];
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
        const allowed = ['name','is_active','trust_tier','source_family','treatment','nvs_hint','all_qualify','url','channel_id','proxy','is_p4','notes'];
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
      const site  = resolveSite(url, sites);
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
      const site  = resolveSite(url, sites);
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
      const authed = await checkAdminAuth(request, env);
      if (!authed) return new Response(renderPinPage(url.pathname), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      const allSites = await getActiveSites(env);
      const currentSite = resolveSite(url, allSites);
      return new Response(renderSourcesPage(currentSite.short_code, allSites), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/report') {
      const cookie = request.headers.get('cookie') || '';
      const authed = await checkAdminAuth(request, env);
      if (!authed) return new Response(renderPinPage('/admin/report'), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      const allSites = await getActiveSites(env);
      const currentSite = resolveSite(url, allSites);
      return new Response(renderAdminReportPage(currentSite.short_code, allSites), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/report-data') {
      const cookie = request.headers.get('cookie') || '';
      const authed = await checkAdminAuth(request, env);
      if (!authed) return new Response('Unauthorized', { status: 401 });
      const from = url.searchParams.get('from') || null;
      const to   = url.searchParams.get('to')   || null;
      const report = await buildReport(env, from, to);
      return new Response(JSON.stringify(report), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/admin/pipeline-log') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const from = url.searchParams.get('from');
      const to   = url.searchParams.get('to');
      const SITE = '2b5cfe49-b69a-4143-8323-ca29fff6502e';
      const filt = (from ? `&run_at=gte.${encodeURIComponent(from)}` : '') + (to ? `&run_at=lte.${encodeURIComponent(to)}` : '');
      const ciTimeFilt = from ? `&reviewed_at=gte.${encodeURIComponent(from)}` : '';

      const [rows, recentItems] = await Promise.all([
        supabase(env, 'GET',
          `/rest/v1/pipeline_log?site_id=eq.${SITE}&order=run_at.desc,created_at.desc&limit=1000${filt}&select=source_name,title,url,stage,nvs_score,publish_mode,run_at,trust_tier,source_body_len,drop_detail`
        ),
        supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${SITE}${ciTimeFilt}&order=reviewed_at.desc&select=original_url,slug,status,story_id&limit=500`
        ),
      ]);

      // Build URL → content_item lookup
      const ciMap = {};
      for (const ci of (recentItems || [])) {
        if (ci.original_url) ciMap[ci.original_url] = ci;
      }

      // Fetch story titles for all referenced story_ids
      const storyIds = [...new Set((recentItems || []).map(ci => ci.story_id).filter(Boolean))];
      const storyMap = {};
      if (storyIds.length > 0) {
        const stories = await supabase(env, 'GET',
          `/rest/v1/stories?id=in.(${storyIds.slice(0, 60).join(',')})&select=id,title&limit=60`
        );
        for (const s of (stories || [])) storyMap[s.id] = s.title;
      }

      // Enrich pipeline_log rows with content_item data where available
      const enriched = (rows || []).map(r => {
        const ci = r.url ? ciMap[r.url] : null;
        if (!ci) return r;
        return {
          ...r,
          slug:           ci.slug,
          content_status: ci.status,
          story_id:       ci.story_id || null,
          story_title:    ci.story_id ? (storyMap[ci.story_id] || null) : null,
        };
      });

      return Response.json(enriched);
    }

    if (url.pathname === '/admin/kpi-strip') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const SITE = '2b5cfe49-b69a-4143-8323-ca29fff6502e';
      const now = Date.now();
      const enc = s => encodeURIComponent(s);
      const todayUTC = new Date(now).toISOString().slice(0, 10);
      const todayStart = todayUTC + 'T00:00:00.000Z';
      const fourteenDaysAgo = new Date(now - 14 * 86400000).toISOString();
      const sixHoursAgo = new Date(now - 6 * 3600000).toISOString();
      const days14 = [];
      for (let i = 13; i >= 0; i--) days14.push(new Date(now - i * 86400000).toISOString().slice(0, 10));

      const allResults = await Promise.all([
        env.PITCHOS_CACHE.get('articles:BJK').catch(() => null),
        env.PITCHOS_CACHE.get(`churn:BJK:${todayUTC}`).catch(() => null),
        supabase(env, 'GET', `/rest/v1/fetch_logs?site_id=eq.${SITE}&order=created_at.desc&limit=1&select=created_at,error_message`).catch(() => null),
        supabase(env, 'GET', `/rest/v1/fetch_logs?site_id=eq.${SITE}&created_at=gte.${enc(todayStart)}&select=items_fetched,estimated_cost_eur`).catch(() => null),
        supabase(env, 'GET', `/rest/v1/fetch_logs?site_id=eq.${SITE}&created_at=gte.${enc(fourteenDaysAgo)}&select=created_at,estimated_cost_eur`).catch(() => null),
        supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${SITE}&status=eq.published&published_at=gte.${enc(todayStart)}&select=id&limit=500`).catch(() => null),
        supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${SITE}&status=eq.published&published_at=gte.${enc(fourteenDaysAgo)}&select=published_at,nvs_score&limit=3000`).catch(() => null),
        supabase(env, 'GET', `/rest/v1/pipeline_log?site_id=eq.${SITE}&run_at=gte.${enc(todayStart)}&select=stage,source_name&limit=5000`).catch(() => null),
        supabase(env, 'GET', `/rest/v1/story_contributions?added_at=gte.${enc(sixHoursAgo)}&select=story_id,added_at&limit=500`).catch(() => null),
        supabase(env, 'GET', `/rest/v1/stories?site_id=eq.${SITE}&last_contribution_at=gte.${enc(sixHoursAgo)}&select=id,title&limit=50`).catch(() => null),
        ...days14.map(d => env.PITCHOS_CACHE.get(`pool_snapshot:BJK:${d}`).catch(() => null)),
      ]);

      const [kvRaw, churnRaw, lastCronRows, todayFetchRows, trend14dFetchRows,
             todayPubRows, trend14dPubRows, todayFunnelRows, contribsRows, storiesRows,
             ...pool14dRaws] = allResults;

      // ── Pool composition
      const poolArr = kvRaw ? (JSON.parse(kvRaw) || []) : [];
      const poolSize = Array.isArray(poolArr) ? poolArr.length : 0;
      let videoCount = 0, yzCount = 0, yzPlusCount = 0;
      for (const a of poolArr) {
        const mode = a.publish_mode || '';
        if (mode === 'youtube_embed') videoCount++;
        else if (mode === 'synthesis_generated' || mode === 'original_synthesis') yzPlusCount++;
        else if (mode === 'rewrite' || mode === 'copy_source' || mode === 'rss_summary') yzCount++;
      }

      // ── Hot story (highest contribution count in last 6h, need ≥3)
      const storyTitleMap = {};
      for (const s of (storiesRows || [])) storyTitleMap[s.id] = s.title;
      const storyContribCounts = {}, storyContribLast = {};
      for (const c of (contribsRows || [])) {
        storyContribCounts[c.story_id] = (storyContribCounts[c.story_id] || 0) + 1;
        if (!storyContribLast[c.story_id] || c.added_at > storyContribLast[c.story_id])
          storyContribLast[c.story_id] = c.added_at;
      }
      let hotStoryId = null, hotCount = 0;
      for (const [id, cnt] of Object.entries(storyContribCounts)) {
        if (cnt >= 3 && cnt > hotCount) { hotCount = cnt; hotStoryId = id; }
      }
      let hot_story = null;
      if (hotStoryId && storyTitleMap[hotStoryId]) {
        const minsAgo = Math.round((now - new Date(storyContribLast[hotStoryId]).getTime()) / 60000);
        hot_story = { title: storyTitleMap[hotStoryId], contribution_count: hotCount, minutes_since_last: minsAgo };
      }

      // ── Last cron run
      const lastCron = (lastCronRows || [])[0];
      let last_cron = null;
      if (lastCron) {
        const cronMs = new Date(lastCron.created_at).getTime();
        const minsAgo = Math.round((now - cronMs) / 60000);
        let status = 'success';
        if (lastCron.error_message) {
          try { const em = JSON.parse(lastCron.error_message); if (em.error || em.failed) status = 'error'; } catch(e) { /* non-JSON = error details */ }
        }
        last_cron = { timestamp: lastCron.created_at, minutes_ago: minsAgo, status };
      }

      // ── Today published + 14d baseline
      const todayPubCount = (todayPubRows || []).length;
      const pub14dMap = {};
      for (const r of (trend14dPubRows || [])) {
        const day = (r.published_at || '').slice(0, 10);
        if (day && day < todayUTC) pub14dMap[day] = (pub14dMap[day] || 0) + 1;
      }
      const pub14dVals = Object.values(pub14dMap);
      const pubBaseline = pub14dVals.length > 0 ? Math.round(pub14dVals.reduce((s, v) => s + v, 0) / pub14dVals.length) : 0;
      const pubDeltaPct = pubBaseline > 0 ? Math.round(((todayPubCount - pubBaseline) / pubBaseline) * 100) : 0;

      // ── Funnel (pipeline_log stages)
      let qualified = 0, rejected_pl = 0, unscored = 0;
      for (const r of (todayFunnelRows || [])) {
        const stage = r.stage || '';
        if (stage === 'published') { qualified++; }
        else if (stage === 'scored_low' || stage === 'synthesis_failed') { qualified++; rejected_pl++; }
        else { unscored++; }
      }

      // ── Pool churn
      const churn = churnRaw ? JSON.parse(churnRaw) : { added: 0, removed_total: 0, removed_aged_out: 0, removed_ttl: 0, removed_overflow: 0 };

      // ── Today fetched + active sources (sources from pipeline_log, count from fetch_logs)
      const fetchedCount = (todayFetchRows || []).reduce((s, r) => s + (r.items_fetched || 0), 0);
      const activeSources = new Set((todayFunnelRows || []).map(r => r.source_name).filter(Boolean)).size;

      // ── Cost today + 14d baseline (estimated_cost_eur is actually USD — see utils.js)
      const todayCostUsd = (todayFetchRows || []).reduce((s, r) => s + (r.estimated_cost_eur || 0), 0);
      const cost14dMap = {};
      for (const r of (trend14dFetchRows || [])) {
        const day = (r.created_at || '').slice(0, 10);
        if (day && day < todayUTC) cost14dMap[day] = (cost14dMap[day] || 0) + (r.estimated_cost_eur || 0);
      }
      const cost14dVals = Object.values(cost14dMap);
      const costBaseline = cost14dVals.length > 0 ? cost14dVals.reduce((s, v) => s + v, 0) / cost14dVals.length : 0;

      // ── 14d trend arrays
      const pool14d = pool14dRaws.map(v => v !== null ? parseInt(v, 10) : null);
      const nvsByDay = {};
      for (const r of (trend14dPubRows || [])) {
        const day = (r.published_at || '').slice(0, 10);
        if (day && r.nvs_score !== null && r.nvs_score !== undefined) {
          if (!nvsByDay[day]) nvsByDay[day] = [];
          nvsByDay[day].push(Number(r.nvs_score));
        }
      }
      const nvs14d = days14.map(d => {
        const vals = nvsByDay[d];
        if (!vals || vals.length === 0) return null;
        const sorted = [...vals].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      });
      const costByDay = {};
      for (const r of (trend14dFetchRows || [])) {
        const day = (r.created_at || '').slice(0, 10);
        if (day) costByDay[day] = (costByDay[day] || 0) + (r.estimated_cost_eur || 0);
      }
      costByDay[todayUTC] = todayCostUsd;
      const cost14d = days14.map(d => costByDay[d] !== undefined ? Math.round(costByDay[d] * 1000) / 1000 : null);

      return Response.json({
        as_of: new Date(now).toISOString(),
        days: days14,
        live_state: {
          pool_size: poolSize,
          pool_composition: { video: videoCount, yz: yzCount, yz_plus: yzPlusCount },
          hot_story,
          last_cron,
        },
        today: {
          published: { count: todayPubCount, baseline: pubBaseline, delta_pct: pubDeltaPct },
          funnel: { qualified, unscored, rejected: rejected_pl },
          live_churn: churn,
          fetched: { count: fetchedCount, active_sources: activeSources },
          cost: { today_usd: Math.round(todayCostUsd * 1000) / 1000, baseline_usd: Math.round(costBaseline * 1000) / 1000 },
        },
        trend_14d: { pool_size: pool14d, median_nvs_published: nvs14d, cost_daily_usd: cost14d },
      }, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } });
    }

    // TEMP: rewrite-db-check — remove after use
    if (url.pathname === '/admin/rewrite-db-check' && request.method === 'GET') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const sites = await getActiveSites(env);
      const site = resolveSite(url, sites);
      if (!site) return Response.json({ error: 'no site' });
      const [allRewrites, nullPub, recent4d, schemaCheck] = await Promise.all([
        supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${site.id}&publish_mode=eq.rewrite&select=slug,title,published_at,fetched_at,created_at&order=created_at.desc&limit=20`),
        supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${site.id}&publish_mode=eq.rewrite&published_at=is.null&select=slug,title,created_at&limit=5`),
        supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${site.id}&publish_mode=eq.rewrite&published_at=gte.${new Date(Date.now()-4*86400*1000).toISOString()}&select=slug,title,published_at&limit=5`),
        supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${site.id}&select=publish_mode,count()&order=count.desc&limit=10`, null, { 'Prefer': 'count=exact' }),
      ]);
      return Response.json({
        total_rewrites_ever: Array.isArray(allRewrites) ? allRewrites.length : allRewrites,
        rewrites_sample: Array.isArray(allRewrites) ? allRewrites.slice(0, 5) : null,
        rewrites_null_published_at: Array.isArray(nullPub) ? nullPub.length : nullPub,
        rewrites_null_sample: Array.isArray(nullPub) ? nullPub.slice(0, 3) : null,
        rewrites_last_4d: Array.isArray(recent4d) ? recent4d.length : recent4d,
        schema_check: schemaCheck,
      });
    }
    // END TEMP

    // TEMP: proxy-probe — test article URL through Render proxy, same call shape as synthesizeArticle
    if (url.pathname === '/admin/proxy-probe' && request.method === 'GET') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const testUrl = url.searchParams.get('url');
      if (!testUrl) return Response.json({ error: 'url param required' }, { status: 400, headers });
      const PROXY_BASE = 'https://pitchos-proxy.onrender.com';
      const result = { url: testUrl, proxy_status: null, proxy_ok: false, content_length: null, content_preview: null, direct_status: null, direct_body_length: null, error: null };
      try {
        const res = await fetch(PROXY_BASE + '/article?url=' + encodeURIComponent(testUrl), { signal: AbortSignal.timeout(20000) });
        result.proxy_status = res.status;
        result.proxy_ok = res.ok;
        if (res.ok) {
          const data = await res.json();
          result.content_length = data.content?.length ?? 0;
          result.content_preview = (data.content || '').slice(0, 300);
        } else {
          result.error = await res.text().catch(() => '(unreadable)');
        }
      } catch(e) {
        result.error = e.message;
      }
      if (!result.proxy_ok) {
        try {
          const dr = await fetch(testUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kartalix/1.0)' }, signal: AbortSignal.timeout(10000) });
          result.direct_status = dr.status;
          result.direct_body_length = (await dr.text()).length;
        } catch(e) {
          result.direct_status = 'error: ' + e.message;
        }
      }
      return Response.json(result, { headers });
    }
    // END TEMP proxy-probe

    if (url.pathname === '/admin/pool-timeseries' && request.method === 'GET') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const raw = await env.PITCHOS_CACHE.get('pool_ts:BJK').catch(() => null);
      const data = raw ? JSON.parse(raw) : [];
      return Response.json({ data }, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    if (url.pathname === '/admin/alarms/clear' && request.method === 'POST') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const body = await request.json().catch(() => ({}));
      const id = body.id;
      if (!id) return Response.json({ error: 'id required' }, { status: 400 });
      const stateRaw = await env.PITCHOS_CACHE.get('alarms:state').catch(() => null);
      const state = stateRaw ? JSON.parse(stateRaw) : {};
      if (!state.alarm_acked) state.alarm_acked = {};
      state.alarm_acked[id] = Date.now();
      await env.PITCHOS_CACHE.put('alarms:state', JSON.stringify(state), { expirationTtl: 86400 * 7 });
      return Response.json({ ok: true, id });
    }

    if (url.pathname === '/admin/alarms') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const SITE = '2b5cfe49-b69a-4143-8323-ca29fff6502e';
      const now = Date.now();
      const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      const fourHoursAgo = new Date(now - 4 * 60 * 60 * 1000).toISOString();

      const [stateRaw, recentPublished, recentLog] = await Promise.all([
        env.PITCHOS_CACHE.get('alarms:state').catch(() => null),
        supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${SITE}&status=eq.published&published_at=gte.${encodeURIComponent(fourHoursAgo)}&select=id&limit=5`
        ).catch(() => null),
        supabase(env, 'GET',
          `/rest/v1/pipeline_log?site_id=eq.${SITE}&run_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=source_name,run_at&order=run_at.desc&limit=5000`
        ).catch(() => null),
      ]);

      const state = stateRaw ? JSON.parse(stateRaw) : {};
      if (!state.alarm_first_seen) state.alarm_first_seen = {};
      if (!state.alarm_acked) state.alarm_acked = {};

      // Helper: check if alarm is active (fires AND not acked after first_seen)
      const isActive = (id) => {
        const fs = state.alarm_first_seen[id];
        if (!fs) return false;
        const acked = state.alarm_acked[id] || 0;
        return acked < fs;
      };
      // Helper: register alarm as firing (set first_seen if not set), return true if active
      const markFiring = (id) => {
        if (!state.alarm_first_seen[id]) state.alarm_first_seen[id] = now;
        return isActive(id);
      };
      // Helper: alarm condition cleared — reset tracking so it can re-fire next time
      const markCleared = (id) => {
        delete state.alarm_first_seen[id];
        delete state.alarm_acked[id];
      };

      const alarms = [];
      let stateDirty = false;

      // 1. Pool-size floor
      if ((state.pool_floor_consecutive || 0) >= 2) {
        if (markFiring('pool_floor')) {
          alarms.push({
            id: 'pool_floor', category: 'major',
            title: 'Pool-size floor',
            msg: `Article pool has ${state.pool_floor_last} articles (≤ 20 — at minimum floor) for ${state.pool_floor_consecutive} consecutive cron runs`,
            first_seen: state.alarm_first_seen.pool_floor,
          });
        }
        stateDirty = true;
      }

      // 2. Zero-published-in-window (UTC+3 7am–11pm = UTC 04:00–20:00)
      const utcHour = new Date().getUTCHours();
      const isNormalHours = utcHour >= 4 && utcHour < 20;
      if (isNormalHours && Array.isArray(recentPublished) && recentPublished.length === 0) {
        if (markFiring('zero_published')) {
          alarms.push({
            id: 'zero_published', category: 'major',
            title: 'Zero published in 4h',
            msg: 'No articles published in the last 4 hours during normal operating hours (07:00–23:00 local)',
            first_seen: state.alarm_first_seen.zero_published,
          });
        }
        stateDirty = true;
      } else if (state.alarm_first_seen.zero_published) {
        markCleared('zero_published');
        stateDirty = true;
      }

      // 3. Live pool collapse
      if ((state.live_pool_consecutive || 0) >= 2) {
        if (markFiring('live_pool_collapse')) {
          alarms.push({
            id: 'live_pool_collapse', category: 'critical',
            title: 'Live pool collapse',
            msg: `Only ${state.live_pool_last} articles published in last 24h (< 8) for ${state.live_pool_consecutive} consecutive runs`,
            first_seen: state.alarm_first_seen.live_pool_collapse,
          });
        }
        stateDirty = true;
      }

      // 4. Self-heartbeat fail (>15 min; skip if never run yet)
      if (state.heartbeat_last && (now - state.heartbeat_last) > 15 * 60 * 1000) {
        const minsAgo = Math.round((now - state.heartbeat_last) / 60000);
        if (markFiring('heartbeat_fail')) {
          alarms.push({
            id: 'heartbeat_fail', category: 'critical',
            title: 'Self-heartbeat fail',
            msg: `Alarm checker last ran ${minsAgo} min ago (expected every 5 min)`,
            first_seen: state.alarm_first_seen.heartbeat_fail,
          });
        }
        stateDirty = true;
      } else if (state.alarm_first_seen.heartbeat_fail) {
        markCleared('heartbeat_fail');
        stateDirty = true;
      }

      // 5. Source disappeared (0 pipeline entries for 3+ consecutive days)
      if (Array.isArray(recentLog) && recentLog.length > 0) {
        const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
        const srcLatest = {};
        for (const row of recentLog) {
          if (!row.source_name) continue;
          const ts = new Date(row.run_at).getTime();
          if (!srcLatest[row.source_name] || ts > srcLatest[row.source_name]) srcLatest[row.source_name] = ts;
        }
        const gone = Object.entries(srcLatest)
          .filter(([, ts]) => ts < threeDaysAgo)
          .map(([name, ts]) => ({ name, daysAgo: Math.round((now - ts) / 86400000) }))
          .sort((a, b) => b.daysAgo - a.daysAgo);
        if (gone.length > 0) {
          if (markFiring('source_disappeared')) {
            alarms.push({
              id: 'source_disappeared', category: 'major',
              title: `Source disappeared (${gone.length})`,
              msg: gone.slice(0, 5).map(s => `${s.name} (${s.daysAgo}d)`).join(', ') + (gone.length > 5 ? ` +${gone.length - 5} more` : ''),
              first_seen: state.alarm_first_seen.source_disappeared,
            });
          }
          stateDirty = true;
        } else if (state.alarm_first_seen.source_disappeared) {
          markCleared('source_disappeared');
          stateDirty = true;
        }
      }

      // 6. Source test failures (written by daily runSourceTests cron)
      const testFailRaw = await env.PITCHOS_CACHE.get('source_tests:failed').catch(() => null);
      const testFails = testFailRaw ? JSON.parse(testFailRaw) : null;
      if (Array.isArray(testFails) && testFails.length > 0) {
        if (markFiring('source_test_fail')) {
          alarms.push({
            id: 'source_test_fail', category: 'major',
            title: `Source fetch failures (${testFails.length})`,
            msg: testFails.map(s => `${s.name}: ${s.error}`).join('; '),
            first_seen: state.alarm_first_seen.source_test_fail,
          });
        }
        stateDirty = true;
      } else if (testFails !== null && state.alarm_first_seen.source_test_fail) {
        markCleared('source_test_fail');
        stateDirty = true;
      }

      if (stateDirty) {
        env.PITCHOS_CACHE.put('alarms:state', JSON.stringify(state), { expirationTtl: 86400 * 7 }).catch(() => {});
      }

      return Response.json({ alarms, checked_at: now, heartbeat_last: state.heartbeat_last || null },
        { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/admin/analytics-data') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const SITE = '2b5cfe49-b69a-4143-8323-ca29fff6502e';
      const from = url.searchParams.get('from') || new Date(Date.now() - 7*24*3600000).toISOString();
      const to   = url.searchParams.get('to')   || new Date().toISOString();
      const enc  = s => encodeURIComponent(s);
      const [runs, pubItems, storiesRaw, plRows] = await Promise.all([
        supabase(env, 'GET', `/rest/v1/fetch_logs?site_id=eq.${SITE}&created_at=gte.${enc(from)}&created_at=lte.${enc(to)}&order=created_at.asc&limit=500&select=created_at,items_fetched,items_published,estimated_cost_eur,error_message`),
        supabase(env, 'GET', `/rest/v1/content_items?site_id=eq.${SITE}&reviewed_at=gte.${enc(from)}&reviewed_at=lte.${enc(to)}&select=reviewed_at,publish_mode,nvs_score,status&limit=3000&order=reviewed_at.asc`),
        supabase(env, 'GET', `/rest/v1/stories?site_id=eq.${SITE}&created_at=gte.${enc(from)}&created_at=lte.${enc(to)}&select=created_at,state&order=created_at.asc&limit=1000`),
        supabase(env, 'GET', `/rest/v1/pipeline_log?site_id=eq.${SITE}&created_at=gte.${enc(from)}&created_at=lte.${enc(to)}&select=nvs_score,stage,source_name&limit=8000`),
      ]);
      const modeGroup = m => {
        if (!m) return 'other';
        if (m === 'youtube_embed') return 'video';
        if (m === 'synthesis_generated' || m === 'original_synthesis') return 'yz_plus';
        if (m === 'rewrite' || m === 'copy_source') return 'yz';
        if (m && m.startsWith('template_')) return 'template';
        return 'other';
      };
      const runs_ts = (runs || []).map(r => {
        let raw = r.items_fetched || 0, kw = 0;
        try { const d = JSON.parse(r.error_message || '{}'); raw = d.raw_fetched || raw; kw = d.after_keyword || 0; } catch(e) {}
        return { ts: r.created_at, raw, kw, published: r.items_published || 0, cost: r.estimated_cost_eur || 0 };
      });
      const pubByDayMap = {};
      (pubItems || []).filter(a => a.status === 'published').forEach(a => {
        const day = (a.reviewed_at || '').slice(0, 10);
        if (!day) return;
        if (!pubByDayMap[day]) pubByDayMap[day] = { day, video: 0, yz: 0, yz_plus: 0, template: 0, other: 0 };
        pubByDayMap[day][modeGroup(a.publish_mode)]++;
      });
      const pub_by_day = Object.values(pubByDayMap).sort((a, b) => a.day.localeCompare(b.day));
      const storyByDayMap = {};
      (storiesRaw || []).forEach(s => {
        const day = (s.created_at || '').slice(0, 10);
        if (!day) return;
        if (!storyByDayMap[day]) storyByDayMap[day] = { day, opened: 0, closed: 0 };
        storyByDayMap[day].opened++;
        if (s.state === 'archived' || s.state === 'closed') storyByDayMap[day].closed++;
      });
      const story_by_day = Object.values(storyByDayMap).sort((a, b) => a.day.localeCompare(b.day));
      const pubHist = new Array(10).fill(0), rejHist = new Array(10).fill(0);
      (plRows || []).forEach(r => {
        if (r.nvs_score == null) return;
        const bucket = Math.min(9, Math.floor(r.nvs_score / 10));
        if (r.stage === 'published') pubHist[bucket]++;
        else if (r.stage === 'scored_low' || r.stage === 'synthesis_failed') rejHist[bucket]++;
      });
      const nvs_hist = pubHist.map((p, i) => ({ range: (i*10) + '-' + (i*10+9), published: p, rejected: rejHist[i] }));
      const srcQMap = {};
      (plRows || []).forEach(r => {
        const s = r.source_name || 'Unknown';
        if (!srcQMap[s]) srcQMap[s] = { source_name: s, total: 0, published: 0, nvs_sum: 0, nvs_n: 0 };
        srcQMap[s].total++;
        if (r.stage === 'published') { srcQMap[s].published++; if (r.nvs_score != null) { srcQMap[s].nvs_sum += r.nvs_score; srcQMap[s].nvs_n++; } }
      });
      const source_quality = Object.values(srcQMap).map(s => ({
        source_name: s.source_name, total: s.total, published: s.published,
        avg_nvs: s.nvs_n > 0 ? Math.round(s.nvs_sum / s.nvs_n) : 0,
        pub_rate: s.total > 0 ? Math.round(s.published / s.total * 100) : 0,
      })).sort((a, b) => b.total - a.total).slice(0, 20);
      return Response.json({ runs_ts, pub_by_day, story_by_day, nvs_hist, source_quality });
    }

    if (url.pathname === '/admin/tools') {
      const cookie = request.headers.get('cookie') || '';
      const authed = await checkAdminAuth(request, env);
      if (!authed) return new Response(renderPinPage(url.pathname), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      const kvRaw = await env.PITCHOS_CACHE.get('match:BJK:next').catch(() => null);
      const cachedMatch = kvRaw ? JSON.parse(kvRaw) : null;
      const allSites = await getActiveSites(env);
      const currentSite = resolveSite(url, allSites);
      return new Response(renderAdminToolsPage(NEXT_MATCH, cachedMatch, currentSite.short_code, allSites), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/releases') {
      const cookie = request.headers.get('cookie') || '';
      const authed = await checkAdminAuth(request, env);
      if (!authed) return new Response(renderPinPage(url.pathname), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      const allSites = await getActiveSites(env);
      const currentSite = resolveSite(url, allSites);
      return new Response(renderAdminReleasesPage(currentSite.short_code, allSites), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/qa') {
      const cookie = request.headers.get('cookie') || '';
      const authed = await checkAdminAuth(request, env);
      if (!authed) return new Response(renderPinPage(url.pathname), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      const raw = await env.PITCHOS_CACHE.get('qa:results').catch(() => null);
      const saved = raw ? JSON.parse(raw) : {};
      const allSites = await getActiveSites(env);
      const currentSite = resolveSite(url, allSites);
      return new Response(renderAdminQAPage(saved, currentSite.short_code, allSites), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/qa/save' && request.method === 'POST') {
      const cookie = request.headers.get('cookie') || '';
      const authed = await checkAdminAuth(request, env);
      if (!authed) return Response.json({ error: 'unauth' }, { status: 401 });
      const body = await request.json().catch(() => null);
      if (!body) return Response.json({ error: 'bad body' }, { status: 400 });
      await env.PITCHOS_CACHE.put('qa:results', JSON.stringify(body), { expirationTtl: 60 * 60 * 24 * 90 });
      return Response.json({ ok: true });
    }

    if (url.pathname === '/admin/login' && request.method === 'POST') {
      const { pin } = await request.json().catch(() => ({}));
      if (!env.ADMIN_PIN) return Response.json({ error: 'Server misconfigured — ADMIN_PIN secret not set' }, { status: 500 });
      const storedPin = (env.ADMIN_PIN || '').trim();
      if (!pin || pin !== storedPin) return Response.json({ error: 'Hatalı PIN' }, { status: 401 });
      const token = crypto.randomUUID();
      await env.PITCHOS_CACHE.put(`admin:session:${token}`, '1', { expirationTtl: 604800 });
      const resHeaders = new Headers({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      resHeaders.append('Set-Cookie', `kx-session=${token}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`);
      resHeaders.append('Set-Cookie', `kx-ui=1; Path=/; Max-Age=604800; SameSite=Lax`);
      return new Response(JSON.stringify({ ok: true }), { headers: resHeaders });
    }
    if (url.pathname === '/admin') {
      const cookie = request.headers.get('cookie') || '';
      const authed = await checkAdminAuth(request, env);
      if (!authed) {
        return new Response(renderPinPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      }
      const allSites = await getActiveSites(env);
      const currentSite = resolveSite(url, allSites);
      const cached = await env.PITCHOS_CACHE.get(`articles:${currentSite.short_code}`);
      const articles = cached ? JSON.parse(cached) : [];
      return new Response(renderAdminPage(articles, currentSite.short_code, allSites), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // ── CONTENT CMS ──────────────────────────────────────────────
    if (url.pathname === '/admin/content') {
      const allSites = await getActiveSites(env);
      const currentSite = resolveSite(url, allSites);
      return new Response(renderContentPage(currentSite.short_code, allSites), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/source-stats') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = resolveSite(url, sites);
      if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });
      const hours = parseInt(url.searchParams.get('hours') || '24');
      const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const sourceName = url.searchParams.get('source') || '';
      let filter = `site_id=eq.${site.id}&fetched_at=gte.${since}&order=fetched_at.desc&limit=200`;
      if (sourceName) filter += `&source_name=eq.${encodeURIComponent(sourceName)}`;
      const rows = await supabase(env, 'GET',
        `/rest/v1/content_items?${filter}&select=title,source_name,nvs_score,publish_mode,fetched_at,original_url`
      ) || [];
      const bySource = {};
      for (const r of rows) {
        const s = r.source_name || 'unknown';
        if (!bySource[s]) bySource[s] = [];
        bySource[s].push({ title: r.title, nvs: r.nvs_score, mode: r.publish_mode, fetched_at: r.fetched_at, url: r.original_url });
      }
      const summary = Object.entries(bySource)
        .sort((a,b) => b[1].length - a[1].length)
        .map(([source, articles]) => ({ source, count: articles.length, articles }));
      return Response.json({ hours, total: rows.length, by_source: summary }, { headers: h });
    }
    if (url.pathname === '/admin/content-counts') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site = resolveSite(url, sites);
      if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });
      const countFor = async (filter) => {
        const res = await fetch(`${env.SUPABASE_URL}/rest/v1/content_items?${filter}&select=id&limit=1`, {
          headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Prefer': 'count=exact' }
        });
        const m = res.headers.get('Content-Range')?.match(/\/(\d+)$/);
        return m ? parseInt(m[1]) : 0;
      };
      const base = `site_id=eq.${site.id}`;
      const [published, pending, archived, deleted] = await Promise.all([
        countFor(`${base}&status=eq.published`),
        countFor(`${base}&status=eq.pending`),
        countFor(`${base}&status=eq.archived`),
        countFor(`${base}&status=eq.deleted`),
      ]);
      const kv = await env.PITCHOS_CACHE.get('articles:BJK');
      const live = kv ? JSON.parse(kv).length : 0;
      const yayinda = Math.max(0, published - live);
      return Response.json({ live, yayinda, pending, archived, deleted }, { headers: h });
    }

    if (url.pathname === '/admin/content-data') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = resolveSite(url, sites);
      if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });
      const page  = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
      const limit = 20;
      const offset = (page - 1) * limit;
      const q       = (url.searchParams.get('q') || '').trim();
      const mode    = url.searchParams.get('mode') || '';
      const nr      = url.searchParams.get('needs_review') === '1';
      const live    = url.searchParams.get('live') === '1';
      const yayinda = url.searchParams.get('yayinda') === '1';
      const status  = url.searchParams.get('status') || '';
      const nvs     = url.searchParams.get('nvs') || '';
      const timelineRaw = await env.PITCHOS_CACHE.get(`kv:timeline:${site.short_code || 'BJK'}`);
      const timeline = timelineRaw ? JSON.parse(timelineRaw) : {};
      const applyTimeline = (articles) => articles.map(a => {
        const t = a.slug ? timeline[a.slug] : null;
        if (!t) return a;
        return { ...a, homepage_published_at: t.published_at || null, homepage_removed_at: t.removed_at || null };
      });
      let filter  = `site_id=eq.${site.id}&order=fetched_at.desc&limit=${limit}&offset=${offset}`;
      if (mode === 'yz')          filter += '&publish_mode=in.(rewrite,synthesis)';
      else if (mode === 'yz_plus')filter += '&publish_mode=in.(original_synthesis,synthesis_generated)';
      else if (mode === 'template')filter += '&publish_mode=like.template%';
      else if (mode === 'video')  filter += '&or=(publish_mode.like.youtube*,publish_mode.eq.video_embed)';
      else if (mode === 'manual') filter += '&publish_mode=eq.manual';
      else if (mode === 'copy_source') filter += '&publish_mode=eq.copy_source';
      else if (mode === 'rss_summary') filter += '&publish_mode=eq.rss_summary';
      else if (mode === 'synthesis') filter += '&publish_mode=in.(rewrite,synthesis)'; // legacy
      else if (mode === 'youtube')   filter += '&publish_mode=like.youtube%';          // legacy
      if (nr) filter += '&needs_review=eq.true';
      if (q)  filter += `&title=ilike.*${encodeURIComponent(q)}*`;
      if (['published','pending','archived','deleted'].includes(status)) filter += `&status=eq.${status}`;
      if (nvs === 'hi')  filter += '&nvs_score=gte.75';
      else if (nvs === 'mid') filter += '&nvs_score=gte.60&nvs_score=lt.75';
      else if (nvs === 'lo')  filter += '&nvs_score=lt.60';

      if (live) {
        // KV-first: merge all KV articles with Supabase data. KV-only articles get _kv_only:true.
        const kv = await env.PITCHOS_CACHE.get('articles:BJK');
        const kvArticles = kv ? JSON.parse(kv) : [];
        const kvSlugs = kvArticles.map(a => a.slug).filter(Boolean);
        if (!kvSlugs.length) return Response.json({ articles: [], page, has_more: false }, { headers: h });
        const dbRows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${site.id}&slug=in.(${kvSlugs.join(',')})&select=id,slug,title,summary,full_body,category,publish_mode,nvs_score,needs_review,fetched_at,image_url,source_name,status,template_id`
        );
        const dbBySlug = new Map((dbRows || []).map(r => [r.slug, r]));
        // KV fields (scoring, entry) spread first; Supabase editorial fields overlay
        let merged = kvArticles
          .filter(a => a.slug)
          .map(a => {
            const db = dbBySlug.get(a.slug);
            return db
              ? { ...a, ...db }
              : { ...a, id: null, needs_review: false, status: 'published', _kv_only: true };
          });
        // Load scoring config and compute P13 fields server-side
        const scoringConfig = await loadSiteConfig(env, site.short_code || 'BJK').catch(() => null);
        const nowMs = Date.now();
        merged = merged.map(a => {
          const halfLifeVal = getHalfLife(a, scoringConfig);
          const scoreNow = computeScore(a, scoringConfig, nowMs);
          const nvs = getEffectiveNVS(a, scoringConfig);
          const trust = getTrustMultiplier(a, scoringConfig);
          // Exit ETA
          let exitEta = '—';
          if (a.template_id === 'T05') {
            exitEta = 'Pinned';
          } else if (halfLifeVal === null) {
            exitEta = 'Pinned';
          } else {
            const ts = a.fetched_at || a.published_at || a.created_at;
            const currentAgeHours = ts ? (nowMs - new Date(ts).getTime()) / 3600000 : 0;
            const FLOOR = 5;
            const ratio = (nvs * trust) / FLOOR;
            if (ratio <= 1) {
              exitEta = '≤floor';
            } else {
              const ageAtFloor = halfLifeVal * Math.log(ratio);
              let naturalHours = ageAtFloor - currentAgeHours;
              const tid = a.template_id;
              const hardTtl = tid ? (HARD_TTL_BY_TEMPLATE[tid] || null) : (HARD_TTL_BY_MODE[a.publish_mode] || null);
              let binding = '';
              if (hardTtl && (hardTtl - currentAgeHours < naturalHours)) {
                naturalHours = hardTtl - currentAgeHours;
                binding = ' TTL';
              }
              if (naturalHours <= 0) exitEta = 'imminent';
              else if (naturalHours < 1) exitEta = `~${Math.round(naturalHours * 60)}m${binding}`;
              else exitEta = `~${Math.round(naturalHours)}h${binding}`;
            }
          }
          return { ...a,
            _score_now: scoreNow !== null ? Math.round(scoreNow * 10) / 10 : null,
            _score_entry: a.entry_rank_score != null ? Math.round(a.entry_rank_score * 10) / 10 : null,
            _nvs_eff: Math.round(nvs),
            _half_life: halfLifeVal,
            _exit_eta: exitEta,
            _kv_entered_at: a.kv_entered_at || null,
            _current_rank: a.current_rank != null ? Math.round(a.current_rank * 10) / 10 : null,
          };
        });
        // Sort by current_rank DESC (nulls last)
        merged.sort((a, b) => (b._current_rank ?? -1) - (a._current_rank ?? -1));
        if (q) { const ql = q.toLowerCase(); merged = merged.filter(a => (a.title||'').toLowerCase().includes(ql)); }
        if (mode === 'yz')           merged = merged.filter(a => ['rewrite','synthesis'].includes(a.publish_mode));
        else if (mode === 'yz_plus') merged = merged.filter(a => ['original_synthesis','synthesis_generated'].includes(a.publish_mode));
        else if (mode === 'template') merged = merged.filter(a => (a.publish_mode||'').startsWith('template'));
        else if (mode === 'video')   merged = merged.filter(a => (a.publish_mode||'').startsWith('youtube') || a.publish_mode === 'video_embed');
        else if (mode === 'manual')  merged = merged.filter(a => a.publish_mode === 'manual');
        else if (mode === 'copy_source') merged = merged.filter(a => a.publish_mode === 'copy_source');
        else if (mode === 'rss_summary') merged = merged.filter(a => a.publish_mode === 'rss_summary');
        if (nvs === 'hi')        merged = merged.filter(a => (a.nvs_score||0) >= 75);
        else if (nvs === 'mid')  merged = merged.filter(a => { const n = a.nvs_score||0; return n >= 60 && n < 75; });
        else if (nvs === 'lo')   merged = merged.filter(a => (a.nvs_score||0) < 60);
        const paged = applyTimeline(merged.slice(offset, offset + limit));
        return Response.json({ articles: paged, page, has_more: merged.length > offset + limit }, { headers: h });
      }

      if (yayinda) {
        // Published in Supabase but NOT in KV (accessible by URL, not on homepage)
        const kvRaw = await env.PITCHOS_CACHE.get('articles:BJK');
        const kvSlugs = kvRaw ? JSON.parse(kvRaw).map(a => a.slug).filter(Boolean) : [];
        const notIn = kvSlugs.length > 0 ? `&slug=not.in.(${kvSlugs.join(',')})` : '';
        let yFilter = `site_id=eq.${site.id}&status=eq.published&order=fetched_at.desc&limit=${limit}&offset=${offset}${notIn}`;
        if (mode === 'yz')           yFilter += '&publish_mode=in.(rewrite,synthesis)';
        else if (mode === 'yz_plus') yFilter += '&publish_mode=in.(original_synthesis,synthesis_generated)';
        else if (mode === 'template') yFilter += '&publish_mode=like.template%';
        else if (mode === 'video')   yFilter += '&or=(publish_mode.like.youtube*,publish_mode.eq.video_embed)';
        else if (mode === 'manual')  yFilter += '&publish_mode=eq.manual';
        else if (mode === 'copy_source') yFilter += '&publish_mode=eq.copy_source';
        else if (mode === 'rss_summary') yFilter += '&publish_mode=eq.rss_summary';
        if (nvs === 'hi')       yFilter += '&nvs_score=gte.75';
        else if (nvs === 'mid') yFilter += '&nvs_score=gte.60&nvs_score=lt.75';
        else if (nvs === 'lo')  yFilter += '&nvs_score=lt.60';
        if (q) yFilter += `&title=ilike.*${encodeURIComponent(q)}*`;
        const rows = await supabase(env, 'GET',
          `/rest/v1/content_items?${yFilter}&select=id,slug,title,summary,full_body,category,publish_mode,nvs_score,needs_review,fetched_at,image_url,source_name,status,template_id`
        );
        return Response.json({ articles: applyTimeline(rows || []), page, has_more: (rows || []).length === limit }, { headers: h });
      }

      const rows = await supabase(env, 'GET',
        `/rest/v1/content_items?${filter}&select=id,slug,title,summary,full_body,category,publish_mode,nvs_score,needs_review,fetched_at,image_url,source_name,status,template_id`
      );
      return Response.json({ articles: applyTimeline(rows || []), page, has_more: (rows || []).length === limit }, { headers: h });
    }

    if (url.pathname === '/admin/content-save' && request.method === 'POST') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = sites?.[0];
      if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });
      const { slug, title, summary, full_body, category, image_url, status, is_new, kv_only } = await request.json();
      if (!title?.trim()) return Response.json({ error: 'title required' }, { status: 400, headers: h });

      if (is_new || kv_only) {
        const now     = new Date().toISOString();
        const newSlug = (kv_only && slug) ? slug : generateSlug(title, now);
        const newRow  = {
          site_id: site.id, title: title.trim(), summary: summary || '',
          full_body: full_body || '', category: category || 'Haber',
          image_url: image_url || '', source_type: 'kartalix', source_name: 'Kartalix',
          publish_mode: 'manual', status: 'published', nvs_score: 75,
          content_type: 'fact', sport: 'football', original_url: '',
          reviewed_by: 'admin', slug: newSlug,
          fetched_at: now, published_at: now, reviewed_at: now,
        };
        const inserted = await supabase(env, 'POST', '/rest/v1/content_items', [newRow]);
        if (!inserted) return Response.json({ error: 'Supabase insert failed' }, { status: 500, headers: h });
        const kv2 = await env.PITCHOS_CACHE.get('articles:BJK');
        if (kv2) {
          const arts = JSON.parse(kv2);
          if (kv_only) {
            // Article already in KV — update in-place so publish_mode becomes 'manual'
            const patched = arts.map(a => a.slug === newSlug
              ? { ...a, title: newRow.title, summary: newRow.summary, full_body: newRow.full_body,
                  category: newRow.category, image_url: newRow.image_url, publish_mode: 'manual', is_kartalix_content: true }
              : a);
            await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(patched), { expirationTtl: 43200 });
          } else {
            arts.unshift({ title: newRow.title, summary: newRow.summary, full_body: newRow.full_body,
              source: 'Kartalix', source_name: 'Kartalix', category: newRow.category,
              published_at: now, nvs: 75, slug: newSlug, image_url: newRow.image_url || '',
              publish_mode: 'manual', is_kartalix_content: true });
            await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(arts), { expirationTtl: 43200 });
          }
        }
        return Response.json({ ok: true, slug: newSlug, is_new: !kv_only }, { headers: h });
      }

      const newStatus = status === 'pending' ? 'pending' : 'published';
      await supabase(env, 'PATCH', `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}`, {
        title: title.trim(), summary: summary || '',
        full_body: full_body || '', category: category || 'Haber',
        image_url: image_url || '', source_name: 'Kartalix', source_type: 'kartalix',
        status: newStatus, needs_review: false, reviewed_at: new Date().toISOString(),
      });
      // Update KV in-place. If promoted to published, article joins the feed; if set to pending, remove it.
      const kv = await env.PITCHOS_CACHE.get('articles:BJK');
      if (kv) {
        let arts = JSON.parse(kv);
        const existing = arts.find(a => a.slug === slug);
        if (newStatus === 'published') {
          if (existing) {
            arts = arts.map(a => a.slug === slug
              ? { ...a, title: title.trim(), summary: summary || '', full_body: full_body || '', category: category || 'Haber', image_url: image_url || '' }
              : a);
          } else {
            // Article was pending (not in KV) — promote it into the feed
            const row = await supabase(env, 'GET', `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`);
            const r = row?.[0];
            if (r) {
              arts.unshift({ title: r.title, summary: r.summary || '', full_body: r.full_body || r.summary || '',
                source: r.source_name || 'Kartalix', source_name: r.source_name || 'Kartalix',
                category: r.category || 'Haber', published_at: r.published_at || new Date().toISOString(),
                nvs: r.nvs_score || 0, slug: r.slug, image_url: r.image_url || '',
                publish_mode: r.publish_mode || 'manual', is_kartalix_content: r.source_type === 'kartalix' });
              arts = arts.slice(0, 100);
            }
          }
        } else {
          // Demoted to pending — remove from public feed
          arts = arts.filter(a => a.slug !== slug);
        }
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(arts), { expirationTtl: 43200 });
      }
      return Response.json({ ok: true, slug }, { headers: h });
    }

    if (url.pathname === '/admin/content-publish' && request.method === 'POST') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const cookie = request.headers.get('cookie') || '';
      const authed = await checkAdminAuth(request, env);
      if (!authed) return Response.json({ error: 'unauthorized' }, { status: 401, headers: h });
      const { slug } = await request.json();
      if (!slug) return Response.json({ error: 'slug required' }, { status: 400, headers: h });
      await supabase(env, 'PATCH', `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}`, {
        status: 'published', needs_review: false, reviewed_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
      });
      const kv = await env.PITCHOS_CACHE.get('articles:BJK');
      if (kv) {
        let arts = JSON.parse(kv);
        if (!arts.find(a => a.slug === slug)) {
          const row = await supabase(env, 'GET', `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`);
          const r = row?.[0];
          if (r) {
            arts.unshift({ title: r.title, summary: r.summary || '', full_body: r.full_body || r.summary || '',
              source: r.source_name || 'Kartalix', source_name: r.source_name || 'Kartalix',
              category: r.category || 'Haber', published_at: new Date().toISOString(),
              nvs: r.nvs_score || 0, slug: r.slug, image_url: r.image_url || '',
              publish_mode: r.publish_mode || 'manual', is_kartalix_content: r.source_type === 'kartalix' });
            await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(arts), { expirationTtl: 43200 });
          }
        }
      }
      return Response.json({ ok: true, slug }, { headers: h });
    }

    if (url.pathname === '/admin/content-delete' && request.method === 'POST') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = sites?.[0];
      if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });
      const { slug } = await request.json();
      if (!slug) return Response.json({ error: 'slug required' }, { status: 400, headers: h });
      await supabase(env, 'DELETE', `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}&site_id=eq.${site.id}`);
      const kv = await env.PITCHOS_CACHE.get('articles:BJK');
      if (kv) {
        const arts = JSON.parse(kv).filter(a => a.slug !== slug);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(arts), { expirationTtl: 43200 });
      }
      return Response.json({ ok: true }, { headers: h });
    }

    if (url.pathname === '/admin/content-archive' && request.method === 'POST') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = sites?.[0];
      if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });
      const { slug } = await request.json();
      if (!slug) return Response.json({ error: 'slug required' }, { status: 400, headers: h });
      await supabase(env, 'PATCH', `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}&site_id=eq.${site.id}`,
        { status: 'archived' });
      const kv = await env.PITCHOS_CACHE.get('articles:BJK');
      if (kv) {
        const arts = JSON.parse(kv).filter(a => a.slug !== slug);
        await env.PITCHOS_CACHE.put('articles:BJK', JSON.stringify(arts), { expirationTtl: 43200 });
      }
      return Response.json({ ok: true }, { headers: h });
    }

    if (url.pathname === '/admin/curated-video') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const authed = await checkAdminAuth(request, env);
      if (!authed) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: h });

      const validSections = new Set(Object.keys(_VH_ALL_SECTION_MAP));
      const allSites = await getActiveSites(env);
      const currentSite = resolveSite(url, allSites);

      if (request.method === 'GET') {
        const [list, orderRaw] = await Promise.all([
          supabase(env, 'GET',
            `/rest/v1/content_items?select=slug,title,source_name,published_at,image_url,category,original_url&site_id=eq.${currentSite.id}&publish_mode=eq.youtube_embed&category=in.(${Object.keys(_VH_ALL_SECTION_MAP).join(',')})&status=eq.published&order=published_at.desc&limit=200`
          ),
          env.PITCHOS_CACHE.get('curated:order'),
        ]);
        const items = list || [];
        if (orderRaw) {
          const orderMap = Object.fromEntries(JSON.parse(orderRaw).map((s, i) => [s, i]));
          items.sort((a, b) => (orderMap[a.slug] ?? 99999) - (orderMap[b.slug] ?? 99999));
        }
        return new Response(renderCuratedVideoPage(items, currentSite.short_code, allSites), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
      }

      if (request.method === 'PUT') {
        const { order } = await request.json().catch(() => ({}));
        if (!Array.isArray(order)) return Response.json({ error: 'order array required' }, { status: 400, headers: h });
        await env.PITCHOS_CACHE.put('curated:order', JSON.stringify(order));
        return Response.json({ ok: true }, { headers: h });
      }

      if (request.method === 'POST') {
        const { youtube_url, section, title: bodyTitle } = await request.json().catch(() => ({}));
        if (!youtube_url || !section) return Response.json({ error: 'youtube_url and section required' }, { status: 400, headers: h });
        if (!validSections.has(section)) return Response.json({ error: `section must be one of: ${[...validSections].join(', ')}` }, { status: 400, headers: h });
        const vidMatch = youtube_url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
        const videoId = vidMatch?.[1];
        if (!videoId) return Response.json({ error: 'could not extract YouTube video ID' }, { status: 400, headers: h });
        let title = bodyTitle;
        let sourceName = 'YouTube';
        if (!title) {
          const oembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`).then(r => r.ok ? r.json() : null).catch(() => null);
          title = oembed?.title || videoId;
          sourceName = oembed?.author_name || 'YouTube';
        }
        const slug = generateSlug(title, null);
        const now = new Date().toISOString();
        const secDef = _VH_ALL_SECTION_MAP[section];
        const saved = await supabase(env, 'POST', '/rest/v1/content_items', [{
          site_id: currentSite.id, source_type: 'youtube', source_name: sourceName,
          original_url: `https://www.youtube.com/watch?v=${videoId}`,
          title, summary: title, full_body: title,
          image_url: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          category: secDef.category, content_type: 'youtube_embed', sport: 'football',
          nvs_score: 75, publish_mode: 'youtube_embed', status: 'published',
          template_id: 'T-VID', slug, published_at: now, reviewed_at: now,
          reviewed_by: 'admin', video_type: secDef.video_type,
        }]);
        if (!saved?.[0]) return Response.json({ error: 'Supabase insert failed' }, { status: 500, headers: h });
        return Response.json({ ok: true, slug: saved[0].slug }, { headers: h });
      }

      if (request.method === 'PATCH') {
        const { slug, section, title } = await request.json().catch(() => ({}));
        if (!slug) return Response.json({ error: 'slug required' }, { status: 400, headers: h });
        const patch = {};
        if (section) {
          if (!validSections.has(section)) return Response.json({ error: 'invalid section' }, { status: 400, headers: h });
          const secDef = _VH_ALL_SECTION_MAP[section];
          patch.category = secDef.category;
          patch.video_type = secDef.video_type;
        }
        if (title) patch.title = title;
        if (!Object.keys(patch).length) return Response.json({ error: 'nothing to update' }, { status: 400, headers: h });
        await supabase(env, 'PATCH', `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}&site_id=eq.${currentSite.id}`, patch);
        return Response.json({ ok: true }, { headers: h });
      }

      if (request.method === 'DELETE') {
        const { slug } = await request.json().catch(() => ({}));
        if (!slug) return Response.json({ error: 'slug required' }, { status: 400, headers: h });
        await supabase(env, 'PATCH', `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}&site_id=eq.${currentSite.id}`, { status: 'archived' });
        return Response.json({ ok: true }, { headers: h });
      }

      return Response.json({ error: 'method not allowed' }, { status: 405, headers: h });
    }

    if (url.pathname === '/admin/live-slugs' && request.method === 'GET') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const kv = await env.PITCHOS_CACHE.get('articles:BJK');
      const slugs = kv ? JSON.parse(kv).map(a => a.slug).filter(Boolean) : [];
      return new Response(JSON.stringify(slugs), { headers: h });
    }

    if (url.pathname === '/admin/test-templates' && request.method === 'GET') {
      const allSites = await getActiveSites(env);
      const currentSite = resolveSite(url, allSites);
      return new Response(renderTestTemplatesPage(currentSite.short_code, allSites), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    if (url.pathname === '/admin/test-templates/recent-fixtures' && request.method === 'GET') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const fixtures = await getLastFixtures(env, 8);
        return Response.json({ fixtures: fixtures.filter(f => f.is_finished) }, { headers: h });
      } catch(e) {
        return Response.json({ error: e.message }, { status: 500, headers: h });
      }
    }

    if (url.pathname === '/admin/test-templates/fixture-events' && request.method === 'GET') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const fid = parseInt(url.searchParams.get('fixture_id') || '0');
      if (!fid) return Response.json({ error: 'fixture_id required' }, { status: 400, headers: h });
      try {
        const events = await fetchAllEvents(fid, env);
        const grouped = {
          goals:    events.filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty' && e.detail !== 'Own Goal'),
          own_goals: events.filter(e => e.type === 'Goal' && e.detail === 'Own Goal'),
          missed_pens: events.filter(e => e.type === 'Goal' && e.detail === 'Missed Penalty'),
          red_cards: events.filter(e => e.type === 'Card' && (e.detail === 'Red Card' || e.detail === 'Yellow Red Card')),
          var_events: events.filter(e => e.type === 'Var'),
          all: events,
        };
        return Response.json({ events: grouped }, { headers: h });
      } catch(e) {
        return Response.json({ error: e.message }, { status: 500, headers: h });
      }
    }

    if (url.pathname === '/admin/test-templates' && request.method === 'POST') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const { template, fixture_id, event_data } = await request.json();
      const sites = await getActiveSites(env);
      const site  = sites?.[0];
      if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });

      const fid = fixture_id || NEXT_MATCH.fixture_id;

      // Use the actual selected fixture's data instead of NEXT_MATCH / next-from-API
      let nextMatch = NEXT_MATCH;
      try {
        const apiFixture = await getFixture(fid, env);
        if (apiFixture) {
          const coords = await resolveVenueCoords(apiFixture.venue, apiFixture.venue_city);
          nextMatch = {
            ...NEXT_MATCH,
            ...apiFixture,
            match_day:      apiFixture.date,
            opponent_short: apiFixture.opponent?.split(' ')[0] || apiFixture.opponent,
            venue_lat:      coords?.lat ?? NEXT_MATCH.venue_lat,
            venue_lon:      coords?.lon ?? NEXT_MATCH.venue_lon,
            tv:             NEXT_MATCH.tv,
          };
        }
      } catch(e) {}

      let card = null;
      try {
        if (template === 'T01') {
          const [h2h, weather, table] = await Promise.all([
            nextMatch.opponent_id ? getH2H(nextMatch.opponent_id, env) : Promise.resolve([]),
            getMatchWeather(nextMatch.venue_lat, nextMatch.venue_lon),
            getStandings(env),
          ]);
          card = await generateMatchPreview(nextMatch, h2h, weather, buildStandingsContext(table), site, env);

        } else if (template === 'T02') {
          const h2h = nextMatch.opponent_id ? await getH2H(nextMatch.opponent_id, env) : [];
          if (!h2h || h2h.length < 2) return Response.json({ error: `H2H verisi yetersiz (${h2h?.length ?? 0} maç)` }, { headers: h });
          card = await generateH2HHistory(nextMatch, h2h, site, env);

        } else if (template === 'T03') {
          const [recent, table] = await Promise.all([getLastFixtures(env, 5), getStandings(env)]);
          const bjkRow = table ? table.find(r => r.team?.id === 549) : null;
          card = await generateFormGuide(nextMatch, recent, bjkRow, site, env);

        } else if (template === 'T05') {
          const injuries = await getInjuries(env, fid).catch(() => []);
          card = await generateMatchDayCard(nextMatch, [], site, env, injuries);

        } else if (template === 'T07') {
          const injuries = await getInjuries(env, fid).catch(() => []);
          card = await generateInjuryReport(nextMatch, injuries, [], site, env);

        } else if (template === 'T08b') {
          card = await generateMuhtemel11(nextMatch, [], site, env);

        } else if (template === 'T08c') {
          const [bjkLast, oppLast, injuries] = await Promise.all([
            getBJKLastLineupData(env).catch(() => null),
            nextMatch.opponent_id ? getOpponentLastLineup(nextMatch.opponent_id, env).catch(() => null) : Promise.resolve(null),
            getInjuries(env, fid).catch(() => []),
          ]);
          card = await generateLineupCard(nextMatch, bjkLast, oppLast, injuries, [], site, env);

        } else if (template === 'T09') {
          const lineup = await getFixtureLineup(fid, env).catch(() => null);
          if (!lineup) return Response.json({ error: 'Bu maç için kadro henüz açıklanmamış' }, { headers: h });
          card = await generateConfirmedLineup(nextMatch, lineup, site, env);

        } else if (template === 'T-REF') {
          const referee = nextMatch.referee;
          if (!referee) return Response.json({ error: 'Bu maç için hakem bilgisi yok' }, { headers: h });
          const recentFixtures = await getLastFixtures(env, 10).catch(() => []);
          const refMatches = recentFixtures.filter(f => f.referee === referee);
          const refStats = refMatches.length > 0 ? {
            bjk_games:  refMatches.length,
            bjk_wins:   refMatches.filter(f => f.score_bjk > f.score_opp).length,
            bjk_draws:  refMatches.filter(f => f.score_bjk === f.score_opp).length,
            bjk_losses: refMatches.filter(f => f.score_bjk < f.score_opp).length,
          } : null;
          card = await generateRefereeProfile(nextMatch, referee, refStats, site, env);

        } else if (template === 'T10') {
          const allEvents = await fetchAllEvents(fid, env);
          const goals = allEvents.filter(e => e.type === 'Goal' && e.detail !== 'Missed Penalty' && e.detail !== 'Own Goal');
          const ev = event_data || goals[goals.length - 1] || { type: 'Goal', detail: 'Normal Goal', time: { elapsed: 35 }, player: { name: 'Test Oyuncu' }, team: { id: 549 } };
          const mockMatch = { ...nextMatch, score_bjk: event_data?.score_bjk ?? 1, score_opp: event_data?.score_opp ?? 0 };
          card = await generateGoalFlash(mockMatch, ev, site, env);

        } else if (template === 'T11') {
          const [players, events] = await Promise.all([
            getFixturePlayers(fid, env).catch(() => []),
            getFixtureEvents(fid, env).catch(() => []),
          ]);
          card = await generateResultFlash(nextMatch, players, site, env, events);

        } else if (template === 'T12') {
          const [players, stats, events] = await Promise.all([
            getFixturePlayers(fid, env).catch(() => []),
            getFixtureStats(fid, env).catch(() => null),
            getFixtureEvents(fid, env).catch(() => []),
          ]);
          card = await generateMatchReport(nextMatch, players, stats, site, env, events);

        } else if (template === 'T13') {
          const players = await getFixturePlayers(fid, env).catch(() => []);
          card = await generateManOfTheMatch(nextMatch, players, site, env);

        } else if (template === 'T-XG') {
          const stats = await getFixtureStats(fid, env).catch(() => null);
          const stubStats = stats || { xg: '1.4', possession: '55%', shots_total: 18, shots_on_target: 8 };
          card = await generateXGDelta(nextMatch, stubStats, site, env);

        } else if (template === 'T-HT') {
          const allEvents = await fetchAllEvents(fid, env);
          const mockMatch = { ...nextMatch, score_bjk: event_data?.score_bjk ?? 1, score_opp: event_data?.score_opp ?? 0 };
          card = await generateHalftimeReport(mockMatch, allEvents, site, env);

        } else if (template === 'T-RED') {
          const ev = event_data || { type: 'Card', detail: 'Red Card', time: { elapsed: 55 }, player: { name: 'Test Oyuncu' }, team: { id: 549 } };
          const mockMatch = { ...nextMatch, score_bjk: ev.score_bjk ?? 1, score_opp: ev.score_opp ?? 0 };
          card = await generateRedCardFlash(mockMatch, ev, site, env);

        } else if (template === 'T-VAR') {
          const ev = event_data || { type: 'Var', detail: 'Goal cancelled', time: { elapsed: 67 }, player: { name: 'Test Oyuncu' }, comments: 'Offside' };
          const mockMatch = { ...nextMatch, score_bjk: ev.score_bjk ?? 1, score_opp: ev.score_opp ?? 1 };
          card = await generateVARFlash(mockMatch, ev, site, env);

        } else if (template === 'T-PEN') {
          const ev = event_data || { type: 'Goal', detail: 'Missed Penalty', time: { elapsed: 80 }, player: { name: 'Test Oyuncu' }, team: { id: 549 } };
          const mockMatch = { ...nextMatch, score_bjk: ev.score_bjk ?? 0, score_opp: ev.score_opp ?? 0 };
          card = await generateMissedPenaltyFlash(mockMatch, ev, site, env);

        } else {
          return Response.json({ error: `Unknown template: ${template}` }, { headers: h });
        }
      } catch(e) {
        return Response.json({ error: e.message }, { status: 500, headers: h });
      }

      if (!card) return Response.json({ error: 'Generator returned null (missing data or Claude failure)' }, { headers: h });
      const articleForRender = {
        title: card.title, full_body: card.full_body || '', summary: card.summary || '',
        source: 'Kartalix', category: 'Match', published_at: card.published_at || new Date().toISOString(),
        nvs: card.nvs_score || 85, url: '#', slug: card.slug, publish_mode: card.publish_mode,
        is_kartalix_content: true, template_id: card.template_id,
      };
      const html = renderArticleHTML(articleForRender, env.API_FOOTBALL_KEY || '', null);
      return Response.json({ ok: true, title: card.title, body: card.full_body, template_id: card.template_id, slug: card.slug, html }, { headers: h });
    }

    if (url.pathname === '/admin/pipeline-failures') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      if (request.method === 'GET') {
        const failures = JSON.parse(await env.PITCHOS_CACHE.get(FAILURES_KEY) || '[]');
        return new Response(JSON.stringify({ failures }), { headers: h });
      }
      if (request.method === 'DELETE') {
        await env.PITCHOS_CACHE.delete(FAILURES_KEY);
        return new Response(JSON.stringify({ ok: true }), { headers: h });
      }
    }

    if (url.pathname === '/admin/rewrite-queue') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const siteCode = url.searchParams.get('site') || 'BJK';
      const raw = await env.PITCHOS_CACHE.get(`rewrite:queue:${siteCode}`);
      const queue = raw ? JSON.parse(raw) : [];
      return Response.json({ site: siteCode, count: queue.length, queue: queue.slice(0, 50) }, { headers: h });
    }

    if (url.pathname === '/admin/seed-kv' && request.method === 'POST') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = sites?.[0];
      if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });
      const GOOD_MODES = ['rewrite','copy_source','template_matchday','template_postmatch','template_lineup','template_h2h','template_form_guide','template_injury','template_official','youtube_embed','synthesis_generated','manual','original_synthesis','video_embed'];
      const dbRows = await supabase(env, 'GET',
        `/rest/v1/content_items?site_id=eq.${site.id}&status=eq.published&publish_mode=in.(${GOOD_MODES.join(',')})&order=published_at.desc&limit=100&select=slug,title,summary,full_body,category,source_name,source_type,original_url,nvs_score,golden_score,publish_mode,published_at,fetched_at,created_at,template_id,sport`);
      if (!Array.isArray(dbRows) || dbRows.length === 0) {
        return Response.json({ seeded: 0, message: 'No published articles with known modes in DB' }, { headers: h });
      }
      const kvArticles = dbRows.filter(r => r.slug && (r.full_body || r.summary)).map(r => toKVShape({
        title:               r.title        || '',
        summary:             r.summary      || '',
        full_body:           r.full_body    || r.summary || '',
        source_name:         r.source_name  || '',
        source:              r.source_name  || '',
        url:                 r.original_url || '',
        original_url:        r.original_url || '',
        category:            r.category     || 'Haber',
        nvs:                 r.nvs_score    || 0,
        golden_score:        r.golden_score || null,
        published_at:        r.published_at || r.created_at || r.fetched_at,
        fetched_at:          r.created_at   || r.fetched_at,
        is_fresh:            false,
        is_kartalix_content: r.source_type === 'kartalix',
        publish_mode:        r.publish_mode || 'rss_summary',
        slug:                r.slug,
        template_id:         r.template_id  || null,
        sport:               r.sport        || 'football',
      }));
      await cacheToKV(env, site.short_code, kvArticles);
      return Response.json({ seeded: kvArticles.length }, { headers: h });
    }

    if (url.pathname === '/admin/seed-voice' && request.method === 'POST') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const added = await seedVoiceRules(env);
      return Response.json({ ok: true, added }, { headers: h });
    }

    if (url.pathname === '/admin/run-voice-patterns' && request.method === 'POST') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        await runVoicePatternExtraction(env);
        const raw = await env.PITCHOS_CACHE.get('editorial:voice_patterns').catch(() => null);
        const patterns = raw ? JSON.parse(raw) : [];
        return Response.json({ ok: true, total: patterns.length }, { headers: h });
      } catch(e) {
        return Response.json({ error: e.message }, { status: 500, headers: h });
      }
    }

    if (url.pathname === '/admin/voice-patterns' && request.method === 'GET') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const raw = await env.PITCHOS_CACHE.get('editorial:voice_patterns').catch(() => null);
      const patterns = raw ? JSON.parse(raw) : [];
      return Response.json({ count: patterns.length, patterns }, { headers: h });
    }

    // GET: show cached + live next match; POST: force-refresh from API and update KV
    if (url.pathname === '/admin/next-match') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      if (request.method === 'POST') {
        try {
          const fixture = await getNextFixture(env);
          if (!fixture) return Response.json({ error: 'API returned no fixture' }, { status: 404, headers: h });
          const coords = await resolveVenueCoords(fixture.venue, fixture.venue_city);
          const nextMatch = {
            home: fixture.home, team: 'Beşiktaş', team_short: 'BJK',
            opponent: fixture.opponent, opponent_short: fixture.opponent,
            opponent_id: fixture.opponent_id, league: fixture.league,
            week: parseInt((fixture.round || '').match(/(\d+)/)?.[1] || '0') || NEXT_MATCH.week,
            date: fixture.date, time: fixture.time,
            venue: fixture.venue || NEXT_MATCH.venue, venue_city: fixture.venue_city || NEXT_MATCH.venue_city,
            venue_lat: coords.lat, venue_lon: coords.lon,
            tv: NEXT_MATCH.tv, match_day: fixture.date, cup: null,
            fixture_id: fixture.fixture_id,
            referee: fixture.referee || null,
          };
          await env.PITCHOS_CACHE.put('match:BJK:next', JSON.stringify(nextMatch), { expirationTtl: 7 * 24 * 3600 });
          return Response.json({ ok: true, source: 'api', match: nextMatch }, { headers: h });
        } catch(e) {
          return Response.json({ error: e.message }, { status: 500, headers: h });
        }
      }
      // GET
      const kvRaw = await env.PITCHOS_CACHE.get('match:BJK:next').catch(() => null);
      const kvMatch = kvRaw ? JSON.parse(kvRaw) : null;
      return Response.json({ hardcoded: NEXT_MATCH, cached: kvMatch, using: kvMatch || NEXT_MATCH }, { headers: h });
    }

    // Archive pre-firewall/rss_summary articles — run once to clean DB
    if (url.pathname === '/admin/archive-legacy' && request.method === 'POST') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        // Count first
        const preview = url.searchParams.get('preview') === '1';
        const sites = await getActiveSites(env);
        const site = sites?.[0];
        if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });
        const countRes = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${site.id}&status=eq.published&or=(publish_mode.is.null,publish_mode.eq.rss_summary,publish_mode.eq.pre_firewall_cleaned)&select=id&limit=1000`);
        const ids = (countRes || []).map(r => r.id);
        if (preview || !ids.length) {
          return Response.json({ preview: true, count: ids.length, message: preview ? 'Add ?preview=0 to execute' : 'Nothing to archive' }, { headers: h });
        }
        // Archive in batches of 100
        let archived = 0;
        for (let i = 0; i < ids.length; i += 100) {
          const batch = ids.slice(i, i + 100);
          await supabase(env, 'PATCH',
            `/rest/v1/content_items?id=in.(${batch.join(',')})`,
            { status: 'archived' });
          archived += batch.length;
        }
        return Response.json({ ok: true, archived }, { headers: h });
      } catch(e) {
        return Response.json({ error: e.message }, { status: 500, headers: h });
      }
    }

    if (url.pathname === '/admin/sync-kv-to-db' && request.method === 'POST') {
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = sites?.[0];
      if (!site) return Response.json({ error: 'no site' }, { status: 500, headers: h });
      const kv = await env.PITCHOS_CACHE.get('articles:BJK');
      const kvArticles = kv ? JSON.parse(kv) : [];
      const kvSlugs = kvArticles.map(a => a.slug).filter(Boolean);
      if (!kvSlugs.length) return Response.json({ synced: 0, message: 'KV is empty' }, { headers: h });
      const dbRows = await supabase(env, 'GET',
        `/rest/v1/content_items?site_id=eq.${site.id}&slug=in.(${kvSlugs.join(',')})&select=slug`);
      const dbSlugs = new Set((dbRows || []).map(r => r.slug));
      const kvOnly = kvArticles.filter(a => a.slug && !dbSlugs.has(a.slug));
      if (!kvOnly.length) return Response.json({ synced: 0, message: 'All KV articles already in DB' }, { headers: h });
      const now = new Date().toISOString();
      const rows = kvOnly.map(a => ({
        site_id: site.id, slug: a.slug, title: a.title || '', summary: a.summary || '',
        full_body: a.full_body || '', category: a.category || 'Haber',
        source_type: a.is_kartalix_content ? 'kartalix' : 'rss',
        source_name: a.source_name || a.source || 'Kartalix',
        publish_mode: a.publish_mode || 'rss_summary', status: 'published',
        nvs_score: a.nvs || a.nvs_score || 50, content_type: 'fact',
        sport: a.sport || 'football', original_url: a.url || a.original_url || '',
        image_url: a.image_url || '', template_id: a.template_id || null,
        published_at: a.published_at || now, fetched_at: a.published_at || now, reviewed_at: now, reviewed_by: 'sync_kv_to_db',
      }));
      await supabase(env, 'POST', '/rest/v1/content_items', rows);
      return Response.json({ synced: kvOnly.length, slugs: kvOnly.map(a => a.slug) }, { headers: h });
    }

    if (url.pathname === '/admin/backfill-published-at' && request.method === 'POST') {
      const authErr = await requireOps(request, env); if (authErr) return authErr;
      const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      const sites = await getActiveSites(env);
      const site  = sites?.[0];
      if (!site) return Response.json({ error: 'no active site' }, { status: 500, headers: h });
      const nullRows = await supabase(env, 'GET',
        `/rest/v1/content_items?site_id=eq.${site.id}&published_at=is.null&select=id,fetched_at,created_at&limit=1000`
      );
      if (!nullRows?.length) return Response.json({ updated: 0, message: 'no null rows' }, { headers: h });
      let updated = 0;
      const CHUNK = 50;
      for (let i = 0; i < nullRows.length; i += CHUNK) {
        await Promise.all(nullRows.slice(i, i + CHUNK).map(r =>
          supabase(env, 'PATCH', `/rest/v1/content_items?id=eq.${r.id}`,
            { published_at: r.fetched_at || r.created_at },
            { 'Prefer': 'return=minimal' }
          ).then(() => { updated++; }).catch(() => {})
        ));
      }
      return Response.json({ updated, total_null: nullRows.length }, { headers: h });
    }

    if (url.pathname === '/admin/migrate-pipeline-log' && request.method === 'POST') {
      if (request.headers.get('X-Migration-Key') !== 'plv-2026-05-19') return new Response('Unauthorized', { status: 401 });
      const h = { 'Content-Type': 'application/json' };
      try {
        const sql = [
          'ALTER TABLE pipeline_log ADD COLUMN IF NOT EXISTS trust_tier TEXT',
          'ALTER TABLE pipeline_log ADD COLUMN IF NOT EXISTS source_body_len INTEGER',
          'ALTER TABLE pipeline_log ADD COLUMN IF NOT EXISTS drop_detail TEXT',
        ];
        const results = [];
        const projectRef = env.SUPABASE_URL.replace('https://','').split('.')[0];
        for (const q of sql) {
          const r = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` },
            body: JSON.stringify({ query: q }),
          });
          const txt = await r.text();
          results.push({ q, status: r.status, body: txt.slice(0, 200) });
        }
        return Response.json({ ok: true, results }, { headers: h });
      } catch(e) { return Response.json({ ok: false, error: e.message }, { status: 500, headers: h }); }
    }

    if (url.pathname === '/rss') {
      return serveRSSFeed(env);
    }
    if (url.pathname === '/sitemap.xml') {
      return serveSitemap(env);
    }
    if (url.pathname === '/hakkimizda' || url.pathname === '/hakkimizda/') {
      return new Response(renderAboutPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=86400' } });
    }
    if (url.pathname === '/iletisim' || url.pathname === '/iletisim/') {
      return new Response(renderContactPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=86400' } });
    }
    if (url.pathname === '/gizlilik' || url.pathname === '/gizlilik/') {
      return new Response(renderPrivacyPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=86400' } });
    }
    if (url.pathname === '/kosullar' || url.pathname === '/kosullar/') {
      return new Response(renderTermsPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=86400' } });
    }
    if (url.pathname === '/kaynak-atif' || url.pathname === '/kaynak-atif/') {
      return new Response(renderAttributionPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=86400' } });
    }
    if (url.pathname === '/editoryal-politika' || url.pathname === '/editoryal-politika/') {
      return new Response(renderEditorialPolicyPage(), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=86400' } });
    }
    if (url.pathname === '/konu/videolar' || url.pathname === '/konu/videolar/') {
      const tip = url.searchParams.get('tip') || '';
      return new Response(await renderVideoHubPage(tip, env), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=300' } });
    }
    if (url.pathname.startsWith('/konu/')) {
      const topicSlug = url.pathname.replace('/konu/', '').replace(/\/$/, '').toLowerCase();
      return new Response(renderTopicPage(topicSlug), { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public,max-age=300' } });
    }
    if (url.pathname.startsWith('/haber/')) {
      const slug = url.pathname.replace('/haber/', '').replace(/\/$/, '');
      return serveArticlePage(slug, env, ctx);
    }

    return new Response('Kartalix Fetch Agent — OK', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    const cron = event.cron;
    if (cron === '*/5 * * * *') {
      // During a live match, also run the article pipeline every 5 min (30-min lookback).
      // URL dedup in getSeenUrls ensures already-processed articles are skipped.
      const liveRaw = await env.PITCHOS_CACHE.get('match:BJK:live').catch(() => null);
      const liveState = liveRaw ? JSON.parse(liveRaw) : null;
      const isMatchLive = liveState?.fixture_id && !liveState.result_published;
      const runRequested = await env.PITCHOS_CACHE.get('run:requested').catch(() => null);
      if (runRequested) await env.PITCHOS_CACHE.delete('run:requested').catch(() => {});
      const work = [matchWatcher(env), runAlarmChecks(env)];
      if (isMatchLive) {
        work.push(runAllSites(env, ctx, { cronExpr: '*/5 * * * *', lookbackMs: 30 * 60 * 1000 }));
      } else if (runRequested) {
        work.push(runAllSites(env, ctx, { forceRun: true }));
      }
      ctx.waitUntil(Promise.all(work));
    } else if (cron === '0 4 * * *') {
      ctx.waitUntil(Promise.all([runDailyArchival(env), runSourceTests(env)]));
    } else if (cron === '0 3 * * 1') {
      ctx.waitUntil(redistillEditorialNotes(env));
    } else if (cron === '0 2 * * 0') {
      ctx.waitUntil(runVoicePatternExtraction(env));
    } else {
      ctx.waitUntil(runAllSites(env, ctx, { cronExpr: event.cron }));
    }
  },
};

// ─── ALARM CHECKS ─────────────────────────────────────────────
async function runAlarmChecks(env) {
  const SITE = '2b5cfe49-b69a-4143-8323-ca29fff6502e';
  const now = Date.now();
  try {
    const stateRaw = await env.PITCHOS_CACHE.get('alarms:state').catch(() => null);
    const state = stateRaw ? JSON.parse(stateRaw) : {};
    if (!state.alarm_first_seen) state.alarm_first_seen = {};
    if (!state.alarm_acked) state.alarm_acked = {};

    // 1. Pool-size floor (articles:BJK)
    const kvRaw = await env.PITCHOS_CACHE.get('articles:BJK').catch(() => null);
    const poolArr = kvRaw ? JSON.parse(kvRaw) : [];
    const poolSize = Array.isArray(poolArr) ? poolArr.length : 0;
    if (poolSize <= 20) {
      state.pool_floor_consecutive = (state.pool_floor_consecutive || 0) + 1;
      if (state.pool_floor_consecutive >= 2 && !state.alarm_first_seen.pool_floor)
        state.alarm_first_seen.pool_floor = now;
    } else {
      if (state.pool_floor_consecutive >= 2) {
        delete state.alarm_first_seen.pool_floor;
        delete state.alarm_acked.pool_floor;
      }
      state.pool_floor_consecutive = 0;
    }
    state.pool_floor_last = poolSize;

    // Daily pool snapshot for KPI strip 14d trend (write once per day)
    const todayDate = new Date(now).toISOString().slice(0, 10);
    const snapshotKey = `pool_snapshot:BJK:${todayDate}`;
    const existingSnap = await env.PITCHOS_CACHE.get(snapshotKey).catch(() => null);
    if (!existingSnap) {
      await env.PITCHOS_CACHE.put(snapshotKey, String(poolSize), { expirationTtl: 86400 * 16 }).catch(() => {});
    }

    // 2. Live pool collapse (published in last 24h)
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const liveRows = await supabase(env, 'GET',
      `/rest/v1/content_items?site_id=eq.${SITE}&status=eq.published&published_at=gte.${encodeURIComponent(oneDayAgo)}&select=id&limit=20`
    ).catch(() => null);
    if (Array.isArray(liveRows)) {
      const liveSize = liveRows.length;
      if (liveSize < 8) {
        state.live_pool_consecutive = (state.live_pool_consecutive || 0) + 1;
        if (state.live_pool_consecutive >= 2 && !state.alarm_first_seen.live_pool_collapse)
          state.alarm_first_seen.live_pool_collapse = now;
      } else {
        if (state.live_pool_consecutive >= 2) {
          delete state.alarm_first_seen.live_pool_collapse;
          delete state.alarm_acked.live_pool_collapse;
        }
        state.live_pool_consecutive = 0;
      }
      state.live_pool_last = liveSize;
    }

    // 3. Self-heartbeat timestamp
    state.heartbeat_last = now;

    await env.PITCHOS_CACHE.put('alarms:state', JSON.stringify(state), { expirationTtl: 86400 * 7 });
  } catch (e) {
    console.log('runAlarmChecks error:', e.message);
  }
}

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
    const failures = [];
    for (const src of sources) {
      const result = await testSourceConfig(src, env);
      await env.PITCHOS_CACHE.put(`source_test:${src.id}`, JSON.stringify({
        ...result, tested_at: new Date().toISOString(),
      }), { expirationTtl: 86400 * 3 });
      if (result.ok) { passed++; } else { failed++; failures.push({ id: src.id, name: src.name, error: result.error || 'unknown' }); }
    }
    await env.PITCHOS_CACHE.put('source_tests:failed', JSON.stringify(failures), { expirationTtl: 86400 * 3 });
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

// ─── VOICE RULES SEED ────────────────────────────────────────
// One-time bootstrap: writes Turkish sports voice rules into editorial:notes KV.
// Called via POST /admin/seed-voice or automatically from redistill when KV is empty.
// Each rule is idempotent — won't add duplicates if voice rules already exist.
async function seedVoiceRules(env) {
  const existing = await listEditorialNotes(env);
  if (existing.some(n => n.text.includes('Kartallar') || n.text.includes('rival_pov'))) {
    return 0; // already seeded
  }

  const VOICE_RULES = [
    { scope: 'global', text: 'Beşiktaş için "Kartallar", "Siyah-Beyazlılar", "Kara Kartallar" ifadelerini kullan. Aynı haber içinde her zaman "Beşiktaş" tekrarlama — çeşitlilik sağla.' },
    { scope: 'global', text: 'Haber tarafsız değil, tutkulu Beşiktaş taraftarının bakış açısından yazılmalı. Gurur, hayal kırıklığı, umut, kızgınlık duygularını doğal biçimde yansıt.' },
    { scope: 'global', text: 'YASAK AI kalıpları: "It is worth noting", "Certainly", "Furthermore", "Kayda değer", "Öte yandan belirtmek gerekir ki", "Sonuç olarak", "Önemle vurgulamak gerekir". Bunları hiçbir zaman kullanma.' },
    { scope: 'global', text: 'Başlıklar doğrudan ve çarpıcı olmalı. Pasif yapıdan kaçın: "3 puan alındı" değil, "Kartallar 3 puanı kaptı". Eylem fiilleri kullan.' },
    { scope: 'global', text: 'Klişelerden kaçın: "kritik viraj", "zorlu maraton", "hayati önem taşıyan" gibi aşınmış spor gazeteciliği kalıplarını kullanma.' },
    { scope: 'global', text: 'Rakip takımların perspektifinden yazma (rival_pov=true içerikler). Galatasaray, Fenerbahçe haberleri Beşiktaş açısından frame et veya hiç yazma.' },
    { scope: 'global', text: 'Türkçe dilbilgisi: apostroflu ekleri doğru yaz — "Beşiktaş\'ın", "Kartallar\'ın", "İstanbul\'da". Yabancı oyuncu isimlerini Türkçe okunuşuna göre çekimle.' },
    { scope: 'transfer', text: 'Transfer haberlerinde kaynak güvenilirliğini belirt: resmi açıklama için doğrudan, yakın kaynak için "güvenilir kaynaklara göre", dedikodu için "iddialar" veya "rivayetler".' },
    { scope: 'transfer', text: 'Transfer spekülasyonunu gerçekmiş gibi sunma. "İddia edildiğine göre" veya "Transfer.Iddiaları" çerçevesi kullan.' },
    { scope: 'T09', text: 'İlk 11 haberi duyuru formatında olmalı: önce kaleci, sonra defans, orta saha, forvet sıralamasıyla listele. Antrenörün sistemini kısaca yorumla.' },
    { scope: 'T10', text: 'Gol haberi heyecanlı ve ani olmalı. "GOL!" veya "NET!" ile aç. İlk cümle: kimin attığı, kaçıncı dakikada, skoru ver.' },
    { scope: 'T11', text: 'Maç sonu haberini skorla aç: "Beşiktaş X-Y [Rakip]". İkinci cümlede maçın öyküsü. Üçüncüde puan durumu veya anlam.' },
    { scope: 'T12', text: 'Maç raporu objektif ama Beşiktaş odaklı. xG ve istatistikleri bağlam içinde yorumla — sadece sayıları sıralama.' },
  ];

  const now = new Date().toISOString();
  const newNotes = VOICE_RULES.map(r => ({
    id: crypto.randomUUID(),
    scope: r.scope,
    text: r.text,
    active: true,
    created_at: now,
  }));

  const all = [...newNotes, ...existing];
  await env.PITCHOS_CACHE.put('editorial:notes', JSON.stringify(all));
  console.log(`SEED-VOICE: added ${newNotes.length} voice rules`);
  return newNotes.length;
}

// ─── WEEKLY EDITORIAL NOTES RE-DISTILL ───────────────────────
// Runs every Monday 03:00. Reads all current notes, sends to Claude Sonnet
// to merge overlaps and remove redundancies, then replaces the full set.
async function redistillEditorialNotes(env) {
  const notes = await listEditorialNotes(env);
  const refs  = await getReferenceArticles(env);
  if (notes.length < 3) {
    console.log('REDISTILL: fewer than 3 notes — seeding voice rules first');
    await seedVoiceRules(env);
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

// ─── VOICE PATTERN EXTRACTION (Slice 3.9 Phase 2) ────────────
// Runs every Sunday 02:00. Picks top 10 recently published synthesis articles,
// extracts style DNA via Haiku (rhythm, idioms, emotional vocab — not content),
// stores in editorial:voice_patterns KV for injection into future generation prompts.
async function runVoicePatternExtraction(env) {
  console.log('VOICE-PATTERNS: starting weekly style extraction');

  // Get top synthesis articles from the last 14 days
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const sites = await getActiveSites(env);
  const site  = sites?.[0];
  if (!site) { console.log('VOICE-PATTERNS: no site, skipping'); return; }

  const articles = await supabase(env, 'GET',
    `/rest/v1/content_items?site_id=eq.${site.id}&publish_mode=in.(synthesis,kartalix)&status=eq.published&fetched_at=gte.${since}&nvs_score=gte.70&order=nvs_score.desc&limit=10&select=id,title,full_body,nvs_score`
  ) || [];

  if (articles.length < 3) {
    console.log(`VOICE-PATTERNS: only ${articles.length} articles, skipping (need ≥3)`);
    return;
  }

  // Load existing patterns to avoid re-processing the same article
  const existingRaw = await env.PITCHOS_CACHE.get('editorial:voice_patterns').catch(() => null);
  const existing = existingRaw ? JSON.parse(existingRaw) : [];

  const newPatterns = [];
  for (const article of articles.slice(0, 8)) {
    const body = (article.full_body || '').slice(0, 2000);
    if (body.length < 200) continue;

    const prompt = `Aşağıdaki Türkçe spor haberi metnini analiz et. SADECE yazım üslubunu ve dil ritmini çıkar — içerik değil.

METİN:
${body}

Şunu döndür (JSON):
{
  "style_observations": "3-4 cümle: bu metnin ritmi, cümle yapısı, duygusal tonu, idiom kullanımı hakkında",
  "example_sentences": "metinden en karakteristik 2 cümle — yazım tarzını en iyi yansıtanlar (virgülle ayır)"
}

Sadece JSON döndür.`;

    try {
      const res = await callClaude(env, MODEL_FETCH, prompt, false, 400);
      const text = extractText(res.content);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.example_sentences) continue;

      newPatterns.push({
        id: crypto.randomUUID(),
        article_id: article.id,
        source: article.title?.slice(0, 80) || 'synthesis',
        style_observations: parsed.style_observations || '',
        example_sentences: parsed.example_sentences,
        weight: Math.min(2, Math.max(0.5, (article.nvs_score || 70) / 70)),
        created_at: new Date().toISOString(),
      });
    } catch(e) {
      console.error(`VOICE-PATTERNS: extraction failed for article ${article.id}:`, e.message);
    }
  }

  if (newPatterns.length === 0) {
    console.log('VOICE-PATTERNS: no new patterns extracted');
    return;
  }

  // Merge with existing, cap at 30 patterns (drop oldest/lowest weight)
  const merged = [...newPatterns, ...existing]
    .sort((a, b) => (b.weight || 1) - (a.weight || 1))
    .slice(0, 30);

  await env.PITCHOS_CACHE.put('editorial:voice_patterns', JSON.stringify(merged), { expirationTtl: 90 * 24 * 3600 });
  console.log(`VOICE-PATTERNS: ${newPatterns.length} new patterns extracted, ${merged.length} total in library`);
}

// ─── ORCHESTRATOR ────────────────────────────────────────────
async function runAllSites(env, ctx, opts = {}) {
  // Quiet period: 00:00–06:30 Istanbul (UTC+3) — no RSS runs overnight
  // Bypassed when called manually via /run (forceRun: true)
  if (!opts.forceRun) {
    const now = new Date();
    const istMin = ((now.getUTCHours() + 3) % 24) * 60 + now.getUTCMinutes();
    if (istMin < 390) { // 390 = 06:30 in minutes
      const hh = String(Math.floor(istMin / 60)).padStart(2, '0');
      const mm = String(istMin % 60).padStart(2, '0');
      console.log(`QUIET PERIOD: ${hh}:${mm} Istanbul — skipping RSS run`);
      return { processed: 0, skipped: 'quiet_period' };
    }
  }

  const { blocked: capBlocked, current: capCurrent, cap: capLimit } = await checkCostCap(env);
  if (capBlocked) {
    console.warn(`COST CAP REACHED: $${capCurrent.toFixed(4)} >= $${capLimit.toFixed(2)} — RSS run skipped`);
    return { processed: 0, skipped: 'cost_cap' };
  }

  // Minimum 8h to cover quiet-period gap (00:00–06:30 IST = up to 7.5h no runs).
  // Live-match runs pass opts.lookbackMs directly to skip the 8h floor.
  const lookbackMs = opts.lookbackMs != null
    ? opts.lookbackMs
    : opts.cronExpr
      ? Math.max(3 * cronToIntervalMs(opts.cronExpr), 8 * 60 * 60 * 1000)
      : 24 * 60 * 60 * 1000;
  console.log(`LOOKBACK: ${Math.round(lookbackMs / 3600000 * 10) / 10}h (cron: ${opts.cronExpr || 'manual'}${opts.lookbackMs != null ? ' live-mode' : ''})`);

  const sites = await getActiveSites(env);
  console.log('Sites found:', JSON.stringify(sites));
  if (!sites || sites.length === 0) {
    return { processed: 0, error: 'No active sites found in Supabase' };
  }
  const results = [];
  for (const site of sites) {
    try {
      const result = await processSite(site, env, ctx, lookbackMs);
      results.push({ site: site.short_code, ...result });
    } catch (err) {
      console.error(`Failed site ${site.short_code}:`, err);
      results.push({ site: site.short_code, error: err.message });
      await logFetch(env, site.id, 'failed', {}, err.message);
    }

    // Drain rewrite queue — runs after main pipeline on each hourly tick
    try {
      const drained = await drainRewriteQueue(site, env);
      if (drained?.length) {
        const { saved } = await saveArticles(env, site.id, drained, 'published');
        if (saved.length) {
          const existing = await getCachedArticles(env, site.short_code);
          await cacheToKV(env, site.short_code, [...saved.map(a => toKVShape({ ...a, nvs: a.nvs_score || a.nvs || 0, is_kartalix_content: true })), ...existing]);
          console.log(`REWRITE DRAIN: saved ${saved.length} articles to DB+KV for ${site.short_code}`);
        }
      }
    } catch(e) { console.error(`Drain failed for ${site?.short_code}:`, e.message); }
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

// ─── VENUE COORDINATES MAP (Süper Lig 2025/26) ───────────────
// API-Football returns venue.name but no lat/lon. This map covers all
// current Süper Lig grounds; keyed by the name API-Football returns.
const VENUE_COORDS = {
  // Beşiktaş
  'Tüpraş Stadyumu':                  { lat: 41.0443, lon: 29.0083 },
  'BJK Tüpraş Stadyumu':              { lat: 41.0443, lon: 29.0083 },
  'Vodafone Park':                    { lat: 41.0443, lon: 29.0083 },
  // Galatasaray
  'Rams Park':                        { lat: 41.1043, lon: 28.9330 },
  'RAMS Park':                        { lat: 41.1043, lon: 28.9330 },
  'Türk Telekom Stadyumu':            { lat: 41.1043, lon: 28.9330 },
  // Fenerbahçe
  'Ülker Stadyumu':                   { lat: 40.9928, lon: 29.0544 },
  'Şükrü Saracoğlu Stadyumu':         { lat: 40.9928, lon: 29.0544 },
  // Trabzonspor
  'Papara Park':                      { lat: 40.9995, lon: 39.7267 },
  'Medical Park Trabzon Stadyumu':    { lat: 40.9995, lon: 39.7267 },
  // Başakşehir
  'Başakşehir Fatih Terim Stadyumu':  { lat: 41.0934, lon: 28.8024 },
  'Fatih Terim Stadyumu':             { lat: 41.0934, lon: 28.8024 },
  // Gaziantep
  'Kalyon Stadyumu':                  { lat: 37.0662, lon: 37.3833 },
  'Gaziantep Stadyumu':               { lat: 37.0662, lon: 37.3833 },
  // Antalyaspor
  'Antalya Stadyumu':                 { lat: 36.8676, lon: 30.7060 },
  // Konyaspor
  'Konya Büyükşehir Stadyumu':        { lat: 37.8711, lon: 32.4847 },
  // Sivasspor
  'Yeni 4 Eylül Stadyumu':            { lat: 39.7477, lon: 37.0173 },
  '4 Eylül Stadyumu':                 { lat: 39.7477, lon: 37.0173 },
  // Alanyaspor
  'Bahçeşehir Okul Stadyumu':         { lat: 36.5440, lon: 32.0187 },
  // Adana Demirspor
  'Yeni Adana Stadyumu':              { lat: 36.9915, lon: 35.3294 },
  // Kasımpaşa
  'Recep Tayyip Erdoğan Stadyumu':    { lat: 41.0523, lon: 28.9528 },
  'Nef Stadyumu':                     { lat: 41.0523, lon: 28.9528 },
  // Kayserispor
  'Kadir Has Stadyumu':               { lat: 38.6912, lon: 35.4847 },
  // Samsunspor
  'Yeni Samsun Stadyumu':             { lat: 41.2780, lon: 36.3364 },
  // Rizespor
  'Çaykur Didi Stadyumu':             { lat: 41.0276, lon: 40.5218 },
  // Ankaragücü
  'Eryaman Stadyumu':                 { lat: 39.8950, lon: 32.7380 },
  // Hatayspor (currently using Atatürk in Mersin post-earthquake)
  'Mersin Stadyumu':                  { lat: 36.7994, lon: 34.6156 },
  'Atatürk Stadyumu':                 { lat: 36.2028, lon: 36.1637 },
  // Göztepe
  'Gürsel Aksel Stadyumu':            { lat: 38.4278, lon: 27.1505 },
  // Eyüpspor
  'Eyüp Stadyumu':                    { lat: 41.0503, lon: 28.9327 },
  // Bodrum FK
  'Bodrum İlçe Stadyumu':             { lat: 37.0343, lon: 27.4305 },
};

// Sync map lookup — returns null if venue is unknown (don't fake coords).
function getVenueCoords(venueName) {
  if (!venueName) return null;
  if (VENUE_COORDS[venueName]) return VENUE_COORDS[venueName];
  const lower = venueName.toLowerCase();
  const found = Object.entries(VENUE_COORDS).find(([k]) => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()));
  return found ? found[1] : null;
}

// Async fallback: geocode venue_city via Open-Meteo (free, no auth).
// Used when venue name isn't in the static map (European away, cup, promoted teams).
async function geocodeCity(city) {
  if (!city) return null;
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data.results?.[0];
    if (r?.latitude && r?.longitude) return { lat: r.latitude, lon: r.longitude };
  } catch(e) { console.error('geocodeCity failed:', e.message); }
  return null;
}

// Resolves coords for a fixture: static map → city geocode → null (weather skipped).
async function resolveVenueCoords(venueName, venueCity) {
  return getVenueCoords(venueName) ?? await geocodeCity(venueCity);
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
// Uses fetchAllEvents + code filter instead of ?type=Goal query param,
// which the API silently ignores/returns empty for live matches.
async function fetchGoalEvents(fixtureId, env) {
  const all = await fetchAllEvents(fixtureId, env);
  return all.filter(e =>
    e.type === 'Goal' &&
    e.detail !== 'Missed Penalty' &&
    e.team?.id === 549
  );
}

// ─── ALL EVENTS (for Sprint A: T-HT, T-RED, T-VAR, T-PEN + own goals → T10) ──
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
// Explicit property whitelist — internal pipeline fields (_siblings, _facts, _used_sibling_source,
// _rank, etc.) are automatically excluded and never written to KV.
const toKVShape = a => ({
  title:               a.title        || '',
  summary:             a.summary      || a.description || '',
  full_body:           a.full_body && a.full_body.length > 300
    ? (a.is_template ? a.full_body : sanitizeBodyHtml(a.full_body).slice(0, 8000))
    : (a.summary || a.description || ''),
  source:              a.source       || a.source_name || '',
  source_name:         a.source_name  || a.source || '',
  source_emoji:        a.source_emoji || '',
  source_url:          a.url          || a.original_url || '',
  url:                 a.url          || a.original_url || '',
  category:            a.category     || 'Haber',
  nvs:                 a.nvs          || a.nvs_score   || 0,
  trust_score:         a.trust_score  || tierToTrustScore(a.trust_tier || a.trust),
  trust_tier:          a.trust_tier   || null,
  golden_score:        a.golden_score || null,
  published_at:        a.published_at || a.fetched_at  || new Date().toISOString(),
  fetched_at:          a.fetched_at   || null,
  is_fresh:            a.is_fresh     ?? true,
  is_kartalix_content: a.is_kartalix_content || false,
  is_p4:               isP4(a),
  sport:               a.sport        || 'football',
  publish_mode:        a.publish_mode || 'rss_summary',
  image_url:           a.image_url    || '',
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
  // the pre-match window, then to KV-cached next match, then to NEXT_MATCH hardcoded config.
  const cachedNextRaw = await env.PITCHOS_CACHE.get('match:BJK:next').catch(() => null);
  let nextMatch = cachedNextRaw ? JSON.parse(cachedNextRaw) : NEXT_MATCH;
  let knownLiveFixture = null; // set if already live — avoids double getLiveFixture call

  try {
    const live = await getLiveFixture(env);
    if (live) {
      knownLiveFixture = live;
      nextMatch = {
        ...nextMatch,
        home:        live.home,
        opponent:    live.opponent,
        opponent_id: live.opponent_id,
        league:      live.league,
        date:        live.date,
        time:        live.time,
        venue:       live.venue       || nextMatch.venue,
        venue_city:  live.venue_city  || nextMatch.venue_city,
        match_day:   live.date,
        fixture_id:  live.fixture_id,
        referee:     live.referee     || null,
      };
    } else {
      const fixture = await getNextFixture(env);
      if (fixture) {
        // Only adopt the upcoming fixture if it's within the pre-match window (≤ 3h).
        // If it's further away (e.g. getNextFixture returned next week's match because
        // tonight's match just kicked off), stick with KV/hardcoded fallback.
        const upcomingKickoff = new Date(`${fixture.date}T${fixture.time}:00+03:00`);
        const hrsAway = (upcomingKickoff - new Date()) / (1000 * 60 * 60);
        if (hrsAway <= 3) {
          nextMatch = {
            ...nextMatch,
            home:        fixture.home,
            opponent:    fixture.opponent,
            opponent_id: fixture.opponent_id,
            league:      fixture.league,
            date:        fixture.date,
            time:        fixture.time,
            venue:       fixture.venue       || nextMatch.venue,
            venue_city:  fixture.venue_city  || nextMatch.venue_city,
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

  // ── Post-match catch-up ───────────────────────────────────────
  // getLiveFixture only returns matches currently in-progress. Once a match
  // ends (FT), it drops off the live endpoint and the main watcher window
  // exits immediately (hoursToKickoff < -2). We check KV for any tracked
  // fixture that finished but hasn't had its post-match suite generated yet.
  if (hoursToKickoff > 3 || hoursToKickoff < -2) {
    try {
      const savedLiveRaw = await env.PITCHOS_CACHE.get('match:BJK:live');
      const savedLive    = savedLiveRaw ? JSON.parse(savedLiveRaw) : null;
      if (savedLive?.fixture_id && !savedLive.result_published) {
        const finished = await getFixture(savedLive.fixture_id, env);
        if (finished?.is_finished) {
          console.log(`WATCHER post-match catch-up: fixture ${savedLive.fixture_id} is FT, running T11/T12/T13/T-XG`);
          const { blocked } = await checkCostCap(env);
          if (!blocked) {
            const sites = await getActiveSites(env);
            const site  = sites?.[0];
            if (site) {
              const matchObj = { ...NEXT_MATCH, ...finished, match_day: finished.date };
              const [players, stats, events] = await Promise.all([
                getFixturePlayers(savedLive.fixture_id, env).catch(() => []),
                getFixtureStats(savedLive.fixture_id, env).catch(() => null),
                getFixtureEvents(savedLive.fixture_id, env).catch(() => []),
              ]);
              const _fid = savedLive.fixture_id;
              const t11 = await generateResultFlash(matchObj, players, site, env, events).catch(() => null);
              if (t11) {
                const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                const kv  = raw ? JSON.parse(raw) : [];
                await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...t11, nvs: t11.nvs_score || 88, is_kartalix_content: true, is_template: true, fixture_id: _fid }), ...kv], 300));
                console.log('WATCHER CATCH-UP KV WRITE T11: done');
              }
              const t13 = await generateManOfTheMatch(matchObj, players, site, env).catch(() => null);
              if (t13) {
                const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                const kv  = raw ? JSON.parse(raw) : [];
                await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...t13, nvs: t13.nvs_score || 80, is_kartalix_content: true, is_template: true, fixture_id: _fid }), ...kv], 300));
                console.log('WATCHER CATCH-UP KV WRITE T13: done');
              }
              const t12 = await generateMatchReport(matchObj, players, stats, site, env, events).catch(() => null);
              if (t12) {
                const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                const kv  = raw ? JSON.parse(raw) : [];
                await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...t12, nvs: t12.nvs_score || 85, is_kartalix_content: true, is_template: true, fixture_id: _fid }), ...kv], 300));
                console.log('WATCHER CATCH-UP KV WRITE T12: done');
              }
              if (stats?.xg != null && Math.abs((finished.score_bjk ?? 0) - parseFloat(stats.xg)) > 1.2) {
                const txg = await generateXGDelta(matchObj, stats, site, env).catch(() => null);
                if (txg) {
                  const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const kv  = raw ? JSON.parse(raw) : [];
                  await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...txg, nvs: txg.nvs_score || 78, is_kartalix_content: true, is_template: true, fixture_id: _fid }), ...kv], 300));
                  console.log('WATCHER CATCH-UP KV WRITE T-XG: done');
                }
              }
              // Mark done so we don't re-run on next tick
              await env.PITCHOS_CACHE.put('match:BJK:live', JSON.stringify({ ...savedLive, result_published: true }));
            }
          }
        }
      }
    } catch(e) { console.error('WATCHER post-match catch-up failed:', e.message); }
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
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
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
          await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
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
        const savedState   = liveStateRaw ? JSON.parse(liveStateRaw) : null;
        // New match — reset all per-match flags so old ht_published/seen_event_ids don't bleed over
        const liveState    = (savedState && savedState.fixture_id === liveFixture.fixture_id)
          ? savedState
          : { score_bjk: 0, score_opp: 0, result_published: false };

        // Guard: if the match is still live, result cannot have been published yet.
        // Prevents a mid-match false positive (e.g. wrong status poll) from permanently
        // blocking the post-match T11/T12/T13 suite.
        if (!liveFixture.is_finished) liveState.result_published = false;

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
              // Events API never caught up — generate score-only flash so users at least see the goal
              console.log('WATCHER T10: events empty after 3 ticks — generating score-only flash');
              liveState.goal_wait_ticks = 0;
              const scoreFlashEvent = { type: 'Goal', detail: 'Normal Goal', time: { elapsed: null }, player: { name: null }, team: { id: 549 } };
              const matchObj = { ...nextMatch, score_bjk: liveFixture.score_bjk, score_opp: liveFixture.score_opp };
              const card = await generateGoalFlash(matchObj, scoreFlashEvent, site, env).catch(() => null);
              if (card) {
                const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                const latest = raw ? JSON.parse(raw) : [];
                await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: card.nvs_score || 90, is_kartalix_content: true, is_template: true }), ...latest], 300));
                console.log('WATCHER KV WRITE T10 (score-only): done');
              }
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
              await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
              console.log('WATCHER KV WRITE T10: done');
            }
          }
        }

        // ── Sprint A: T-HT, T-RED, T-VAR, T-PEN + own goals → T10 ──
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
                  await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...htCard, nvs: 85, is_kartalix_content: true, is_template: true, fixture_id: liveFixture.fixture_id }), ...latest], 300));
                  console.log('WATCHER KV WRITE T-HT: done');
                }
              } catch(e) { console.error('WATCHER T-HT failed:', e.message); }
            }

            // Scan events for T-RED, T-VAR, own goals (→ T10), T-PEN
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
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 88, is_kartalix_content: true, is_template: true, fixture_id: liveFixture.fixture_id }), ...latest], 300));
                    console.log(`WATCHER KV WRITE T-RED: ${ev.player?.name}`);
                  }
                }
                // T-VAR — any VAR event
                else if (ev.type === 'Var') {
                  const card = await generateVARFlash(matchObj, ev, site, env);
                  if (card) {
                    const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                    const latest = raw ? JSON.parse(raw) : [];
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 85, is_kartalix_content: true, is_template: true, fixture_id: liveFixture.fixture_id }), ...latest], 300));
                    console.log(`WATCHER KV WRITE T-VAR: ${ev.detail}`);
                  }
                }
                // Own goal — saves as T10 (generateGoalFlash always uses template_id: 'T10')
                else if (ev.type === 'Goal' && ev.detail === 'Own Goal' && ev.team?.id !== 549) {
                  const card = await generateGoalFlash(matchObj, ev, site, env);
                  if (card) {
                    const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                    const latest = raw ? JSON.parse(raw) : [];
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 85, is_kartalix_content: true, is_template: true, fixture_id: liveFixture.fixture_id }), ...latest], 300));
                    console.log(`WATCHER KV WRITE T10 (own goal): ${ev.player?.name}`);
                  }
                }
                // T-PEN — missed penalty (any team)
                else if (ev.type === 'Goal' && ev.detail === 'Missed Penalty') {
                  const card = await generateMissedPenaltyFlash(matchObj, ev, site, env);
                  if (card) {
                    const raw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                    const latest = raw ? JSON.parse(raw) : [];
                    await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape({ ...card, nvs: 82, is_kartalix_content: true, is_template: true, fixture_id: liveFixture.fixture_id }), ...latest], 300));
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
            const kvCard = toKVShape({ ...t11card, nvs: t11card.nvs_score || 88, is_kartalix_content: true, is_template: true, fixture_id: liveFixture.fixture_id });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
            console.log('WATCHER KV WRITE T11: done');
          }

          try {
            const t13card = await generateManOfTheMatch(liveFixture, players, site, env);
            if (t13card) {
              const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const latest = raw ? JSON.parse(raw) : [];
              const kvCard = toKVShape({ ...t13card, nvs: t13card.nvs_score || 80, is_kartalix_content: true, is_template: true, fixture_id: liveFixture.fixture_id });
              await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
              console.log('WATCHER KV WRITE T13: done');
            }
          } catch(e) { console.error('WATCHER T13 failed:', e.message); }

          try {
            const t12card = await generateMatchReport(liveFixture, players, stats, site, env, events);
            if (t12card) {
              const raw    = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const latest = raw ? JSON.parse(raw) : [];
              const kvCard = toKVShape({ ...t12card, nvs: t12card.nvs_score || 85, is_kartalix_content: true, is_template: true, fixture_id: liveFixture.fixture_id });
              await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
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
                  const kvCard = toKVShape({ ...xgCard, nvs: xgCard.nvs_score || 78, is_kartalix_content: true, is_template: true, fixture_id: liveFixture.fixture_id });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
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

    for (const video of newVids.slice(0, 3)) {
      // Transcript-only channels go to digest queue, not embed
      if (video.transcript_qualify && !video.embed_qualify) {
        rabonaQueue.push(video);
        seenUrls.add(`https://www.youtube.com/watch?v=${video.video_id}`);
        continue;
      }
      if (!video.embed_qualify) continue;
      try {
        const card = await generateVideoEmbed(video, site, env, stats);
        if (!card) continue;
        const raw     = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
        const current = raw ? JSON.parse(raw) : [];
        const kvCard  = toKVShape({ ...card, nvs: card.nvs_score || 72, is_kartalix_content: true, is_template: true });
        await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...current], 300));
        seenUrls.add(`https://www.youtube.com/watch?v=${video.video_id}`);
        published++;

        // Story matching — video contributes to story system (capped at 3/run)
        if (storyMatchCount < 3) {
          try {
            if (!openStories) openStories = await getOpenStories(site.id, env);
            const videoArticle = videoToArticle(video);
            const facts = await extractFactsForStory(videoArticle, env);
            if (!SKIP_STORY_TYPES.has(facts.story_type)) {
              const { story, isNew } = await matchOrCreateStory(videoArticle, facts, site.id, env, openStories, site.short_code);
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
                const { story, isNew } = await matchOrCreateStory(videoArticle, facts, site.id, env, openStories, site.short_code);
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
          const card = await generateRabonaDigest(usedVideos, transcripts, site, env, stats);
          if (card) {
            const raw     = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const current = raw ? JSON.parse(raw) : [];
            const kvCard  = toKVShape({ ...card, nvs: card.nvs || 74, is_kartalix_content: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...current], 300));
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
async function processSite(site, env, ctx, lookbackMs = 3 * 60 * 60 * 1000) {
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
    fetchRSSArticles(site, dynamicRSSFeeds, lookbackMs),
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
  const offTopicHashes = await getOffTopicHashes(env, site.short_code);
  const synthFailedHashes = await getSynthesisFailedHashes(env, site.short_code);
  const allFetched = [...rssArticles, ...webArticles, ...beINArticles, ...twitterArticles]
    .filter(a => {
      const urlHash = simpleHash(a.url || a.original_url || '');
      return !offTopicHashes.has(urlHash) && !synthFailedHashes.has(urlHash);
    });
  const TRUST_RANK = { T1: 0, T2: 1, T3: 2, T4: 3 };
  allFetched.sort((a, b) => (TRUST_RANK[a.trust_tier] ?? 3) - (TRUST_RANK[b.trust_tier] ?? 3));

  const { articles: afterPreFilter, counts: filterCounts, rejected: preFilterRejected } = preFilter(allFetched, seenHashes, lookbackMs);

  // Persist off_topic rejections so next cron run skips re-evaluation.
  const newOffTopicHashes = new Set(offTopicHashes);
  for (const r of preFilterRejected) {
    if (r._stage === 'off_topic') newOffTopicHashes.add(simpleHash(r.url || r.original_url || ''));
  }
  await saveOffTopicHashes(env, site.short_code, newOffTopicHashes, Math.floor(lookbackMs / 1000));

  // ── URL DEDUP against Supabase (permanent, prevents re-scoring) ──
  const seenUrls = await getSeenUrls(env, site.id);
  const urlSeenItems = [];
  const preFiltered = afterPreFilter.filter(a => {
    const url = a.url || a.original_url || '';
    if (!url || url === '#') return true;
    if (seenUrls.has(url)) {
      urlSeenItems.push({ url, title: a.title, source_name: a.source_name || a.source, published_at: a.published_at, _stage: 'url_seen',
        trust_tier: a.trust_tier || a.trust || null,
        source_body_len: ((a.summary || '') + (a.full_text || '')).length,
        drop_detail: 'seen previously' });
      return false;
    }
    return true;
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
    // KV may have expired — seed from DB so the site doesn't go dark
    const kvCheck = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
    if (!kvCheck || JSON.parse(kvCheck).length === 0) {
      try {
        const GOOD_MODES_SEED = ['rewrite','copy_source','template_matchday','template_postmatch','template_lineup','template_h2h','template_form_guide','template_injury','template_official','youtube_embed','synthesis_generated','manual','original_synthesis','video_embed'];
        const dbRows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${site.id}&status=eq.published&publish_mode=in.(${GOOD_MODES_SEED.join(',')})&order=published_at.desc&limit=300&select=slug,title,summary,full_body,category,source_name,source_type,original_url,nvs_score,golden_score,publish_mode,published_at,fetched_at,created_at,template_id,sport`);
        if (Array.isArray(dbRows) && dbRows.length > 0) {
          const seeded = dbRows.filter(r => r.slug && (r.full_body || r.summary)).map(r => toKVShape({
            title: r.title || '', summary: r.summary || '', full_body: r.full_body || r.summary || '',
            source_name: r.source_name || '', source: r.source_name || '',
            url: r.original_url || '', original_url: r.original_url || '',
            category: r.category || 'Haber', nvs: r.nvs_score || 0,
            golden_score: r.golden_score || null,
            published_at: r.published_at || r.created_at || r.fetched_at,
            fetched_at:   r.created_at   || r.fetched_at,
            is_fresh: false, is_kartalix_content: r.source_type === 'kartalix',
            publish_mode: r.publish_mode || 'rss_summary', slug: r.slug,
            template_id: r.template_id || null, sport: r.sport || 'football',
          }));
          await cacheToKV(env, site.short_code, seeded);
          console.log(`KV SEED on empty (no new articles): ${seeded.length} from DB`);
        }
      } catch(e) { console.error('KV seed on empty failed:', e.message); }
    } else {
      // Re-rank existing KV so stale articles decay even on quiet cron runs
      try {
        const existing = JSON.parse(kvCheck);
        await cacheToKV(env, site.short_code, existing);
        console.log(`KV RE-RANK (no new articles): ${existing.length} articles re-ranked`);
      } catch(e) { console.error('KV re-rank on quiet run failed:', e.message); }
    }
    return { ...stats, cached: 0 };
  }

  // ── SCORE ARTICLES ────────────────────────────────────────────
  await sleep(500);
  let scored, scoreUsage;
  try {
    ({ scored, usage: scoreUsage } = await scoreArticles(preFiltered, site, env));
  } catch(e) {
    console.error(`SCORING FAILED (Claude unavailable): ${e.message}`);
    // Claude down — keep KV alive so the pool doesn't go dark
    const kvRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
    const kvExisting = kvRaw ? JSON.parse(kvRaw) : [];
    if (kvExisting.length >= 5) {
      await cacheToKV(env, site.short_code, kvExisting);
      console.log(`KV REFRESH (scoring fallback): ${kvExisting.length} articles re-ranked`);
    } else {
      try {
        const seedCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const dbRows = await supabase(env, 'GET',
          `/rest/v1/content_items?site_id=eq.${site.id}&status=eq.published&published_at=not.is.null&published_at=gte.${seedCutoff}&publish_mode=not.in.(rss_summary,copy_source)&order=published_at.desc&limit=300&select=*`);
        if (Array.isArray(dbRows) && dbRows.length > 0) {
          const seeded = dbRows.map(r => toKVShape({
            title: r.title, summary: r.summary || '', full_body: r.full_body || r.summary || '',
            source_name: r.source_name || '', source: r.source_name || '',
            url: r.original_url || '', original_url: r.original_url || '',
            category: r.category || 'Haber', nvs: r.nvs_score || 0,
            golden_score: r.golden_score || null, published_at: r.published_at,
            is_fresh: false, is_kartalix_content: r.source_type === 'kartalix',
            publish_mode: r.publish_mode || 'rss_summary', slug: r.slug,
            template_id: r.template_id || null,
          }));
          await cacheToKV(env, site.short_code, seeded);
          console.log(`KV SEED from DB (scoring fallback): ${seeded.length} articles`);
        }
      } catch(seedErr) { console.error('KV seed fallback failed:', seedErr.message); }
    }
    funnelStats._error = e.message;
    await logFetch(env, site.id, 'failed', stats, e.message, funnelStats);
    if (stats.costEur > 0) await addCost(env, stats.costEur);
    return stats;
  }
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

  // ── DB-FIRST: read existing KV for template dedup — no early write ──
  // KV is updated only after Supabase confirms the save. Nothing goes live
  // without a DB record.
  const existing = await getCachedArticles(env, site.short_code);
  const kvCandidates = top100.filter(a => a.publish_mode !== 'rss_summary');
  // immediateKV kept as in-memory reference for template existence checks but
  // NOT written to KV here.
  const immediateKV = mergeAndDedupe([...kvCandidates, ...existing.filter(a => a.publish_mode !== 'rss_summary')], 100).map(toKVShape);

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
          venue_lat:      null, // resolved below via resolveVenueCoords
          venue_lon:      null,
          tv:             NEXT_MATCH.tv,          // not in API, keep hardcoded
          match_day:      liveFixture.date,
          cup:            null,
          fixture_id:     liveFixture.fixture_id,
          opponent_id:    liveFixture.opponent_id,
          referee:        liveFixture.referee || null,
        };
        const coords = await resolveVenueCoords(nextMatch.venue, nextMatch.venue_city);
        nextMatch.venue_lat = coords.lat;
        nextMatch.venue_lon = coords.lon;
        console.log(`NEXT MATCH (API): ${nextMatch.opponent} on ${nextMatch.date} ${nextMatch.time} @ ${nextMatch.venue} (${coords.lat},${coords.lon})`);
        // Cache resolved next-match for matchWatcher fallback (survives API downtime)
        await env.PITCHOS_CACHE.put('match:BJK:next', JSON.stringify(nextMatch), { expirationTtl: 7 * 24 * 3600 }).catch(() => {});
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
        const card = await generateMatchDayCard(nextMatch, preFiltered, site, env, injuries, stats);
        if (card) {
          await linkToMatchStory(card);
          const withT = [toKVShape(card), ...immediateKV];
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
        const card = await generateMuhtemel11(nextMatch, preFiltered, site, env, stats);
        if (card) {
          await linkToMatchStory(card);
          const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
          const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
          await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape(card), ...latest], 300));
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
            await cacheToKV(env, site.short_code, mergeAndDedupe([toKVShape(card), ...latest], 300));
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
          const card = await generateH2HHistory(nextMatch, h2h, site, env, stats);
          if (card) {
            await linkToMatchStory(card);
            await env.PITCHOS_CACHE.put(t02Key, '1', { expirationTtl: 86400 });
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 72, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
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
          const card = await generateInjuryReport(nextMatch, injuries, rssArticles, site, env, stats);
          if (card) {
            await linkToMatchStory(card);
            await env.PITCHOS_CACHE.put(t07Key, '1', { expirationTtl: 86400 });
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 75, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...rssArticles], 300));
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
            const card = await generateRefereeProfile(nextMatch, referee, refStats, site, env, stats);
            if (card) {
              await linkToMatchStory(card);
              await env.PITCHOS_CACHE.put(trefKey, '1', { expirationTtl: 86400 });
              const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
              const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
              const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 65, is_kartalix_content: true, is_template: true });
              await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
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
          const card = await generateFormGuide(nextMatch, recent, bjkRow, site, env, stats);
          if (card) {
            await linkToMatchStory(card);
            await env.PITCHOS_CACHE.put(t03Key, '1', { expirationTtl: 86400 });
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 70, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
            console.log('KV WRITE WITH T03: done');
          }
        }
      }
    } catch(e) { console.error('Template T03 failed:', e.message); }

    // T08c Predicted Lineup Pitch — fires once per match in the 48-72h window
    try {
      const t08cKey = `flag:t08c:${nextMatch.date}`;
      const t08cExists = await env.PITCHOS_CACHE.get(t08cKey);
      if (!t08cExists) {
        const matchDateTime = new Date(`${nextMatch.date}T${nextMatch.time}:00+03:00`);
        const hoursToKickoff = (matchDateTime - new Date()) / (1000 * 60 * 60);
        if (hoursToKickoff > 0 && hoursToKickoff <= 72) {
          console.log(`TEMPLATE T08c: ${hoursToKickoff.toFixed(1)}h to kickoff — generating predicted lineup...`);
          const [bjkLastLineup, oppLastLineup, injuries, predHistory] = await Promise.all([
            getBJKLastLineupData(env),
            nextMatch.opponent_id ? getOpponentLastLineup(nextMatch.opponent_id, env) : Promise.resolve(null),
            getInjuries(env, nextMatch.fixture_id),
            env.PITCHOS_CACHE.get('lineup_history', 'json').catch(() => null),
          ]);
          const card = await generateLineupCard(nextMatch, bjkLastLineup, oppLastLineup, injuries, predHistory || [], site, env, stats);
          if (card) {
            await linkToMatchStory(card);
            await env.PITCHOS_CACHE.put(t08cKey, '1', { expirationTtl: 86400 });
            // Store prediction for accuracy comparison after real lineup is announced
            if (nextMatch.fixture_id && card.predicted_players) {
              await env.PITCHOS_CACHE.put(
                `lineup_predict:${nextMatch.fixture_id}`,
                JSON.stringify({
                  fixture_id:        nextMatch.fixture_id,
                  opponent:          nextMatch.opponent,
                  date:              nextMatch.date,
                  predicted_players: card.predicted_players,
                  formation:         card.formation,
                  generated_at:      new Date().toISOString(),
                  compared:          false,
                }),
                { expirationTtl: 60 * 60 * 24 * 14 }
              );
            }
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 75, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
            console.log('KV WRITE WITH T08c: done');
          }
        }
      }
    } catch(e) { console.error('Template T08c failed:', e.message); }

    // T08c Accuracy Comparison — fires when real lineup confirmed (~60min before kickoff)
    try {
      if (nextMatch.fixture_id) {
        const matchDateTime = new Date(`${nextMatch.date}T${nextMatch.time}:00+03:00`);
        const hoursToKickoff = (matchDateTime - new Date()) / (1000 * 60 * 60);
        if (hoursToKickoff >= 0 && hoursToKickoff <= 1.5) {
          const predictKey = `lineup_predict:${nextMatch.fixture_id}`;
          const prediction = await env.PITCHOS_CACHE.get(predictKey, 'json');
          if (prediction && !prediction.compared) {
            const realLineup = await getFixtureLineup(nextMatch.fixture_id, env);
            if (realLineup?.startXI?.length >= 11) {
              const realNames = realLineup.startXI.map(p => p.name.toLowerCase());
              const correct = (prediction.predicted_players || []).filter(pred =>
                realNames.some(r => {
                  const predLast = pred.toLowerCase().split(' ').pop();
                  return r.includes(pred.toLowerCase()) || r.split(' ').pop() === predLast;
                })
              );
              const correctCount = correct.length;
              await env.PITCHOS_CACHE.put(predictKey, JSON.stringify({
                ...prediction,
                real_players:  realLineup.startXI.map(p => p.name),
                correct,
                correct_count: correctCount,
                accuracy:      correctCount / 11,
                compared:      true,
                compared_at:   new Date().toISOString(),
              }), { expirationTtl: 60 * 60 * 24 * 30 });
              // Append to rolling history (last 10)
              const histRaw = await env.PITCHOS_CACHE.get('lineup_history', 'json').catch(() => null);
              const hist = Array.isArray(histRaw) ? histRaw : [];
              hist.unshift({ fixture_id: nextMatch.fixture_id, opponent: nextMatch.opponent, date: nextMatch.date, correct_count: correctCount });
              await env.PITCHOS_CACHE.put('lineup_history', JSON.stringify(hist.slice(0, 10)));
              console.log(`T08c COMPARE: ${correctCount}/11 correct vs ${nextMatch.opponent}`);
            }
          }
        }
      }
    } catch(e) { console.error('T08c comparison failed:', e.message); }

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
          const card = await generateMatchPreview(nextMatch, h2h, weather, standingsCtx, site, env, stats);
          if (card) {
            await linkToMatchStory(card);
            await env.PITCHOS_CACHE.put(t01Key, '1', { expirationTtl: 86400 });
            const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
            const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
            const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 82, is_kartalix_content: true, is_template: true });
            await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
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
                const card = await generateGoalFlash(matchObj, latestGoal, site, env, stats);
                if (card) {
                  await linkToMatchStory(card);
                  const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                  const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 90, is_kartalix_content: true, is_template: true });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
                  console.log('KV WRITE WITH TEMPLATE T10: done');
                }
              }
            }

            // T11 + T12 + T13 — match finished, fire once
            if (liveFixture.is_finished && !liveState.result_published) {
              console.log('T11: match finished — generating result flash...');
              const [players, fixtureStats, events] = await Promise.all([
                getFixturePlayers(liveFixture.fixture_id, env),
                getFixtureStats(liveFixture.fixture_id, env),
                getFixtureEvents(liveFixture.fixture_id, env).catch(() => []),
              ]);
              const card = await generateResultFlash(liveFixture, players, site, env, events, stats);
              if (card) {
                await linkToMatchStory(card);
                liveState.result_published = true;
                const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                const kvCard = toKVShape({ ...card, nvs: card.nvs_score || 88, is_kartalix_content: true, is_template: true });
                await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
                console.log('KV WRITE WITH TEMPLATE T11: done');
              }

              // T13 — Man of the Match
              try {
                console.log('T13: generating man of the match...');
                const motmCard = await generateManOfTheMatch(liveFixture, players, site, env, stats);
                if (motmCard) {
                  await linkToMatchStory(motmCard);
                  const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                  const kvCard = toKVShape({ ...motmCard, nvs: motmCard.nvs_score || 80, is_kartalix_content: true, is_template: true });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
                  console.log('KV WRITE WITH TEMPLATE T13: done');
                }
              } catch(e) { console.error('T13 failed:', e.message); }

              // T12 — Full match report (xG + stats + ratings)
              try {
                console.log('T12: generating match report...');
                const reportCard = await generateMatchReport(liveFixture, players, fixtureStats, site, env, events, stats);
                if (reportCard) {
                  await linkToMatchStory(reportCard);
                  const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                  const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                  const kvCard = toKVShape({ ...reportCard, nvs: reportCard.nvs_score || 85, is_kartalix_content: true, is_template: true });
                  await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
                  console.log('KV WRITE WITH TEMPLATE T12: done');
                }
              } catch(e) { console.error('T12 failed:', e.message); }

              // T-xG Delta — only when |BJK goals − xG| > 1.2
              try {
                if (fixtureStats?.xg != null) {
                  const xgDelta = Math.abs((liveFixture.score_bjk ?? 0) - parseFloat(fixtureStats.xg));
                  console.log(`T-XG: delta=${xgDelta.toFixed(2)}`);
                  if (xgDelta > 1.2) {
                    const xgCard = await generateXGDelta(liveFixture, fixtureStats, site, env, stats);
                    if (xgCard) {
                      await linkToMatchStory(xgCard);
                      const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
                      const latest = latestRaw ? JSON.parse(latestRaw) : immediateKV;
                      const kvCard = toKVShape({ ...xgCard, nvs: xgCard.nvs_score || 78, is_kartalix_content: true, is_template: true });
                      await cacheToKV(env, site.short_code, mergeAndDedupe([kvCard, ...latest], 300));
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

    // ── DB-FIRST SAVE + KV WRITE ─────────────────────────────────
    // Articles reach KV only after Supabase confirms the write. Any failure
    // is recorded in KV so the admin panel can surface it immediately.
    let scoredLowItems    = [];
    let publishedLogItems = [];
    let thinDropItems     = [];
    try {
      const top100forWrite = top100.slice(0, 100);
      const { results: allWritten, _usage: writeUsage } = await writeArticles(top100forWrite, site, env);
      if (writeUsage?.haiku && (writeUsage.haiku.input_tokens || writeUsage.haiku.output_tokens)) {
        addUsagePhase(stats, writeUsage.haiku, MODEL_FETCH, 'synthesis');
        stats.claudeCalls++;
      }
      if (writeUsage?.sonnet && (writeUsage.sonnet.input_tokens || writeUsage.sonnet.output_tokens)) {
        addUsagePhase(stats, writeUsage.sonnet, MODEL_GENERATE, 'synthesis');
        stats.claudeCalls++;
      }
      console.log(`Write phase: ${allWritten.map(a => a.publish_mode).join(', ')}`);

      scoredLowItems = allWritten
        .filter(a => a.publish_mode === 'rss_summary')
        .map(a => ({
          url: a.url || a.original_url, title: a.title, source_name: a.source_name || a.source, nvs_score: a.nvs,
          _stage: (a.nvs || 0) >= 30 ? 'synthesis_failed' : 'scored_low',
          trust_tier: a.trust_tier || a.trust || null,
          source_body_len: ((a.summary || '') + (a.full_text || '')).length,
          drop_detail: (a.nvs || 0) >= 30 ? 'synthesis_cap_or_source_unavailable' : null,
        }));

      const publishThreshold = site.auto_publish_threshold || 30;
      // template_official = @Besiktas official tweets — always publish regardless of NVS score
      const toPublish = allWritten.filter(a =>
        (a.nvs >= publishThreshold || a.publish_mode === 'template_official') &&
        a.publish_mode !== 'hot_news_hold');
      stats.queued    = 0;

      const pubResult   = toPublish.length > 0 ? await saveArticles(env, site.id, toPublish, 'published') : { saved: [], failed: [], thinDropped: [] };
      stats.published = pubResult.saved.length;
      publishedLogItems = pubResult.saved
        .map(a => ({ url: a.url || a.original_url, title: a.title, source_name: a.source_name || a.source, nvs_score: a.nvs, publish_mode: a.publish_mode, _stage: 'published',
          trust_tier: a.trust_tier || a.trust || null,
          source_body_len: ((a.summary || '') + (a.full_text || '')).length,
          drop_detail: null }));
      thinDropItems = (pubResult.thinDropped || [])
        .map(a => ({ url: a.url || a.original_url, title: a.title, source_name: a.source_name || a.source, nvs_score: a.nvs, publish_mode: a.publish_mode, _stage: 'template_transfer_thin',
          trust_tier: a.trust_tier || a.trust || null,
          source_body_len: (a.full_body || '').length,
          drop_detail: String((a.full_body || '').length) }));
      const queueResult = { saved: [], failed: [] };

      // Surface any DB write failures to the admin panel immediately
      const allFailed = [...pubResult.failed, ...queueResult.failed];
      if (allFailed.length > 0) {
        await recordPipelineFailures(env, site.short_code, allFailed, pubResult.error || queueResult.error || 'unknown');
      }

      await saveSeenHashes(env, site.short_code, pubResult.saved);

      // Persist synthesis_failed URLs so next cron run skips re-attempt (6h TTL).
      const newSynthFailedHashes = new Set(synthFailedHashes);
      for (const r of scoredLowItems) {
        if (r._stage === 'synthesis_failed') newSynthFailedHashes.add(simpleHash(r.url || ''));
      }
      await saveSynthesisFailedHashes(env, site.short_code, newSynthFailedHashes);

      // Write to KV — only articles confirmed in Supabase + any template cards already there.
      // Synthesis bodies are patched in here as well, no separate KV write needed.
      const confirmedArticles = [...pubResult.saved, ...queueResult.saved];
      const synthesisUrlMap = new Map(
        allWritten.filter(a => a.publish_mode === 'rewrite' && a.full_body?.length > 200)
          .map(a => [a.url || a.original_url, a])
      );
      const latestRaw = await env.PITCHOS_CACHE.get('articles:' + site.short_code);
      let latestKV = latestRaw ? JSON.parse(latestRaw) : [];
      // KV cache miss OR near-empty (drought recovery) — seed from DB.
      // Filter by created_at (server-generated, never null) — published_at was unreliable
      // (null for all articles before commit d864504). created_at is the Supabase insertion timestamp.
      if (!latestRaw || latestKV.length < 10) {
        try {
          const seedCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          // Exclude rss_summary and copy_source — hardTtl 2h/12h means they'd all be
          // immediately evicted by rankAndEvict, defeating the seed entirely.
          const seedModeExclude = ['rss_summary','copy_source'];
          const dbRows = await supabase(env, 'GET',
            `/rest/v1/content_items?site_id=eq.${site.id}&status=eq.published&created_at=gte.${encodeURIComponent(seedCutoff)}&publish_mode=not.in.(${seedModeExclude.join(',')})&order=created_at.desc&limit=300&select=slug,title,summary,full_body,category,source_name,nvs_score,publish_mode,published_at,fetched_at,created_at,image_url,original_url,source_type,template_id,golden_score`);
          if (Array.isArray(dbRows) && dbRows.length > 0) {
            latestKV = dbRows.map(r => toKVShape({
              title:        r.title,
              summary:      r.summary || '',
              full_body:    r.full_body || r.summary || '',
              source_name:  r.source_name || '',
              source:       r.source_name || '',
              url:          r.original_url || '',
              original_url: r.original_url || '',
              category:     r.category || 'Haber',
              nvs:          r.nvs_score || 0,
              golden_score: r.golden_score || null,
              published_at: r.published_at || r.created_at,
              fetched_at:   r.created_at || r.fetched_at || null,
              is_fresh:     false,
              is_kartalix_content: r.source_type === 'kartalix',
              publish_mode: r.publish_mode || 'rss_summary',
              image_url:    r.image_url   || '',
              slug:         r.slug,
              template_id:  r.template_id || null,
            }));
            console.log(`KV SEED from DB: ${latestKV.length} published articles (last 30d)`);
          } else {
            console.error(`KV SEED from DB: no rows returned — dbRows=${dbRows === null ? 'null (Supabase error)' : '[]'}`);
          }
        } catch(e) { console.error('KV seed from DB failed:', e.message); }
      }
      const processedAt = new Date().toISOString();
      const newKVItems = confirmedArticles.map(a => {
        const syn = synthesisUrlMap.get(a.url || a.original_url);
        const base = syn ? { ...a, full_body: syn.full_body, publish_mode: 'rewrite' } : a;
        const isKartalix = base.is_kartalix_content ||
          ['rewrite','original_synthesis','youtube_embed','video_embed'].includes(base.publish_mode) ||
          (base.publish_mode && base.publish_mode.startsWith('template'));
        return toKVShape({ ...base, fetched_at: base.fetched_at || processedAt, is_kartalix_content: isKartalix });
      });
      const finalKVCount = await cacheToKV(env, site.short_code, [...newKVItems, ...latestKV]);
      console.log(`KV WRITE (DB-confirmed): ${newKVItems.length} new + ${latestKV.length} existing → ${finalKVCount} ranked`);
      if (allFailed.length > 0) {
        console.error(`DB WRITE FAILURES (${allFailed.length}): ${allFailed.map(a => '"' + (a.title||'').slice(0,50) + '"').join(', ')}`);
      }

      // ── STORY MATCHING ───────────────────────────────────────
      // Capped at 5 per run — each article requires 2 Claude calls (extractFacts + judge).
      // Cron runs every 30 min so all articles get processed across multiple ticks.
      // Fetch open stories once, reuse to avoid N×Supabase reads.
      // Thread DB IDs from confirmedArticles back into allWritten so addContribution stores them.
      const idBySlug = Object.fromEntries(confirmedArticles.filter(a => a.id && a.slug).map(a => [a.slug, a.id]));
      const articlesWithFacts = allWritten.filter(a => a._facts).slice(0, 5)
        .map(a => (a.id || !a.slug || !idBySlug[a.slug]) ? a : { ...a, id: idBySlug[a.slug] });
      const storiesThisRun = new Map(); // story_id → story (touched this run)
      if (articlesWithFacts.length > 0) {
        console.log(`Story matching: ${articlesWithFacts.length} articles with extracted facts`);
        let openStories = await getOpenStories(site.id, env);
        for (const article of articlesWithFacts) {
          try {
            const { story, isNew } = await matchOrCreateStory(article, article._facts, site.id, env, openStories, site.short_code);
            console.log(`Story match [${article.title?.slice(0, 40)}]: ${isNew ? 'NEW' : 'MATCHED'} → ${story.id} (conf:${story.confidence} state:${story.state}) id=${article.id||'null'}`);
            // Also patch content_item.story_id so H5 gate and synthesizeStory can find it
            if (article.id) {
              supabase(env, 'PATCH', `/rest/v1/content_items?id=eq.${article.id}`, { story_id: story.id })
                .catch(e => console.error('content_item story_id patch failed:', e.message));
            }
            storiesThisRun.set(story.id, story);
            if (isNew) openStories = [...openStories, story];
          } catch (e) {
            console.error('Story match failed:', e.message, '| article:', article.title?.slice(0, 40));
          }
        }
      }

      // ── H5 MULTI-SOURCE SYNTHESIS ────────────────────────────
      // Fires synthesizeStory for confirmed/active stories that passed the quality gate.
      // Cap 2/run to stay within Claude budget.
      const h5Candidates = [...storiesThisRun.values()]
        .filter(s => ['confirmed', 'active', 'developing'].includes(s.state));
      if (h5Candidates.length > 0) {
        const scRows = await supabase(env, 'GET', `/rest/v1/source_configs?select=name,source_family&is_active=eq.true`) || [];
        const scMap = Object.fromEntries(scRows.filter(r => r.source_family).map(r => [r.name, r.source_family]));
        let h5Count = 0;
        for (const story of h5Candidates) {
          if (h5Count >= 2) break;
          try {
            const gate = await checkH5SynthGate(story.id, env, scMap);
            if (gate.eligible) {
              console.log(`H5 SYNTH: firing for story ${story.id} "${story.title?.slice(0,40)}" — ${gate.reason}`);
              synthesizeStory(story, site.id, env, site.short_code).catch(e => console.error('H5 synth failed:', e.message));
              h5Count++;
            } else {
              console.log(`H5 SYNTH: skip story ${story.id} — ${gate.reason}`);
            }
          } catch(e) { console.error('H5 gate check failed:', e.message); }
        }
      }
    } catch(e) {
      console.error('Pipeline save failed:', e.message);
      await recordPipelineFailures(env, site.short_code, [], e.message);
    }

    await logFetch(env, site.id, 'success', stats, null, funnelStats);
    if (stats.costEur > 0) await addCost(env, stats.costEur);

    // ── PIPELINE LOG — per-article disposition ─────────────────
    try {
      const runAt = new Date().toISOString();
      const cutoff7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      // Cleanup old rows
      await supabase(env, 'DELETE', `/rest/v1/pipeline_log?site_id=eq.${site.id}&created_at=lt.${cutoff7d}`).catch(() => {});
      // Collect all events
      const allEvents = [
        ...(preFilterRejected || []),
        ...(urlSeenItems      || []),
        ...(scoredLowItems    || []),
        ...(thinDropItems     || []),
        ...(publishedLogItems || []),
      ];
      if (allEvents.length > 0) {
        const rows = allEvents.slice(0, 600).map(a => ({
          site_id:         site.id,
          run_at:          runAt,
          source_name:     (a.source_name || '').slice(0, 100),
          title:           (a.title       || '').slice(0, 250),
          url:             (a.url         || '').slice(0, 500),
          stage:           a._stage,
          nvs_score:       a.nvs_score || null,
          publish_mode:    a.publish_mode || null,
          trust_tier:      a.trust_tier || null,
          source_body_len: a.source_body_len != null ? a.source_body_len : null,
          drop_detail:     a.drop_detail || null,
        }));
        await supabase(env, 'POST', `/rest/v1/pipeline_log`, rows).catch(e => console.error('pipeline_log write failed:', e.message));
      }
    } catch(e) { console.error('pipeline_log block failed:', e.message); }

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
    supabase(env, 'GET', `/rest/v1/source_configs?site_id=eq.${SITE}&select=name,source_type,trust_tier,is_active,source_family`),
    supabase(env, 'GET', `/rest/v1/stories?site_id=eq.${SITE}&select=id,story_type,state,created_at&order=created_at.desc&limit=200`),
  ]);

  const cached = cachedRaw ? JSON.parse(cachedRaw) : [];
  const items = contentItems || [];
  const published = items.filter(a => a.status === 'published');
  const pending   = items.filter(a => a.status === 'pending');
  const rejected  = items.filter(a => a.status === 'rejected');

  // ─── source type distribution ─────────────────────────────
  const srcMap = {};
  (sourceConfigs || []).forEach(sc => { srcMap[sc.name] = { type: sc.source_type, tier: sc.trust_tier, family: sc.source_family }; });
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
    if (!bySource[s]) bySource[s] = { source_name:s, contributed:0, published:0, queued:0, rejected:0, nvs_total:0, last_article_at:null };
    bySource[s].contributed++;
    if (a.status === 'published') bySource[s].published++;
    if (a.status === 'pending')   bySource[s].queued++;
    if (a.status === 'rejected')  bySource[s].rejected++;
    bySource[s].nvs_total += (a.nvs_score || 0);
    if (!bySource[s].last_article_at || a.fetched_at > bySource[s].last_article_at) bySource[s].last_article_at = a.fetched_at;
  });
  // ─── per-source fetch stats from fetch_logs.error_message.by_source ─────
  const srcFetchStats = {};
  (runs || []).forEach(run => {
    if (!run.error_message) return;
    try {
      const d = JSON.parse(run.error_message);
      if (d.by_source && typeof d.by_source === 'object') {
        Object.entries(d.by_source).forEach(([src, s]) => {
          if (!srcFetchStats[src]) srcFetchStats[src] = { raw: 0, after_date: 0, kw: 0 };
          srcFetchStats[src].raw        += s.raw          || 0;
          srcFetchStats[src].after_date += s.after_date   || 0;
          srcFetchStats[src].kw         += s.after_keyword || 0;
        });
      }
    } catch(e) {}
  });

  // Merge: start from srcFetchStats so sources with 0 content_items are still visible
  const mergedSources = {};
  Object.entries(srcFetchStats).forEach(([src, fs]) => {
    mergedSources[src] = {
      source_name: src, raw_fetched: fs.raw || 0, after_date: fs.after_date || 0, kw_passed: fs.kw || 0,
      contributed: 0, published: 0, queued: 0, rejected: 0, nvs_total: 0, last_article_at: null,
    };
  });
  Object.values(bySource).forEach(s => {
    if (!mergedSources[s.source_name]) mergedSources[s.source_name] = {
      source_name: s.source_name, raw_fetched: 0, after_date: 0, kw_passed: 0,
      contributed: 0, published: 0, queued: 0, rejected: 0, nvs_total: 0, last_article_at: null,
    };
    const m = mergedSources[s.source_name];
    m.contributed    = s.contributed;
    m.published      = s.published;
    m.queued         = s.queued;
    m.rejected       = s.rejected;
    m.nvs_total      = s.nvs_total;
    m.last_article_at = s.last_article_at;
  });
  const by_source = Object.values(mergedSources).map(s => ({
    ...s,
    avg_nvs: s.contributed > 0 ? Math.round(s.nvs_total / s.contributed) : 0,
    lost:    Math.max(0, (s.kw_passed || 0) - (s.contributed || 0)),
  })).sort((a,b) => (b.raw_fetched || 0) - (a.raw_fetched || 0));

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
  let agg = { raw:0, fetched:0, date:0, kw:0, hash:0, title:0, url_dedup:0, pub:0, q:0, rej:0, cost:0, calls:0 };
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
          agg.raw      += d.raw_fetched    || 0;
          agg.date     += d.after_date     || 0;
          agg.kw       += d.after_keyword  || 0;
          agg.hash     += d.after_hash     || 0;
          agg.title    += d.after_title    || 0;
          agg.url_dedup+= d.after_url_dedup|| 0;
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
      after_title_dedup:    hasDetailedFunnel ? agg.title    : agg.raw,
      after_url_dedup:      hasDetailedFunnel ? agg.url_dedup : agg.raw,
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

// Stored in KV so it survives across requests and the admin panel can read it.
async function recordPipelineFailures(env, siteCode, articles, error) {
  try {
    const existing = JSON.parse(await env.PITCHOS_CACHE.get(FAILURES_KEY) || '[]');
    const newEntries = articles.length > 0
      ? articles.map(a => ({
          ts:           new Date().toISOString(),
          site:         siteCode,
          slug:         a.slug || '',
          title:        (a.title || '').slice(0, 100),
          publish_mode: a.publish_mode || '',
          error:        String(error || 'db_write_failed'),
        }))
      : [{ ts: new Date().toISOString(), site: siteCode, slug: '', title: '', publish_mode: '', error: String(error) }];
    const updated = [...newEntries, ...existing].slice(0, 100);
    await env.PITCHOS_CACHE.put(FAILURES_KEY, JSON.stringify(updated), { expirationTtl: FAILURES_TTL });
  } catch(e) {
    console.error('recordPipelineFailures failed:', e.message);
  }
}

// Auto-backfill: create a Supabase record for an article that is live in KV but has no DB row.
// Called in background (ctx.waitUntil) so it never delays the served response.
async function backfillArticleToSupabase(kvArticle, env) {
  try {
    const sites = await getActiveSites(env);
    const site  = sites?.[0];
    if (!site) return;
    const now = new Date().toISOString();
    await supabase(env, 'POST', '/rest/v1/content_items', [{
      site_id:      site.id,
      slug:         kvArticle.slug,
      title:        kvArticle.title || '',
      summary:      kvArticle.summary || '',
      full_body:    kvArticle.full_body || '',
      category:     kvArticle.category || 'Haber',
      source_type:  kvArticle.is_kartalix_content ? 'kartalix' : 'rss',
      source_name:  kvArticle.source_name || kvArticle.source || 'Kartalix',
      publish_mode: kvArticle.publish_mode || 'rss_summary',
      status:       'published',
      nvs_score:    kvArticle.nvs || kvArticle.nvs_score || 50,
      content_type: 'fact',
      sport:        kvArticle.sport || 'football',
      original_url: kvArticle.url || kvArticle.original_url || '',
      image_url:    kvArticle.image_url || '',
      template_id:  kvArticle.template_id || null,
      published_at: kvArticle.published_at || now,
      fetched_at:   kvArticle.published_at || now,
      reviewed_at:  now,
      reviewed_by:  'auto_backfill',
    }]);
    console.log(`BACKFILL: saved KV-only article to DB: ${kvArticle.slug}`);
  } catch(e) {
    console.error('backfillArticleToSupabase failed:', e.message);
  }
}

async function serveArticlePage(slug, env, ctx) {
  const cached = await env.PITCHOS_CACHE.get('articles:BJK');
  const articles = cached ? JSON.parse(cached) : [];

  // Find by slug in KV first
  const kvArticle = articles.find(a => a.slug === slug);
  let article = kvArticle || null;

  // Always verify against Supabase (status filter + canonical data)
  const rows = await supabase(env, 'GET',
    `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}&status=not.in.(rejected,archived)&select=*&limit=1`);
  if (rows && rows.length > 0) {
    const r = rows[0];
    // For rewrites, saveArticles overwrites source_name → 'Kartalix' in Supabase.
    // Fall back to KV article's source_name (original value) when available.
    const effectiveSource = (r.publish_mode === 'rewrite' && r.source_name === 'Kartalix' &&
      kvArticle?.source_name && kvArticle.source_name !== 'Kartalix')
      ? kvArticle.source_name
      : (r.source_name || '');
    article = {
      title: r.title, summary: r.summary || '', full_body: r.full_body || '',
      source: effectiveSource, category: r.category || 'Haber',
      published_at: r.fetched_at, image_url: r.image_url || '',
      nvs: r.nvs_score || 0, url: r.original_url || '#', slug,
      is_kartalix_content: r.content_type === 'kartalix_generated',
      template_id: r.template_id || null,
      publish_mode: r.publish_mode || '',
    };
  } else if (kvArticle && ctx) {
    // KV-only: article is live but has no DB record — backfill in background
    ctx.waitUntil(backfillArticleToSupabase(kvArticle, env));
  }

  if (!article) {
    // Check if this slug ever existed (rejected/archived/deleted) → 410 Gone
    // so Google drops it faster than repeated 404s.
    const gone = await supabase(env, 'GET',
      `/rest/v1/content_items?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
    const status = (gone && gone.length > 0) ? 410 : 404;
    return new Response(renderArticleNotFound(slug), {
      status,
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
  }

  // Fixture widget: resolve fixture_id for match template articles.
  // Priority: fixture_id stored on the KV article (set at generation time) > live state > NEXT_MATCH fallback.
  // The KV-stored fixture_id is authoritative — it represents the match the article was actually generated for.
  let fixtureId = null;
  let opponentId = null;
  if (article.is_kartalix_content && article.template_id) {
    const liveStateRaw = await env.PITCHOS_CACHE.get('match:BJK:live');
    const liveState = liveStateRaw ? JSON.parse(liveStateRaw) : null;
    fixtureId = kvArticle?.fixture_id || liveState?.fixture_id || null;
    if (article.template_id === 'T02') {
      opponentId = kvArticle?.opponent_id || liveState?.opponent_id || NEXT_MATCH.opponent_id || null;
    }
  }

  let related = [];
  if (article.publish_mode === 'youtube_embed') {
    const pureCurated = new Set(_VH_CURATED_SECTIONS.map(s => s.value));
    const cat = article.category;
    const isCurated = pureCurated.has(cat);
    const catFilter = isCurated
      ? `category=eq.${encodeURIComponent(cat)}`
      : `category=not.in.(${[...pureCurated].join(',')})`;
    related = await supabase(env, 'GET',
      `/rest/v1/content_items?site_id=eq.${_VH_SITE_ID}&publish_mode=eq.youtube_embed&status=eq.published&${catFilter}&slug=neq.${encodeURIComponent(slug)}&select=slug,title,image_url&order=published_at.desc&limit=3`
    ) || [];
  }

  return new Response(renderArticleHTML(article, env.API_FOOTBALL_KEY || '', fixtureId, opponentId, related), {
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
  const SITEMAP_NOINDEX_TEMPLATES = ['T10', 'T11', 'T-RED', 'T-VAR', 'T-PEN', 'T-HT'];
  const articleUrls = articles
    .filter(a => a.slug && !SITEMAP_NOINDEX_TEMPLATES.includes(a.template_id || '') && a.publish_mode !== 'rss_summary')
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
  <url><loc>${BASE_URL}/hakkimizda</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>
  <url><loc>${BASE_URL}/iletisim</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>
  <url><loc>${BASE_URL}/editoryal-politika</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>
  <url><loc>${BASE_URL}/gizlilik</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>
  <url><loc>${BASE_URL}/kosullar</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>
${articleUrls}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml;charset=UTF-8',
      'Cache-Control': 'public, max-age=1800',
    },
  });
}

// ─── AD GATING ───────────────────────────────────────────────
const ADSENSE_SCRIPT = `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5282305686231853" crossorigin="anonymous"></script>`;

function shouldShowAds({ templateId, publishMode, bodyLength }) {
  const NO_ADS_TEMPLATES = ['T10','T11','T-RED','T-VAR','T-PEN','T-HT'];
  if (templateId && NO_ADS_TEMPLATES.includes(templateId)) return false;
  if (publishMode === 'rss_summary') return false;
  return (bodyLength || 0) >= 1200;
}

// ─── COOKIE BANNER ───────────────────────────────────────────
function siteCookieBanner() {
  return `<div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;background:#111;border-top:2px solid #E30A17;padding:1rem 1.5rem;z-index:999;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;display:none">
  <p style="color:#ccc;font-size:0.8rem;margin:0;flex:1">Bu site deneyiminizi iyileştirmek için çerezler kullanmaktadır. Siteyi kullanmaya devam ederek çerez politikamızı kabul etmiş olursunuz. <a href="/gizlilik" style="color:#E30A17;text-decoration:none">Gizlilik Politikası</a></p>
  <button onclick="acceptCookies()" style="background:#E30A17;color:white;border:none;padding:0.5rem 1.25rem;border-radius:6px;font-family:'Barlow Condensed',sans-serif;font-size:0.9rem;font-weight:700;cursor:pointer;white-space:nowrap">KABUL ET</button>
</div>
<script>
function acceptCookies(){localStorage.setItem('cookies_accepted','1');document.getElementById('cookie-banner').style.display='none'}
if(!localStorage.getItem('cookies_accepted'))document.getElementById('cookie-banner').style.display='flex';
</script>`;
}

// ─── STATIC PAGE SHELL ───────────────────────────────────────
function renderStaticPage(title, bodyHtml, { path = '/', metaDescription = '' } = {}) {
  const desc = escHtml(metaDescription);
  const pageUrl = `${BASE_URL}${path}`;
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escHtml(title)} | Kartalix</title>
${desc ? `<meta name="description" content="${desc}"/>` : ''}
${desc ? `<meta property="og:title" content="${escHtml(title)} | Kartalix"/>
<meta property="og:description" content="${desc}"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="${pageUrl}"/>
<meta property="og:site_name" content="Kartalix"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="${escHtml(title)} | Kartalix"/>
<meta name="twitter:description" content="${desc}"/>` : ''}
<link rel="canonical" href="${pageUrl}"/>
<link rel="alternate" type="application/rss+xml" title="Kartalix RSS" href="${BASE_URL}/rss"/>
${siteSharedFonts()}
<style>
${siteSharedCSS()}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:16px;line-height:1.7}
a{color:#E30A17;text-decoration:none}a:hover{text-decoration:underline}
main{max-width:720px;margin:0 auto;padding:2.5rem 1.5rem 5rem}
h1{font-size:1.65rem;font-weight:800;color:#fff;margin-bottom:1.5rem;line-height:1.25}
h2{font-size:1.1rem;font-weight:700;color:#fff;margin:2rem 0 0.6rem}
p{color:#c8c6c0;margin-bottom:1.2rem}
ul{padding-left:1.5rem;margin-bottom:1.2rem}
li{color:#c8c6c0;margin-bottom:0.4rem}
hr{border:none;border-top:1px solid #333;margin:1.5rem 0}
@media(max-width:600px){main{padding:1.5rem 1rem 3rem}h1{font-size:1.3rem}}
</style>
</head>
<body>
${siteHeader()}
<main>${bodyHtml}</main>
${siteFooter()}
${siteCookieBanner()}
</body>
</html>`;
}

function renderTestTemplatesPage(siteCode, allSites) {
  const nav = adminNav('test', siteCode, allSites);
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Şablon Test — Kartalix Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;height:100vh;display:flex;flex-direction:column}
.layout{display:flex;height:calc(100vh - 48px);overflow:hidden}
.sidebar{width:340px;flex-shrink:0;background:#1e293b;border-right:1px solid #334155;display:flex;flex-direction:column;overflow:hidden}
.sidebar-top{padding:.8rem;border-bottom:1px solid #334155;flex-shrink:0}
.sidebar-top h2{font-size:.8rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.5rem}
.fixture-list{overflow-y:auto;flex:1}
.fix-item{padding:.6rem .8rem;border-bottom:1px solid #1e293b;cursor:pointer;transition:background .15s}
.fix-item:hover{background:#273348}
.fix-item.active{background:#1d4ed8;border-left:3px solid #60a5fa}
.fix-date{font-size:.7rem;color:#64748b}
.fix-score{font-size:.85rem;font-weight:600;color:#f1f5f9;margin:.1rem 0}
.fix-league{font-size:.7rem;color:#94a3b8}
.fix-loading{padding:1rem;color:#64748b;font-size:.82rem;text-align:center}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.templates-area{padding:.8rem;overflow-y:auto;flex:1}
.templates-area h2{font-size:.8rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.7rem}
.tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.6rem}
.tcard{background:#1e293b;border:1px solid #334155;border-radius:6px;padding:.75rem;cursor:pointer;transition:border-color .15s}
.tcard:hover{border-color:#475569}
.tcard.has-events{border-color:#065f46}
.tcard.no-events{opacity:.5}
.tc-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.4rem}
.tc-label{font-size:.85rem;font-weight:600;color:#f1f5f9}
.tc-badge{font-size:.65rem;background:#065f46;color:#6ee7b7;border-radius:3px;padding:1px 5px}
.tc-badge.none{background:#374151;color:#9ca3af}
.tc-desc{font-size:.72rem;color:#94a3b8;margin-bottom:.5rem}
.tc-events{margin:.4rem 0}
.ev-chip{display:inline-block;background:#1e3a5f;border:1px solid #1d4ed8;border-radius:3px;padding:2px 6px;font-size:.68rem;color:#93c5fd;margin:2px;cursor:pointer}
.ev-chip:hover{background:#1d4ed8;color:#fff}
.ev-chip.selected{background:#1d4ed8;color:#fff}
.tc-btn{width:100%;background:#2563eb;color:#fff;border:none;border-radius:4px;padding:.35rem;cursor:pointer;font-size:.8rem;margin-top:.4rem}
.tc-btn:hover{background:#1d4ed8}
.tc-btn:disabled{background:#334155;color:#64748b;cursor:default}
.preview-panel{width:520px;flex-shrink:0;background:#0f172a;border-left:1px solid #334155;display:flex;flex-direction:column;overflow:hidden}
.preview-header{padding:.6rem .8rem;border-bottom:1px solid #334155;flex-shrink:0;display:flex;align-items:center;justify-content:space-between}
.preview-header span{font-size:.8rem;color:#94a3b8}
.preview-header .ph-title{font-size:.82rem;color:#f1f5f9;font-weight:500;max-width:300px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.preview-body{flex:1;overflow:hidden}
.preview-body iframe{width:100%;height:100%;border:none}
.preview-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#475569;font-size:.85rem}
.spinner{display:inline-block;width:13px;height:13px;border:2px solid #334155;border-top-color:#7dd3fc;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:.3rem}
@keyframes spin{to{transform:rotate(360deg)}}
.err{color:#f87171;font-size:.78rem;padding:.5rem}
</style>
</head>
<body>
${nav}
<div class="layout">

  <!-- Fixture selector -->
  <div class="sidebar">
    <div class="sidebar-top">
      <h2>Son Maçlar</h2>
      <div style="font-size:.72rem;color:#64748b;margin-top:.35rem" id="fix-label">Bir maç seç</div>
    </div>
    <div class="fixture-list" id="fix-list">
      <div class="fix-loading">Yükleniyor…</div>
    </div>
  </div>

  <!-- Template cards -->
  <div class="main">
    <div class="templates-area">
      <h2>Şablonlar</h2>
      <div class="tgrid" id="tgrid">
        <div style="color:#475569;font-size:.82rem">Önce bir maç seç</div>
      </div>
    </div>
  </div>

  <!-- Preview -->
  <div class="preview-panel">
    <div class="preview-header">
      <span class="ph-title" id="prev-title">Önizleme</span>
    </div>
    <div class="preview-body">
      <div class="preview-empty" id="prev-empty">Şablon üret → önizleme burada görünür</div>
      <iframe id="prev-frame" style="display:none"></iframe>
    </div>
  </div>

</div>
<script>
let currentFixture = null;
let currentEvents  = {};
let selectedEvents = {}; // templateId -> event object

const TEMPLATES = [
  // ── Pre-match ────────────────────────────────────────────────
  { id:'T01',   label:'T01 — Maç Önizlemesi',        desc:'H2H + hava durumu + puan durumu',     eventKey: null },
  { id:'T02',   label:'T02 — H2H Tarihi',            desc:'Son 10 karşılaşma özeti',             eventKey: null },
  { id:'T03',   label:'T03 — Form Rehberi',          desc:'Son 5 maç + güncel puan durumu',      eventKey: null },
  { id:'T05',   label:'T05 — Maç Günü Kartı',        desc:'API: sakatlıklar + maç bilgisi',      eventKey: null },
  { id:'T07',   label:'T07 — Sakatlık Raporu',       desc:'API sakatlık + kadro dışı listesi',   eventKey: null },
  { id:'T08b',  label:'T08b — Muhtemel 11',          desc:'Önceki maç kadrosundan tahmin',       eventKey: null },
  { id:'T08c',  label:'T08c — Kadro Tahmini Kartı',  desc:'Son kadro + rakip + sakatlık verisi', eventKey: null },
  { id:'T09',   label:'T09 — Kesin Kadro',           desc:'Resmi kadro, mactan ~60dk once aciklanir', eventKey: null },
  { id:'T-REF', label:'T-REF — Hakem Profili',       desc:'Son 10 BJK maçındaki hakem istatistikleri', eventKey: null },
  // ── Live ─────────────────────────────────────────────────────
  { id:'T-HT',  label:'T-HT — Devre Arası Özeti',   desc:'1. yarı tüm olayları kullanır',       eventKey: 'all' },
  { id:'T10',   label:'T10 — Gol Flash',             desc:'BJK golü — olay seç',                 eventKey: 'goals' },
  { id:'T-RED', label:'T-RED — Kırmızı Kart Flash',  desc:'Kırmızı kart olayı seç',             eventKey: 'red_cards' },
  { id:'T-VAR', label:'T-VAR — VAR Karar Flash',     desc:'VAR olayı seç',                      eventKey: 'var_events' },
  { id:'T-PEN', label:'T-PEN — Kaçırılan Penaltı',   desc:'Kaçırılan penaltı olayı seç',        eventKey: 'missed_pens' },
  // ── Post-match ───────────────────────────────────────────────
  { id:'T11',   label:'T11 — Maç Sonu Flash',        desc:'FT: skor + lig durumu',               eventKey: 'all' },
  { id:'T12',   label:'T12 — Maç Raporu',            desc:'xG + istatistikler + oyuncu notları', eventKey: 'all' },
  { id:'T13',   label:'T13 — Maçın Adamı',           desc:'Oyuncu puanlarından en iyi seçim',    eventKey: null },
  { id:'T-XG',  label:'T-XG — xG Analizi',           desc:'Gol–xG farkı > 1.2 ise tetiklenir',  eventKey: null },
];

function evLabel(ev) {
  if (!ev) return '';
  const min = ev.time?.extra ? ev.time.elapsed+'+'+ev.time.extra : (ev.time?.elapsed || '?');
  const who = ev.player?.name || '';
  const team = ev.team?.name || '';
  return min+"' "+who+(team?" ("+team+")":"");
}

function renderTemplateCards() {
  const grid = document.getElementById('tgrid');
  grid.innerHTML = TEMPLATES.map(t => {
    const evs     = t.eventKey ? (currentEvents[t.eventKey] || []) : null;
    const hasReal = evs === null || evs.length > 0;
    const chips = evs && evs.length > 0
      ? evs.map((ev, i) => \`<span class="ev-chip" data-tid="\${t.id}" data-idx="\${i}" onclick="selectEvent('\${t.id}',\${i})">\${evLabel(ev)}</span>\`).join('')
      : (evs !== null ? '<span style="font-size:.7rem;color:#94a3b8;font-style:italic">Mock olay ile test edilecek</span>' : '');
    const badge = evs === null ? 'API' : evs.length > 0 ? evs.length+' olay' : 'mock';
    return \`<div class="tcard has-events" id="tc-\${t.id}">
      <div class="tc-head">
        <span class="tc-label">\${t.label}</span>
        <span class="tc-badge \${hasReal?'':'none'}">\${badge}</span>
      </div>
      <div class="tc-desc">\${t.desc}</div>
      \${chips ? '<div class="tc-events">'+chips+'</div>' : ''}
      <button class="tc-btn" id="btn-\${t.id}" onclick="runTemplate('\${t.id}')">▶ Üret</button>
    </div>\`;
  }).join('');
}

function selectEvent(tid, idx) {
  const t = TEMPLATES.find(x => x.id === tid);
  if (!t || !t.eventKey) return;
  const evs = currentEvents[t.eventKey] || [];
  selectedEvents[tid] = evs[idx];
  document.querySelectorAll(\`[data-tid="\${tid}"] .ev-chip\`).forEach((c,i) => {
    c.classList.toggle('selected', i === idx);
  });
}

async function loadFixtures() {
  const list = document.getElementById('fix-list');
  let data;
  try {
    const r = await fetch('/admin/test-templates/recent-fixtures');
    if (!r.ok) { list.innerHTML = '<div class="fix-loading err">HTTP '+r.status+'</div>'; return; }
    data = await r.json();
  } catch(e) {
    list.innerHTML = '<div class="fix-loading err">Yüklenemedi: '+e.message+'</div>';
    return;
  }
  if (data.error || !data.fixtures?.length) {
    list.innerHTML = '<div class="fix-loading">'+(data.error || 'Maç bulunamadı (API boş döndü)')+'</div>';
    return;
  }
  list.innerHTML = data.fixtures.map((f,i) => {
    const result = f.score_bjk > f.score_opp ? 'G' : f.score_bjk === f.score_opp ? 'B' : 'M';
    const col    = result==='G'?'#6ee7b7':result==='B'?'#fbbf24':'#f87171';
    return \`<div class="fix-item" onclick="selectFixture(\${JSON.stringify(f).replace(/"/g,'&quot;')})">
      <div class="fix-date">\${f.date} · \${f.league}</div>
      <div class="fix-score">Beşiktaş \${f.score_bjk??'?'}-\${f.score_opp??'?'} \${f.opponent} <span style="color:\${col};font-size:.7rem">\${result}</span></div>
      <div class="fix-league">Fixture #\${f.fixture_id}</div>
    </div>\`;
  }).join('');
}

async function selectFixture(f) {
  currentFixture = f;
  selectedEvents = {};
  document.querySelectorAll('.fix-item').forEach((el,i) => el.classList.remove('active'));
  event.currentTarget.classList.add('active');
  document.getElementById('fix-label').textContent = 'Beşiktaş '+f.score_bjk+'-'+f.score_opp+' '+f.opponent+' ('+f.date+')';
  document.getElementById('tgrid').innerHTML = '<div style="color:#64748b;font-size:.82rem">Olaylar yükleniyor…</div>';
  const r    = await fetch('/admin/test-templates/fixture-events?fixture_id='+f.fixture_id);
  const data = await r.json();
  currentEvents = data.events || {};
  renderTemplateCards();
  // Auto-select first event for each template
  TEMPLATES.forEach(t => {
    if (t.eventKey && currentEvents[t.eventKey]?.length > 0) selectEvent(t.id, 0);
  });
}

async function runTemplate(id) {
  const btn = document.getElementById('btn-'+id);
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Üretiliyor…';

  const body = { template: id, fixture_id: currentFixture?.fixture_id };
  const ev = selectedEvents[id];
  if (ev) {
    body.event_data = {
      ...ev,
      score_bjk: currentFixture?.score_bjk ?? 0,
      score_opp: currentFixture?.score_opp ?? 0,
    };
  }

  try {
    const r = await fetch('/admin/test-templates', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const data = await r.json();
    if (data.error) {
      alert('Hata: '+data.error);
    } else {
      document.getElementById('prev-title').textContent = data.title || '(başlıksız)';
      document.getElementById('prev-empty').style.display = 'none';
      const frame = document.getElementById('prev-frame');
      frame.style.display = 'block';
      frame.srcdoc = data.html || '<p>İçerik yok</p>';
    }
  } catch(e) { alert('İstek hatası: '+e.message); }

  btn.disabled = false;
  btn.textContent = '▶ Üret';
}

loadFixtures();
</script>
</body>
</html>`;
}

// ─── VIDEO HUB PAGE ──────────────────────────────────────────
const _VH_SITE_ID = '2b5cfe49-b69a-4143-8323-ca29fff6502e';
const _VH_DAY = 864e5;
const _VH_CURATED_SECTIONS = [
  { value: 'belgeseller', label: 'Belgeseller', icon: '🎬' },
  { value: 'unutulmaz',   label: 'Unutulmazlar', icon: '⭐' },
];
const _VH_ALL_SECTION_MAP = {
  haber:       { label: 'Haber',         video_type: 'news',              category: 'haber' },
  mac:         { label: 'Maç Özeti',     video_type: 'generic_highlight', category: 'mac' },
  roportaj:    { label: 'Röportaj',      video_type: 'generic_interview', category: 'roportaj' },
  belgeseller: { label: 'Belgeseller',   video_type: 'news',              category: 'belgeseller' },
  unutulmaz:   { label: 'Unutulmazlar',  video_type: 'news',              category: 'unutulmaz' },
};

function _vhRelDate(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins || 1} dakika önce`;
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 24) return `${hrs} saat önce`;
  if (diff < 2 * _VH_DAY) return 'Dün';
  const days = Math.floor(diff / _VH_DAY);
  if (days < 7) return `${days} gün önce`;
  if (diff < 30 * _VH_DAY) return `${Math.floor(days / 7)} hafta önce`;
  return new Date(iso).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function _vhEsc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _vhAdSlot(type, id) {
  return `<div class="ad-slot ad-${type}" data-ad-slot="${type}-${id}"><!-- AdSense code injected after approval --></div>`;
}

function _vhCard(v, extraClass = '') {
  const cls   = 'vh-card' + (extraClass ? ' ' + extraClass : '');
  const href  = v.href || (v.slug ? `/haber/${_vhEsc(v.slug)}` : '#');
  const tgt   = v.href ? ' target="_blank" rel="noopener"' : '';
  const img   = _vhEsc(v.image_url || '');
  const title = _vhEsc(v.title || '');
  const src   = _vhEsc(v.source_name || '');
  const date  = v.published_at ? _vhRelDate(v.published_at) : '';
  return `<a class="${cls}" href="${href}"${tgt}><div class="vh-thumb"><img src="${img}" loading="lazy" alt="${title}"><div class="vh-play">▶</div></div><div class="vh-meta"><h3 class="vh-title">${title}</h3><div class="vh-source">${src} · ${date}</div></div></a>`;
}

function _vhGrid(videos, injectAds) {
  let html = '<div class="vh-grid">';
  videos.forEach((v, i) => {
    html += _vhCard(v);
    if (injectAds && (i + 1) % 10 === 0) html += _vhAdSlot('native', i);
  });
  return html + '</div>';
}

function _vhGridReveal(videos, injectAds) {
  let html = '<div class="vh-grid">';
  videos.forEach((v, i) => {
    html += _vhCard(v, i >= 12 ? 'vh-hidden' : '');
    if (injectAds && (i + 1) % 10 === 0) html += `<div class="vh-ad-slot-wrap" style="display:none">${_vhAdSlot('native', i)}</div>`;
  });
  html += '</div>';
  if (videos.length > 12) html += `<button class="vh-reveal-btn" type="button">Devamını Göster (12)</button>`;
  return html;
}

function _vhSection(label, icon, videos, activeTip) {
  if (activeTip && !videos.length) {
    return `<section class="vh-section"><div class="vh-sec-head"><span class="vh-sec-icon">${icon}</span><span class="vh-sec-label">${label}</span></div><div class="vh-empty"><p>Şu anda yeni içerik yok.</p><a href="/konu/videolar">← Tüm videolar</a></div></section>`;
  }
  const grid = activeTip ? _vhGridReveal(videos, true) : _vhGrid(videos, false);
  return `<section class="vh-section"><div class="vh-sec-head"><span class="vh-sec-icon">${icon}</span><span class="vh-sec-label">${label}</span></div>${grid}</section>`;
}

async function renderVideoHubPage(tip, env) {
  const _VH_INTERVIEW_TYPES = new Set(['coach_interview','president_interview','player_interview','generic_interview']);
  const _VH_HIGHLIGHT_TYPES = new Set(['match_highlight','generic_highlight']);
  const _VH_CURATED_TYPES   = new Set(_VH_CURATED_SECTIONS.map(s => s.value));
  const _VH_CURATED_CATS    = new Set(Object.keys(_VH_ALL_SECTION_MAP));

  const validTips = ['haber', 'mac', 'roportaj', ..._VH_CURATED_SECTIONS.map(s => s.value)];
  const activeTip = validTips.includes(tip) ? tip : '';

  const [rows, curatedOrderRaw] = await Promise.all([
    supabase(env, 'GET',
      `/rest/v1/content_items?select=slug,title,source_name,published_at,image_url,video_type,category&site_id=eq.${_VH_SITE_ID}&publish_mode=eq.youtube_embed&status=eq.published&order=published_at.desc&limit=500`
    ),
    env.PITCHOS_CACHE.get('curated:order'),
  ]);
  const curatedOrderMap = curatedOrderRaw ? Object.fromEntries(JSON.parse(curatedOrderRaw).map((s, i) => [s, i])) : null;

  const now = Date.now();
  const videos = rows.filter(v => {
    const age = now - new Date(v.published_at).getTime();
    if (_VH_HIGHLIGHT_TYPES.has(v.video_type) || _VH_CURATED_CATS.has(v.category)) return true;
    if (_VH_INTERVIEW_TYPES.has(v.video_type)) return age < 7 * _VH_DAY;
    return age < 7 * _VH_DAY;
  });

  const _VH_PURE_CURATED_CATS = new Set(_VH_CURATED_SECTIONS.map(s => s.value));
  const allRows = rows || [];

  function _vhWithMin(ageFiltered, typeFilter, min = 12) {
    if (ageFiltered.length >= min) return ageFiltered;
    const seen = new Set(ageFiltered.map(v => v.slug));
    const extra = allRows.filter(v => typeFilter(v) && !seen.has(v.slug));
    return [...ageFiltered, ...extra.slice(0, min - ageFiltered.length)];
  }

  const haberFilter    = v => v.video_type === 'news' && !_VH_PURE_CURATED_CATS.has(v.category);
  const macFilter      = v => _VH_HIGHLIGHT_TYPES.has(v.video_type) && !_VH_PURE_CURATED_CATS.has(v.category);
  const roportajFilter = v => _VH_INTERVIEW_TYPES.has(v.video_type) && !_VH_PURE_CURATED_CATS.has(v.category);

  const byType = {
    haber:    _vhWithMin(videos.filter(haberFilter),    haberFilter),
    mac:      _vhWithMin(videos.filter(macFilter),      macFilter),
    roportaj: _vhWithMin(videos.filter(roportajFilter), roportajFilter),
  };
  for (const s of _VH_CURATED_SECTIONS) {
    let vids = videos.filter(v => v.category === s.value);
    if (curatedOrderMap) vids.sort((a, b) => (curatedOrderMap[a.slug] ?? 99999) - (curatedOrderMap[b.slug] ?? 99999));
    byType[s.value] = vids;
  }

  const sectionDefs = [
    { key: 'haber',    label: 'Haber Videoları', icon: '📰' },
    { key: 'mac',      label: 'Maç Özetleri',    icon: '⚽' },
    { key: 'roportaj', label: 'Röportajlar',      icon: '🎙️' },
    ..._VH_CURATED_SECTIONS.map(s => ({ key: s.value, label: s.label, icon: s.icon })),
  ];

  let sectionsHtml = '';
  let rendered = 0;
  for (const def of sectionDefs) {
    const vids = byType[def.key];
    if (!activeTip && !vids.length) continue;
    if (activeTip && activeTip !== def.key) continue;
    if (rendered > 0 && !activeTip) sectionsHtml += _vhAdSlot('banner', `between-${def.key}`);
    const shown = activeTip ? vids : vids.slice(0, 8);
    sectionsHtml += _vhSection(def.label, def.icon, shown, activeTip);
    rendered++;
  }
  if (!sectionsHtml) sectionsHtml = '<div style="padding:3rem;text-align:center;color:#555">Bu dönemde video bulunamadı.</div>';

  const pageTitleMap = { haber: 'Haber Videoları', mac: 'Maç Özetleri', roportaj: 'Röportajlar' };
  for (const s of _VH_CURATED_SECTIONS) pageTitleMap[s.value] = s.label;
  const pageTitle = pageTitleMap[activeTip] || 'Videolar';
  const canonical = activeTip ? `/konu/videolar?tip=${activeTip}` : '/konu/videolar';

  const tabs = [
    { key: '', label: 'Tümü' },
    { key: 'haber', label: 'Haber' },
    { key: 'mac', label: 'Maç Özetleri' },
    { key: 'roportaj', label: 'Röportajlar' },
    ..._VH_CURATED_SECTIONS.map(s => ({ key: s.value, label: s.label })),
  ].map(t => {
    const href = t.key ? `/konu/videolar?tip=${t.key}` : '/konu/videolar';
    return `<a class="vh-tab${t.key === activeTip ? ' vh-tab-active' : ''}" href="${href}">${t.label}</a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${_vhEsc(pageTitle)} | Kartalix</title>
  <meta name="description" content="Beşiktaş YouTube videoları — haberler, maç özetleri ve röportajlar." />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="https://kartalix.com${canonical}" />
  ${siteSharedFonts()}
  <style>
    ${siteSharedCSS()}
    :root{--accent:#E30A17;--bg:#1a1a1a;--surface:#0f0f0f;--text-on-dark:#fff;--border:#222}
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    body{background:var(--bg);color:var(--text-on-dark);font-family:'Inter',sans-serif;min-height:100vh}
    .vh-tabs{display:flex;overflow-x:auto;scrollbar-width:none;background:#111;border-bottom:1px solid var(--border);padding:0 1rem;gap:.1rem}
    .vh-tabs::-webkit-scrollbar{display:none}
    .vh-tab{font-family:'Barlow Condensed',sans-serif;font-size:.8rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;color:#666;padding:.65rem 1rem;border-bottom:2px solid transparent;white-space:nowrap;transition:color .15s,border-color .15s}
    .vh-tab:hover{color:#ccc}
    .vh-tab-active{color:#fff;border-bottom-color:var(--accent)}
    .vh-ad-top{padding:.75rem 1.25rem}
    .vh-section{padding:1.25rem 1.25rem .75rem;overflow-x:hidden}
    .vh-sec-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.9rem;border-left:3px solid var(--accent);padding-left:.75rem}
    .vh-sec-icon{font-size:1.05rem}
    .vh-sec-label{font-family:'Barlow Condensed',sans-serif;font-size:1.1rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase}
    .vh-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem;width:100%;max-width:100%}
    .vh-card{display:block;text-decoration:none;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;transition:border-color .2s;min-width:0}
    .vh-card:hover{border-color:var(--accent)}
    .vh-thumb{position:relative;aspect-ratio:16/9;overflow:hidden;background:#000}
    .vh-thumb img{width:100%;height:100%;object-fit:cover;display:block}
    .vh-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
    .vh-play::after{content:'▶';font-size:1.4rem;color:#fff;background:rgba(0,0,0,.5);width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;padding-left:3px}
    .vh-meta{padding:.55rem .65rem .65rem}
    .vh-title{font-size:.82rem;font-weight:600;line-height:1.4;color:#e5e5e5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:.3rem;min-width:0;word-break:break-word;overflow-wrap:anywhere}
    .vh-source{font-size:.7rem;color:#666}
    .ad-slot{background:transparent}
    .ad-leaderboard{min-height:100px;width:100%;max-width:320px;margin:0 auto;display:block}
    .ad-banner{min-height:100px;width:100%;max-width:320px;margin:.5rem auto;display:block}
    .ad-native{aspect-ratio:16/9;background:var(--surface);border:1px dashed var(--border);border-radius:8px;min-width:0}
    .vh-empty{padding:2rem 1rem;text-align:center;color:#555;font-size:.88rem}
    .vh-empty a{color:var(--accent);text-decoration:none;display:inline-block;margin-top:.5rem}
    .vh-card.vh-hidden{display:none}
    .vh-reveal-btn{display:block;margin:1.25rem auto .5rem;padding:.6rem 1.75rem;background:var(--accent);color:#fff;border:none;border-radius:6px;font-family:'Barlow Condensed',sans-serif;font-size:.95rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;cursor:pointer}
    .vh-reveal-btn:hover{opacity:.85}
    @media(min-width:768px){
      .vh-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem}
      .vh-section{padding:1.75rem 2rem 1rem}
      .vh-ad-top{padding:1rem 2rem}
      .ad-leaderboard,.ad-banner{max-width:728px;min-height:90px}
      .vh-title{font-size:.88rem}
    }
  </style>
</head>
<body>
${siteHeader('/konu/videolar')}
<nav class="vh-tabs">${tabs}</nav>
<div class="vh-ad-top">${_vhAdSlot('leaderboard', 'top')}</div>
${sectionsHtml}
${siteFooter()}
<script>
document.querySelectorAll('.vh-tab').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    history.pushState({}, '', a.href);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    window.location = a.href;
  });
});
document.querySelectorAll('.vh-reveal-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const grid = btn.previousElementSibling;
    const hidden = [...grid.querySelectorAll('.vh-card.vh-hidden')];
    hidden.slice(0, 12).forEach(c => c.classList.remove('vh-hidden'));
    grid.querySelectorAll('.vh-ad-slot-wrap').forEach(w => w.style.display = '');
    if (!grid.querySelectorAll('.vh-card.vh-hidden').length) btn.style.display = 'none';
  });
});
</script>
${siteCookieBanner()}
</body>
</html>`;
}

const TOPIC_META = {
  transfer: { label: 'Transfer', title: 'Transfer Haberleri', desc: 'Beşiktaş transfer haberleri — resmi açıklamalar, dedikodular ve analizler.', filter: 'category', cats: ['transfer'] },
  mac:      { label: 'Maç',      title: 'Maç Haberleri',      desc: 'Beşiktaş maç haberleri, şablon analizleri ve skor raporları.',               filter: 'template', cats: [] },
  videolar: { label: 'Videolar', title: 'Videolar',            desc: 'Beşiktaş ile ilgili seçilmiş YouTube videoları.',                            filter: 'video',    cats: [] },
};

function renderTopicPage(topicSlug) {
  const meta = TOPIC_META[topicSlug];
  if (!meta) {
    return `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Kartalix</title></head><body><p>Konu bulunamadı. <a href="/">Ana sayfa</a></p></body></html>`;
  }
  const catFilter = JSON.stringify(meta.cats || []);
  const filterMode = meta.filter || 'category';
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${meta.title} | Kartalix</title>
  <meta name="description" content="${meta.desc}" />
  <meta name="robots" content="index, follow" />
  ${siteSharedFonts()}
  <style>
    ${siteSharedCSS()}
    :root{--accent:#E30A17;--bg:#1a1a1a;--surface:#fff;--text:#111;--text-on-dark:#fff;--muted:#6b7280;--border:#e5e7eb}
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    body{background:var(--bg);color:var(--text-on-dark);font-family:'Inter',sans-serif;min-height:100vh}
    .page-header{padding:2rem;border-bottom:1px solid #222}
    .page-title{font-family:'Barlow Condensed',sans-serif;font-size:2.2rem;font-weight:800;letter-spacing:.03em}
    .page-desc{color:#999;font-size:.85rem;margin-top:.4rem}
    .article-grid{padding:1.5rem 2rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1.25rem}
    .art-card{background:#0f0f0f;border:1px solid #222;border-radius:6px;padding:1rem;cursor:pointer;transition:border-color .15s;text-decoration:none;display:block}
    .art-card:hover{border-color:var(--accent)}
    .art-card-title{font-size:.9rem;font-weight:600;line-height:1.4;color:#e5e5e5;margin-bottom:.5rem}
    .art-card-meta{display:flex;gap:.5rem;align-items:center;font-size:.7rem;color:#555;flex-wrap:wrap}
    .art-card-source{color:#E30A17;font-weight:600}
    .art-card-summary{font-size:.78rem;color:#777;margin-top:.5rem;line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    .empty{padding:3rem 2rem;color:#555;text-align:center;font-size:.9rem}
    @media(max-width:640px){.article-grid{grid-template-columns:1fr}.page-header,.article-grid{padding:1rem}}
  </style>
</head>
<body>
${siteHeader(`/konu/${topicSlug}`)}
<div class="page-header">
  <div class="page-title">${meta.title}</div>
  <div class="page-desc">${meta.desc}</div>
</div>
<div id="grid" class="article-grid"><p style="color:#555;padding:1rem">Yükleniyor…</p></div>
<script>
const FILTER_MODE = '${filterMode}';
const CATS = ${catFilter};
async function init() {
  const grid = document.getElementById('grid');
  try {
    const res = await fetch('https://kartalix.com/cache');
    if (!res.ok) throw new Error('cache ' + res.status);
    const all = await res.json();
    const articles = all.filter(a => {
      if (FILTER_MODE === 'video') {
        const pm = (a.publish_mode || '').toLowerCase();
        return pm.startsWith('youtube') || pm === 'video_embed';
      }
      if (FILTER_MODE === 'template') {
        return !!a.template_id;
      }
      const cat = (a.category || '').toLowerCase();
      return CATS.some(c => cat.includes(c));
    });
    if (!articles.length) { grid.innerHTML = '<div class="empty">Bu kategoride haber bulunamadı.</div>'; return; }
    grid.innerHTML = articles.map(a => {
      const href = a.slug ? '/haber/' + a.slug : '#';
      const date = a.published_at ? new Date(a.published_at).toLocaleDateString('tr-TR',{day:'2-digit',month:'short'}) : '';
      const src  = a.is_kartalix_content || a.source_name === 'Kartalix' ? 'Kartalix' : (a.source_name || a.source || '');
      return '<a class="art-card" href="' + href + '"><div class="art-card-title">' + esc(a.title||'') + '</div><div class="art-card-meta"><span class="art-card-source">' + esc(src) + '</span><span>' + date + '</span></div>' + (a.summary ? '<div class="art-card-summary">' + esc(a.summary) + '</div>' : '') + '</a>';
    }).join('');
  } catch(e) { grid.innerHTML = '<div class="empty">Haberler yüklenemedi: ' + e.message + '</div>'; }
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
init();
</script>
${siteFooter()}
${siteCookieBanner()}
</body>
</html>`;
}

function renderAboutPage() {
  return renderStaticPage('Hakkımızda', `
<h1>Hakkımızda</h1>
<p>Merhaba, ben Ali Gencer. Kartalix'i 2025 yılında kurdum — çünkü güvenilir, bağımsız bir Beşiktaş haber kaynağının eksikliğini hissediyordum.</p>
<p>Küçüklüğümden beri siyah-beyazlıyım. Yıllar içinde Türk spor basınını takip ettikçe bir sorunla yüzleştim: önemli haberler click-bait başlıkların arkasına gizleniyor, transfer iddiaları doğrulanmadan gerçekmiş gibi sunuluyor, temel istatistikler çoğu zaman yanlış aktarılıyor. Taraftara gerçekten yararlı olacak bir platform yaratmak istedim.</p>
<h2>Nasıl Çalışıyoruz?</h2>
<p>Kartalix'te haberler onlarca Türk spor kaynağından ve resmi veri sağlayıcılarından derleniyor. Her içerik otomatik bir haber değeri puanlamasından geçiyor. Yüksek değerli içerikler için yapay zeka araçlarıyla taslak oluşturuluyor — ancak her makale yayımlanmadan önce editörlerimiz tarafından kontrol ediliyor ve kaynakları doğrulanıyor.</p>
<p>YZ araçlarını kullandığımızı saklayacak bir sebebimiz yok; aksine bu araçlar sayesinde daha fazla haberi daha hızlı takip edebiliyoruz. Ama sorumluluk bize ait: bir hata yaptığımızda biz düzeltiyoruz.</p>
<h2>Bağımsızlık</h2>
<p>Kartalix, Beşiktaş JK ile resmi bir bağlantısı bulunmayan tamamen bağımsız bir yayın organıdır. Kulüp, sponsor veya herhangi bir yatırımcı tarafından yönlendirilmiyoruz. Editoryal kararlarımız yalnızca okuyuculara karşı sorumluluk anlayışıyla alınır.</p>
<h2>İletişim</h2>
<p>Haber düzeltmeleri, öneriler ve geri bildiriminiz için: <a href="/iletisim">iletişim sayfamız</a>.</p>
`, { path: '/hakkimizda', metaDescription: 'Kartalix, Beşiktaş futbol haberlerini yapay zekâ destekli editöryal süreçle sunan bağımsız bir kişisel projedir. Misyonumuzu ve yaklaşımımızı keşfedin.' });
}

function renderContactPage() {
  return renderStaticPage('İletişim', `
<h1>İletişim</h1>
<p>Kartalix kurucusu Ali Gencer ile iletişime geçmek için aşağıdaki e-posta adresini kullanabilirsiniz.</p>
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
`, { path: '/iletisim', metaDescription: 'Kartalix ile iletişime geçin. Geri bildirim, hata bildirimi, telif hakkı veya içerik talepleri için iletisim@kartalix.com adresini kullanabilirsiniz.' });
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
`, { path: '/kaynak-atif', metaDescription: 'Kartalix kaynak atıf yaklaşımı: sentezlenmiş haberlerin nasıl hazırlandığı, kaynak gösterimi ve YouTube gömme politikası hakkında açıklamalar.' });
}

function renderEditorialPolicyPage() {
  return renderStaticPage('Editoryal Politika', `
<h1>Editoryal Politika</h1>
<h2>Kaynak Seçimi</h2>
<p>Kartalix, Türk spor basınından seçilmiş onlarca RSS kaynağı, resmi kulüp açıklamaları ve API-Football gibi lisanslı istatistik sağlayıcılarından içerik toplamaktadır. Kaynaklar, güvenilirlik geçmişine göre derecelendirilir; düşük güvenilirliğe sahip kaynaklar içerik puanlamasında dezavantajlı konumda başlar.</p>
<h2>Yapay Zekanın Rolü</h2>
<p>Yüksek haber değeri taşıyan içerikler için yapay zeka modelleri (Claude, Anthropic) kullanılarak taslak oluşturulmaktadır. YZ modelleri metin yazımında yardımcı olur; neyin yayımlanacağı, neyin reddedileceği ve hangi haberin öne çıkarılacağı gibi gazetecilik kararları editörlere aittir.</p>
<h2>İnsan Denetimi</h2>
<p>Otomatik üretilen içerikler yayımlanmadan önce editör incelemesine tabi tutulabilir. Doğrulama gerektiren içerikler inceleme kuyruğuna alınır. Hatalarımızın sorumluluğunu üstleniyoruz ve düzeltmeleri kamuoyuyla paylaşıyoruz.</p>
<h2>Kaynak Atıf</h2>
<p>Tek kaynaktan yapılan haberlerde orijinal kaynak ve bağlantısı makalenin alt kısmında gösterilir. Çok kaynaklı sentez içeriklerde katkıda bulunan kaynaklar listelenir. İstatistik verileri için API-Football ve resmi kulüp kaynakları kullanılır.</p>
<h2>Spekülatif İçerik</h2>
<p>Transfer iddiaları, olası 11'ler ve resmi olarak doğrulanmamış haberler açıkça etiketlenir. "İddia ediliyor", "görüşmeler sürüyor" gibi ifadeler bilginin henüz kesinleşmediğini gösterir.</p>
<h2>Düzeltme Politikası</h2>
<p>Yayımlanmış bir haberde hata tespit edildiğinde makale güncellenir ve değişiklik belirtilir. Düzeltme taleplerinizi <a href="/iletisim">iletişim sayfamız</a> aracılığıyla iletebilirsiniz; doğrulanan düzeltmeler en kısa sürede yayımlanır.</p>
<h2>Editoryal İletişim</h2>
<p>İçeriklerimize ilişkin sorularınız için: <a href="mailto:iletisim@kartalix.com">iletisim@kartalix.com</a> — Ali Gencer, Kurucu Editör.</p>
`, { path: '/editoryal-politika', metaDescription: 'Kartalix editöryal politikası: yapay zekâ destekli içerik üretimi, kaynak seçimi, doğrulama süreçleri ve düzeltme prensipleri.' });
}

function renderPrivacyPage() {
  const date = '16 Mayıs 2026';
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
`, { path: '/gizlilik', metaDescription: 'Kartalix Gizlilik Politikası: çerez kullanımı, üçüncü taraf reklam hizmetleri, veri toplama uygulamaları ve kullanıcı haklarına ilişkin detaylar.' });
}

function renderTermsPage() {
  return renderStaticPage('Kullanım Koşulları', `
<h1>Kartalix Kullanım Koşulları</h1>
<p><strong>Son güncelleme:</strong> 27 Mayıs 2026</p>
<p>Kartalix'e (kartalix.com) hoş geldiniz. Bu Kullanım Koşulları ("Koşullar"), siteyi kullanımınızı düzenler. Siteye erişerek veya içeriği kullanarak bu Koşulları kabul etmiş sayılırsınız. Koşulları kabul etmiyorsanız lütfen siteyi kullanmayınız.</p>
<hr>
<h2>1. Hizmet Kapsamı</h2>
<p>Kartalix, Beşiktaş Jimnastik Kulübü ile ilgili futbol haberlerini derleyen, sentezleyen ve sunan bağımsız bir içerik platformudur. Site, çeşitli kaynaklardan elde edilen bilgileri yapay zekâ destekli editöryal süreçlerle yeniden işler ve okuyuculara erişilebilir bir biçimde sunar.</p>
<p>Kartalix:</p>
<ul>
  <li>Beşiktaş Jimnastik Kulübü'nün resmî kulübü, iştiraki veya temsilcisi <strong>değildir</strong></li>
  <li>Resmî bir spor veya haber kuruluşu olarak yetkilendirilmemiştir</li>
  <li>Kişisel bir proje olarak işletilir</li>
  <li>İçerikleri kâr amacı gözetmeksizin bilgilendirme amacıyla sunar</li>
</ul>
<hr>
<h2>2. İçerik ve Telif Hakkı</h2>
<h2>2.1 Kartalix İçeriği</h2>
<p>Kartalix üzerindeki içerik birden fazla yöntemle hazırlanır:</p>
<ul>
  <li><strong>Sentezlenmiş haberler:</strong> Birden çok kaynağın yapay zekâ destekli olarak yeniden yazılmasıyla oluşturulur</li>
  <li><strong>Şablon haberler:</strong> Maç günü, transfer, sakatlık gibi yapılandırılmış kısa içerikler</li>
  <li><strong>Özet kartlar:</strong> Kaynak özetinin kısa biçimi (bu kartlar arama motorlarına kapalıdır)</li>
  <li><strong>Video makaleler:</strong> YouTube videolarının açıklayıcı metinlerle birlikte sunumu</li>
</ul>
<p>Her haberde kaynak ismi ve URL'si açıkça belirtilir; yapay zekâ desteğiyle hazırlanan içerikler "YZ destekli" rozetiyle gösterilir.</p>
<p>Bu içeriklerin telif hakları Kartalix'e aittir. Bireysel okuma serbesttir; ticari kullanım veya yeniden yayın için yazılı izin gerekir.</p>
<h2>2.2 Üçüncü Taraf İçerikleri</h2>
<p><strong>YouTube Videoları:</strong> Kartalix, YouTube'un sağladığı standart gömme (embed) protokolü ile içerik gösterir. Yalnızca yayıncının gömmeye açık olarak işaretlediği videolar gömülür.</p>
<p><strong>Kaynak Haberler:</strong> Sentezlenmiş haberlerde kaynak haberin URL'si açıkça belirtilir. Bu bağlantılar yalnızca atıf amaçlıdır; bağlantı verilen sitelerin içerik veya kullanım politikaları Kartalix'in sorumluluğunda değildir.</p>
<h2>2.3 Görseller</h2>
<p>Video makaleler için YouTube'un standart thumbnail servisi (img.youtube.com) kullanılır. Diğer makalelerde ilgili kaynağın og:image meta verisi referans alınır; görsel doğrudan kaynak siteden yüklenir.</p>
<p>Bir görselin kaldırılmasını talep eden hak sahipleri <a href="mailto:iletisim@kartalix.com">iletisim@kartalix.com</a> adresinden başvurabilir. Geçerli talepler 48 saat içinde değerlendirilir.</p>
<hr>
<h2>3. Kullanıcı Davranış Kuralları</h2>
<p>Kartalix'i kullanırken aşağıdaki kurallara uymayı kabul edersiniz:</p>
<ul>
  <li>Siteye erişimi engelleyecek otomatik araçlar (bot, scraper) kullanmamak</li>
  <li>Site içeriğini izinsiz olarak büyük ölçekte indirip yeniden yayınlamamak</li>
  <li>Sitenin teknik altyapısına zarar verecek girişimlerde bulunmamak</li>
  <li>Yanıltıcı veya yasadışı amaçlarla site içeriğine atıfta bulunmamak</li>
</ul>
<hr>
<h2>4. Sorumluluk Sınırlamaları</h2>
<h2>4.1 Bilgi Doğruluğu</h2>
<p>Kartalix, içeriklerin doğruluğu için makul özen gösterir; ancak içerikler birden fazla kaynaktan derlenir ve kaynaklardaki hatalar yansıyabilir. Spor haberleri hızla değişebilir; yayın anındaki bilgi sonradan güncellenmiş olabilir. Hata bildirimleri için <a href="mailto:iletisim@kartalix.com">iletisim@kartalix.com</a> adresini kullanabilirsiniz.</p>
<h2>4.2 Genel Sorumluluk Reddi</h2>
<p>Kartalix, sunulan içeriğin kullanımından doğabilecek herhangi bir zarardan sorumlu tutulamaz. İçerikler "olduğu gibi" sunulur; herhangi bir garanti içermez.</p>
<h2>4.3 Üçüncü Taraf Bağlantıları</h2>
<p>Kaynak sitelere veya YouTube videolarına verilen bağlantılar, kullanıcının kendi sorumluluğunda erişimine sunulur. Bağlantı verilen sitelerin içerik veya kullanım politikaları Kartalix'in sorumluluğunda değildir.</p>
<hr>
<h2>5. Reklamlar ve Üçüncü Taraf Hizmetleri</h2>
<p>Site, Google AdSense gibi reklam hizmetleri aracılığıyla reklam gösterebilir. Bu hizmetler kullanıcı bilgilerini kendi politikaları çerçevesinde işler. Detaylar için <a href="/gizlilik">Gizlilik Politikası</a> sayfamıza bakınız.</p>
<hr>
<h2>6. Hizmet Sürekliliği</h2>
<p>Kartalix, herhangi bir bildirim yapmaksızın site içeriğini güncellemek veya silmek, hizmeti geçici veya kalıcı olarak durdurmak, site özelliklerini değiştirmek haklarını saklı tutar.</p>
<hr>
<h2>7. Değişiklikler</h2>
<p>Kartalix bu Koşulları gerektiğinde güncelleyebilir. Önemli değişiklikler olduğunda sayfanın üst kısmındaki "Son güncelleme" tarihi yenilenir. Değişikliklerden sonra siteyi kullanmaya devam etmeniz, güncel Koşulları kabul ettiğiniz anlamına gelir.</p>
<hr>
<h2>8. Uygulanacak Hukuk ve Yetki</h2>
<p>Bu Koşullar Türkiye Cumhuriyeti yasalarına tabidir. Koşullardan kaynaklanan uyuşmazlıklarda İstanbul mahkemeleri yetkilidir.</p>
<hr>
<h2>9. İletişim</h2>
<p>Bu Koşullar hakkında soru, görüş veya itirazlarınız için: <a href="mailto:iletisim@kartalix.com">iletisim@kartalix.com</a></p>
<p style="margin-top:2rem;font-size:0.82rem;color:#666">İlgili sayfalar: <a href="/hakkimizda">Hakkımızda</a> · <a href="/editoryal-politika">Editoryal Politika</a> · <a href="/gizlilik">Gizlilik Politikası</a> · <a href="/kaynak-atif">Kaynak Atıf</a></p>
`, { path: '/kosullar', metaDescription: 'Kartalix Kullanım Koşulları: site kullanımına ilişkin kurallar, içerik telif hakkı, sorumluluk sınırlamaları ve iletişim bilgileri.' });
}

// ─── SHARED SITE CHROME ──────────────────────────────────────
function siteSharedFonts() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&display=swap" rel="stylesheet"/>`;
}

function siteSharedCSS() {
  return `
header{background:#0d0d0d;border-bottom:2px solid #E30A17;height:60px;display:flex;align-items:center;justify-content:space-between;padding:0 1.5rem;position:sticky;top:0;z-index:100}
.logo-link{text-decoration:none;display:flex;align-items:center}
.header-right{display:flex;align-items:center;gap:1rem}
.live-pill{display:flex;align-items:center;gap:.4rem;font-family:'Barlow Condensed',sans-serif;font-size:.65rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#E30A17;border:1px solid #E30A17;padding:.3rem .7rem;border-radius:2px}
.live-dot{width:6px;height:6px;border-radius:50%;background:#E30A17;animation:blink 1.4s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.site-cat-nav{background:#111;border-bottom:1px solid #1e1e1e;display:flex;align-items:center;overflow-x:auto;scrollbar-width:none;padding:0 1rem}
.site-cat-nav::-webkit-scrollbar{display:none}
.site-cat-nav a{font-family:'Barlow Condensed',sans-serif;font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;text-decoration:none;color:#777;padding:.6rem .9rem;border-bottom:2px solid transparent;white-space:nowrap;transition:color .15s,border-color .15s}
.site-cat-nav a:hover{color:#ddd}
.site-cat-nav a.active{color:#fff;border-bottom-color:#E30A17}
.site-footer{border-top:1px solid #222;padding:1.5rem;text-align:center;font-size:.72rem;color:#555;background:#0d0d0d;margin-top:3rem}
.site-footer a{color:#666;margin:0 .6rem;text-decoration:none}
.site-footer a:hover{color:#E30A17}`;
}

const SITE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 44" height="38">
  <rect x="0" y="2" width="8" height="40" fill="#ffffff"/>
  <polygon points="8,22 36,2 29,2 8,16" fill="#ffffff"/>
  <polygon points="8,22 38,42 46,42 8,25" fill="#E30A17"/>
  <rect x="0" y="20" width="8" height="5" fill="#E30A17"/>
  <text x="54" y="28" font-family="'Barlow Condensed',Impact,'Arial Narrow',sans-serif" font-size="24" font-weight="900" letter-spacing="3" fill="#ffffff">KARTALIX</text>
  <text x="55" y="40" font-family="Arial,Helvetica,sans-serif" font-size="7" letter-spacing="2" fill="#666666">BEŞİKTAŞ HABERLERİ</text>
</svg>`;

function siteHeader(activePath = '/') {
  const tabs = [
    { href: '/',              label: 'Tümü' },
    { href: '/konu/transfer', label: 'Transfer' },
    { href: '/konu/mac',      label: 'Maç' },
    { href: '/konu/videolar', label: 'Videolar' },
  ];
  const navLinks = tabs.map(({ href, label }) => {
    const active = activePath === href || (href !== '/' && activePath.startsWith(href));
    return `<a href="${href}"${active ? ' class="active"' : ''}>${label}</a>`;
  }).join('');
  return `<header>
  <a href="/" class="logo-link">${SITE_LOGO_SVG}</a>
  <div class="header-right"><div class="live-pill"><div class="live-dot"></div>Canlı</div></div>
</header>
<nav class="site-cat-nav">${navLinks}</nav>`;
}

function siteFooter() {
  return `<footer class="site-footer">
  <a href="/hakkimizda">Hakkımızda</a>
  <a href="/iletisim">İletişim</a>
  <a href="/editoryal-politika">Editoryal Politika</a>
  <a href="/gizlilik">Gizlilik</a>
  <a href="/kosullar">Kullanım Koşulları</a>
  <a href="/kaynak-atif">Kaynak Atıf</a>
  <a href="/rss">RSS</a>
</footer>`;
}

// ─── ARTICLE PAGE HTML ────────────────────────────────────────
function renderArticleHTML(a, apiKey = '', fixtureId = null, opponentId = null, related = []) {
  const slug      = a.slug || '';
  const title     = a.title || 'Haber';
  const desc      = (a.summary || a.full_body || '').replace(/<[^>]+>/g, ' ').slice(0, 200).trim();
  const image     = a.image_url || '';
  const rawSource = a.source || a.source_name || '';
  const isKartalix = !rawSource || rawSource === 'Kartalix' ||
    ['rewrite','original_synthesis','manual'].includes(a.publish_mode) ||
    (a.publish_mode && a.publish_mode.startsWith('template'));
  const source    = isKartalix ? 'Kartalix' : rawSource;
  const category  = a.category || 'Haber';
  const nvs       = a.nvs || a.nvs_score || 0;
  const pageUrl   = `${BASE_URL}/haber/${slug}`;
  const pubDate   = a.published_at ? new Date(a.published_at) : new Date();
  const dateStr   = pubDate.toLocaleDateString('tr-TR', { day:'numeric', month:'long', year:'numeric' });
  const isoDate   = pubDate.toISOString();
  const srcUrl      = a.url && a.url.startsWith('http') ? a.url : null;
  const templateId  = a.template_id || null;
  // Event-flash templates are short time-sensitive cards, not indexable articles.
  // rss_summary articles are source excerpts — also noindex.
  const NOINDEX_TEMPLATES = ['T10', 'T11', 'T-RED', 'T-VAR', 'T-PEN', 'T-HT'];
  const isNoIndex = (templateId && NOINDEX_TEMPLATES.includes(templateId)) || a.publish_mode === 'rss_summary';
  // Derive default admin note scope from article type
  const feedbackScope = templateId || (a.publish_mode?.includes('transfer') ? 'transfer' : a.publish_mode?.includes('match') ? 'match' : 'news');

  // Content-type badge (P1.2)
  const BADGE_MAP = {
    'T01':['Maç Önü','badge-match'], 'T02':['Maç Günü','badge-match'],
    'T03':['Maç Raporu','badge-match'], 'T08':['Olası 11','badge-match'],
    'T08b':['Olası 11','badge-match'], 'T09':['İlk 11','badge-match'],
    'T10':['Gol','badge-live'], 'T11':['Sonuç','badge-live'],
    'T12':['Maç Sonu','badge-match'], 'T13':['Analiz','badge-analysis'],
    'T-XG':['xG Analizi','badge-analysis'], 'T-REF':['Referans','badge-analysis'],
    'T-RED':['Kırmızı Kart','badge-live'], 'T-VAR':['VAR','badge-live'],
    'T-PEN':['Penaltı','badge-live'],
    'T-HT':['Devre Arası','badge-live'],
  };
  const [badgeLabel, badgeClass] = (() => {
    if (templateId) {
      if (templateId.startsWith('T-VID')) return ['Video', 'badge-video'];
      return BADGE_MAP[templateId] || [category, ''];
    }
    if (a.publish_mode === 'original_synthesis') return ['Analiz', 'badge-analysis'];
    const cat = (category || '').toLowerCase();
    if (cat.includes('transfer')) return ['Transfer', 'badge-transfer'];
    return [category || 'Haber', ''];
  })();

  // Source attribution (P1.3)
  // When DB/KV source_name is 'Kartalix' for rewrite articles, derive display name from URL hostname.
  const HOST_NAMES = {
    'ntvspor.net':'NTV Spor','hurriyet.com.tr':'Hürriyet','sabah.com.tr':'Sabah',
    'fanatik.com.tr':'Fanatik','milliyet.com.tr':'Milliyet','haberturk.com':'Habertürk',
    'sporx.com':'Sporx','fotomac.com.tr':'Fotomaç','posta.com.tr':'Posta',
    'sozcu.com.tr':'Sözcü','cumhuriyet.com.tr':'Cumhuriyet','takvim.com.tr':'Takvim',
    'goal.com':'Goal','bbc.com':'BBC','espn.com':'ESPN','transfermarkt.com':'Transfermarkt',
    'as.com':'AS','marca.com':'Marca','bjk.com.tr':'BJK Resmi',
    'trtspor.com.tr':'TRT Spor','aspor.com.tr':'A Spor','beinsports.com':'beIN Sports',
  };
  const srcLabel = (() => {
    if (rawSource && rawSource !== 'Kartalix') return rawSource;
    if (!srcUrl) return 'Kaynak';
    try {
      const host = new URL(srcUrl).hostname.replace(/^www\./, '');
      return HOST_NAMES[host] || host;
    } catch { return 'Kaynak'; }
  })();
  const attrHtml = (() => {
    if (['youtube_embed', 'video_embed', 'rabona_digest'].includes(a.publish_mode) && srcUrl) {
      return `<div class="source-attr">Video kaynağı: <a href="${escHtml(srcUrl)}" target="_blank" rel="noopener"><strong>${escHtml(srcLabel)}</strong> →</a></div>`;
    }
    if (!isKartalix && srcUrl) {
      return `<div class="source-attr">Kaynak: <a href="${escHtml(srcUrl)}" target="_blank" rel="noopener"><strong>${escHtml(source)}</strong> →</a></div>`;
    }
    if (a.publish_mode === 'rewrite' && srcUrl) {
      return `<div class="source-attr">Kaynak temel alınarak Kartalix editörleri tarafından üretildi: <a href="${escHtml(srcUrl)}" target="_blank" rel="noopener"><strong>${escHtml(srcLabel)}</strong> →</a></div>`;
    }
    if (['synthesis', 'original_synthesis'].includes(a.publish_mode)) {
      return `<div class="source-attr">Birden fazla kaynaktan derlenerek Kartalix editörleri tarafından üretildi.</div>`;
    }
    return '';
  })();

  const bodyText  = a.full_body || a.summary || '';
  const bodyHtml  = bodyText.includes('<') ? bodyText :
    bodyText.split('\n').map(l => {
      const stripped = l.trim().replace(/^#+\s*/, '');
      return stripped ? `<p>${escHtml(stripped)}</p>` : '';
    }).join('');

  const ytEmbedId = a.publish_mode === 'youtube_embed' && srcUrl
    ? (srcUrl.match(/(?:youtu\.be\/|[?&]v=)([a-zA-Z0-9_-]{11})/)?.[1] || null)
    : null;
  const videoHtml = ytEmbedId && !bodyHtml.includes('<iframe')
    ? `<div class="yt-embed"><iframe src="https://www.youtube.com/embed/${ytEmbedId}" allowfullscreen loading="lazy" frameborder="0" title="${escHtml(a.title || '')}"></iframe></div>`
    : '';

  const relatedHtml = related.length ? `<div class="related-vids">
  <div class="related-vids-label">İlgili Videolar</div>
  <div class="related-vids-grid">${related.map(v => `<a class="related-card" href="/haber/${escHtml(v.slug || '')}">
    <div class="related-card-thumb"><img src="${escHtml(v.image_url || '')}" loading="lazy" alt=""><div class="related-card-play"><div class="related-card-play-icon">▶</div></div></div>
    <div class="related-card-title">${escHtml(v.title || '')}</div>
  </a>`).join('')}</div></div>` : '';

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
    author: { '@type': 'Person', name: 'Ali Gencer' },
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
<meta name="robots" content="${isNoIndex ? 'noindex,nofollow' : 'index,follow'}"/>
<link rel="alternate" type="application/rss+xml" title="Kartalix RSS" href="${BASE_URL}/rss"/>
<script type="application/ld+json">${jsonLd}</script>
${siteSharedFonts()}
<style>
${siteSharedCSS()}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:16px;line-height:1.7}
a{color:#E30A17;text-decoration:none}
a:hover{text-decoration:underline}
main{max-width:720px;margin:0 auto;padding:2rem 1.5rem 4rem}
.cat-tag{display:inline-block;background:#E30A17;color:#fff;font-size:0.6rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;padding:3px 10px;border-radius:2px;margin-bottom:1rem}
.cat-tag.badge-live{background:#f59e0b;color:#000}
.cat-tag.badge-match{background:#1d4ed8}
.cat-tag.badge-analysis{background:#0d9488}
.cat-tag.badge-transfer{background:#d97706;color:#000}
.cat-tag.badge-video{background:#374151}
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
.article-meta .source-attr{display:block;width:100%;margin-top:0.4rem;padding-top:0;border-top:none}
.yt-embed{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:6px;margin-bottom:1.5rem;background:#000}
.yt-embed iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0}
.related-vids{margin:2rem 0 1.5rem}
.related-vids-label{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#555;margin-bottom:.85rem;border-left:3px solid #E30A17;padding-left:.65rem}
.related-vids-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem}
@media(max-width:540px){.related-vids-grid{grid-template-columns:1fr}}
.related-card{display:block;text-decoration:none;color:inherit}
.related-card:hover .related-card-title{color:#E30A17}
.related-card-thumb{position:relative;padding-bottom:56.25%;background:#111;border-radius:4px;overflow:hidden;margin-bottom:.45rem}
.related-card-thumb img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover}
.related-card-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);opacity:0;transition:opacity .15s}
.related-card:hover .related-card-play{opacity:1}
.related-card-play-icon{width:36px;height:36px;background:rgba(227,10,23,.9);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.85rem;color:#fff;padding-left:2px}
.related-card-title{font-size:.78rem;line-height:1.35;color:#ccc;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.source-link{color:#888;font-size:0.75rem;display:inline-block;margin-top:0.5rem}
.share-box{margin-top:2.5rem;padding:1.5rem;background:#141414;border:1px solid #222;border-radius:6px}
.share-title{font-size:0.7rem;letter-spacing:0.12em;text-transform:uppercase;color:#888;margin-bottom:1rem}
.share-btns{display:flex;gap:0.75rem;flex-wrap:wrap}
.share-btn{display:inline-block;font-size:0.78rem;font-weight:600;padding:9px 18px;border-radius:4px;cursor:pointer;border:none;text-decoration:none;transition:opacity 0.15s}
.share-btn:hover{opacity:0.85;text-decoration:none}
.btn-wa{background:#25D366;color:#fff}
.btn-tw{background:#1DA1F2;color:#fff}
.btn-copy{background:#333;color:#fff}
.reaction-bar{display:flex;gap:1rem;align-items:center;margin-top:2rem;padding:1rem 1.25rem;background:#222;border:1px solid #333;border-radius:6px}
.rxn-btn{display:flex;align-items:center;gap:.5rem;background:#2a2a2a;border:1px solid #444;color:#ccc;padding:.5rem 1.1rem;border-radius:20px;cursor:pointer;font-size:.9rem;transition:all .15s;user-select:none}
.rxn-btn:hover{border-color:#666;color:#fff;background:#333}
.rxn-btn.active-like{background:#1a3a1a;border-color:#4a4;color:#6d6}
.rxn-btn.active-dislike{background:#3a1a1a;border-color:#a44;color:#e66}
.rxn-count{font-size:.82rem;font-weight:700;min-width:1ch}
@media(max-width:600px){main{padding:1.5rem 1rem 3rem}h1{font-size:1.35rem}}
</style>
${shouldShowAds({ templateId, publishMode: a.publish_mode, bodyLength: (a.full_body || '').length }) ? ADSENSE_SCRIPT : ''}
</head>
<body>
${siteHeader('/haber/')}
<main>
  <article>
    <div class="cat-tag ${badgeClass}">${escHtml(badgeLabel)}</div>
    <h1>${escHtml(title)}</h1>
    <div class="article-meta">
      ${isKartalix ? '<span style="color:#888;font-size:0.72rem;font-weight:600">Kartalix Editöryel · Ali Gencer</span>' : `<span>📰 ${escHtml(source)}</span>`}
      <time datetime="${isoDate}">${dateStr}</time>
      ${nvs >= 40 ? `<span class="nvs-pill">NVS ${nvs}</span>` : ''}
      <span style="color:#555;font-size:0.68rem">YZ destekli</span>
      ${attrHtml}
    </div>
    ${image && a.publish_mode !== 'youtube_embed' ? `<img class="article-img" src="${escHtml(image)}" alt="${escHtml(title)}" loading="lazy"/>` : ''}
    ${videoHtml}
    <div class="article-body">${bodyHtml}</div>
    ${relatedHtml}
    ${opponentId && templateId === 'T02' ? `<div id="h2hWidget" style="margin:2rem 0">
      <api-sports-widget data-type="h2h" data-team1="549" data-team2="${opponentId}" data-season="2025"></api-sports-widget>
    </div>
    <script>
    (async function(){
      try {
        const cfg = await fetch('/widgets/config').then(r => r.json());
        if (!cfg.apiKey) return;
        await new Promise((res,rej) => {
          const s = document.createElement('script');
          s.type = 'module';
          s.src = 'https://widgets.api-sports.io/3.1.0/widgets.js';
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
        const c = document.createElement('api-sports-widget');
        c.setAttribute('data-type','config'); c.setAttribute('data-key',cfg.apiKey);
        c.setAttribute('data-sport','football'); c.setAttribute('data-theme','dark');
        c.setAttribute('data-lang','en');
        c.setAttribute('data-custom-lang','https://app.kartalix.com/widgets/tr.json');
        document.body.appendChild(c);
      } catch(e){}
    })();
    </script>` : ''}
    ${fixtureId && templateId && ['T-HT','T11','T12','T13','T-XG'].includes(templateId) ? `<div id="matchStatsBox" style="margin:1.5rem 0"></div>
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

  <!-- Editor-only feedback panel: visible only when kx-ui cookie is set (set by /admin/login) -->
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

// Show editor controls only when kx-ui cookie is present (set by /admin/login)
if (document.cookie.split(';').some(c => c.trim() === 'kx-ui=1')) {
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
${siteFooter()}
${siteCookieBanner()}
</body>
</html>`;
}

function renderContentPage(siteCode, allSites) {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — İçerik</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.5;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.cms{display:flex;flex:1;overflow:hidden}
.list-panel{width:360px;min-width:300px;border-right:1px solid #222;display:flex;flex-direction:column;overflow:hidden}
.editor-panel{flex:1;display:flex;flex-direction:column;overflow:hidden}
.toolbar{padding:.6rem .85rem;border-bottom:1px solid #222;display:flex;gap:.5rem;align-items:center;flex-shrink:0;background:#111}
input[type=search],input[type=text],input[type=url],select,textarea{background:#1a1a1a;border:1px solid #2a2a2a;color:#e8e6e0;border-radius:4px;font-family:inherit;font-size:.83rem;outline:none;padding:.35rem .6rem}
input[type=search]:focus,input[type=text]:focus,input[type=url]:focus,select:focus,textarea:focus{border-color:#444}
input[type=search]{flex:1;height:30px}
select{height:30px;color:#aaa}
.filter-check{font-size:.72rem;color:#888;white-space:nowrap;cursor:pointer;display:flex;align-items:center;gap:.3rem}
.filter-check input{accent-color:#E30A17}
.btn{border:none;border-radius:4px;font-size:.75rem;font-weight:700;padding:.35rem .85rem;cursor:pointer;white-space:nowrap}
.btn-primary{background:#E30A17;color:#fff}.btn-primary:hover{opacity:.85}
.btn-secondary{background:#2a2a2a;color:#ccc;border:1px solid #333}.btn-secondary:hover{background:#333}
.btn-danger{background:transparent;color:#c0392b;border:1px solid #c0392b}.btn-danger:hover{background:#c0392b;color:#fff}
.btn-sm{padding:.25rem .6rem;font-size:.7rem}
.art-list{flex:1;overflow-y:auto}
.art-row{padding:.65rem .85rem;border-bottom:1px solid #1e1e1e;cursor:pointer;transition:background .12s}
.art-row:hover{background:#161616}
.art-row.active{background:#1a1a1a;border-left:2px solid #E30A17}
.art-title{font-size:.82rem;color:#ddd;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.art-meta{margin-top:.3rem;display:flex;gap:.45rem;align-items:center;flex-wrap:wrap}
.badge{font-size:.58rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:1px 6px;border-radius:3px}
.badge-synth{background:#1a3a1a;color:#4a9a4a}
.badge-tmpl{background:#1a2a3a;color:#4a7aaa}
.badge-yt{background:#3a1a1a;color:#aa4a4a}
.badge-manual{background:#2a2a1a;color:#aaaa4a}
.badge-rss{background:#2a2a2a;color:#777}
.nvs{font-size:.63rem;color:#555}
.nr-flag{font-size:.72rem;color:#f0a500}
.status-pill{font-size:.6rem;font-weight:700;letter-spacing:.05em;padding:1px 7px;border-radius:10px;white-space:nowrap}
.sp-live{background:#14532d;color:#4ade80}
.sp-pub{background:#1e3a5f;color:#60a5fa}
.sp-pend{background:#3a2e00;color:#fbbf24}
.sp-arch{background:#2a2a2a;color:#555}
.sp-kv{background:#2a1a3a;color:#a78bfa}
.art-date{font-size:.63rem;color:#444;margin-left:auto}
.btn-quick-pub{font-size:.6rem;font-weight:700;padding:1px 8px;border-radius:3px;border:1px solid #92400e;background:#78350f;color:#fbbf24;cursor:pointer;white-space:nowrap;margin-left:auto}
.btn-quick-pub:hover{background:#92400e;color:#fff}
.editor-inner{flex:1;display:flex;flex-direction:column;padding:1.25rem 1.5rem;overflow-y:auto;gap:.85rem}
.editor-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#333;font-size:.9rem}
.field label{display:block;font-size:.65rem;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.3rem}
.field input[type=text],.field input[type=url]{width:100%;height:34px}
.field textarea{width:100%;resize:vertical}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.editor-actions{display:flex;gap:.6rem;align-items:center;padding:.85rem 1.5rem;border-top:1px solid #222;flex-shrink:0;background:#111}
.save-status{font-size:.72rem;color:#555;margin-left:.5rem}
.pagination{padding:.5rem .85rem;border-top:1px solid #1e1e1e;display:flex;gap:.5rem;flex-shrink:0}
.dash-strip{display:flex;gap:.4rem;padding:.5rem .85rem;border-bottom:1px solid #222;background:#0d0d0d;flex-shrink:0}
.dash-stat{flex:1;display:flex;flex-direction:column;align-items:center;gap:.12rem;background:#111;border:1px solid #1e1e1e;border-radius:5px;padding:.3rem .2rem;cursor:pointer;transition:border-color .12s;min-width:0}
.dash-stat:hover{border-color:#333}.dash-stat.ds-active{border-color:#E30A17}
.ds-count{font-size:.9rem;font-weight:700;color:#ddd;line-height:1}
.ds-label{font-size:.5rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#555;white-space:nowrap}
.ds-live .ds-count{color:#4ade80}.ds-yayinda .ds-count{color:#60a5fa}.ds-pend .ds-count{color:#fbbf24}.ds-arch .ds-count{color:#666}.ds-del .ds-count{color:#c0392b}
.hp-times{font-size:.59rem;color:#4a7aaa;margin-top:.2rem;line-height:1.3}
.hp-times-pub{color:#4a9a6a}.hp-times-evicted{color:#7a5a3a}
.score-strip{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.3rem;padding:.25rem .35rem;background:#111;border:1px solid #1e1e1e;border-radius:3px}
.sc{display:flex;flex-direction:column;align-items:center;min-width:36px}
.sc-val{font-size:.65rem;font-weight:700;color:#ccc;line-height:1}
.sc-val.sc-now{color:#4ade80}.sc-val.sc-pinned{color:#a78bfa}.sc-val.sc-floor{color:#ef4444}.sc-val.sc-imminent{color:#f97316}.sc-val.sc-rank{color:#facc15}
.sc-lbl{font-size:.48rem;letter-spacing:.05em;text-transform:uppercase;color:#444;line-height:1;margin-top:.15rem}
</style>
</head>
<body>
ADMINNAV_PLACEHOLDER
<div class="cms">
  <div class="list-panel">
    <div class="dash-strip" id="dashStrip">
      <div class="dash-stat ds-live" id="ds-live" onclick="setFilter('live')" title="Anasayfada görünen haberler"><span class="ds-count" id="dc-live">—</span><span class="ds-label">Canlı</span></div>
      <div class="dash-stat ds-yayinda" id="ds-yayinda" onclick="setFilter('yayinda')" title="Link aktif ama anasayfada yok"><span class="ds-count" id="dc-yayinda">—</span><span class="ds-label">Yayında</span></div>
      <div class="dash-stat ds-pend" id="ds-pend" onclick="setFilter('pending')" title="Onay bekliyor"><span class="ds-count" id="dc-pend">—</span><span class="ds-label">Beklemede</span></div>
      <div class="dash-stat ds-arch" id="ds-arch" onclick="setFilter('archived')" title="Arşivlendi"><span class="ds-count" id="dc-arch">—</span><span class="ds-label">Arşiv</span></div>
      <div class="dash-stat ds-del" id="ds-del" onclick="setFilter('deleted')" title="Silindi"><span class="ds-count" id="dc-del">—</span><span class="ds-label">Silindi</span></div>
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Başlık ara…" oninput="schedSearch()">
      <select id="modeFilter" onchange="load(1)">
        <option value="">Tür</option>
        <option value="yz">YZ</option>
        <option value="yz_plus">YZ+</option>
        <option value="template">Şablon</option>
        <option value="video">Video</option>
        <option value="manual">Manuel</option>
        <option value="copy_source">Kaynak</option>
        <option value="rss_summary">RSS</option>
      </select>
      <select id="nvsFilter" onchange="load(1)">
        <option value="">NVS</option>
        <option value="hi">75+</option>
        <option value="mid">60–74</option>
        <option value="lo">&lt;60</option>
      </select>
      <select id="statusFilter" onchange="load(1)">
        <option value="">Tüm Durumlar</option>
        <option value="live">Canlı</option>
        <option value="yayinda">Yayında</option>
        <option value="pending">Beklemede</option>
        <option value="archived">Arşiv</option>
        <option value="deleted">Silindi</option>
      </select>
    </div>
    <div class="toolbar" style="padding:.4rem .85rem">
      <label class="filter-check"><input type="checkbox" id="nrFilter" onchange="load(1)"> ⚠️ Sadece inceleme gerektirenler</label>
      <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="newArticle()">+ Yeni</button>
    </div>
    <div id="failureBanner" style="display:none;background:#7f1d1d;color:#fca5a5;padding:.6rem 1rem;font-size:0.78rem;border-bottom:1px solid #991b1b"></div>
    <div class="art-list" id="artList"><p style="padding:1rem;color:#444">Yükleniyor…</p></div>
    <div class="pagination" id="pagination"></div>
  </div>
  <div class="editor-panel">
    <div class="editor-empty" id="editorEmpty">← Düzenlemek için bir haber seçin</div>
    <div id="editorForm" style="display:none;flex:1;flex-direction:column;overflow:hidden">
      <div class="editor-inner">
        <div class="field">
          <label>Başlık</label>
          <input type="text" id="eTitle" placeholder="Haber başlığı">
        </div>
        <div class="field">
          <label>Özet <span style="color:#444;text-transform:none;font-weight:400">(isteğe bağlı)</span></label>
          <textarea id="eSummary" rows="2" placeholder="Kısa özet…"></textarea>
        </div>
        <div class="field">
          <label>İçerik <span id="wc" style="color:#444;text-transform:none;font-weight:400"></span></label>
          <textarea id="eBody" rows="16" placeholder="Haber metni veya HTML…" oninput="updateWc()"></textarea>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Kategori</label>
            <select id="eCat" style="width:100%;height:34px">
              <option>Haber</option><option>Analiz</option><option>Maç</option><option>Transfer</option><option>Sakatlık</option><option>Kulüp</option><option>Milli Takım</option>
            </select>
          </div>
          <div class="field">
            <label>Görsel URL</label>
            <input type="url" id="eImg" placeholder="https://…">
          </div>
        </div>
        <div class="field" id="eSlugRow" style="display:none">
          <label>Slug <span style="color:#444;text-transform:none;font-weight:400">(sadece okuma)</span></label>
          <input type="text" id="eSlug" readonly style="color:#555;cursor:default">
        </div>
        <div class="field" id="eFbRow" style="display:none">
          <label>YZ Rehberlik Notu <span style="color:#444;text-transform:none;font-weight:400;letter-spacing:0">— Talimat Üret için kaynak olarak kullanılır</span></label>
          <textarea id="eFbText" rows="3" placeholder="Ton, eksik bilgi, üslup, düzeltme önerileri…"></textarea>
          <div style="display:flex;gap:.5rem;margin-top:.4rem;align-items:center">
            <button class="btn btn-secondary btn-sm" onclick="saveFb()">Notu Kaydet</button>
            <span id="eFbStatus" style="font-size:.72rem;color:#555"></span>
          </div>
          <div id="eFbList" style="margin-top:.5rem"></div>
        </div>
      </div>
      <div class="editor-actions">
        <button class="btn btn-primary" onclick="saveArticle()">Kaydet</button>
        <button class="btn btn-secondary" id="previewBtn" onclick="previewArticle()" style="display:none">Önizle ↗</button>
        <span class="save-status" id="saveStatus"></span>
        <button class="btn btn-secondary btn-sm" style="margin-left:auto" onclick="archiveArticle()">Arşivle</button>
        <button class="btn btn-danger btn-sm" onclick="deleteArticle()">Sil</button>
      </div>
    </div>
  </div>
</div>
<script>
let currentSlug = null;
let currentPage = 1;
let currentTemplateId = null;
let currentIsKVOnly = false;
let searchTimer = null;
const articleCache = {};
let liveSlugSet = new Set();

function schedSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(() => load(1), 350); }

function setFilter(val) {
  const prev = document.getElementById('statusFilter').value;
  const next = (prev === val) ? '' : val;
  document.getElementById('statusFilter').value = next;
  syncPills(next);
  load(1);
}

function syncPills(val) {
  document.querySelectorAll('.dash-stat').forEach(el => el.classList.remove('ds-active'));
  const map = { live: 'ds-live', yayinda: 'ds-yayinda', pending: 'ds-pend', archived: 'ds-arch', deleted: 'ds-del' };
  if (val && map[val]) document.getElementById(map[val])?.classList.add('ds-active');
}

async function loadCounts() {
  try {
    const r = await fetch('/admin/content-counts');
    if (!r.ok) return;
    const d = await r.json();
    document.getElementById('dc-live').textContent   = d.live    ?? '—';
    document.getElementById('dc-yayinda').textContent = d.yayinda ?? '—';
    document.getElementById('dc-pend').textContent   = d.pending  ?? '—';
    document.getElementById('dc-arch').textContent   = d.archived ?? '—';
    document.getElementById('dc-del').textContent    = d.deleted  ?? '—';
  } catch(e) {}
}

function badgeClass(m) {
  if (!m) return 'badge-rss';
  if (m === 'rewrite' || m === 'synthesis' || m === 'original_synthesis' || m === 'synthesis_generated') return 'badge-synth';
  if (m.startsWith('template')) return 'badge-tmpl';
  if (m.startsWith('youtube') || m === 'video_embed') return 'badge-yt';
  if (m === 'manual') return 'badge-manual';
  if (m === 'copy_source') return 'badge-rss';
  return 'badge-rss';
}
const TEMPLATE_LABELS = {
  matchday: 'Maç', postmatch: 'Maç Sonu', official: 'Resmi', transfer: 'Transfer',
  injury: 'Sakatlık', lineup: 'Kadro', h2h: 'H2H', form_guide: 'Form',
  preview: 'Önizleme', referee: 'Hakem', xg_delta: 'xG', goal_flash: 'Gol',
  result_flash: 'Sonuç', halftime: 'Devre', red_card: 'Kırmızı', var_flash: 'VAR',
  penalty: 'Penaltı', man_of_match: 'Adam', match_report: 'Rapor',
};
function badgeLabel(m) {
  if (!m) return 'RSS';
  if (m === 'rewrite' || m === 'synthesis') return 'YZ';
  if (m === 'original_synthesis' || m === 'synthesis_generated') return 'YZ+';
  if (m.startsWith('template_')) {
    const key = m.replace('template_', '');
    return 'Ş:' + (TEMPLATE_LABELS[key] || key.slice(0,6));
  }
  if (m.startsWith('youtube') || m === 'video_embed') return 'Video';
  if (m === 'manual') return 'Manuel';
  if (m === 'copy_source') return 'Kaynak';
  if (m === 'rss_summary') return 'RSS';
  return m.slice(0, 8);
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleDateString('tr-TR',{day:'2-digit',month:'2-digit'}) + ' ' + d.toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'});
}
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtOnSite(kvEnteredAt) {
  if (!kvEnteredAt) return '—';
  const ms = Date.now() - new Date(kvEnteredAt).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin > 0 ? hours + 'h ' + remMin + 'm' : hours + 'h';
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? days + 'd ' + remHours + 'h' : days + 'd';
}
function fmtHalfLife(hl) {
  if (hl === null || hl === undefined) return 'pinned';
  return hl + 'h';
}

function statusPill(a) {
  if (!a.slug) return '';
  if (a._kv_only)              return '<span class="status-pill sp-kv">Canlı·DB yok</span>';
  if (a.status === 'archived') return '<span class="status-pill sp-arch">Arşiv</span>';
  if (a.status === 'pending')  return '<span class="status-pill sp-pend">Beklemede</span>';
  if (a.status === 'published') {
    if (liveSlugSet.has(a.slug)) return '<span class="status-pill sp-live">Canlı</span>';
    return '<span class="status-pill sp-pub">Yayında</span>';
  }
  return \`<span class="status-pill sp-arch">\${esc(a.status||'?')}</span>\`;
}

async function checkPipelineFailures() {
  try {
    const r = await fetch('/admin/pipeline-failures');
    if (!r.ok) return;
    const { failures } = await r.json();
    const banner = document.getElementById('failureBanner');
    if (!banner) return;
    if (!failures || failures.length === 0) { banner.style.display = 'none'; return; }
    const latest = failures[0];
    banner.style.display = 'block';
    banner.innerHTML = \`⚠️ <strong>DB Yazma Hatası:</strong> Son hata: "\${esc(latest.title || latest.error)}" (\${new Date(latest.ts).toLocaleString('tr-TR')}).
      \${failures.length} kayıt etkilendi.
      <button onclick="clearFailures()" style="margin-left:1rem;background:#991b1b;color:#fff;border:none;border-radius:4px;padding:2px 10px;cursor:pointer;font-size:0.75rem">Temizle</button>\`;
  } catch(e) {}
}
async function clearFailures() {
  await fetch('/admin/pipeline-failures', { method: 'DELETE' });
  document.getElementById('failureBanner').style.display = 'none';
}

async function load(page) {
  currentPage = page || 1;
  try {
    const kr = await fetch('/admin/live-slugs');
    if (kr.ok) { const slugs = await kr.json(); liveSlugSet = new Set(slugs); }
  } catch(e) {}
  checkPipelineFailures();
  const q  = document.getElementById('q').value.trim();
  const m  = document.getElementById('modeFilter').value;
  const nv = document.getElementById('nvsFilter').value;
  const nr = document.getElementById('nrFilter').checked ? '1' : '';
  const sf = document.getElementById('statusFilter').value;
  syncPills(sf);
  const params = new URLSearchParams({ page: currentPage, q, mode: m, needs_review: nr });
  if (nv) params.set('nvs', nv);
  if (sf === 'live') params.set('live', '1');
  else if (sf === 'yayinda') params.set('yayinda', '1');
  else if (sf) params.set('status', sf);
  const res = await fetch('/admin/content-data?' + params);
  const data = await res.json();
  let articles = data.articles || [];
  if (sf === 'yayinda') articles = articles.filter(a => !liveSlugSet.has(a.slug));
  const has_more = data.has_more || false;
  const list = document.getElementById('artList');
  if (data.error) { list.innerHTML = '<p style="padding:1rem;color:#c0392b">Hata: ' + esc(data.error) + '</p>'; return; }
  if (!articles.length) { list.innerHTML = '<p style="padding:1rem;color:#444">Haber bulunamadı.</p>'; }
  else {
    articles.forEach(a => { articleCache[a.slug] = a; });
    list.innerHTML = articles.map(a => {
      let hpHtml = '';
      if (a.homepage_published_at && a.homepage_removed_at) {
        hpHtml = \`<div class="hp-times hp-times-evicted">🏠 \${fmtDate(a.homepage_published_at)} → \${fmtDate(a.homepage_removed_at)}</div>\`;
      } else if (a.homepage_published_at) {
        hpHtml = \`<div class="hp-times hp-times-pub">🏠 \${fmtDate(a.homepage_published_at)} · hâlâ yayında</div>\`;
      }
      const hasScoring = a._score_now !== undefined && a._score_now !== null;
      const nowCls = a._exit_eta === 'Pinned' ? 'sc-pinned' : a._exit_eta === '≤floor' ? 'sc-floor' : a._exit_eta === 'imminent' ? 'sc-imminent' : 'sc-now';
      const scoreStripHtml = hasScoring ? \`<div class="score-strip">
        <div class="sc"><span class="sc-val sc-rank">\${a._current_rank != null ? a._current_rank : '—'}</span><span class="sc-lbl">Rank</span></div>
        <div class="sc"><span class="sc-val">\${a._nvs_eff ?? '—'}</span><span class="sc-lbl">NVS</span></div>
        <div class="sc"><span class="sc-val">\${a._score_entry != null ? a._score_entry : '—'}</span><span class="sc-lbl">Entry</span></div>
        <div class="sc"><span class="sc-val \${nowCls}">\${a._score_now != null ? a._score_now : '—'}</span><span class="sc-lbl">Now</span></div>
        <div class="sc"><span class="sc-val">\${esc(a._exit_eta||'—')}</span><span class="sc-lbl">Exit ETA</span></div>
        <div class="sc"><span class="sc-val">\${fmtOnSite(a._kv_entered_at)}</span><span class="sc-lbl">On Site</span></div>
        <div class="sc"><span class="sc-val">\${fmtHalfLife(a._half_life)}</span><span class="sc-lbl">HalfLife</span></div>
      </div>\` : '';
      return \`
      <div class="art-row\${currentSlug===a.slug?' active':''}" data-slug="\${esc(a.slug)}" onclick="openBySlug(this.dataset.slug)">
        <div class="art-title">\${esc(a.title||'(başlıksız)')}</div>
        <div class="art-meta">
          <span class="badge \${badgeClass(a.publish_mode)}">\${badgeLabel(a.publish_mode)}</span>
          \${statusPill(a)}
          \${a.nvs_score ? '<span class="nvs">NVS '+a.nvs_score+'</span>' : ''}
          \${a.needs_review ? '<span class="nr-flag">⚠️</span>' : ''}
          \${a.status === 'pending' && a.slug ? '<button class="btn-quick-pub" data-slug="'+esc(a.slug)+'" onclick="quickPublish(event,this.dataset.slug)">Yayınla ↑</button>' : ''}
          <span class="art-date">\${fmtDate(a.fetched_at)}</span>
        </div>
        \${scoreStripHtml}
        \${hpHtml}
      </div>\`;
    }).join('');
  }
  const pg = document.getElementById('pagination');
  pg.innerHTML = \`
    \${currentPage > 1 ? '<button class="btn btn-secondary btn-sm" onclick="load('+(currentPage-1)+')">← Önceki</button>' : ''}
    <span style="font-size:.72rem;color:#555;margin:auto">Sayfa \${currentPage}</span>
    \${has_more ? '<button class="btn btn-secondary btn-sm" onclick="load('+(currentPage+1)+')">Sonraki →</button>' : ''}
  \`;
}

function openBySlug(slug) { openArticle(articleCache[slug]); }

async function quickPublish(e, slug) {
  e.stopPropagation();
  const btn = e.target;
  btn.disabled = true; btn.textContent = '…';
  try {
    const res = await fetch('/admin/content-publish', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ slug }) });
    const data = await res.json();
    if (data.ok) { btn.textContent = '✓'; btn.style.background='#14532d'; btn.style.color='#4ade80'; setTimeout(() => load(currentPage), 800); }
    else { btn.textContent = 'Hata'; btn.disabled = false; }
  } catch { btn.textContent = 'Hata'; btn.disabled = false; }
}

function openArticle(a) {
  currentSlug = a.slug;
  currentIsKVOnly = a._kv_only || false;
  document.querySelectorAll('.art-row').forEach(r => r.classList.toggle('active', r.dataset.slug === a.slug));
  document.getElementById('editorEmpty').style.display  = 'none';
  const f = document.getElementById('editorForm');
  f.style.display = 'flex';
  document.getElementById('eTitle').value   = a.title || '';
  document.getElementById('eSummary').value = a.summary || '';
  document.getElementById('eBody').value    = a.full_body || a.summary || '';
  document.getElementById('eCat').value     = a.category || 'Haber';
  document.getElementById('eImg').value     = a.image_url || '';
  document.getElementById('eSlug').value    = a.slug || '';
  document.getElementById('eSlugRow').style.display  = 'block';
  document.getElementById('previewBtn').style.display = a.slug ? 'inline-block' : 'none';
  document.getElementById('saveStatus').textContent = '';
  document.getElementById('deleteBtn') && (document.getElementById('deleteBtn').style.display = 'inline-block');
  currentTemplateId = a.template_id || null;
  document.getElementById('eFbText').value = '';
  document.getElementById('eFbStatus').textContent = '';
  document.getElementById('eFbList').innerHTML = '';
  document.getElementById('eFbRow').style.display = 'block';
  if (a.slug) loadArticleFb(a.slug);
  updateWc();
}

function newArticle() {
  currentSlug = null;
  currentIsKVOnly = false;
  document.querySelectorAll('.art-row').forEach(r => r.classList.remove('active'));
  document.getElementById('editorEmpty').style.display  = 'none';
  const f = document.getElementById('editorForm');
  f.style.display = 'flex';
  document.getElementById('eTitle').value   = '';
  document.getElementById('eSummary').value = '';
  document.getElementById('eBody').value    = '';
  document.getElementById('eCat').value     = 'Haber';
  document.getElementById('eImg').value     = '';
  document.getElementById('eSlug').value    = '';
  document.getElementById('eSlugRow').style.display = 'none';
  document.getElementById('eFbRow').style.display = 'none';
  document.getElementById('previewBtn').style.display = 'none';
  document.getElementById('saveStatus').textContent = '';
  document.getElementById('eTitle').focus();
  updateWc();
}

function updateWc() {
  const text = document.getElementById('eBody').value.replace(/<[^>]+>/g,'');
  const words = text.trim() ? text.trim().split(/\\s+/).length : 0;
  document.getElementById('wc').textContent = words ? words + ' kelime' : '';
}

function previewArticle() {
  if (currentSlug) window.open('/haber/' + currentSlug, '_blank');
}

async function saveArticle() {
  const title    = document.getElementById('eTitle').value.trim();
  const summary  = document.getElementById('eSummary').value.trim();
  const full_body = document.getElementById('eBody').value;
  const category = document.getElementById('eCat').value;
  const image_url = document.getElementById('eImg').value.trim();
  const status   = document.getElementById('eStatus')?.value || 'published';
  const st = document.getElementById('saveStatus');
  if (!title) { st.textContent = 'Başlık zorunlu.'; st.style.color='#E30A17'; return; }
  st.textContent = 'Kaydediliyor…'; st.style.color = '#666';
  const res = await fetch('/admin/content-save', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ slug: currentSlug, title, summary, full_body, category, image_url, status, is_new: !currentSlug, kv_only: currentIsKVOnly })
  });
  const data = await res.json();
  if (data.ok) {
    st.textContent = 'Kaydedildi ✓'; st.style.color = '#3a9a3a';
    currentIsKVOnly = false;
    if (data.is_new) {
      currentSlug = data.slug;
      document.getElementById('eSlug').value = data.slug;
      document.getElementById('eSlugRow').style.display = 'block';
      document.getElementById('previewBtn').style.display = 'inline-block';
    }
    load(currentPage);
    loadCounts();
  } else {
    st.textContent = data.error || 'Hata oluştu.'; st.style.color = '#E30A17';
  }
}

async function deleteArticle() {
  if (!currentSlug) return;
  if (!confirm('Bu haberi silmek istediğinize emin misiniz? Bu işlem geri alınamaz.')) return;
  const res = await fetch('/admin/content-delete', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ slug: currentSlug })
  });
  const data = await res.json();
  if (data.ok) {
    currentSlug = null;
    document.getElementById('editorForm').style.display  = 'none';
    document.getElementById('editorEmpty').style.display = 'flex';
    load(currentPage);
    loadCounts();
  }
}

async function archiveArticle() {
  if (!currentSlug) return;
  if (!confirm('Bu haberi arşivlemek istediğinize emin misiniz? Makale yayından kaldırılır, link erişilemez olur.')) return;
  const res = await fetch('/admin/content-archive', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ slug: currentSlug })
  });
  const data = await res.json();
  if (data.ok) {
    currentSlug = null;
    document.getElementById('editorForm').style.display  = 'none';
    document.getElementById('editorEmpty').style.display = 'flex';
    load(currentPage);
    loadCounts();
  }
}

async function loadArticleFb(slug) {
  try {
    const res = await fetch('/article/feedback');
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('json')) return;
    const all = await res.json();
    const items = all.filter(f => f.article_slug === slug);
    const list = document.getElementById('eFbList');
    if (!items.length) { list.innerHTML = ''; return; }
    list.innerHTML = items.map(f => \`
      <div style="background:#1a2a1a;border-left:2px solid #3a5a3a;padding:.35rem .6rem;margin-bottom:.3rem;font-size:.75rem;color:#9a9;border-radius:0 3px 3px 0;display:flex;justify-content:space-between;gap:.5rem;align-items:flex-start">
        <span style="flex:1">\${esc(f.comment)}</span>
        <button onclick="delArticleFb('\${f.id}')" style="background:transparent;border:none;color:#555;cursor:pointer;font-size:.7rem;flex-shrink:0">✕</button>
      </div>
    \`).join('');
  } catch(e) {}
}

async function saveFb() {
  if (!currentSlug) return;
  const text = document.getElementById('eFbText').value.trim();
  const st = document.getElementById('eFbStatus');
  if (!text) { st.textContent = 'Not boş olamaz.'; st.style.color = '#E30A17'; return; }
  st.textContent = 'Kaydediliyor…'; st.style.color = '#666';
  const title = document.getElementById('eTitle').value.trim();
  const res = await fetch('/article/feedback', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ article_slug: currentSlug, article_title: title, template_id: currentTemplateId, comment: text })
  });
  if (res.ok) {
    document.getElementById('eFbText').value = '';
    st.textContent = '✓ Kaydedildi'; st.style.color = '#3a9a3a';
    setTimeout(() => { st.textContent = ''; st.style.color = '#555'; }, 2500);
    await loadArticleFb(currentSlug);
  } else { st.textContent = 'Hata.'; st.style.color = '#E30A17'; }
}

async function delArticleFb(id) {
  await fetch('/article/feedback', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'delete', id }) });
  if (currentSlug) await loadArticleFb(currentSlug);
}

load(1);
loadCounts();
</script>
</body>
</html>`.replace('ADMINNAV_PLACEHOLDER', adminNav('content', siteCode, allSites));
}

function resolveSite(url, sites) {
  const code = url.searchParams.get('site');
  return (code && sites.find(s => s.short_code === code)) || sites[0];
}

function adminNav(active, siteCode, allSites) {
  const links = [
    { href: `/admin/content?site=${siteCode}`,        label: 'İçerik',      key: 'content'        },
    { href: `/admin/curated-video?site=${siteCode}`,  label: 'Küratör',     key: 'curated-video'  },
    { href: `/admin?site=${siteCode}`,                label: 'Editör',      key: 'news'           },
    { href: `/admin/sources/ui?site=${siteCode}`,     label: 'Kaynaklar',   key: 'sources'        },
    { href: `/admin/financials?site=${siteCode}`,     label: 'Maliyet',     key: 'financials'     },
    { href: `/admin/report?site=${siteCode}`,         label: 'Rapor',       key: 'report'         },
    { href: `/admin/test-templates?site=${siteCode}`, label: 'Şablon Test', key: 'test'           },
    { href: `/admin/tools?site=${siteCode}`,          label: 'Araçlar',     key: 'tools'          },
    { href: `/admin/releases?site=${siteCode}`,       label: 'Sürümler',    key: 'releases'       },
    { href: `/admin/qa?site=${siteCode}`,             label: 'QA',          key: 'qa'             },
  ];
  const navLinks = links.map(l => {
    const isActive = active === l.key;
    return `<a href="${l.href}" style="display:flex;align-items:center;padding:0 1rem;height:100%;font-size:.78rem;font-weight:${isActive ? '700' : '400'};color:${isActive ? '#fff' : '#666'};text-decoration:none;border-bottom:${isActive ? '2px solid #E30A17' : '2px solid transparent'}">${l.label}</a>`;
  }).join('');
  const siteSelector = allSites && allSites.length > 1
    ? `<select onchange="location.href=location.pathname+'?site='+this.value" style="background:#1a1a1a;border:1px solid #333;color:#ccc;font-size:.75rem;padding:3px 8px;border-radius:4px;margin-left:1rem;cursor:pointer">${allSites.map(s=>`<option value="${s.short_code}"${s.short_code===siteCode?' selected':''}>${s.short_code} — ${s.team_name||s.short_code}</option>`).join('')}</select>`
    : '';
  return `<header style="background:#111;border-bottom:1px solid #222;padding:0 1.5rem;height:48px;display:flex;align-items:center;gap:0;position:sticky;top:0;z-index:10">
  <a href="/" style="font-size:1rem;font-weight:900;color:#fff;text-decoration:none;margin-right:1rem">Kartal<span style="color:#E30A17">ix</span></a>
  <nav style="display:flex;height:100%">${navLinks}</nav>${siteSelector}
  <a href="/" style="color:#555;font-size:.72rem;text-decoration:none;margin-left:auto">← Site</a>
</header>`;
}

function renderCuratedVideoPage(list, siteCode, allSites) {
  const sectionOpts = Object.entries(_VH_ALL_SECTION_MAP).map(([k, d]) => `<option value="${k}">${d.label}</option>`).join('');
  const sectionsJson = JSON.stringify(Object.entries(_VH_ALL_SECTION_MAP).map(([value, d]) => ({ value, label: d.label })));

  const rows = list.map(v => {
    const thumb = v.image_url || '';
    const articleHref = `/haber/${v.slug}`;
    const ytHref = v.original_url || '#';
    const secLabel = _VH_ALL_SECTION_MAP[v.category]?.label || v.category;
    const date = v.published_at ? new Date(v.published_at).toLocaleDateString('tr-TR') : '';
    const slug = (v.slug || '').replace(/'/g, "\\'");
    const titleEsc = (v.title || '').replace(/"/g, '&quot;').replace(/'/g, "\\'");
    const editOpts = Object.entries(_VH_ALL_SECTION_MAP).map(([k, d]) =>
      `<option value="${k}"${k === v.category ? ' selected' : ''}>${d.label}</option>`
    ).join('');
    return `<tr id="row-${slug}" data-slug="${slug}" draggable="true">
      <td class="drag-handle" style="padding:.55rem .5rem;width:24px;text-align:center;cursor:grab;color:#444;font-size:1rem;user-select:none">⠿</td>
      <td style="padding:.55rem .75rem;width:108px">
        <a href="${ytHref}" target="_blank" rel="noopener"><img src="${thumb}" style="width:96px;height:54px;object-fit:cover;border-radius:4px;display:block" loading="lazy"></a>
      </td>
      <td style="padding:.55rem .75rem">
        <a href="${articleHref}" style="color:#ddd;text-decoration:none;font-size:.82rem;line-height:1.4">${v.title || ''}</a>
        <div style="margin-top:.25rem;font-size:.68rem;color:#555">${v.source_name || ''} · ${date}</div>
      </td>
      <td style="padding:.55rem .75rem;white-space:nowrap">
        <span style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:3px;background:#1a2a3a;color:#4a7aaa">${secLabel}</span>
      </td>
      <td style="padding:.55rem .75rem;white-space:nowrap">
        <button class="btn btn-secondary btn-sm" onclick="toggleEdit('${slug}','${titleEsc}')">Düzenle</button>
        <button class="btn btn-danger btn-sm" onclick="del('${slug}')" style="margin-left:.3rem">Sil</button>
      </td>
    </tr>
    <tr id="edit-${slug}" style="display:none;background:#0d1117">
      <td colspan="5" style="padding:.75rem 1rem">
        <div style="display:grid;grid-template-columns:1fr 180px auto auto;gap:.6rem;align-items:end">
          <div><label>Başlık</label><input type="text" id="et-${slug}" value="${titleEsc}" style="width:100%;height:32px"></div>
          <div><label>Bölüm</label><select id="es-${slug}" style="width:100%;height:32px">${editOpts}</select></div>
          <button class="btn btn-primary btn-sm" onclick="saveEdit('${slug}')" style="height:32px;align-self:end">Kaydet</button>
          <button class="btn btn-secondary btn-sm" onclick="cancelEdit('${slug}')" style="height:32px;align-self:end">İptal</button>
        </div>
        <div id="edit-status-${slug}" style="display:none;margin-top:.4rem;font-size:.72rem"></div>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Küratör Video</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#181818;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.5}
.btn{border:none;border-radius:4px;font-size:.75rem;font-weight:700;padding:.35rem .85rem;cursor:pointer;white-space:nowrap}
.btn-primary{background:#E30A17;color:#fff}.btn-primary:hover{opacity:.85}
.btn-secondary{background:#2a2a2a;color:#ccc;border:1px solid #333}.btn-secondary:hover{background:#333}
.btn-danger{background:transparent;color:#c0392b;border:1px solid #c0392b}.btn-danger:hover{background:#c0392b;color:#fff}
.btn-sm{padding:.25rem .6rem;font-size:.7rem}
input[type=text],input[type=url],select{background:#1a1a1a;border:1px solid #2a2a2a;color:#e8e6e0;border-radius:4px;font-family:inherit;font-size:.83rem;outline:none;padding:.35rem .6rem}
input[type=text]:focus,input[type=url]:focus,select:focus{border-color:#444}
label{font-size:.65rem;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:.3rem}
.page{max-width:900px;margin:2rem auto;padding:0 1.25rem}
.card{background:#111;border:1px solid #222;border-radius:8px;padding:1.25rem;margin-bottom:1.5rem}
.card-title{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#555;margin-bottom:1rem}
.form-row{display:grid;grid-template-columns:1fr auto;gap:.75rem;align-items:end;margin-bottom:.75rem}
.form-grid{display:grid;grid-template-columns:1fr 1fr auto;gap:.75rem;align-items:end}
.field{display:flex;flex-direction:column}
.field input,.field select{height:34px;width:100%}
.status{font-size:.75rem;padding:.3rem .6rem;border-radius:4px;margin-top:.5rem}
.status-ok{background:#14532d;color:#4ade80}.status-err{background:#7f1d1d;color:#fca5a5}
table{width:100%;border-collapse:collapse}
thead th{padding:.5rem .75rem;text-align:left;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#555;border-bottom:1px solid #222}
tbody tr{border-bottom:1px solid #1e1e1e}
tbody tr:hover:not([id^="edit-"]){background:#161616}
tbody tr.drag-over{outline:2px solid #E30A17}
.empty{padding:2rem;text-align:center;color:#444;font-size:.85rem}
</style>
</head>
<body>
${adminNav('curated-video', siteCode, allSites)}
<div class="page">
  <div class="card">
    <div class="card-title">Video Ekle</div>
    <div class="form-row">
      <div class="field">
        <label>YouTube URL</label>
        <input type="url" id="ytUrl" placeholder="https://youtu.be/… veya youtube.com/watch?v=…" oninput="onUrlInput()" style="height:34px;width:100%">
      </div>
      <div style="padding-bottom:0">
        <button class="btn btn-secondary btn-sm" onclick="fetchMeta()" id="fetchBtn" style="height:34px">Getir</button>
      </div>
    </div>
    <div class="form-grid">
      <div class="field">
        <label>Başlık</label>
        <input type="text" id="ytTitle" placeholder="Otomatik veya manuel">
      </div>
      <div class="field">
        <label>Bölüm</label>
        <select id="ytSection">${sectionOpts}</select>
      </div>
      <div style="padding-bottom:0">
        <button class="btn btn-primary" id="addBtn" onclick="addVideo()" style="height:34px">Video+</button>
      </div>
    </div>
    <div id="formStatus" style="display:none"></div>
  </div>

  <div class="card">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
      <span>Küratör Liste (${list.length})</span>
      ${list.length > 1 ? `<button class="btn btn-secondary btn-sm" id="saveOrderBtn" onclick="saveOrder()" style="display:none">Sıralamayı Kaydet</button>` : ''}
    </div>
    ${list.length === 0 ? '<div class="empty">Henüz video eklenmedi.</div>' : `
    <table id="curatedTable">
      <thead><tr><th style="width:24px"></th><th style="width:108px"></th><th>Başlık</th><th>Bölüm</th><th></th></tr></thead>
      <tbody id="curatedTbody">${rows}</tbody>
    </table>`}
  </div>
</div>
<script>
const ADMIN_SITE = '${siteCode}';
const _origFetch = window.fetch.bind(window);
window.fetch = (input, opts) => {
  if (typeof input === 'string' && input.startsWith('/admin/')) {
    try {
      const u = new URL(input, location.origin);
      if (!u.searchParams.get('site')) u.searchParams.set('site', ADMIN_SITE);
      input = u.pathname + u.search;
    } catch(e) {}
  }
  return _origFetch(input, opts);
};
const SECTIONS = ${sectionsJson};

function onUrlInput() {
  document.getElementById('fetchBtn').disabled = !document.getElementById('ytUrl').value.trim();
}

async function fetchMeta() {
  const url = document.getElementById('ytUrl').value.trim();
  if (!url) return;
  showStatus('Bilgi alınıyor…', '');
  const m = url.match(/(?:youtu\\.be\\/|[?&]v=|\\/shorts\\/)([a-zA-Z0-9_-]{11})/);
  const vid = m?.[1];
  if (!vid) { showStatus('Video ID bulunamadı', 'err'); return; }
  try {
    const r = await fetch('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' + vid + '&format=json');
    if (!r.ok) throw new Error();
    const d = await r.json();
    document.getElementById('ytTitle').value = d.title || '';
    showStatus('Başlık alındı ✓ — Eklemek için Video+ butonuna bas', 'ok');
  } catch { showStatus('Başlık alınamadı — lütfen manuel girin', 'err'); }
}

async function addVideo() {
  const youtube_url = document.getElementById('ytUrl').value.trim();
  const title = document.getElementById('ytTitle').value.trim();
  const section = document.getElementById('ytSection').value;
  if (!youtube_url) { showStatus('YouTube URL gerekli', 'err'); return; }
  document.getElementById('addBtn').disabled = true;
  showStatus('Ekleniyor…', '');
  try {
    const r = await fetch('/admin/curated-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtube_url, section, title: title || undefined }),
    });
    const d = await r.json();
    if (!r.ok) { showStatus(d.error || 'Hata', 'err'); return; }
    showStatus('Eklendi ✓', 'ok');
    document.getElementById('ytUrl').value = '';
    document.getElementById('ytTitle').value = '';
    setTimeout(() => location.reload(), 900);
  } catch { showStatus('Bağlantı hatası', 'err'); }
  finally { document.getElementById('addBtn').disabled = false; }
}

function toggleEdit(slug, title) {
  const row = document.getElementById('edit-' + slug);
  row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
  if (row.style.display !== 'none') document.getElementById('et-' + slug).focus();
}

function cancelEdit(slug) {
  document.getElementById('edit-' + slug).style.display = 'none';
}

async function saveEdit(slug) {
  const title = document.getElementById('et-' + slug).value.trim();
  const section = document.getElementById('es-' + slug).value;
  const statusEl = document.getElementById('edit-status-' + slug);
  statusEl.style.display = 'block'; statusEl.style.color = '#aaa'; statusEl.textContent = 'Kaydediliyor…';
  try {
    const r = await fetch('/admin/curated-video', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, title, section }),
    });
    const d = await r.json();
    if (!r.ok) { statusEl.style.color = '#fca5a5'; statusEl.textContent = d.error || 'Hata'; return; }
    statusEl.style.color = '#4ade80'; statusEl.textContent = 'Kaydedildi ✓';
    setTimeout(() => location.reload(), 600);
  } catch { statusEl.style.color = '#fca5a5'; statusEl.textContent = 'Bağlantı hatası'; }
}

async function del(slug) {
  if (!confirm('Bu videoyu küratör listesinden kaldır?')) return;
  const r = await fetch('/admin/curated-video', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  if (r.ok) location.reload();
  else alert('Silinemedi');
}

function showStatus(msg, type) {
  const el = document.getElementById('formStatus');
  el.style.display = 'block';
  el.className = 'status' + (type === 'ok' ? ' status-ok' : type === 'err' ? ' status-err' : '');
  el.textContent = msg;
}

// Drag-and-drop ordering
(function() {
  const tbody = document.getElementById('curatedTbody');
  const saveBtn = document.getElementById('saveOrderBtn');
  if (!tbody || !saveBtn) return;

  let dragSlug = null;

  tbody.addEventListener('dragstart', e => {
    const tr = e.target.closest('tr[data-slug]');
    if (!tr) { e.preventDefault(); return; }
    dragSlug = tr.dataset.slug;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => tr.style.opacity = '.4', 0);
  });

  tbody.addEventListener('dragend', e => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr) tr.style.opacity = '';
    tbody.querySelectorAll('tr.drag-over').forEach(r => r.classList.remove('drag-over'));
  });

  tbody.addEventListener('dragover', e => {
    e.preventDefault();
    const tr = e.target.closest('tr[data-slug]');
    if (!tr || tr.dataset.slug === dragSlug) return;
    tbody.querySelectorAll('tr.drag-over').forEach(r => r.classList.remove('drag-over'));
    tr.classList.add('drag-over');
  });

  tbody.addEventListener('dragleave', e => {
    if (!tbody.contains(e.relatedTarget)) {
      tbody.querySelectorAll('tr.drag-over').forEach(r => r.classList.remove('drag-over'));
    }
  });

  tbody.addEventListener('drop', e => {
    e.preventDefault();
    tbody.querySelectorAll('tr.drag-over').forEach(r => r.classList.remove('drag-over'));
    const tgt = e.target.closest('tr[data-slug]');
    if (!tgt || !dragSlug || tgt.dataset.slug === dragSlug) return;
    const srcMain = document.getElementById('row-' + dragSlug);
    const srcEdit = document.getElementById('edit-' + dragSlug);
    const tgtMain = document.getElementById('row-' + tgt.dataset.slug);
    if (!srcMain || !tgtMain) return;
    tbody.insertBefore(srcMain, tgtMain);
    tbody.insertBefore(srcEdit, tgtMain);
    srcMain.style.opacity = '';
    saveBtn.style.display = 'inline-block';
  });
})();

async function saveOrder() {
  const tbody = document.getElementById('curatedTbody');
  const saveBtn = document.getElementById('saveOrderBtn');
  if (!tbody || !saveBtn) return;
  const order = [...tbody.querySelectorAll('tr[data-slug]')].map(r => r.dataset.slug);
  saveBtn.disabled = true; saveBtn.textContent = 'Kaydediliyor…';
  try {
    const r = await fetch('/admin/curated-video', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
    if (!r.ok) throw new Error();
    saveBtn.textContent = 'Kaydedildi ✓';
    saveBtn.style.background = '#14532d'; saveBtn.style.color = '#4ade80';
    setTimeout(() => {
      saveBtn.textContent = 'Sıralamayı Kaydet';
      saveBtn.style.background = ''; saveBtn.style.color = '';
      saveBtn.style.display = 'none';
      saveBtn.disabled = false;
    }, 1800);
  } catch {
    saveBtn.textContent = 'Hata — tekrar dene';
    saveBtn.disabled = false;
  }
}
</script>
</body>
</html>`;
}

function renderCostPage(data, siteCode, allSites) {
  const { current_usd, cap_usd, cap_is_override, pct_used, blocked, history, alarms, current_month } = data;
  const barPct = Math.min(parseFloat(pct_used || 0), 100);
  const barColor = barPct >= 100 ? '#E30A17' : barPct >= 80 ? '#f0a500' : '#3a9a3a';
  const statusCls = blocked ? 'status-blocked' : barPct >= 80 ? 'status-warn' : 'status-ok';
  const statusTxt = blocked ? 'BLOCKED' : barPct >= 80 ? 'WARNING' : 'OK';
  function fmtTs(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  const alarm80ts  = fmtTs(alarms[80]);
  const alarm90ts  = fmtTs(alarms[90]);
  const alarm100ts = fmtTs(alarms[100]);
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
.big-num{font-size:2.6rem;font-weight:900;color:#fff;line-height:1}
.pct-badge{display:inline-block;font-size:1.2rem;font-weight:800;margin-left:.6rem;vertical-align:middle;color:${barColor}}
.big-sub{font-size:.75rem;color:#666;margin-top:.3rem}
.bar-wrap{background:#1a1a1a;border-radius:4px;height:10px;margin:1rem 0 .5rem;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .3s}
.bar-label{font-size:.72rem;color:#888;display:flex;justify-content:space-between}
.status-ok{color:#3a9a3a;font-weight:700}
.status-warn{color:#f0a500;font-weight:700}
.status-blocked{color:#E30A17;font-weight:700}
.alarm-row{display:flex;align-items:center;gap:.75rem;padding:.55rem 0;border-bottom:1px solid #1a1a1a}
.alarm-row:last-child{border-bottom:none}
.alarm-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.alarm-dot.triggered{background:${barPct>=100?'#E30A17':barPct>=90?'#f0a500':barPct>=80?'#f0a500':'#333'}}
.alarm-dot.ok{background:#3a9a3a}
.alarm-label{font-size:.82rem;font-weight:600;min-width:3.5rem}
.alarm-ts{font-size:.73rem;color:#777;flex:1}
.alarm-ts.hit{color:#f0a500}
.alarm-dot[data-lvl="80"].on{background:${alarms[80]?'#f0a500':'#333'}}
.alarm-dot[data-lvl="90"].on{background:${alarms[90]?'#f0a500':'#333'}}
.alarm-dot[data-lvl="100"].on{background:${alarms[100]?'#E30A17':'#333'}}
.row-btns{display:flex;gap:.6rem;margin-top:1rem;flex-wrap:wrap}
.btn{background:#1a1a1a;border:1px solid #333;color:#ccc;padding:.45rem 1rem;border-radius:4px;font-size:.78rem;cursor:pointer;font-family:inherit}
.btn:hover{border-color:#555;color:#fff}
.btn.danger{border-color:#5a1a1a;color:#e07070}
.btn.danger:hover{border-color:#E30A17;color:#E30A17}
.btn.primary{border-color:#335;color:#aad;background:#1a1a2a}
.btn.primary:hover{border-color:#44f;color:#ccf}
.cap-edit{display:none;align-items:center;gap:.5rem;margin-top:.75rem;flex-wrap:wrap}
.cap-edit input{background:#1a1a1a;border:1px solid #333;color:#e8e6e0;padding:.4rem .6rem;border-radius:4px;font-size:.82rem;font-family:inherit;width:90px}
.cap-source{font-size:.7rem;color:#555;margin-top:.3rem}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:.7rem;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:4px 0;border-bottom:1px solid #222}
td{padding:6px 0;border-bottom:1px solid #1a1a1a;font-size:.85rem}
td:last-child{text-align:right;color:#888}
#toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#222;border:1px solid #444;color:#e8e6e0;padding:.6rem 1rem;border-radius:5px;font-size:.8rem;display:none;z-index:999}
</style>
</head>
<body>
${adminNav('cost', siteCode, allSites)}
<main>
  <div class="card">
    <h2>This Month — ${current_month}</h2>
    <div>
      <span class="big-num">$${current_usd.toFixed(4)}</span>
      <span class="pct-badge">${barPct.toFixed(1)}%</span>
    </div>
    <div class="big-sub">of $${cap_usd.toFixed(2)} cap — <span class="${statusCls}">${statusTxt}</span></div>
    <div class="bar-wrap"><div class="bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
    <div class="bar-label"><span>${barPct.toFixed(1)}% used</span><span>$${Math.max(0, cap_usd - current_usd).toFixed(4)} remaining</span></div>
    <div class="row-btns">
      <button class="btn primary" onclick="toggleCapEdit()">Edit Cap</button>
      <button class="btn danger" onclick="doReset()">Reset Counter</button>
    </div>
    <div class="cap-edit" id="capEditRow">
      <span style="font-size:.78rem;color:#888">New cap ($):</span>
      <input type="number" id="capInput" min="1" max="9999" step="0.5" value="${cap_usd.toFixed(2)}"/>
      <button class="btn primary" onclick="saveCap()">Save</button>
      <button class="btn" onclick="toggleCapEdit()">Cancel</button>
    </div>
    <div class="cap-source">${cap_is_override ? 'Cap: KV override (cost:cap key)' : 'Cap: MONTHLY_CLAUDE_CAP env var — use Edit Cap to override at runtime'}</div>
  </div>

  <div class="card">
    <h2>Alarms</h2>
    <div class="alarm-row">
      <div class="alarm-dot" data-lvl="80" style="background:${alarms[80]?'#f0a500':'#333'}"></div>
      <span class="alarm-label">80%</span>
      <span class="alarm-ts ${alarm80ts?'hit':''}">${alarm80ts ? 'Triggered: ' + alarm80ts : 'Not triggered'}</span>
    </div>
    <div class="alarm-row">
      <div class="alarm-dot" data-lvl="90" style="background:${alarms[90]?'#f0a500':'#333'}"></div>
      <span class="alarm-label">90%</span>
      <span class="alarm-ts ${alarm90ts?'hit':''}">${alarm90ts ? 'Triggered: ' + alarm90ts : 'Not triggered'}</span>
    </div>
    <div class="alarm-row">
      <div class="alarm-dot" data-lvl="100" style="background:${alarms[100]?'#E30A17':'#333'}"></div>
      <span class="alarm-label">100%</span>
      <span class="alarm-ts ${alarm100ts?'hit':''}">${alarm100ts ? 'Triggered: ' + alarm100ts : 'Not triggered'}</span>
    </div>
    <p style="font-size:.7rem;color:#555;margin-top:.75rem">Alarm timestamps are recorded once per month — first crossing only. Reset counter to clear.</p>
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
</main>
<div id="toast"></div>
<script>
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 2500);
}
function toggleCapEdit() {
  const row = document.getElementById('capEditRow');
  row.style.display = row.style.display === 'flex' ? 'none' : 'flex';
}
async function saveCap() {
  const cap = parseFloat(document.getElementById('capInput').value);
  if (!cap || cap <= 0) { toast('Invalid cap value'); return; }
  const r = await fetch('/admin/cost', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ action: 'set-cap', cap }) });
  if (r.ok) { toast('Cap updated — reloading…'); setTimeout(() => location.reload(), 800); }
  else { toast('Error saving cap'); }
}
async function doReset() {
  if (!confirm('Reset current month counter and all alarm timestamps?')) return;
  const r = await fetch('/admin/cost', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ action: 'reset' }) });
  if (r.ok) { toast('Counter reset — reloading…'); setTimeout(() => location.reload(), 800); }
  else { toast('Error resetting'); }
}
</script>
</body>
</html>`;
}

function renderFinancialsPage(monthsData, fixedItems, costData, activeTab, siteCode, allSites) {
  const allMonths    = monthsData.map(d => d.month);
  const currentMonth = allMonths[allMonths.length - 1] || '';
  const allManual = monthsData.flatMap(d => d.manual.map(c => ({ ...c, startMonth: d.month })));

  // Cost panel data
  const { current_usd, cap_usd, cap_is_override, pct_used, blocked, history: costHistory, alarms, current_month: costMonth } = costData;
  const barPct = Math.min(parseFloat(pct_used || 0), 100);
  const barColor = barPct >= 100 ? '#E30A17' : barPct >= 80 ? '#f0a500' : '#3a9a3a';
  const statusCls = blocked ? 'status-blocked' : barPct >= 80 ? 'status-warn' : 'status-ok';
  const statusTxt = blocked ? 'BLOCKED' : barPct >= 80 ? 'WARNING' : 'OK';
  function fmtTs(iso) { if (!iso) return null; const d = new Date(iso); return d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  const alarm80ts = fmtTs(alarms[80]), alarm90ts = fmtTs(alarms[90]), alarm100ts = fmtTs(alarms[100]);

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
.tabs{display:flex;gap:0;border-bottom:1px solid #2a2a2a;margin-bottom:1.5rem}
.tab-btn{padding:.55rem 1.25rem;cursor:pointer;font-size:.75rem;color:#666;border:none;background:none;border-bottom:2px solid transparent;font-family:inherit}
.tab-btn.active{color:#fff;border-bottom-color:#E30A17}
.tab-btn:hover{color:#ccc}
#costPanel .cost-card{background:#111;border:1px solid #222;border-radius:6px;padding:1.25rem 1.5rem;margin-bottom:1.25rem}
#costPanel .ch2{font-size:.78rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:1rem}
#costPanel .big-num{font-size:2.6rem;font-weight:900;color:#fff;line-height:1}
#costPanel .pct-badge{display:inline-block;font-size:1.2rem;font-weight:800;margin-left:.6rem;vertical-align:middle;color:${barColor}}
#costPanel .big-sub{font-size:.75rem;color:#666;margin-top:.3rem}
#costPanel .bar-wrap{background:#1a1a1a;border-radius:4px;height:10px;margin:1rem 0 .5rem;overflow:hidden}
#costPanel .bar-fill{height:100%;border-radius:4px}
#costPanel .bar-label{font-size:.72rem;color:#888;display:flex;justify-content:space-between}
#costPanel .status-ok{color:#3a9a3a;font-weight:700}
#costPanel .status-warn{color:#f0a500;font-weight:700}
#costPanel .status-blocked{color:#E30A17;font-weight:700}
#costPanel .alarm-row{display:flex;align-items:center;gap:.75rem;padding:.55rem 0;border-bottom:1px solid #1a1a1a}
#costPanel .alarm-row:last-child{border-bottom:none}
#costPanel .alarm-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
#costPanel .alarm-label{font-size:.82rem;font-weight:600;min-width:3.5rem}
#costPanel .alarm-ts{font-size:.73rem;color:#777;flex:1}
#costPanel .alarm-ts.hit{color:#f0a500}
#costPanel .row-btns{display:flex;gap:.6rem;margin-top:1rem;flex-wrap:wrap}
#costPanel .cbtn{background:#1a1a1a;border:1px solid #333;color:#ccc;padding:.45rem 1rem;border-radius:4px;font-size:.78rem;cursor:pointer;font-family:inherit}
#costPanel .cbtn:hover{border-color:#555;color:#fff}
#costPanel .cbtn.danger{border-color:#5a1a1a;color:#e07070}
#costPanel .cbtn.danger:hover{border-color:#E30A17;color:#E30A17}
#costPanel .cbtn.primary{border-color:#335;color:#aad;background:#1a1a2a}
#costPanel .cbtn.primary:hover{border-color:#44f;color:#ccf}
#costPanel .cap-edit{display:none;align-items:center;gap:.5rem;margin-top:.75rem;flex-wrap:wrap}
#costPanel .cap-edit input{background:#1a1a1a;border:1px solid #333;color:#e8e6e0;padding:.4rem .6rem;border-radius:4px;font-size:.82rem;font-family:inherit;width:90px}
#costPanel .cap-source{font-size:.7rem;color:#555;margin-top:.3rem}
#costPanel table{width:100%;border-collapse:collapse}
#costPanel th{text-align:left;font-size:.7rem;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:4px 0;border-bottom:1px solid #222}
#costPanel td{padding:6px 0;border-bottom:1px solid #1a1a1a;font-size:.85rem}
#costPanel td:last-child{text-align:right;color:#888}
#toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#222;border:1px solid #444;color:#e8e6e0;padding:.6rem 1rem;border-radius:5px;font-size:.8rem;display:none;z-index:999}
</style>
</head>
<body>
${adminNav('financials', siteCode, allSites)}
<main>
<div class="tabs">
  <button class="tab-btn${activeTab==='fin'?' active':''}" onclick="showTab('fin')">Finansal Özet</button>
  <button class="tab-btn${activeTab==='cost'?' active':''}" onclick="showTab('cost')">Claude Maliyeti</button>
</div>
<div id="finPanel" style="display:${activeTab==='fin'?'block':'none'}">
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
</div><!-- /finPanel -->

<div id="costPanel" style="display:${activeTab==='cost'?'block':'none'};max-width:640px;margin:0 auto">
  <div class="cost-card">
    <div class="ch2">This Month — ${costMonth}</div>
    <div>
      <span class="big-num">$${current_usd.toFixed(4)}</span>
      <span class="pct-badge">${barPct.toFixed(1)}%</span>
    </div>
    <div class="big-sub">of $${cap_usd.toFixed(2)} cap — <span class="${statusCls}">${statusTxt}</span></div>
    <div class="bar-wrap"><div class="bar-fill" style="width:${barPct}%;background:${barColor}"></div></div>
    <div class="bar-label"><span>${barPct.toFixed(1)}% used</span><span>$${Math.max(0, cap_usd - current_usd).toFixed(4)} remaining</span></div>
    <div class="row-btns">
      <button class="cbtn primary" onclick="toggleCapEdit()">Edit Cap</button>
      <button class="cbtn danger" onclick="doReset()">Reset Counter</button>
    </div>
    <div class="cap-edit" id="capEditRow">
      <span style="font-size:.78rem;color:#888">New cap ($):</span>
      <input type="number" id="capInput" min="1" max="9999" step="0.5" value="${cap_usd.toFixed(2)}"/>
      <button class="cbtn primary" onclick="saveCap()">Save</button>
      <button class="cbtn" onclick="toggleCapEdit()">Cancel</button>
    </div>
    <div class="cap-source">${cap_is_override ? 'Cap: KV override (cost:cap key)' : 'Cap: MONTHLY_CLAUDE_CAP env var — use Edit Cap to override at runtime'}</div>
  </div>
  <div class="cost-card">
    <div class="ch2">Alarms</div>
    <div class="alarm-row"><div class="alarm-dot" style="background:${alarms[80]?'#f0a500':'#333'}"></div><span class="alarm-label">80%</span><span class="alarm-ts ${alarm80ts?'hit':''}">${alarm80ts?'Triggered: '+alarm80ts:'Not triggered'}</span></div>
    <div class="alarm-row"><div class="alarm-dot" style="background:${alarms[90]?'#f0a500':'#333'}"></div><span class="alarm-label">90%</span><span class="alarm-ts ${alarm90ts?'hit':''}">${alarm90ts?'Triggered: '+alarm90ts:'Not triggered'}</span></div>
    <div class="alarm-row"><div class="alarm-dot" style="background:${alarms[100]?'#E30A17':'#333'}"></div><span class="alarm-label">100%</span><span class="alarm-ts ${alarm100ts?'hit':''}">${alarm100ts?'Triggered: '+alarm100ts:'Not triggered'}</span></div>
    <p style="font-size:.7rem;color:#555;margin-top:.75rem">Alarm timestamps are recorded once per month — first crossing only. Reset counter to clear.</p>
  </div>
  <div class="cost-card">
    <div class="ch2">History</div>
    <table><thead><tr><th>Month</th><th>Spend (USD)</th></tr></thead>
    <tbody>${costHistory.map(h=>`<tr><td>${h.month}</td><td>$${h.usd.toFixed(4)}</td></tr>`).join('')}</tbody></table>
  </div>
</div><!-- /costPanel -->

</main>
<div id="toast"></div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script>
const ADMIN_SITE = '${siteCode}';
const _origFetch = window.fetch.bind(window);
window.fetch = (input, opts) => {
  if (typeof input === 'string' && input.startsWith('/admin/')) {
    try {
      const u = new URL(input, location.origin);
      if (!u.searchParams.get('site')) u.searchParams.set('site', ADMIN_SITE);
      input = u.pathname + u.search;
    } catch(e) {}
  }
  return _origFetch(input, opts);
};
function showTab(t) {
  document.getElementById('finPanel').style.display = t==='fin'?'block':'none';
  document.getElementById('costPanel').style.display = t==='cost'?'block':'none';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.textContent.includes(t==='fin'?'Finansal':'Claude')));
}
function toast(msg) { const t=document.getElementById('toast'); t.textContent=msg; t.style.display='block'; setTimeout(()=>{t.style.display='none';},2500); }
function toggleCapEdit() { const r=document.getElementById('capEditRow'); r.style.display=r.style.display==='flex'?'none':'flex'; }
async function saveCap() { const cap=parseFloat(document.getElementById('capInput').value); if(!cap||cap<=0){toast('Invalid cap');return;} const r=await fetch('/admin/cost',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'set-cap',cap})}); if(r.ok){toast('Cap updated — reloading…');setTimeout(()=>location.reload(),800);}else{toast('Error saving cap');} }
async function doReset() { if(!confirm('Reset current month counter and all alarm timestamps?'))return; const r=await fetch('/admin/cost',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'reset'})}); if(r.ok){toast('Counter reset — reloading…');setTimeout(()=>location.reload(),800);}else{toast('Error resetting');} }
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

function renderSourcesPage(siteCode, allSites) {
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
${adminNav('sources', siteCode, allSites)}
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
        <th>On</th><th>Name / URL</th><th>Type</th><th>Trust</th><th>Family</th><th>Treatment</th>
        <th>NVS</th><th style="text-align:center;white-space:nowrap;font-size:10px" title="All videos qualify — bypass BJK keyword filter">All Q</th><th>Notes</th><th style="text-align:right">Actions</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</main>
<script>
const ADMIN_SITE = '${siteCode}';
const _origFetch = window.fetch.bind(window);
window.fetch = (input, opts) => {
  if (typeof input === 'string' && input.startsWith('/admin/')) {
    try {
      const u = new URL(input, location.origin);
      if (!u.searchParams.get('site')) u.searchParams.set('site', ADMIN_SITE);
      input = u.pathname + u.search;
    } catch(e) {}
  }
  return _origFetch(input, opts);
};
const TIERS      = ['T1','T2','T3','T4'];
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
      <td><input type="text" value="\${esc(r.source_family||'')}" placeholder="e.g. turkuvaz" style="width:90px" onchange="markDirty('\${r.id}')"/></td>
      <td><select onchange="markDirty('\${r.id}')">\${TREATMENTS.map(t=>\`<option \${t===r.treatment?'selected':''}>\${t}</option>\`).join('')}</select></td>
      <td><input type="number" style="width:52px" value="\${r.nvs_hint??''}" placeholder="auto" onchange="markDirty('\${r.id}')"/></td>
      <td style="text-align:center"><input type="checkbox" \${r.all_qualify?'checked':''} onchange="markDirty('\${r.id}')"/></td>
      <td><input type="text" value="\${esc(r.notes||'')}" placeholder="notes" onchange="markDirty('\${r.id}')"/></td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" onclick="save('\${r.id}')">Save</button>
        <span class="saved" id="saved-\${r.id}" style="display:none">✓</span>
        <button class="btn btn-sm" onclick="openEdit('\${r.id}')">Edit</button>
        <button class="btn btn-blue btn-sm" onclick="testSource('\${r.id}')">Test</button>
        <button class="btn btn-red btn-sm" onclick="delSource('\${r.id}')">Del</button>
      </td>
    </tr>
    <tr class="test-row" id="test-\${r.id}" style="display:none"><td colspan="10"><span id="test-out-\${r.id}"></span></td></tr>
    <tr id="edit-\${r.id}" style="display:none"><td colspan="10">
      <div style="padding:8px 14px;background:#f8fafc;display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;border-top:1px solid #e2e8f0">
        \${r.source_type==='rss'
          ? \`<label style="font-size:11px;display:flex;flex-direction:column;gap:2px">Feed URL<input id="eu-\${r.id}" type="text" value="\${esc(r.url||'')}" style="width:320px"/></label>\`
          : \`<label style="font-size:11px;display:flex;flex-direction:column;gap:2px">Channel ID<input id="ec-\${r.id}" type="text" value="\${esc(r.channel_id||'')}" style="width:180px"/></label>\`
        }
        <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="eproxy-\${r.id}" \${r.proxy?'checked':''}/> Proxy</label>
        <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="ep4-\${r.id}" \${r.is_p4?'checked':''}/> P4</label>
        <button class="btn btn-green btn-sm" onclick="saveEdit('\${r.id}','\${r.source_type}')">Apply</button>
        <button class="btn btn-sm" onclick="document.getElementById('edit-\${r.id}').style.display='none'">Cancel</button>
      </div>
    </td></tr>
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
  const family  = inputs[3];
  const treat   = inputs[4];
  const nvs     = inputs[5];
  const allq    = inputs[6];
  const notes   = inputs[7];
  await fetch('/admin/sources', { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
    id, is_active: active.checked, name: name.value,
    trust_tier: tier.value, source_family: family.value || null,
    treatment: treat.value,
    nvs_hint: nvs.value ? parseInt(nvs.value) : null,
    all_qualify: allq.checked,
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

function openEdit(id) {
  const row = document.getElementById('edit-'+id);
  row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
}

async function saveEdit(id, type) {
  const patch = { id };
  if (type === 'rss') {
    const u = document.getElementById('eu-'+id);
    if (u) patch.url = u.value.trim();
  } else {
    const c = document.getElementById('ec-'+id);
    if (c) patch.channel_id = c.value.trim();
  }
  const proxy = document.getElementById('eproxy-'+id);
  const p4    = document.getElementById('ep4-'+id);
  if (proxy) patch.proxy  = proxy.checked;
  if (p4)    patch.is_p4  = p4.checked;
  await fetch('/admin/sources', { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(patch) });
  document.getElementById('edit-'+id).style.display = 'none';
  load();
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

function renderAdminReportPage(siteCode, allSites) {
  const nav = adminNav('report', siteCode, allSites);
  const shell = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Report</title>
<script type="text/javascript" src="https://www.gstatic.com/charts/loader.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f0f2f5;color:#1e293b;font-family:'Segoe UI',system-ui,sans-serif;font-size:15px;line-height:1.6}
.toolbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:.6rem 1.5rem;display:flex;align-items:center;gap:1rem;position:sticky;top:48px;z-index:9;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.toolbar input{flex:1;max-width:380px;background:#f8fafc;border:1px solid #e2e8f0;color:#1e293b;padding:.45rem .75rem;font-size:.88rem;font-family:inherit;outline:none;border-radius:4px}
.toolbar input:focus{border-color:#94a3b8}
.toolbar-right{display:flex;align-items:center;gap:1rem;margin-left:auto;font-size:.75rem;color:#94a3b8}
.refresh-btn{background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:.3rem .85rem;cursor:pointer;font-size:.75rem;font-family:inherit;border-radius:4px}
.refresh-btn:hover{border-color:#94a3b8;color:#1e293b}
.refresh-btn:disabled{opacity:.4;cursor:not-allowed}
.range-bar{background:#f8fafc;border-bottom:1px solid #e2e8f0;padding:.45rem 1.5rem;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;position:sticky;top:88px;z-index:8}
.range-btn{background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:.3rem .7rem;cursor:pointer;font-size:.75rem;font-family:inherit;line-height:1;border-radius:4px}
.range-btn:hover{border-color:#94a3b8;color:#1e293b}
.range-btn.active{background:#f0fdf4;border-color:#16a34a;color:#15803d;font-weight:600}
.range-sep{color:#cbd5e1;margin:0 .2rem;font-size:.8rem}
.range-input{background:#fff;border:1px solid #e2e8f0;color:#475569;padding:.28rem .5rem;font-size:.75rem;font-family:inherit;width:152px;border-radius:4px}
.range-apply{background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:.28rem .6rem;cursor:pointer;font-size:.75rem;font-family:inherit;border-radius:4px}
.range-apply:hover{border-color:#94a3b8;color:#1e293b}
.range-label{margin-left:auto;font-size:.7rem;color:#94a3b8}
main{max-width:1200px;margin:1.5rem auto;padding:0 1.5rem}
#sankey-wrap{background:#fff;border:1px solid #e2e8f0;margin-bottom:1.25rem;padding:.85rem 1.1rem;border-radius:6px}
.sankey-title{font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;margin-bottom:.6rem;font-weight:400}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#e2e8f0;border:1px solid #e2e8f0;margin-bottom:1.25rem;border-radius:6px;overflow:hidden}
.grid4 .cell,.grid2 .cell{background:#fff;padding:1.25rem 1.4rem}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.25rem}
.stat-lbl{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;margin-bottom:.4rem}
.stat-val{font-size:2rem;font-weight:900;line-height:1;color:#1e293b}
.stat-val.g{color:#16a34a}.stat-val.b{color:#2563eb}.stat-val.a{color:#d97706}
.stat-sub{font-size:.7rem;color:#94a3b8;margin-top:.3rem}
.section{background:#fff;border:1px solid #e2e8f0;margin-bottom:1rem;border-radius:6px;overflow:hidden}
.sec-head{display:flex;align-items:center;justify-content:space-between;padding:.8rem 1.1rem;cursor:pointer;user-select:none}
.sec-head:hover{background:#f8fafc}
.sec-title{font-size:.88rem;font-weight:700;display:flex;align-items:center;gap:.6rem;color:#1e293b}
.badge{font-size:.65rem;background:#f1f5f9;border:1px solid #e2e8f0;color:#64748b;padding:2px 8px;border-radius:10px}
.badge.g{background:#f0fdf4;border-color:#bbf7d0;color:#16a34a}
.badge.r{background:#fef2f2;border-color:#fecaca;color:#dc2626}
.badge.a{background:#fffbeb;border-color:#fde68a;color:#d97706}
.chev{font-size:.65rem;color:#94a3b8;transition:transform .15s}
.section.open .chev{transform:rotate(180deg)}
.sec-body{display:none}
.section.open .sec-body{display:block}
.funnel-row{display:flex;align-items:center;padding:.65rem 1.1rem;border-bottom:1px solid #f1f5f9;gap:.75rem;cursor:pointer}
.funnel-row:hover{background:#f8fafc}
.funnel-row:last-child{border-bottom:none}
.f-lbl{width:175px;flex-shrink:0;font-size:.8rem;color:#475569}
.f-bar-w{flex:1;height:6px;background:#f1f5f9;border-radius:3px}
.f-bar{height:100%;border-radius:3px}.f-bar.removed,.f-bar.rejected{background:#fca5a5}.f-bar.queued{background:#fde68a}.f-bar{background:#86efac}
.f-num{width:40px;text-align:right;font-size:.85rem;font-weight:700;flex-shrink:0}
.f-delta{width:110px;text-align:right;font-size:.68rem;color:#94a3b8;flex-shrink:0}
.f-expand{width:50px;text-align:right;font-size:.65rem;color:#16a34a;flex-shrink:0}
.art-list{padding:.6rem 1.1rem}
.art-card{border:1px solid #e2e8f0;background:#fafafa;padding:.75rem .9rem;margin-bottom:.5rem;font-size:.82rem;border-radius:5px}
.art-card.hidden{display:none}
.art-meta{display:flex;align-items:center;gap:.4rem;margin-bottom:.35rem;flex-wrap:wrap}
.tag{font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;padding:2px 6px;border-radius:3px}
.tag.src{background:#f1f5f9;border:1px solid #e2e8f0;color:#64748b}
.tag.cat{background:#eff6ff;border:1px solid #bfdbfe;color:#2563eb}
.nvs{font-size:.65rem;padding:2px 6px;font-weight:700;border-radius:3px}
.nvs.hi{background:#f0fdf4;color:#15803d}.nvs.md{background:#fffbeb;color:#b45309}.nvs.lo{background:#fef2f2;color:#dc2626}
.art-title{font-size:.88rem;font-weight:600;margin-bottom:.3rem;line-height:1.4;color:#1e293b}
.art-note{font-size:.72rem;color:#94a3b8;font-style:italic;margin-bottom:.3rem}
.art-ts{display:flex;gap:1.2rem;flex-wrap:wrap}
.ts{font-size:.65rem;color:#94a3b8}
.ts strong{color:#64748b;font-weight:500}
.src-table,.runs-table{width:100%;border-collapse:collapse}
.src-table th,.runs-table th{font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;text-align:left;padding:.6rem 1.1rem;border-bottom:1px solid #e2e8f0;font-weight:600}
.src-table td,.runs-table td{padding:.65rem 1.1rem;border-bottom:1px solid #f1f5f9;font-size:.82rem}
.src-table tr:last-child td,.runs-table tr:last-child td{border-bottom:none}
.src-table tr,.runs-table tr{cursor:pointer}
.src-table tr:hover td,.runs-table tr:hover td{background:#f8fafc}
.mini-bar-w{width:60px;height:4px;background:#f1f5f9;display:inline-block;vertical-align:middle;margin-right:.4rem;border-radius:2px}
.mini-bar{height:100%;background:#16a34a;border-radius:2px}
.cat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#e2e8f0}
.cat-cell{background:#fff;padding:.9rem 1.1rem;cursor:pointer}
.cat-cell:hover{background:#f8fafc}
.cat-name{font-size:.65rem;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:.3rem}
.cat-num{font-size:1.6rem;font-weight:900;color:#16a34a;line-height:1}
.cat-sub{font-size:.65rem;color:#94a3b8;margin-top:.2rem}
.dist-row{display:flex;align-items:center;gap:.6rem;padding:.5rem 1.1rem;border-bottom:1px solid #f1f5f9}
.dist-row:last-child{border-bottom:none}
.dist-lbl{width:55px;font-size:.65rem;color:#64748b;flex-shrink:0}
.dist-bw{flex:1;height:5px;background:#f1f5f9;border-radius:3px}
.dist-b{height:100%;border-radius:3px}
.dist-n{width:28px;text-align:right;font-size:.78rem;font-weight:700;flex-shrink:0}
.ok{color:#16a34a;font-weight:700}.fail{color:#dc2626;font-weight:700}.partial{color:#d97706;font-weight:700}
.load-more{text-align:center;padding:.6rem;border-top:1px solid #f1f5f9}
.load-more button{background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:.35rem .85rem;cursor:pointer;font-size:.7rem;font-family:inherit;border-radius:4px}
.load-more button:hover{border-color:#94a3b8;color:#475569}
.loading-state{text-align:center;padding:4rem 2rem;color:#94a3b8}
.spinner{width:20px;height:20px;border:2px solid #e2e8f0;border-top-color:#16a34a;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto .75rem}
@keyframes spin{to{transform:rotate(360deg)}}
.pl-badge{display:inline-block;font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:3px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
.pl-published{background:#dcfce7;color:#15803d}
.pl-scored_low{background:#fef9c3;color:#854d0e}
.pl-url_seen{background:#f1f5f9;color:#64748b}
.pl-off_topic{background:#fee2e2;color:#991b1b}
.pl-date_old{background:#fce7f3;color:#9d174d}
.pl-too_short{background:#ffedd5;color:#9a3412}
.pl-hash_dedup{background:#ede9fe;color:#6d28d9}
.pl-title_dedup{background:#e0e7ff;color:#4338ca}
.pl-cap_drop{background:#f1f5f9;color:#475569}
.pl-synthesis_failed{background:#fde68a;color:#92400e}
.pl-live_blog_source{background:#dbeafe;color:#1e40af}
.pl-template_transfer_thin{background:#fce7f3;color:#9d174d}
.pl-table{width:100%;border-collapse:collapse}
.pl-table th{font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;text-align:left;padding:.55rem 1rem;border-bottom:1px solid #e2e8f0;font-weight:600;background:#fff;position:sticky;top:0;z-index:1}
.pl-table td{padding:.5rem 1rem;border-bottom:1px solid #f1f5f9;font-size:.8rem;vertical-align:middle}
.pl-table tr:hover td{background:#f8fafc}
.pl-title-cell{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-title-cell a{color:#1e293b;text-decoration:none}
.pl-title-cell a:hover{color:#2563eb;text-decoration:underline}
.pl-wrap{max-height:520px;overflow-y:auto}
.pl-story-hdr{display:flex;align-items:center;gap:.5rem;padding:.5rem 1rem;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:.82rem;font-weight:700;color:#1e293b;cursor:pointer}
.pl-story-hdr:hover{background:#f1f5f9}
.pl-story-count{font-size:.68rem;color:#94a3b8;font-weight:400}
.pl-st-live{display:inline-block;font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:3px;background:#dcfce7;color:#15803d;vertical-align:middle;margin-left:.35rem}
.pl-st-pub{display:inline-block;font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:3px;background:#eff6ff;color:#2563eb;vertical-align:middle;margin-left:.35rem}
.pl-st-arch{display:inline-block;font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:3px;background:#f1f5f9;color:#64748b;vertical-align:middle;margin-left:.35rem}
.pl-filter-bar{display:flex;gap:.4rem;padding:.5rem 1rem;border-bottom:1px solid #f1f5f9;flex-wrap:wrap;align-items:center}
.pl-filter-btn{background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:.2rem .55rem;cursor:pointer;font-size:.68rem;font-family:inherit;border-radius:3px}
.pl-filter-btn.active{background:#f0fdf4;border-color:#16a34a;color:#15803d;font-weight:600}
.pl-filter-btn:hover{border-color:#94a3b8}
@media(max-width:900px){.grid4{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}.cat-grid{grid-template-columns:repeat(2,1fr)}}
.an-toggle-bar{display:flex;flex-wrap:wrap;gap:.5rem;padding:.65rem 1.1rem;border-bottom:1px solid #f1f5f9;background:#fafafa}
.an-toggle{display:flex;align-items:center;gap:.35rem;font-size:.78rem;color:#475569;cursor:pointer;padding:.2rem .5rem;border:1px solid #e2e8f0;border-radius:4px;background:#fff;user-select:none}
.an-toggle:hover{border-color:#94a3b8}
.an-toggle input{accent-color:#16a34a;cursor:pointer}
.an-chart-panel{padding:.85rem 1.1rem;border-bottom:1px solid #f1f5f9}
.an-chart-panel:last-child{border-bottom:none}
.an-chart-title{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:#64748b;font-weight:700;margin-bottom:.6rem;display:flex;align-items:center;gap:.75rem}
.an-legend{display:flex;gap:.75rem;text-transform:none;letter-spacing:0;font-weight:400;font-size:.72rem;color:#475569;flex-wrap:wrap}
.an-leg-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:.25rem;vertical-align:middle}
.an-leg-sq{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:.25rem;vertical-align:middle}
.an-src-checks{display:flex;flex-wrap:wrap;gap:.35rem;padding:.4rem 0 .65rem}
.an-src-lbl{display:flex;align-items:center;gap:.3rem;font-size:.72rem;color:#475569;cursor:pointer;padding:.15rem .45rem;border:1px solid #e2e8f0;border-radius:3px;background:#fff}
.an-src-lbl:hover{border-color:#94a3b8}
.an-src-lbl input{accent-color:#16a34a;cursor:pointer}
.an-chart-ctrl-row{padding:.4rem 0 .5rem;display:flex;flex-direction:column;gap:.35rem}
.an-series-row{display:flex;flex-wrap:wrap;gap:.3rem}
.an-range-row{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;padding-top:.2rem;border-top:1px solid #f1f5f9;margin-top:.1rem}
.an-range-lbl{font-size:.68rem;color:#94a3b8;white-space:nowrap}
.an-range-mode-btn{background:#fff;border:1px solid #e2e8f0;color:#64748b;padding:.18rem .55rem;cursor:pointer;font-size:.68rem;font-family:inherit;border-radius:3px}
.an-range-mode-btn:hover{border-color:#94a3b8}
.an-range-mode-btn.active{background:#f0fdf4;border-color:#16a34a;color:#15803d;font-weight:600}
.alarm-panel{background:#fff;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;margin-bottom:1rem}
.alarm-panel-head{padding:.6rem 1.1rem;font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;font-weight:600;border-bottom:1px solid #f1f5f9}
.alarm-item{display:flex;align-items:flex-start;gap:.6rem;padding:.55rem 1.1rem;border-bottom:1px solid #f1f5f9}
.alarm-item:last-child{border-bottom:none}
.alarm-item.critical{border-left:3px solid #dc2626;background:#fff5f5}
.alarm-item.major{border-left:3px solid #d97706;background:#fffbeb}
.alarm-cat{font-size:.58rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;padding:2px 6px;border-radius:3px;flex-shrink:0;margin-top:.15rem;white-space:nowrap}
.alarm-cat.critical{background:#fee2e2;color:#dc2626}
.alarm-cat.major{background:#fef3c7;color:#d97706}
.alarm-body{flex:1;min-width:0}
.alarm-row1{display:flex;align-items:baseline;gap:.5rem;margin-bottom:.1rem;flex-wrap:wrap}
.alarm-title{font-size:.82rem;font-weight:700}
.alarm-item.critical .alarm-title{color:#dc2626}
.alarm-item.major .alarm-title{color:#d97706}
.alarm-ts{font-size:.68rem;color:#94a3b8;white-space:nowrap}
.alarm-msg{font-size:.75rem;color:#64748b}
.alarm-clear{margin-left:auto;flex-shrink:0;background:#fff;border:1px solid #e2e8f0;color:#64748b;font-size:.68rem;padding:.18rem .55rem;cursor:pointer;border-radius:3px;font-family:inherit;align-self:center}
.alarm-clear:hover{border-color:#94a3b8;color:#475569}
.kpi-strip{background:#fff;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;margin-bottom:1rem;position:sticky;top:128px;z-index:7}
.kpi-strip-row{display:flex;border-bottom:1px solid #f1f5f9}
.kpi-strip-row:last-child{border-bottom:none}
.kpi-cell{flex:1;padding:.6rem 1rem;border-right:1px solid #f1f5f9;min-width:0;overflow:hidden}
.kpi-cell:last-child{border-right:none}
.kpi-lbl{font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;font-weight:600;margin-bottom:.15rem}
.kpi-big{font-size:1.35rem;font-weight:800;line-height:1.1;color:#1e293b}
.kpi-big.kpi-green{color:#16a34a}
.kpi-big.kpi-yellow{color:#d97706}
.kpi-big.kpi-red{color:#dc2626}
.kpi-sub{font-size:.68rem;color:#64748b;margin-top:.1rem;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi-title-text{font-size:.8rem;font-weight:600;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kpi-delta-red{color:#dc2626;font-weight:600}
.kpi-spark-wrap{flex:1;padding:.5rem 1rem;border-right:1px solid #f1f5f9;min-width:0}
.kpi-spark-wrap:last-child{border-right:none}
.kpi-spark-lbl{font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;font-weight:600;margin-bottom:.2rem}
.kpi-meta{font-size:.6rem;color:#cbd5e1;padding:.2rem 1rem;text-align:right;background:#fafafa}
.kpi-loading{padding:1.2rem;color:#94a3b8;font-size:.78rem;text-align:center}
@media(max-width:768px){
  .kpi-strip-row{flex-direction:column}
  .kpi-cell{border-right:none;border-bottom:1px solid #f1f5f9}
  .kpi-cell:last-child{border-bottom:none}
  .kpi-spark-wrap{border-right:none;border-bottom:1px solid #f1f5f9}
  .kpi-spark-wrap:last-child{border-bottom:none}
  .kpi-strip{position:static}
}
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
  <div id="kpi-strip" class="kpi-strip"><div class="kpi-loading">Loading KPI strip...</div></div>
  <div id="alarm-panel" style="display:none"></div>
  <div class="section open" id="sec-pool-chart">
    <div class="sec-head" onclick="toggleSec('sec-pool-chart')">
      <div class="sec-title">📊 Pool Composition <span id="pc-total-badge" class="badge"></span></div>
      <div class="chev">▼</div>
    </div>
    <div class="sec-body" style="padding:0">
      <div id="pc-legend" style="display:flex;gap:10px;padding:6px 14px;flex-wrap:wrap;font-size:10px;border-bottom:1px solid #f1f5f9"></div>
      <div id="pc-scroll" style="overflow-x:auto;width:100%">
        <div id="pc-inner" style="min-height:190px;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:.8rem">Loading…</div>
      </div>
    </div>
  </div>
  <div id="pc-tooltip" style="display:none;position:fixed;background:rgba(15,23,42,0.92);color:#e2e8f0;padding:7px 10px;border-radius:5px;font-size:11px;pointer-events:none;z-index:200;line-height:1.6;white-space:nowrap"></div>
  <div class="section open" id="sec-pipelog">
    <div class="sec-head" onclick="toggleSec('sec-pipelog')">
      <div class="sec-title">🔎 Article Pipeline Log <span class="badge" id="pl-badge-count">—</span></div>
      <div class="chev">▼</div>
    </div>
    <div class="sec-body">
      <div class="pl-filter-bar" id="pl-filter-bar">
        <span style="font-size:.72rem;color:#94a3b8;margin-right:.25rem">Stage:</span>
        <button class="pl-filter-btn active" data-stage="" onclick="setPlFilter(this)">All</button>
        <button class="pl-filter-btn" data-stage="published" onclick="setPlFilter(this)">Published</button>
        <button class="pl-filter-btn" data-stage="scored_low" onclick="setPlFilter(this)">Below threshold</button>
        <button class="pl-filter-btn" data-stage="synthesis_failed" onclick="setPlFilter(this)">Synthesis failed</button>
        <button class="pl-filter-btn" data-stage="template_transfer_thin" onclick="setPlFilter(this)">Transfer thin</button>
        <button class="pl-filter-btn" data-stage="live_blog_source" onclick="setPlFilter(this)">Live blog</button>
        <button class="pl-filter-btn" data-stage="url_seen" onclick="setPlFilter(this)">Already seen</button>
        <button class="pl-filter-btn" data-stage="off_topic" onclick="setPlFilter(this)">Off-topic</button>
        <button class="pl-filter-btn" data-stage="date_old" onclick="setPlFilter(this)">Too old</button>
        <button class="pl-filter-btn" data-stage="too_short" onclick="setPlFilter(this)">Too short</button>
        <button class="pl-filter-btn" data-stage="title_dedup" onclick="setPlFilter(this)">Near-dupe</button>
        <button class="pl-filter-btn" data-stage="hash_dedup" onclick="setPlFilter(this)">Hash dup</button>
        <span style="color:#e2e8f0;margin:0 .25rem">|</span>
        <button class="pl-filter-btn" id="pl-group-btn" onclick="togglePlGroup()">Group by story</button>
        <button class="pl-filter-btn" onclick="exportPlCsv()" style="margin-left:.25rem">⬇ Export CSV</button>
      </div>
      <div class="pl-wrap" id="pl-wrap">
        <div class="loading-state" style="padding:2rem"><div class="spinner"></div><div>Loading article log...</div></div>
      </div>
    </div>
  </div>
  <div class="section open" id="sec-analytics">
    <div class="sec-head" onclick="toggleSec('sec-analytics')">
      <div class="sec-title">📈 Analytics</div>
      <div class="chev">▼</div>
    </div>
    <div class="sec-body">
      <div class="an-toggle-bar">
        <label class="an-toggle"><input type="checkbox" checked onchange="toggleChart('ch-funnel-trend',this.checked)"> Funnel Trend</label>
        <label class="an-toggle"><input type="checkbox" checked onchange="toggleChart('ch-source-quality',this.checked)"> Source Quality</label>
        <label class="an-toggle"><input type="checkbox" checked onchange="toggleChart('ch-pub-breakdown',this.checked)"> Published Breakdown</label>
        <label class="an-toggle"><input type="checkbox" checked onchange="toggleChart('ch-story',this.checked)"> Story Activity</label>
        <label class="an-toggle"><input type="checkbox" checked onchange="toggleChart('ch-nvs',this.checked)"> NVS Distribution</label>
        <label class="an-toggle"><input type="checkbox" checked onchange="toggleChart('ch-cost',this.checked)"> Cost per Run</label>
      </div>
      <div id="an-loading" class="loading-state" style="display:none;padding:1.5rem"><div class="spinner"></div><div>Loading analytics...</div></div>
      <div id="ch-funnel-trend" class="an-chart-panel">
        <div class="an-chart-title">Funnel Trend</div>
        <div class="an-chart-ctrl-row" id="ch-funnel-trend-ctrl"></div>
        <div id="ch-funnel-trend-svg"></div>
      </div>
      <div id="ch-source-quality" class="an-chart-panel">
        <div class="an-chart-title">Source Quality <span class="an-legend"><span><span class="an-leg-sq" style="background:#f1f5f9"></span>Through pipeline</span><span><span class="an-leg-sq" style="background:#86efac"></span>Published</span></span></div>
        <div class="an-chart-ctrl-row" id="ch-source-quality-ctrl"></div>
        <div id="ch-src-quality-svg"></div>
      </div>
      <div id="ch-pub-breakdown" class="an-chart-panel">
        <div class="an-chart-title">Published Breakdown per Day</div>
        <div class="an-chart-ctrl-row" id="ch-pub-breakdown-ctrl"></div>
        <div id="ch-pub-breakdown-svg"></div>
      </div>
      <div id="ch-story" class="an-chart-panel">
        <div class="an-chart-title">Story Activity per Day</div>
        <div class="an-chart-ctrl-row" id="ch-story-ctrl"></div>
        <div id="ch-story-svg"></div>
      </div>
      <div id="ch-nvs" class="an-chart-panel">
        <div class="an-chart-title">NVS Distribution (scored articles)</div>
        <div class="an-chart-ctrl-row" id="ch-nvs-ctrl"></div>
        <div id="ch-nvs-svg"></div>
      </div>
      <div id="ch-cost" class="an-chart-panel">
        <div class="an-chart-title">Cost per Run</div>
        <div class="an-chart-ctrl-row" id="ch-cost-ctrl"></div>
        <div id="ch-cost-svg"></div>
      </div>
    </div>
  </div>
  <div id="content" class="loading-state"><div class="spinner"></div><div>Loading report...</div></div>
</main>
</body>
</html>`;

  const script = '<script>\n' + reportDashboardJs() + '\n<\/script>';
  const kpiScript = '<script>\n' + kpiStripJs() + '\n<\/script>';
  const analyticsScript = '<script>\n' + analyticsJs() + '\n<\/script>';
  // Use function form of replace to prevent $' / $& special patterns in script content from being misinterpreted
  const poolScript = '<script>\n' + poolChartJs() + '\n<\/script>';
  const allScripts = script + '\n' + kpiScript + '\n' + analyticsScript + '\n' + poolScript + '\n</body>';
  return shell.replace('</body>', () => allScripts);
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
    '    h+=\'<div id="funnel-\'+id+\'" style="display:none;border-bottom:1px solid #f1f5f9">\';',
    '    h+=\'<div class="art-list">\'+articleCards(articles,20)+"</div></div>";',
    '  }',
    '  return h;',
    '}',
    '',
    'function articleCards(items,limit){',
    '  if(!items||!items.length)return\'<div style="padding:.75rem;color:#94a3b8;font-size:.78rem">No articles</div>\';',
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
    '    if(a.original_url&&a.original_url!="#")h+=\'<a href="\'+esc(a.original_url)+\'" target="_blank" rel="noopener" style="font-size:.68rem;color:#2563eb;text-decoration:none">&nearr; Source</a>\';',
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
    'function plToggleNext(el){var n=el.nextElementSibling;if(n)n.style.display=n.style.display==="none"?"":"none";}',
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
    '  loadPipelineLog();',
    '  if(typeof loadAnalytics==="function")loadAnalytics();',
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
    '  loadPipelineLog();',
    '  if(typeof loadAnalytics==="function")loadAnalytics();',
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
    '    var opts={width:"100%",height:200,sankey:{node:{label:{color:"#1e293b",fontSize:12,bold:true},nodePadding:15},link:{colorMode:"gradient"}},backgroundColor:{fill:"transparent"}};',
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
    '    h+=\'<div style="padding:.45rem 1.1rem .2rem;font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8">Channel</div>\';',
    '    stDist.forEach(function(x){h+=distRow(x.type,x.count,stTotal,"#2563eb");});',
    '  }',
    '  if(ttDist.length){',
    '    h+=\'<div style="padding:.45rem 1.1rem .2rem;font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8">Trust Tier</div>\';',
    '    ttDist.forEach(function(x){h+=distRow(x.tier,x.count,stTotal,"#be185d");});',
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
    '  h+=funnelRow("After URL dedup",f.after_url_dedup,maxF,"-"+((f.after_title_dedup||0)-(f.after_url_dedup||0))+" already scored","after_url_dedup",[]);',
    '  h+=funnelRow("Published ✅",f.auto_published,maxF,"NVS ≥ threshold","published",pub,"g");',
    '  h+=funnelRow("Queued ⏳",f.queued_for_review,maxF,"NVS mid-range","queued",d.queued_items,"queued");',
    '  h+=funnelRow("Rejected ❌",f.rejected,maxF,"NVS too low","rejected",rej,"rejected");',
    '  h+="</div></div>";',
    '',
    '  h+=\'<div class="section open" id="sec-sources">\';',
    '  h+=\'<div class="sec-head" data-sec="sec-sources" onclick="toggleSec(this.dataset.sec)">\';',
    '  h+=\'<div class="sec-title">📊 Pipeline by Source<span class="badge">\'+sources.length+" sources</span></div>";',
    '  h+=\'<div class="chev">▼</div></div>\';',
    '  h+=\'<div class="sec-body">\';',
    '  h+=\'<p style="color:#64748b;font-size:.78rem;margin:0 0 10px">Raw: total feed items. Date: after 8h lookback cutoff. KW: after BJK keyword filter. Lost: passed KW but never saved (deduped or below threshold). Scored: reached DB. Pub: published to live pool.</p>\';',
    '  h+=\'<table class="src-table"><thead><tr><th>Source</th><th>Type</th><th>Tier</th><th>Family</th><th>Raw</th><th title="After 8h date cutoff">Date</th><th title="After BJK keyword filter">KW</th><th style="color:#d97706">Lost</th><th>Scored</th><th style="color:#16a34a">Pub</th><th>Rate</th><th>Avg NVS</th><th>Last</th></tr></thead><tbody>\';',
    '  sources.forEach(function(s){',
    '    var sid="src-"+slug(s.source_name);',
    '    var cfg=srcTypeMap[s.source_name]||{};',
    '    var lostPct=s.kw_passed>0?Math.round((s.lost||0)/s.kw_passed*100):0;',
    '    var lostColor=lostPct>=80?"#dc2626":lostPct>=50?"#d97706":"#94a3b8";',
    '    h+=\'<tr data-sid="\'+sid+\'" onclick="toggleSrc(this.dataset.sid)">\';',
    '    h+=\'<td><strong>\'+esc(s.source_name)+"</strong></td>";',
    '    h+=\'<td style="color:#2563eb;font-size:.75rem">\'+esc(cfg.type||"—")+"</td>";',
    '    h+=\'<td style="color:#be185d;font-size:.75rem">\'+esc(cfg.tier||"—")+"</td>";',
    '    h+=\'<td style="color:#0891b2;font-size:.75rem">\'+esc(cfg.family||"—")+"</td>";',
    '    h+=\'<td style="color:#64748b">\'+( s.raw_fetched||0)+"</td>";',
    '    h+=\'<td style="color:#64748b">\'+( s.after_date||0)+"</td>";',
    '    h+=\'<td style="color:#475569">\'+( s.kw_passed||0)+"</td>";',
    '    h+=\'<td style="color:\'+lostColor+\'"><strong>\'+( s.lost||0)+"</strong>"+(s.kw_passed>0?\' <span style="font-size:.7rem">\'+lostPct+\'%</span>\':\'\')+"</td>";',
    '    h+="<td>"+(s.contributed||0)+"</td>";',
    '    h+=\'<td style="color:#16a34a;font-weight:700">\'+( s.published||0)+"</td>";',
    '    h+=\'<td><div class="mini-bar-w"><div class="mini-bar" style="width:\'+pct(s.published,s.kw_passed||s.contributed)+\'%"></div></div>\'+pct(s.published,s.kw_passed||s.contributed)+"%</td>";',
    '    h+="<td>"+nvsBadgeInline(s.avg_nvs)+"</td>";',
    '    h+=\'<td style="color:#94a3b8">\'+fmtTime(s.last_article_at)+"</td></tr>";',
    '    h+=\'<tr id="\'+sid+\'" style="display:none"><td colspan="13" style="padding:0"><div class="art-list">\'+articleCards(all.filter(function(a){return a.source_name===s.source_name;}),10)+"</div></td></tr>";',
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
    '    h+=\'<div id="cat-\'+slug(c.category)+\'" style="display:none;border-top:1px solid #f1f5f9">\';',
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
    '    h+=\'<td style="color:#64748b">\'+fmtDate(r.created_at)+"</td>";',
    '    h+=\'<td class="\'+sc+\'">\'+r.status+"</td>";',
    '    h+="<td>"+(r.items_fetched||0)+"</td>";',
    '    h+=\'<td style="color:#16a34a;font-weight:600">\'+( r.items_published||0)+"</td>";',
    '    h+=\'<td style="color:#d97706">\'+( r.items_queued||0)+"</td>";',
    '    h+=\'<td style="color:#dc2626">\'+( r.items_rejected||0)+"</td>";',
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
    'var plCurrentStage="";',
    'var plGroupByStory=false;',
    'var plAllRows=[];',
    '',
    'function plStageMeta(stage){',
    '  var m={',
    '    published:{label:"Published",cls:"pl-published"},',
    '    scored_low:{label:"Below threshold",cls:"pl-scored_low"},',
    '    synthesis_failed:{label:"Synthesis failed",cls:"pl-synthesis_failed"},',
    '    live_blog_source:{label:"Live blog (rejected)",cls:"pl-live_blog_source"},',
    '    template_transfer_thin:{label:"Transfer thin body",cls:"pl-template_transfer_thin"},',
    '    url_seen:{label:"Already seen",cls:"pl-url_seen"},',
    '    off_topic:{label:"Off-topic",cls:"pl-off_topic"},',
    '    date_old:{label:"Too old",cls:"pl-date_old"},',
    '    too_short:{label:"Too short",cls:"pl-too_short"},',
    '    hash_dedup:{label:"Hash dup",cls:"pl-hash_dedup"},',
    '    title_dedup:{label:"Near-dupe",cls:"pl-title_dedup"},',
    '    cap_drop:{label:"Cap drop",cls:"pl-cap_drop"},',
    '  };',
    '  return m[stage]||{label:stage,cls:"pl-url_seen"};',
    '}',
    '',
    'function plStatusBadge(row){',
    '  if(!row.slug)return"";',
    '  if(row.content_status==="archived")return\'<span class="pl-st-arch">Arşiv</span>\';',
    '  var ageH=row.run_at?(Date.now()-new Date(row.run_at).getTime())/3600000:99;',
    '  return ageH<8?\'<span class="pl-st-live">Canlı</span>\':\'<span class="pl-st-pub">Yayında</span>\';',
    '}',
    '',
    'function plTitleCell(row){',
    '  var text=esc(row.title||"(no title)");',
    '  if(row.slug){',
    '    return\'<a href="https://kartalix.com/haber/\'+esc(row.slug)+\'" target="_blank" rel="noopener">\'+text+"</a>"+plStatusBadge(row);',
    '  }',
    '  return text;',
    '}',
    'function plSrcCell(r){',
    '  var name=esc(r.source_name||"—");',
    '  if(r.url)return\'<a href="\'+esc(r.url)+\'" target="_blank" rel="noopener" style="color:#475569">\'+name+"</a>";',
    '  return name;',
    '}',
    '',
    'function plTableRow(r){',
    '  var m=plStageMeta(r.stage);',
    '  var ts=r.run_at?new Date(r.run_at).toLocaleString("tr-TR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"—";',
    '  var nvs=r.nvs_score!=null?nvsBadgeInline(r.nvs_score):"—";',
    '  var storyCell=r.story_title?\'<span style="color:#0891b2;font-size:.75rem">\'+esc(r.story_title.slice(0,40))+"</span>":"—";',
    '  var h="<tr>";',
    '  h+=\'<td style="color:#94a3b8;white-space:nowrap;font-size:.75rem">\'+ts+"</td>";',
    '  h+=\'<td style="white-space:nowrap;font-size:.78rem">\'+plSrcCell(r)+"</td>";',
    '  h+=\'<td class="pl-title-cell">\'+plTitleCell(r)+"</td>";',
    '  h+=\'<td><span class="pl-badge \'+m.cls+\'">\'+m.label+"</span></td>";',
    '  h+=\'<td>\'+storyCell+"</td>";',
    '  h+=\'<td>\'+nvs+"</td>";',
    '  h+="</tr>";',
    '  return h;',
    '}',
    '',
    'function setPlFilter(btn){',
    '  document.querySelectorAll(".pl-filter-btn").forEach(function(b){b.classList.remove("active");});',
    '  btn.classList.add("active");',
    '  plCurrentStage=btn.dataset.stage||"";',
    '  renderPipelineLog(plAllRows);',
    '}',
    '',
    'function togglePlGroup(){',
    '  plGroupByStory=!plGroupByStory;',
    '  var btn=document.getElementById("pl-group-btn");',
    '  if(btn)btn.classList.toggle("active",plGroupByStory);',
    '  renderPipelineLog(plAllRows);',
    '}',
    '',
    'var PL_STAGE_LABELS={"":"All","published":"Published","scored_low":"Below threshold","synthesis_failed":"Synthesis failed","template_transfer_thin":"Transfer thin body","live_blog_source":"Live blog (rejected)","url_seen":"Already seen","off_topic":"Off-topic","date_old":"Too old","too_short":"Too short","title_dedup":"Near-dupe","hash_dedup":"Hash dup"};',
    'function updatePlFilterCounts(rows){',
    '  var counts={};',
    '  rows.forEach(function(r){var s=r.stage||"";counts[s]=(counts[s]||0)+1;});',
    '  counts[""]=rows.length;',
    '  document.querySelectorAll(".pl-filter-btn[data-stage]").forEach(function(btn){',
    '    var stage=btn.dataset.stage;',
    '    var label=PL_STAGE_LABELS[stage]||stage;',
    '    var n=counts[stage]||0;',
    '    btn.textContent=label+" ("+n+")";',
    '  });',
    '}',
    '',
    'function exportPlCsv(){',
    '  if(!plAllRows||!plAllRows.length){alert("No pipeline data loaded yet.");return;}',
    '  var cols=["run_at","source_name","title","stage","nvs_score","publish_mode","trust_tier","source_body_len","drop_detail","story_title","url","slug"];',
    '  var labels=["Run At","Source","Title","Stage","NVS","Mode","Trust","BodyLen","Detail","Story","URL","Slug"];',
    '  function csvEsc(v){',
    '    if(v==null)return"";',
    '    var s=String(v);',
    '    if(s.indexOf(",")>=0||s.indexOf("\\"")>=0||s.indexOf("\\n")>=0)return\'"\'+s.replace(/"/g,\'""\')+\'"\';',
    '    return s;',
    '  }',
    '  var lines=[labels.join(",")];',
    '  plAllRows.forEach(function(r){lines.push(cols.map(function(c){return csvEsc(r[c]);}).join(","));});',
    '  var bom="\\uFEFF";',
    '  var blob=new Blob([bom+lines.join("\\n")],{type:"text/csv;charset=utf-8;"});',
    '  var u=URL.createObjectURL(blob);',
    '  var a=document.createElement("a");',
    '  a.href=u;a.download="pipeline-log-"+new Date().toISOString().slice(0,10)+".csv";',
    '  document.body.appendChild(a);a.click();document.body.removeChild(a);',
    '  URL.revokeObjectURL(u);',
    '}',
    '',
    'async function loadPipelineLog(){',
    '  var wrap=document.getElementById("pl-wrap");',
    '  if(!wrap)return;',
    '  wrap.innerHTML=\'<div class="loading-state" style="padding:2rem"><div class="spinner"></div><div>Loading...</div></div>\';',
    '  try{',
    '    var url="/admin/pipeline-log";',
    '    var params=[];',
    '    if(currentFrom)params.push("from="+encodeURIComponent(currentFrom));',
    '    if(currentTo)params.push("to="+encodeURIComponent(currentTo));',
    '    if(params.length)url+="?"+params.join("&");',
    '    var res=await fetch(url);',
    '    if(!res.ok)throw new Error("HTTP "+res.status);',
    '    plAllRows=await res.json();',
    '    var pubCount=plAllRows.filter(function(r){return r.stage==="published";}).length;',
    '    var badge=document.getElementById("pl-badge-count");',
    '    if(badge)badge.textContent=plAllRows.length+" articles · "+pubCount+" published";',
    '    updatePlFilterCounts(plAllRows);',
    '    renderPipelineLog(plAllRows);',
    '  }catch(e){',
    '    wrap.innerHTML=\'<div class="loading-state" style="padding:2rem;color:#dc2626">⚠ \'+e.message+"</div>";',
    '  }',
    '}',
    '',
    'function renderPipelineLog(rows){',
    '  var wrap=document.getElementById("pl-wrap");',
    '  if(!wrap)return;',
    '  var filtered=plCurrentStage?rows.filter(function(r){return r.stage===plCurrentStage;}):rows;',
    '  if(!filtered.length){',
    '    wrap.innerHTML=\'<div class="loading-state" style="padding:2rem">No articles for this filter and time range.</div>\';',
    '    return;',
    '  }',
    '  if(plGroupByStory){renderPipelineLogGrouped(filtered,wrap);return;}',
    '  var h=\'<table class="pl-table"><thead><tr><th>Time</th><th>Source</th><th>Title</th><th>Stage</th><th>Story</th><th>NVS</th></tr></thead><tbody>\';',
    '  filtered.forEach(function(r){h+=plTableRow(r);});',
    '  h+="</tbody></table>";',
    '  wrap.innerHTML=h;',
    '}',
    '',
    'function renderPipelineLogGrouped(rows,wrap){',
    '  // Group by story_id; null story_id → "Bağımsız"',
    '  var groups={};',
    '  rows.forEach(function(r){',
    '    var key=r.story_id||"__none__";',
    '    if(!groups[key])groups[key]={title:r.story_title||null,rows:[],pubCount:0};',
    '    groups[key].rows.push(r);',
    '    if(r.stage==="published")groups[key].pubCount++;',
    '  });',
    '  // Sort: stories with most articles first; __none__ last',
    '  var keys=Object.keys(groups).sort(function(a,b){',
    '    if(a==="__none__")return 1;if(b==="__none__")return-1;',
    '    return groups[b].rows.length-groups[a].rows.length;',
    '  });',
    '  var h="";',
    '  keys.forEach(function(key){',
    '    var g=groups[key];',
    '    var label=key==="__none__"?"📋 Hikayesiz ("+g.rows.length+" makale)":"📖 "+esc(g.title||"Story "+key.slice(0,8));',
    '    var sub=key!=="__none__"?" · "+g.rows.length+" makale, "+g.pubCount+" yayında":"";',
    '    h+=\'<div class="pl-story-hdr" onclick="plToggleNext(this)">\';',
    '    h+=label+\'<span class="pl-story-count">\'+sub+"</span></div>";',
    '    h+=\'<div><table class="pl-table"><thead><tr><th>Time</th><th>Source</th><th>Title</th><th>Stage</th><th>NVS</th></tr></thead><tbody>\';',
    '    g.rows.forEach(function(r){',
    '      var m=plStageMeta(r.stage);',
    '      var ts=r.run_at?new Date(r.run_at).toLocaleString("tr-TR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"—";',
    '      var nvs=r.nvs_score!=null?nvsBadgeInline(r.nvs_score):"—";',
    '      h+="<tr>";',
    '      h+=\'<td style="color:#94a3b8;white-space:nowrap;font-size:.75rem">\'+ts+"</td>";',
    '      h+=\'<td style="white-space:nowrap;font-size:.78rem">\'+plSrcCell(r)+"</td>";',
    '      h+=\'<td class="pl-title-cell">\'+plTitleCell(r)+"</td>";',
    '      h+=\'<td><span class="pl-badge \'+m.cls+\'">\'+m.label+"</span></td>";',
    '      h+=\'<td>\'+nvs+"</td></tr>";',
    '    });',
    '    h+="</tbody></table></div>";',
    '  });',
    '  wrap.innerHTML=h;',
    '}',
    '',
    'function fmtAlarmAge(ts){',
    '  if(!ts)return"";',
    '  var diff=Date.now()-ts;',
    '  if(diff<60000)return"just now";',
    '  if(diff<3600000)return Math.round(diff/60000)+"m ago";',
    '  if(diff<86400000)return Math.round(diff/3600000)+"h ago";',
    '  return Math.round(diff/86400000)+"d ago";',
    '}',
    'async function clearAlarm(id){',
    '  try{',
    '    await fetch("/admin/alarms/clear",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})});',
    '    loadAlarms();',
    '  }catch(e){console.log("clearAlarm error",e);}',
    '}',
    'async function loadAlarms(){',
    '  try{',
    '    var res=await fetch("/admin/alarms");',
    '    if(!res.ok)return;',
    '    var d=await res.json();',
    '    var panel=document.getElementById("alarm-panel");',
    '    var alarms=d.alarms||[];',
    '    if(!alarms.length){panel.style.display="none";return;}',
    '    panel.style.display="block";',
    '    var h=\'<div class="alarm-panel"><div class="alarm-panel-head">⚠ Alerts (\'+alarms.length+")</div>";',
    '    alarms.forEach(function(a){',
    '      var cat=a.category||"major";',
    '      h+=\'<div class="alarm-item \'+esc(cat)+\'">\';',
    '      h+=\'<span class="alarm-cat \'+esc(cat)+\'">\'+esc(cat)+"</span>";',
    '      h+=\'<div class="alarm-body">\';',
    '      h+=\'<div class="alarm-row1"><span class="alarm-title">\'+esc(a.title)+"</span>";',
    '      if(a.first_seen)h+=\'<span class="alarm-ts">since \'+fmtAlarmAge(a.first_seen)+"</span>";',
    '      h+="</div>";',
    '      h+=\'<div class="alarm-msg">\'+esc(a.msg)+"</div>";',
    '      h+="</div>";',
    '      h+=\'<button class="alarm-clear" onclick="clearAlarm(\\\'\'+esc(a.id)+\'\\\')">Clear</button>\';',
    '      h+="</div>";',
    '    });',
    '    h+="</div>";',
    '    panel.innerHTML=h;',
    '  }catch(e){console.log("loadAlarms error",e);}',
    '}',
    '',
    'setInterval(function(){loadReport();loadPipelineLog();if(typeof loadAnalytics==="function")loadAnalytics();loadAlarms();if(typeof loadKpiStrip==="function")loadKpiStrip();if(typeof loadPoolChart==="function")loadPoolChart();}, 5*60*1000);',
    'setRange("24h");',
    'loadAlarms();',
  ];
  return lines.join('\n');
}

function poolChartJs() {
  return `
(function(){
  var COLORS={yz:'#3b82f6',video:'#8b5cf6',template:'#f59e0b',rss:'#94a3b8',other:'#64748b'};
  var LABELS={yz:'YZ Yazısı',video:'Video',template:'Şablon',rss:'RSS',other:'Diğer'};
  var ORDER=['rss','other','template','video','yz'];
  var _data=[];

  function fmtTime(ms){
    var d=new Date(ms);
    return (d.getMonth()+1)+'/'+(d.getDate())+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  }

  function buildSvg(data){
    if(!data.length) return '<div style="padding:32px;text-align:center;color:#94a3b8;font-size:.8rem">No data yet — populates after first cron run</div>';
    var PW=10, CH=170, LH=22, W=data.length*PW, H=CH+LH;
    var maxY=Math.ceil(Math.max(30,...data.map(function(d){return d.total||0;}))/10)*10;
    function sy(v){return CH-(v/maxY)*CH;}
    function sx(i){return i*PW+PW/2;}

    // Compute cumulative stacks
    var stacked=data.map(function(d){
      var cum={},prev=0;
      ORDER.forEach(function(k){prev+=(d[k]||0);cum[k]=prev;});
      return cum;
    });

    // Area paths
    var paths='';
    ORDER.forEach(function(layer,li){
      var prev=li>0?ORDER[li-1]:null;
      var top=data.map(function(d,i){return sx(i)+','+sy(stacked[i][layer]);});
      var bot=data.map(function(d,i){return sx(i)+','+sy(prev?stacked[i][prev]:0);}).reverse();
      paths+='<path d="M '+top[0]+' L '+top.slice(1).join(' L ')+' L '+bot[0]+' L '+bot.slice(1).join(' L ')+' Z" fill="'+COLORS[layer]+'" opacity="0.88"/>';
    });

    // Grid lines + Y labels
    var grid='';
    for(var y=0;y<=maxY;y+=10){
      var gy=sy(y);
      grid+='<line x1="0" y1="'+gy+'" x2="'+W+'" y2="'+gy+'" stroke="#e2e8f0" stroke-width="0.5"/>';
      grid+='<text x="3" y="'+(gy-2)+'" font-size="8" fill="#cbd5e1">'+y+'</text>';
    }

    // X axis labels every 12 points (= 1h)
    var xlabels='';
    for(var i=0;i<data.length;i+=12){
      xlabels+='<text x="'+sx(i)+'" y="'+(CH+LH-3)+'" font-size="8" fill="#94a3b8" text-anchor="middle">'+fmtTime(data[i].t)+'</text>';
      xlabels+='<line x1="'+sx(i)+'" y1="'+CH+'" x2="'+sx(i)+'" y2="'+(CH+4)+'" stroke="#cbd5e1" stroke-width="0.5"/>';
    }

    // Hover rects
    var hovers='';
    data.forEach(function(d,i){
      hovers+='<rect x="'+(i*PW)+'" y="0" width="'+PW+'" height="'+CH+'" fill="transparent" class="pc-hover" data-idx="'+i+'"/>';
    });

    return '<svg width="'+W+'" height="'+H+'" style="display:block;font-family:inherit">'
      +'<g>'+grid+'</g>'
      +'<g>'+paths+'</g>'
      +'<g>'+xlabels+'</g>'
      +'<g id="pc-hovers">'+hovers+'</g>'
      +'</svg>';
  }

  function attachHovers(){
    var svg=document.querySelector('#pc-inner svg');
    if(!svg) return;
    svg.querySelectorAll('.pc-hover').forEach(function(el){
      el.addEventListener('mousemove',function(e){
        var idx=parseInt(el.getAttribute('data-idx'),10);
        var d=_data[idx]; if(!d) return;
        var tip=document.getElementById('pc-tooltip');
        var html='<b>'+fmtTime(d.t)+'</b><br>Total: '+d.total;
        ORDER.slice().reverse().forEach(function(k){ if(d[k]) html+='<br><span style="color:'+COLORS[k]+'">'+LABELS[k]+': '+d[k]+'</span>'; });
        tip.innerHTML=html;
        tip.style.display='block';
        tip.style.left=(e.clientX+14)+'px';
        tip.style.top=(e.clientY-10)+'px';
      });
      el.addEventListener('mouseleave',function(){
        document.getElementById('pc-tooltip').style.display='none';
      });
    });
  }

  window.loadPoolChart=async function(){
    try{
      var res=await fetch('/admin/pool-timeseries');
      if(!res.ok) return;
      var json=await res.json();
      _data=json.data||[];
      var inner=document.getElementById('pc-inner');
      if(!inner) return;
      inner.innerHTML=buildSvg(_data);
      attachHovers();
      // Scroll to rightmost (most recent)
      var scroll=document.getElementById('pc-scroll');
      if(scroll) scroll.scrollLeft=scroll.scrollWidth;
      // Badge: latest total
      var badge=document.getElementById('pc-total-badge');
      if(badge&&_data.length) badge.textContent=_data[_data.length-1].total+' articles';
      // Legend
      var leg=document.getElementById('pc-legend');
      if(leg) leg.innerHTML=ORDER.slice().reverse().map(function(k){
        return '<span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:2px;background:'+COLORS[k]+';display:inline-block"></span>'+LABELS[k]+'</span>';
      }).join('');
    }catch(e){console.error('pool chart',e);}
  };

  window.loadPoolChart();
})();
`;
}

function kpiStripJs() {
  return `
function sparkSvg(values,days){
  var nonNull=values.filter(function(v){return v!==null;});
  if(!nonNull.length){return '<svg viewBox="0 0 100 30" style="width:100%;height:32px;display:block"><text x="50" y="20" text-anchor="middle" fill="#e2e8f0" font-size="8">—</text></svg>';}
  var mn=Math.min.apply(null,nonNull),mx=Math.max.apply(null,nonNull);
  var mean=nonNull.reduce(function(s,v){return s+v;},0)/nonNull.length;
  function py(v){if(mx===mn){return 15;}return 3+(1-(v-mn)/(mx-mn))*24;}
  var meanY=py(mean);
  var pts=[];
  for(var i=0;i<values.length;i++){
    if(values[i]===null)continue;
    var spx=(i/13)*100;
    pts.push(spx.toFixed(1)+','+py(values[i]).toFixed(1));
  }
  var todayIdx=-1;
  for(var j=values.length-1;j>=0;j--){if(values[j]!==null){todayIdx=j;break;}}
  var circles='';
  for(var k=0;k<values.length;k++){
    if(values[k]===null)continue;
    var cx=((k/13)*100).toFixed(1),cy=py(values[k]).toFixed(1);
    var tip=((days&&days[k])?days[k]+': ':'')+Math.round(values[k]*100)/100;
    var r=k===todayIdx?'2.5':'1.2',fill=k===todayIdx?'#1e293b':'#cbd5e1';
    circles+='<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+fill+'"><title>'+tip+'</title></circle>';
  }
  return '<svg viewBox="0 0 100 30" style="width:100%;height:32px;display:block" preserveAspectRatio="none">'+
    '<line x1="0" y1="'+meanY.toFixed(1)+'" x2="100" y2="'+meanY.toFixed(1)+'" stroke="#f1f5f9" stroke-width="1"/>'+
    '<polyline points="'+pts.join(' ')+'" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linejoin="round"/>'+
    circles+'</svg>';
}

function renderKpiStrip(d){
  var ls=d.live_state||{};
  var td=d.today||{};
  var tr=d.trend_14d||{};
  var days=d.days||[];
  var ps=ls.pool_size||0;
  var psColor=ps<12?'kpi-red':ps<=25?'kpi-yellow':'kpi-green';
  var comp=ls.pool_composition||{};
  var compParts=[];
  if(comp.video)compParts.push('Video '+comp.video);
  if(comp.yz)compParts.push('AI '+comp.yz);
  if(comp.yz_plus)compParts.push('AI+ '+comp.yz_plus);
  var hs=ls.hot_story;
  var hotHtml=hs?
    '<div class="kpi-title-text">'+esc(hs.title)+'</div><div class="kpi-sub">'+hs.contribution_count+' sources · '+hs.minutes_since_last+' min ago</div>':
    '<div class="kpi-big" style="font-size:1rem">—</div><div class="kpi-sub" style="color:#cbd5e1">no active story</div>';
  var lc=ls.last_cron;
  var cronTs=lc&&lc.timestamp?lc.timestamp.slice(11,16):'—';
  var cronStatusHtml=lc?(lc.status==='success'?'<span style="color:#16a34a">✓ success</span>':'<span style="color:#dc2626">✗ failed</span>'):'';
  var cronMins=lc?lc.minutes_ago+' min ago · '+cronStatusHtml:'';
  var cronBigCls=(lc&&(lc.status!=='success'||lc.minutes_ago>90))?'kpi-red':'';
  var cronHtml='<div class="kpi-big '+cronBigCls+'">'+cronTs+'</div><div class="kpi-sub">'+cronMins+'</div>';
  var pub=td.published||{};
  var pubDelta=pub.delta_pct||0;
  var pubDeltaCls=(pubDelta<-20||pubDelta>50)?'kpi-delta-red':'';
  var pubHtml='<div class="kpi-big">'+(pub.count||0)+'</div><div class="kpi-sub">typical '+(pub.baseline||0)+' <span class="'+pubDeltaCls+'">'+(pubDelta>=0?'+':'')+pubDelta+'%</span></div>';
  var fn=td.funnel||{};
  var funnelRate=fn.qualified>0?Math.round(((pub.count||0)/fn.qualified)*100):0;
  var funnelHtml='<div class="kpi-sub" style="font-size:.75rem">'+(fn.qualified||0)+' qualified · '+(fn.unscored||0)+' unscored · '+(fn.rejected||0)+' rejected</div><div class="kpi-sub">Publish rate: '+funnelRate+'% (Q→P)</div>';
  var ch=td.live_churn||{};
  var ovStyle=ch.removed_overflow>0?' style="color:#d97706"':'';
  var churnHtml='<div class="kpi-sub" style="font-size:.75rem">+'+(ch.added||0)+' added · −'+(ch.removed_total||0)+' removed</div><div class="kpi-sub">(aged '+(ch.removed_aged_out||0)+' · TTL '+(ch.removed_ttl||0)+' · <span'+ovStyle+'>ovf '+(ch.removed_overflow||0)+'</span>)</div>';
  var ft=td.fetched||{};
  var fetchHtml='<div class="kpi-big" style="font-size:1rem">'+(ft.count||0).toLocaleString()+'</div><div class="kpi-sub">'+(ft.active_sources||0)+' sources active</div>';
  var cost=td.cost||{};
  var costBigCls=(cost.baseline_usd>0&&cost.today_usd>cost.baseline_usd*1.5)?'kpi-red':'';
  var costHtml='<div class="kpi-big '+costBigCls+'">$'+(cost.today_usd||0).toFixed(2)+'</div><div class="kpi-sub">typical $'+(cost.baseline_usd||0).toFixed(2)+'</div>';
  var sp1=sparkSvg(tr.pool_size||[],days);
  var sp2=sparkSvg(tr.median_nvs_published||[],days);
  var sp3=sparkSvg(tr.cost_daily_usd||[],days);
  var upd=new Date(d.as_of||Date.now()).toLocaleTimeString();
  return '<div class="kpi-strip-row">'+
    '<div class="kpi-cell"><div class="kpi-lbl">Live Pool</div><div class="kpi-big '+psColor+'">'+ps+'</div><div class="kpi-sub">'+esc(compParts.join(' · '))+'</div></div>'+
    '<div class="kpi-cell"><div class="kpi-lbl">Hot Story</div>'+hotHtml+'</div>'+
    '<div class="kpi-cell"><div class="kpi-lbl">Last Run</div>'+cronHtml+'</div>'+
    '</div>'+
    '<div class="kpi-strip-row">'+
    '<div class="kpi-cell"><div class="kpi-lbl">Published Today</div>'+pubHtml+'</div>'+
    '<div class="kpi-cell"><div class="kpi-lbl">Funnel Today</div>'+funnelHtml+'</div>'+
    '<div class="kpi-cell"><div class="kpi-lbl">Pool Churn</div>'+churnHtml+'</div>'+
    '<div class="kpi-cell"><div class="kpi-lbl">Fetched</div>'+fetchHtml+'</div>'+
    '<div class="kpi-cell"><div class="kpi-lbl">Cost</div>'+costHtml+'</div>'+
    '</div>'+
    '<div class="kpi-strip-row">'+
    '<div class="kpi-spark-wrap"><div class="kpi-spark-lbl">Pool (14d)</div>'+sp1+'</div>'+
    '<div class="kpi-spark-wrap"><div class="kpi-spark-lbl">Median NVS (14d)</div>'+sp2+'</div>'+
    '<div class="kpi-spark-wrap"><div class="kpi-spark-lbl">Cost (14d)</div>'+sp3+'</div>'+
    '</div>'+
    '<div class="kpi-meta">Updated '+esc(upd)+'</div>';
}

async function loadKpiStrip(){
  var el=document.getElementById('kpi-strip');
  try{
    var res=await fetch('/admin/kpi-strip');
    if(!res.ok){
      if(el)el.innerHTML='<div class="kpi-loading">KPI error: HTTP '+res.status+'</div>';
      return;
    }
    var d=await res.json();
    if(el)el.innerHTML=renderKpiStrip(d);
  }catch(e){
    console.error('loadKpiStrip error',e);
    if(el)el.innerHTML='<div class="kpi-loading">KPI error: '+String(e)+'</div>';
  }
}
setInterval(function(){loadKpiStrip();},60*1000);
loadKpiStrip();
`;
}

function analyticsJs() {
  return `
var analyticsData=null;
// Per-chart state: { series:[], from:null, to:null, data:null }
var CS={
  'ch-funnel-trend':   {series:['raw','kw','published'],from:null,to:null,data:null},
  'ch-source-quality': {series:null,from:null,to:null,data:null},
  'ch-pub-breakdown':  {series:['yz_plus','yz','video','template','other'],from:null,to:null,data:null},
  'ch-story':          {series:['opened','closed'],from:null,to:null,data:null},
  'ch-nvs':            {series:['published','rejected'],from:null,to:null,data:null},
  'ch-cost':           {series:['cost'],from:null,to:null,data:null},
};
var SMETA={
  'ch-funnel-trend':[{k:'raw',c:'#93c5fd',l:'Fetched'},{k:'kw',c:'#fb923c',l:'After KW'},{k:'published',c:'#4ade80',l:'Published',anomaly:true}],
  'ch-pub-breakdown':[{k:'yz_plus',c:'#818cf8',l:'YZ+'},{k:'yz',c:'#4ade80',l:'YZ'},{k:'video',c:'#f472b6',l:'Video'},{k:'template',c:'#fb923c',l:'Template'},{k:'other',c:'#94a3b8',l:'Other'}],
  'ch-story':[{k:'opened',c:'#60a5fa',l:'Opened'},{k:'closed',c:'#94a3b8',l:'Closed'}],
  'ch-nvs':[{k:'published',c:'#86efac',l:'Published'},{k:'rejected',c:'#cbd5e1',l:'Below threshold'}],
  'ch-cost':[{k:'cost',c:'#d97706',l:'Cost €'}],
};

function loadAnalytics(){
  var url='/admin/analytics-data';
  var params=[];
  if(currentFrom)params.push('from='+encodeURIComponent(currentFrom));
  if(currentTo)params.push('to='+encodeURIComponent(currentTo));
  if(params.length)url+='?'+params.join('&');
  var loading=document.getElementById('an-loading');
  if(loading)loading.style.display='block';
  fetch(url).then(function(r){return r.json();}).then(function(d){
    analyticsData=d;
    if(loading)loading.style.display='none';
    buildAllControls(d);
    renderAllCharts();
  }).catch(function(e){
    if(loading){loading.style.display='block';loading.textContent='⚠ '+e.message;}
  });
}

function fetchChartData(id){
  var url='/admin/analytics-data';
  var params=[];
  if(CS[id].from)params.push('from='+encodeURIComponent(CS[id].from));
  if(CS[id].to)params.push('to='+encodeURIComponent(CS[id].to));
  if(params.length)url+='?'+params.join('&');
  var svgEl=document.getElementById(id.replace('ch-','ch-').replace('source-quality','src-quality')+'-svg');
  if(id==='ch-source-quality')svgEl=document.getElementById('ch-src-quality-svg');
  else svgEl=document.getElementById(id+'-svg');
  if(svgEl)svgEl.innerHTML='<div style="text-align:center;padding:1.5rem;color:#94a3b8;font-size:.8rem">Loading…</div>';
  fetch(url).then(function(r){return r.json();}).then(function(d){
    CS[id].data=d;
    renderChart(id);
  }).catch(function(e){
    if(svgEl)svgEl.innerHTML='<div style="color:#dc2626;padding:1rem;font-size:.8rem">⚠ '+e.message+'</div>';
  });
}

function getChartData(id){return CS[id].data||analyticsData;}

function toggleChart(id,show){
  var el=document.getElementById(id);
  if(el)el.style.display=show?'':'none';
}

// ── Controls builder ─────────────────────────────────────────────

function buildAllControls(d){
  Object.keys(SMETA).forEach(function(id){buildSeriesCtrls(id);});
  buildSourceCtrls(d.source_quality||[]);
}

function seriesCb(id,m){
  var active=CS[id].series&&CS[id].series.indexOf(m.k)>=0;
  var dot=m.c?'<span class="an-leg-dot" style="background:'+m.c+';width:7px;height:7px;display:inline-block;border-radius:50%;margin-right:2px;vertical-align:middle"></span>':'';
  return '<label class="an-src-lbl"><input type="checkbox"'+(active?' checked':'')+' data-chart="'+id+'" data-key="'+m.k+'" onchange="onSeriesToggle(this)"> '+dot+m.l+'</label>';
}

function buildSeriesCtrls(id){
  var el=document.getElementById(id+'-ctrl');
  if(!el)return;
  var meta=SMETA[id];if(!meta)return;
  if(!CS[id].series)CS[id].series=meta.map(function(m){return m.k;});
  var h='<div class="an-series-row">';
  meta.forEach(function(m){h+=seriesCb(id,m);});
  h+='</div>';
  h+=rangeCtrlHtml(id);
  el.innerHTML=h;
}

function buildSourceCtrls(srcQ){
  var el=document.getElementById('ch-source-quality-ctrl');
  if(!el)return;
  var existing=el.querySelector('.an-series-row');
  if(existing)return; // already built — preserve state
  if(!CS['ch-source-quality'].series)CS['ch-source-quality'].series=srcQ.map(function(s){return s.source_name;});
  var h='<div class="an-series-row">';
  srcQ.forEach(function(s){
    var active=CS['ch-source-quality'].series.indexOf(s.source_name)>=0;
    h+='<label class="an-src-lbl"><input type="checkbox"'+(active?' checked':'')+' data-chart="ch-source-quality" data-key="'+esc(s.source_name)+'" onchange="onSeriesToggle(this)"> '+esc(s.source_name)+'</label>';
  });
  h+='</div>';
  h+=rangeCtrlHtml('ch-source-quality');
  el.innerHTML=h;
}

function rangeCtrlHtml(id){
  var isCustom=!!(CS[id].from||CS[id].to);
  return '<div class="an-range-row">'
    +'<span class="an-range-lbl">Range:</span>'
    +'<button class="an-range-mode-btn'+(isCustom?'':' active')+'" onclick="setChartRangeMode(\\''+id+'\\',false)">Master</button>'
    +'<button class="an-range-mode-btn'+(isCustom?' active':'')+'" onclick="setChartRangeMode(\\''+id+'\\',true)">Custom</button>'
    +'<span id="'+id+'-rinputs" style="display:'+(isCustom?'flex':'none')+';align-items:center;gap:.35rem;flex-wrap:wrap">'
    +'<input type="datetime-local" class="range-input" id="'+id+'-rfrom" style="width:148px"'+(CS[id].from?' value="'+(CS[id].from||'').slice(0,16)+'"':'')+'>'
    +'<input type="datetime-local" class="range-input" id="'+id+'-rto" style="width:148px"'+(CS[id].to?' value="'+(CS[id].to||'').slice(0,16)+'"':'')+'>'
    +'<button class="range-apply" onclick="applyChartRange(\\''+id+'\\')">Apply</button>'
    +(isCustom?'<button class="range-apply" onclick="clearChartRange(\\''+id+'\\')">Clear</button>':'')
    +'</span>'
    +'</div>';
}

function setChartRangeMode(id,custom){
  var row=document.getElementById(id+'-rinputs');
  if(row)row.style.display=custom?'flex':'none';
  var btns=document.querySelectorAll('#'+id+'-ctrl .an-range-mode-btn');
  if(btns.length===2){btns[0].classList.toggle('active',!custom);btns[1].classList.toggle('active',custom);}
  if(!custom)clearChartRange(id);
}

function applyChartRange(id){
  var f=document.getElementById(id+'-rfrom');
  var t=document.getElementById(id+'-rto');
  CS[id].from=f&&f.value?new Date(f.value).toISOString():null;
  CS[id].to  =t&&t.value?new Date(t.value).toISOString():null;
  CS[id].data=null;
  fetchChartData(id);
}

function clearChartRange(id){
  CS[id].from=null;CS[id].to=null;CS[id].data=null;
  var f=document.getElementById(id+'-rfrom'),t=document.getElementById(id+'-rto');
  if(f)f.value='';if(t)t.value='';
  var row=document.getElementById(id+'-rinputs');if(row)row.style.display='none';
  var btns=document.querySelectorAll('#'+id+'-ctrl .an-range-mode-btn');
  if(btns.length===2){btns[0].classList.add('active');btns[1].classList.remove('active');}
  renderChart(id);
}

function onSeriesToggle(cb){
  var id=cb.dataset.chart,key=cb.dataset.key;
  if(!CS[id].series)CS[id].series=[];
  if(cb.checked){if(CS[id].series.indexOf(key)<0)CS[id].series.push(key);}
  else{CS[id].series=CS[id].series.filter(function(k){return k!==key;});}
  renderChart(id);
}

// ── Render layer ─────────────────────────────────────────────────

function renderAllCharts(){
  Object.keys(CS).forEach(renderChart);
}

function renderChart(id){
  var d=getChartData(id);if(!d)return;
  if(id==='ch-funnel-trend')   renderFunnelTrend(d);
  else if(id==='ch-source-quality') renderSrcQuality();
  else if(id==='ch-pub-breakdown')  renderPubBreakdown(d);
  else if(id==='ch-story')          renderStoryChart(d);
  else if(id==='ch-nvs')            renderNvsChart(d);
  else if(id==='ch-cost')           renderCostChart(d);
}

function activeSeries(id){
  return (SMETA[id]||[]).filter(function(m){return !CS[id].series||CS[id].series.indexOf(m.k)>=0;});
}

function renderFunnelTrend(d){
  var series=activeSeries('ch-funnel-trend').map(function(m){return{key:m.k,color:m.c,anomaly:m.anomaly};});
  document.getElementById('ch-funnel-trend-svg').innerHTML=anSvgLine(d.runs_ts||[],series);
}

function renderPubBreakdown(d){
  var meta=activeSeries('ch-pub-breakdown');
  document.getElementById('ch-pub-breakdown-svg').innerHTML=anStackedBar(
    d.pub_by_day||[],meta.map(function(m){return m.k;}),meta.map(function(m){return m.c;})
  );
}

function renderStoryChart(d){
  var series=activeSeries('ch-story').map(function(m){return{key:m.k,color:m.c};});
  var stData=(d.story_by_day||[]).map(function(r){return{ts:r.day+'T12:00:00Z',opened:r.opened,closed:r.closed};});
  document.getElementById('ch-story-svg').innerHTML=anSvgLine(stData,series);
}

function renderNvsChart(d){
  var active=CS['ch-nvs'].series||['published','rejected'];
  document.getElementById('ch-nvs-svg').innerHTML=anHistChart(d.nvs_hist||[],active);
}

function renderCostChart(d){
  document.getElementById('ch-cost-svg').innerHTML=anSvgLine(d.runs_ts||[],[{key:'cost',color:'#d97706'}],{H:140});
}

function renderSrcQuality(){
  var d=getChartData('ch-source-quality');if(!d)return;
  var srcQ=d.source_quality||[];
  var checks=document.querySelectorAll('#ch-source-quality-ctrl input[data-key]');
  var visible=new Set();
  if(checks.length){checks.forEach(function(c){if(c.checked)visible.add(c.dataset.key);});}
  else{srcQ.forEach(function(s){visible.add(s.source_name);});}
  var filtered=srcQ.filter(function(s){return visible.has(s.source_name);});
  document.getElementById('ch-src-quality-svg').innerHTML=anHBar(filtered);
}

// ── SVG chart primitives ─────────────────────────────────────────

function anSvgLine(data,series,opts){
  opts=opts||{};
  var W=opts.W||780,H=opts.H||180,PL=44,PR=14,PT=14,PB=28;
  var cW=W-PL-PR,cH=H-PT-PB;
  if(!data||!data.length||!series||!series.length)return noDataSvg(W,H);
  var allVals=[];
  series.forEach(function(s){data.forEach(function(r){allVals.push(r[s.key]||0);});});
  var maxV=Math.max.apply(null,allVals.concat([1]));
  var n=data.length;
  var svg='<svg width="100%" viewBox="0 0 '+W+' '+H+'" style="overflow:visible;display:block">';
  for(var gi=0;gi<=4;gi++){
    var gy=(PT+cH-(gi/4)*cH).toFixed(1);
    svg+='<line x1="'+PL+'" y1="'+gy+'" x2="'+(PL+cW)+'" y2="'+gy+'" stroke="#f1f5f9" stroke-width="1"/>';
    svg+='<text x="'+(PL-4)+'" y="'+(parseFloat(gy)+4).toFixed(1)+'" text-anchor="end" fill="#94a3b8" font-size="10">'+Math.round(maxV*gi/4)+'</text>';
  }
  var step=Math.max(1,Math.ceil(n/8));
  data.forEach(function(r,i){
    if(i%step!==0&&i!==n-1)return;
    var x=(PL+i/(Math.max(n-1,1))*cW).toFixed(1);
    var lbl=r.ts?new Date(r.ts).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}):'';
    svg+='<text x="'+x+'" y="'+(H-4)+'" text-anchor="middle" fill="#94a3b8" font-size="9">'+lbl+'</text>';
  });
  series.forEach(function(s){
    var pts=data.map(function(r,i){
      return[PL+i/(Math.max(n-1,1))*cW, PT+cH-((r[s.key]||0)/maxV)*cH];
    });
    var d=pts.map(function(p,i){return(i===0?'M':'L')+p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' ');
    svg+='<path d="'+d+'" fill="none" stroke="'+s.color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    pts.forEach(function(p,i){
      var isAnomaly=s.anomaly&&!(data[i][s.key]);
      var fill=isAnomaly?'#dc2626':s.color;
      var r2=isAnomaly?5:3;
      var tip=(data[i].ts?new Date(data[i].ts).toLocaleString('tr-TR'):'')+': '+(data[i][s.key]||0);
      svg+='<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="'+r2+'" fill="'+fill+'"><title>'+tip+'</title></circle>';
    });
  });
  return svg+'</svg>';
}

function anStackedBar(data,keys,colors,opts){
  opts=opts||{};
  var W=opts.W||780,H=opts.H||180,PL=44,PR=14,PT=14,PB=28;
  var cW=W-PL-PR,cH=H-PT-PB;
  if(!data||!data.length||!keys||!keys.length)return noDataSvg(W,H);
  var totals=data.map(function(r){return keys.reduce(function(s,k){return s+(r[k]||0);},0);});
  var maxV=Math.max.apply(null,totals.concat([1]));
  var n=data.length;
  var barW=Math.max(4,Math.floor(cW/n)-2);
  var gap=n>1?(cW-barW*n)/(n-1):0;
  var svg='<svg width="100%" viewBox="0 0 '+W+' '+H+'" style="overflow:visible;display:block">';
  for(var gi=0;gi<=4;gi++){
    var gy=(PT+cH-(gi/4)*cH).toFixed(1);
    svg+='<line x1="'+PL+'" y1="'+gy+'" x2="'+(PL+cW)+'" y2="'+gy+'" stroke="#f1f5f9" stroke-width="1"/>';
    svg+='<text x="'+(PL-4)+'" y="'+(parseFloat(gy)+4).toFixed(1)+'" text-anchor="end" fill="#94a3b8" font-size="10">'+Math.round(maxV*gi/4)+'</text>';
  }
  var step=Math.max(1,Math.ceil(n/8));
  data.forEach(function(r,i){
    var x=PL+i*(barW+gap),stackY=PT+cH;
    keys.forEach(function(k,ki){
      var val=r[k]||0;if(!val)return;
      var h=(val/maxV)*cH;stackY-=h;
      svg+='<rect x="'+x.toFixed(1)+'" y="'+stackY.toFixed(1)+'" width="'+barW+'" height="'+h.toFixed(1)+'" fill="'+colors[ki]+'"><title>'+(r.day||'')+' '+k+': '+val+'</title></rect>';
    });
    if(i%step===0)svg+='<text x="'+(x+barW/2).toFixed(1)+'" y="'+(H-4)+'" text-anchor="middle" fill="#94a3b8" font-size="9">'+((r.day||'').slice(5))+'</text>';
  });
  return svg+'</svg>';
}

function anHistChart(data,active,opts){
  opts=opts||{};
  var W=opts.W||780,H=opts.H||160,PL=44,PR=14,PT=14,PB=26;
  var cW=W-PL-PR,cH=H-PT-PB;
  if(!data||!data.length)return noDataSvg(W,H);
  var showP=!active||active.indexOf('published')>=0;
  var showR=!active||active.indexOf('rejected')>=0;
  var allV=[];data.forEach(function(r){if(showP)allV.push(r.published);if(showR)allV.push(r.rejected);});
  var maxV=Math.max.apply(null,allV.concat([1]));
  var bw=Math.floor(cW/data.length),half=Math.floor(bw*0.38);
  var svg='<svg width="100%" viewBox="0 0 '+W+' '+H+'" style="overflow:visible;display:block">';
  for(var gi=0;gi<=4;gi++){
    var gy=(PT+cH-(gi/4)*cH).toFixed(1);
    svg+='<line x1="'+PL+'" y1="'+gy+'" x2="'+(PL+cW)+'" y2="'+gy+'" stroke="#f1f5f9" stroke-width="1"/>';
    svg+='<text x="'+(PL-4)+'" y="'+(parseFloat(gy)+4).toFixed(1)+'" text-anchor="end" fill="#94a3b8" font-size="10">'+Math.round(maxV*gi/4)+'</text>';
  }
  var threshX=(PL+6.5*bw).toFixed(1);
  svg+='<line x1="'+threshX+'" y1="'+PT+'" x2="'+threshX+'" y2="'+(PT+cH)+'" stroke="#fcd34d" stroke-width="1.5" stroke-dasharray="4,3"/>';
  svg+='<text x="'+threshX+'" y="'+(PT-3)+'" text-anchor="middle" fill="#d97706" font-size="9">threshold</text>';
  data.forEach(function(r,i){
    var cx=PL+(i+0.5)*bw,base=PT+cH;
    if(showP&&r.published){var pH=(r.published/maxV)*cH;svg+='<rect x="'+(cx-half-1)+'" y="'+(base-pH).toFixed(1)+'" width="'+half+'" height="'+pH.toFixed(1)+'" fill="#86efac"><title>'+r.range+' pub: '+r.published+'</title></rect>';}
    if(showR&&r.rejected){var rH=(r.rejected/maxV)*cH;svg+='<rect x="'+cx+'" y="'+(base-rH).toFixed(1)+'" width="'+half+'" height="'+rH.toFixed(1)+'" fill="#cbd5e1"><title>'+r.range+' rejected: '+r.rejected+'</title></rect>';}
    svg+='<text x="'+cx.toFixed(1)+'" y="'+(H-4)+'" text-anchor="middle" fill="#94a3b8" font-size="9">'+r.range+'</text>';
  });
  return svg+'</svg>';
}

function anHBar(data,opts){
  opts=opts||{};
  var rowH=22,PL=120,PR=85,PT=8,gap=3,W=opts.W||780;
  var H=PT+data.length*(rowH+gap)+8;
  if(!data||!data.length)return noDataSvg(W,60);
  var cW=W-PL-PR;
  var maxV=Math.max.apply(null,data.map(function(r){return r.total||1;}));
  var svg='<svg width="100%" viewBox="0 0 '+W+' '+H+'" style="display:block">';
  data.forEach(function(r,i){
    var y=PT+i*(rowH+gap),cy=(y+rowH/2+4).toFixed(1);
    var tW=((r.total||0)/maxV)*cW,pW=((r.published||0)/maxV)*cW;
    svg+='<text x="'+(PL-6)+'" y="'+cy+'" text-anchor="end" fill="#1e293b" font-size="11" font-weight="500">'+esc(r.source_name)+'</text>';
    svg+='<rect x="'+PL+'" y="'+(y+4)+'" width="'+tW.toFixed(1)+'" height="'+(rowH-8)+'" fill="#f1f5f9" rx="2"/>';
    if(pW>0)svg+='<rect x="'+PL+'" y="'+(y+4)+'" width="'+pW.toFixed(1)+'" height="'+(rowH-8)+'" fill="#86efac" rx="2"/>';
    svg+='<text x="'+(PL+cW+6)+'" y="'+cy+'" fill="#64748b" font-size="11">'+(r.pub_rate||0)+'% · NVS '+(r.avg_nvs||0)+'</text>';
  });
  return svg+'</svg>';
}

function noDataSvg(W,H){
  return '<svg width="100%" viewBox="0 0 '+W+' '+H+'"><text x="'+(W/2)+'" y="'+(H/2)+'" text-anchor="middle" fill="#94a3b8" font-size="12">No data for this range</text></svg>';
}

if(typeof currentFrom!=='undefined')loadAnalytics();
`;
}

function renderAdminReleasesPage(siteCode, allSites) {
  const nav = adminNav('releases', siteCode, allSites);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Roadmap &amp; Releases</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.6}
.content{max-width:900px;margin:0 auto;padding:2rem 1.5rem}
h1{font-size:22px;font-weight:800;margin-bottom:4px;color:#fff}
.subtitle{color:#555;font-size:12px;letter-spacing:.06em;margin-bottom:2rem}
.section-title{font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.1em;margin:2.5rem 0 1rem;padding-bottom:6px;border-bottom:1px solid #1a1a1a}
.rlist{display:flex;flex-direction:column;gap:2px;margin-bottom:.5rem}
.rrow{display:grid;grid-template-columns:90px 1fr auto;align-items:start;gap:1rem;padding:14px 16px;background:#111;border:1px solid #1e1e1e;cursor:pointer;transition:background .15s}
.rrow:hover{background:#161616}
.rrow.active{background:#141420;border-color:#2a2a4a}
.vtag{font-size:.7rem;font-weight:800;letter-spacing:.06em;padding:3px 8px;border-radius:3px;white-space:nowrap;display:inline-block}
.vtag.shipped{background:#0a2a0a;color:#3a9a3a;border:1px solid #1a4a1a}
.vtag.current{background:#1a1a0a;color:#c8f135;border:1px solid #3a3a0a}
.vtag.next{background:#1a1a2a;color:#7a7aff;border:1px solid #2a2a4a}
.vtag.planned{background:#1a1a1a;color:#555;border:1px solid #2a2a2a}
.vtag.blocked{background:#2a0a0a;color:#ff4444;border:1px solid #4a1a1a}
.rrow-title{font-size:13px;font-weight:600;color:#ddd}
.rrow-sub{font-size:11px;color:#666;margin-top:2px}
.rrow-date{font-size:11px;color:#444;white-space:nowrap}
.freeze-badge{display:inline-block;font-size:.6rem;font-weight:700;padding:1px 5px;background:#12101a;color:#8877ff;border:1px solid #2a2040;border-radius:2px;margin-left:6px;vertical-align:middle}
.detail{display:none;padding:18px 16px;background:#0d0d14;border:1px solid #1e1e2e;border-top:none;margin-bottom:12px}
.detail.open{display:block}
.detail table{width:100%;border-collapse:collapse;margin-bottom:14px}
.detail td{padding:5px 8px;font-size:12px;border-bottom:1px solid #1a1a1a;vertical-align:top}
.detail td:first-child{color:#666;width:160px;white-space:nowrap}
.detail td:last-child{color:#ccc}
.detail h4{font-size:11px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;margin-top:14px}
.detail ul{padding-left:18px}
.detail li{font-size:12px;color:#bbb;margin-bottom:4px;line-height:1.5}
.rtag{display:inline-block;font-size:.58rem;font-weight:700;padding:1px 5px;margin-right:5px;vertical-align:middle;letter-spacing:.07em}
.feat{background:#1d4ed818;color:#4488ff;border:1px solid #1d4ed850}
.fix{background:#c8f13518;color:#c8f135;border:1px solid #c8f13550}
.perf{background:#ffaa0018;color:#ffaa00;border:1px solid #ffaa0050}
.next{background:#7c3aed18;color:#a78bfa;border:1px solid #7c3aed50}
.defer{background:#37415118;color:#6b7280;border:1px solid #37415150}
.note{background:#0f766e18;color:#2dd4bf;border:1px solid #0f766e50}
.criteria{background:#0f0f18;border:1px solid #2a2a3a;padding:12px 16px;margin-top:12px}
.criteria h5{font-size:11px;font-weight:700;color:#8877ff;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.criteria li{font-size:12px;color:#aaa;margin-bottom:3px}
code{background:#1a1a1a;padding:1px 5px;border-radius:3px;font-size:11px;color:#c8f135;font-family:monospace}
.backup-box{background:#0a0a12;border:1px solid #1a1a2a;padding:12px 16px;margin-top:12px;font-size:12px;color:#666;line-height:1.8}
.backup-box strong{color:#8877ff}
</style>
</head>
<body>
${nav}
<div class="content">
  <h1>Roadmap &amp; Releases</h1>
  <p class="subtitle">Kartalix / PitchOS &nbsp;·&nbsp; AI-native Beşiktaş news platform &nbsp;·&nbsp; Click any release to expand. Source of truth: <code>docs/ROADMAP.md</code></p>

  <div class="section-title">Planned &amp; In Flight</div>
  <div class="rlist">

    <div class="rrow" onclick="toggle('r10')">
      <span class="vtag planned">v1.0</span>
      <div><div class="rrow-title">Public Launch <span class="freeze-badge">FROZEN RELEASE</span></div><div class="rrow-sub">Security hardened · Trust gated · Situational awareness · Telegram ops · Lawyer re-confirmed</div></div>
      <div class="rrow-date">Target: Jul 2026</div>
    </div>
    <div id="r10" class="detail">
      <div class="criteria">
        <h5>Freeze criteria — all must pass before tagging v1.0.0</h5>
        <ul>
          <li>✅ Sprint H complete (news pool, rewrite queue, topic pages, multi-source synthesis)</li>
          <li>✅ Audit pre-work complete — P0 security fixes + DB migrations (v0.91 done 2026-05-16)</li>
          <li>✅ Sprint I complete — trust layer, synthesis gated on source quality (v0.95 done 2026-05-18)</li>
          <li>☐ Sprint J complete — match highlights pipeline</li>
          <li>☐ Sprint K complete — situational awareness engine</li>
          <li>✅ <code>/run</code>, <code>/force-*</code> endpoints require auth — <code>requireOps()</code> on 20 routes (CF 5567db5a)</li>
          <li>✅ Admin session cookie is server-generated token (<code>crypto.randomUUID()</code> + KV, done 2026-05-16)</li>
          <li>☐ <code>ADMIN_PIN</code> secret set in Wrangler — no hardcoded fallback</li>
          <li>☐ Homepage &lt;2s on mobile (4G throttled)</li>
          <li>☐ 40+ articles visible for 3 consecutive days without manual intervention</li>
          <li>☐ Widgets load on kartalix.com, app.kartalix.com, www.kartalix.com — all three</li>
          <li>☐ Kaydet tested: beklemede → yayında promotes to KV within one cron tick</li>
          <li>☐ /admin/cost shows current month spend within cap</li>
          <li>☐ Rewrite articles: ≥3/day for 3 consecutive days (proxy + RSS fallback both exercised)</li>
          <li>☐ No article older than its content-type hard TTL visible on homepage</li>
          <li>☐ At least one synthesis blocked by trust gate (logged in console)</li>
          <li>☐ Situational context block present in at least one synthesis article</li>
          <li>☐ Telegram ops alert wired (Claude cap hit + zero-article run → message)</li>
          <li>☐ Legal sign-off re-confirmed after Sprint H ships</li>
          <li>☐ git tag v1.0.0, CF version ID noted, KV export saved, Supabase backup downloaded</li>
        </ul>
      </div>
      <div class="backup-box">
        <strong>Freeze procedure</strong><br>
        1. <code>git tag v1.0.0 &amp;&amp; git push origin v1.0.0</code><br>
        2. Note Cloudflare Version ID from <code>npx wrangler deploy</code> output<br>
        3. <code>npx wrangler kv bulk get --binding=PITCHOS_CACHE &gt; backups/kv-v1.0.0.json</code><br>
        4. Supabase Dashboard → Settings → Backups → Download<br>
        <strong>Rollback:</strong> <code>npx wrangler rollback [version-id]</code>
      </div>
    </div>

    <div class="rrow" onclick="toggle('r097')">
      <span class="vtag planned">v0.97</span>
      <div><div class="rrow-title">Situational Awareness Engine — Sprint K</div><div class="rrow-sub">League position · Mathematical locks · European path · Editorial narrative arc</div></div>
      <div class="rrow-date">After v0.96</div>
    </div>
    <div id="r097" class="detail">
      <h4>Goal</h4>
      <p style="font-size:12px;color:#aaa;margin-bottom:12px">Every synthesis article has a factually-grounded situational context block. Fabricated "kritik viraj" framing eliminated.</p>
      <h4>Prerequisites</h4>
      <ul>
        <li>Migration 0008 (<code>sites.editorial_context</code>) must be run before K4 begins ✅ done 2026-05-15</li>
        <li>Worker refactor: extract HTML rendering into <code>src/renderer.js</code> before K5 (audit P1-5)</li>
      </ul>
      <h4>Scope — Sprint K</h4>
      <ul>
        <li><strong>K4 first</strong> — <code>sites.editorial_context</code> admin form + BJK seed data</li>
        <li><strong>K1</strong> — Layer 1 gap-fill: remaining fixtures, cache invalidation after result flash</li>
        <li><strong>K2</strong> — Mathematical locks + rival threat index + GD tiebreaker flag</li>
        <li><strong>K3</strong> — European qualification tree (rules + cascade + drop-down + unit tests)</li>
        <li><strong>K5</strong> — <code>src/situation.js</code> glue + <code>formatForPrompt()</code> + integration into synthesize / preview generators</li>
      </ul>
      <div class="criteria">
        <h5>Freeze criteria</h5>
        <ul>
          <li>At least one published synthesis article contains situational context block</li>
          <li><code>computeMathLocks()</code> + <code>computeEuropeanPath()</code> unit tests pass for edge cases</li>
          <li>Layer 3 admin form: BJK editorial context seeded and visible in /admin</li>
        </ul>
      </div>
    </div>

    <div class="rrow" onclick="toggle('rsd')">
      <span class="vtag planned">v1.3</span>
      <div><div class="rrow-title">Special Day Templates</div><div class="rrow-sub">30 Ağustos · 19 Mayıs · 23 Nisan · 10 Kasım · 24 Kasım · Kurban · Ramazan Bayramı — auto-fires at midnight TRT</div></div>
      <div class="rrow-date">Post-launch</div>
    </div>
    <div id="rsd" class="detail">
      <h4>Goal</h4>
      <p style="font-size:12px;color:#aaa;margin-bottom:12px">Date-aware commemorative templates that fire automatically when the calendar date arrives — no manual trigger needed. Covers Turkish national days and Islamic bayrams (Hijri dates computed annually).</p>
      <h4>Days covered</h4>
      <ul>
        <li><strong>30 Ağustos</strong> — Zafer Bayramı (Victory Day)</li>
        <li><strong>19 Mayıs</strong> — Atatürk'ü Anma, Gençlik ve Spor Bayramı</li>
        <li><strong>23 Nisan</strong> — Ulusal Egemenlik ve Çocuk Bayramı</li>
        <li><strong>10 Kasım</strong> — Atatürk'ü Anma günü</li>
        <li><strong>24 Kasım</strong> — Öğretmenler Günü</li>
        <li><strong>Kurban Bayramı</strong> — 4 days; Hijri date lookup required</li>
        <li><strong>Ramazan Bayramı</strong> — 3 days; Hijri date lookup required</li>
      </ul>
      <h4>Implementation</h4>
      <ul>
        <li>Midnight TRT cron checks Gregorian + Hijri calendar; fires pipeline trigger if today matches</li>
        <li>Dedicated template per occasion with curated commemorative content</li>
        <li>No manual intervention — same trigger pipeline as match watcher</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('r096')">
      <span class="vtag planned">v0.96</span>
      <div><div class="rrow-title">Match Highlights — Sprint J</div><div class="rrow-sub">Highlight clips auto-fetched · Embedded around BJK fixtures · Match article quality++</div></div>
      <div class="rrow-date">After v0.95</div>
    </div>
    <div id="r096" class="detail">
      <h4>Goal</h4>
      <p style="font-size:12px;color:#aaa;margin-bottom:12px">Match highlight clips fetched and embedded automatically around BJK fixtures.</p>
      <h4>Prerequisites</h4>
      <ul>
        <li>Fix <code>NEXT_MATCH</code> hardcoded constant — Sprint J uses <code>fixture_id</code> for event API calls; stale ID produces silent wrong content. Make <code>match:BJK:next</code> KV the single source of truth.</li>
      </ul>
      <h4>Scope</h4>
      <ul>
        <li>Full spec in <code>docs/SLICES.md</code> Sprint J and <code>temp/kartalix_match_highlights_prompt.txt</code></li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('r095')">
      <span class="vtag shipped">v0.95</span>
      <div><div class="rrow-title">Trust Layer + AdSense Compliance ✅</div><div class="rrow-sub">Source tier multiplier · Source family diversity · Rewrite quality · AdSense structural fix · _routes.json catch-all</div></div>
      <div class="rrow-date">May 18, 2026</div>
    </div>
    <div id="r095" class="detail">
      <table>
        <tr><td>Shipped</td><td>2026-05-18</td></tr>
      </table>
      <ul>
        <li><span class="rtag fix">done</span> <strong>I1</strong> <code>trust_multiplier = trust_score / 50</code> wired into <code>rankAndEvict</code>; T1→90, T2→70, T3→50, T4→25; sources admin updated with Family column</li>
        <li><span class="rtag fix">done</span> <strong>I2</strong> Synthesis gate uses <code>source_family</code> diversity — Turkuvaz papers count as one family; scMap loaded once per cron cycle</li>
        <li><span class="rtag feat">feat</span> <strong>Rewrite quality</strong> — <code>extractFactsFromSource()</code> (Haiku, transient) injected into synthesis; <code>targetWords</code> tiers by bullet count; filler prohibitions added</li>
        <li><span class="rtag fix">fix</span> <strong>AdSense compliance</strong> — <code>shouldShowAds()</code> gates articles by template + body length (≥1200 chars); utility pages fully ad-free; <code>_routes.json</code> + catch-all 404 Pages Function eliminates SPA fallback serving ads; all trailing-slash variants handled</li>
        <li><span class="rtag perf">perf</span> Pipeline cron: hourly → 2-hourly (<code>0 */2 * * *</code>)</li>
        <li><em style="color:#555;font-size:11px">I3/I4 journalist accuracy tracking deferred to v1.6 — needs Twitter + YT transcript signal</em></li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('r091')">
      <span class="vtag shipped">v0.91</span>
      <div><div class="rrow-title">Audit Pre-work — Security + DB Migrations ✅</div><div class="rrow-sub">P0 auth guards · Session cookie upgrade · Architecture audit 2026-05-15</div></div>
      <div class="rrow-date">May 16, 2026</div>
    </div>
    <div id="r091" class="detail">
      <h4>Scope — from architecture audit 2026-05-15</h4>
      <ul>
        <li><span class="rtag fix">done</span> <strong>P0-2</strong> Remove <code>|| 'kartalix2026'</code> fallback from admin login — fails hard if <code>ADMIN_PIN</code> secret unset</li>
        <li><span class="rtag fix">done</span> <strong>P0-1</strong> <code>requireOps()</code> auth guard on all <code>force-*</code>, <code>/run</code>, <code>/clear-cache</code>, <code>/rebuild-cache</code> handlers (20 routes) — CF version 5567db5a</li>
        <li><span class="rtag fix">done</span> <strong>P1-4</strong> Migration 0008 <code>sites.editorial_context</code> created and run</li>
        <li><span class="rtag fix">done</span> <strong>P1-2</strong> Sprint I DB migrations run: <code>trust_tier</code>, <code>source_family</code>, <code>trust_score</code></li>
        <li><span class="rtag fix">done</span> <strong>P2-5</strong> pitchos-proxy auto-enrich cron confirmed disabled</li>
        <li><span class="rtag fix">done</span> <strong>P1-1</strong> Session cookie: <code>crypto.randomUUID()</code> on login, KV-stored token (7-day TTL), <code>HttpOnly; Secure; SameSite=Lax</code> flags — done 2026-05-16</li>
      </ul>
    </div>

  </div>

  <div class="section-title">Parallel Workstreams</div>
  <div class="rlist">

    <div class="rrow" onclick="toggle('rvh')">
      <span class="vtag shipped">Video Hub</span>
      <div><div class="rrow-title">Video Hub — Classifier + /konu/videolar Redesign</div><div class="rrow-sub">7-type classifier · Server-rendered video page · 4 filter tabs · Featured ranking (next)</div></div>
      <div class="rrow-date">May 2026</div>
    </div>
    <div id="rvh" class="detail">
      <ul>
        <li><span class="rtag feat">done</span> <strong>VH1</strong> <code>video_type</code> column + 3-type classifier (highlight / interview / news) — CF version 3e87c5e3</li>
        <li><span class="rtag feat">done</span> <strong>VH2</strong> /konu/videolar server-rendered redesign — 4 tabs (Tümü / Haber / Maç Özetleri / Röportajlar), 3 sections, retention filters — CF version 5b3f89a1</li>
        <li><span class="rtag feat">done</span> <strong>VH3</strong> Fix Pack 1 Revised — 7-type classifier (match_highlight, generic_highlight, coach_interview, president_interview, player_interview, generic_interview, news), CSS grid fix — CF version 7938b66</li>
        <li><span class="rtag note">note</span> <code>CURRENT_COACH_NAMES</code> is empty — populate when new coach officially signed</li>
        <li><span class="rtag next">next</span> <strong>VH4</strong> Featured Ranking Logic — tier hierarchy + time-decay <code>featured_rank</code>, compute at query time</li>
        <li><span class="rtag next">next</span> <strong>VH5</strong> Homepage Video Filter — top 3 youtube_embed by featured_rank</li>
        <li><span class="rtag defer">defer</span> <strong>VH6</strong> Admin override (<code>featured_until</code> / <code>featured_blocked</code>) — after auto-logic proven</li>
        <li><span class="rtag next">next</span> <strong>VH7</strong> Curated video sections (Unutulmaz + Belgeseller) — <code>manual_section</code> column; <code>/admin/curated-video</code> endpoint; skips classifier; new tabs in /konu/videolar</li>
        <li><span class="rtag next">next</span> <strong>VH8</strong> Video search — server-side ILIKE search box in /konu/videolar header; respects active tab filter</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('rads')">
      <span class="vtag shipped">AdSense</span>
      <div><div class="rrow-title">AdSense Readiness — Pack 1 + Pack 2</div><div class="rrow-sub">robots.txt · author unification · /kosullar Terms · cookie banner · meta tags · canonical fix · routing fix</div></div>
      <div class="rrow-date">May 27, 2026</div>
    </div>
    <div id="rads" class="detail">
      <h4>Pack 1 — git <code>c489881</code></h4>
      <ul>
        <li><span class="rtag feat">feat</span> <code>robots.txt</code> added — <code>Allow: /</code>, <code>Disallow: /api/</code>, Sitemap pointer</li>
        <li><span class="rtag fix">fix</span> Author name unified — <code>"Ali Genç"</code> → <code>"Ali Gencer"</code> in JSON-LD + article byline</li>
        <li><span class="rtag fix">fix</span> Removed <code>&lt;meta name="ai-generated" content="true"/&gt;</code> from all article pages</li>
      </ul>
      <h4>Pack 2 — git <code>fd73c05</code></h4>
      <ul>
        <li><span class="rtag feat">feat</span> <code>/kosullar</code> Terms of Service page — full Turkish ToS, worker-rendered, footer-linked</li>
        <li><span class="rtag feat">feat</span> Cookie consent banner (<code>siteCookieBanner()</code>) on all worker-rendered pages — localStorage-backed, matches SPA consent key</li>
        <li><span class="rtag feat">feat</span> Meta descriptions + <code>og:</code> + <code>twitter:</code> tags on all 5 static pages (hakkimizda, iletisim, gizlilik, kaynak-atif, editoryal-politika)</li>
        <li><span class="rtag fix">fix</span> Canonical URL corrected on all static pages — was hardcoded <code>/</code>, now page-specific path</li>
        <li><span class="rtag fix">fix</span> <code>siteFooter()</code>: added Kullanım Koşulları link</li>
        <li><span class="rtag fix">fix</span> <code>/kosullar</code> routing — added to <code>wrangler.toml</code> routes + <code>_routes.json</code> exclude; git <code>3b5a5cb</code>, CF version <code>e448c745</code></li>
      </ul>
      <h4>Pack 3 — git <code>4b4500d</code> · CF <code>dea1d768</code></h4>
      <ul>
        <li><span class="rtag fix">fix</span> Match stats widget tightened — whitelist <code>['T-HT','T11','T12','T13','T-XG']</code> in both SPA and worker; removes spurious stats on news/analysis articles. Previously SPA fired for any <code>template_id</code>, silently falling back to <code>current-match-stats</code>.</li>
      </ul>
      <h4>AdSense readiness open items</h4>
      <ul>
        <li><span class="rtag next">next</span> P0.3 Consistent byline on every article: "Kartalix Editorial · Ali Gencer" + visible publication date</li>
        <li><span class="rtag next">next</span> P1.1 Read top 20 articles; improve weakest 5 for substance (Ali)</li>
        <li><span class="rtag defer">defer</span> P2.1 Sitemap: exclude rss_summary + T10/T11 cards older than 24h</li>
        <li><span class="rtag defer">defer</span> P2.3–2.4 Lighthouse perf + mobile usability pass</li>
      </ul>
    </div>

  </div>

  <div class="section-title">Shipped</div>
  <div class="rlist">

    <div class="rrow" onclick="toggle('r09')">
      <span class="vtag shipped">v0.9</span>
      <div><div class="rrow-title">News Pool &amp; Publish Queue — Sprint H ✅</div><div class="rrow-sub">Persistent rewrite queue · Ranked 200-slot pool · Topic pages · Multi-source synthesis gate</div></div>
      <div class="rrow-date">May 14, 2026</div>
    </div>
    <div id="r09" class="detail">
      <table>
        <tr><td>Shipped</td><td>2026-05-14</td></tr>
      </table>
      <ul>
        <li><span class="rtag feat">feat</span> <strong>H1</strong> Persistent rewrite queue — NVS≥60 overflow queued to KV; drain runs each hourly cron (top 8 by NVS)</li>
        <li><span class="rtag feat">feat</span> <strong>H2</strong> <code>rankAndEvict</code> — <code>rank_score = nvs × e^(-age/halfLife) × storyBoost</code>; pool 200; re-rank every tick</li>
        <li><span class="rtag feat">feat</span> <strong>H3</strong> Quick-publish "Yayınla ↑" button — POST <code>/admin/content-publish</code>; one-click from pending list</li>
        <li><span class="rtag feat">feat</span> <strong>H4</strong> Topic pages — <code>/konu/transfer</code>, <code>/konu/mac</code>, <code>/konu/sakat</code>, <code>/konu/kulup</code>, <code>/konu/analiz</code>, <code>/konu/milli</code></li>
        <li><span class="rtag feat">feat</span> <strong>H5</strong> Multi-source synthesis gate — ≥3 contributions, ≥2 in 6h, NVS≥60, ≥2 distinct sources</li>
        <li><span class="rtag feat">feat</span> Homepage <code>.cat-nav</code> tabs: Tümü / Transfer / Maç / Videolar</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('r08')">
      <span class="vtag shipped">v0.8</span>
      <div><div class="rrow-title">Operational Fixes <span class="freeze-badge">b8dd716 · CF: 0fbe6b4e</span></div><div class="rrow-sub">Widget CORS wildcard · Rewrite RSS fallback · Kaydet status · Badge cleanup</div></div>
      <div class="rrow-date">May 13, 2026</div>
    </div>
    <div id="r08" class="detail">
      <table>
        <tr><td>Git commit</td><td><code>b8dd716</code> on main</td></tr>
        <tr><td>CF Worker version</td><td><code>0fbe6b4e-8ac5-4ef1-94ba-abddc2e66e62</code></td></tr>
      </table>
      <ul>
        <li><span class="rtag fix">fix</span> Widget CORS → <code>*</code> wildcard + <code>Cache-Control: no-store</code> on all 5 endpoints — fixes app./www. subdomains</li>
        <li><span class="rtag fix">fix</span> Wrangler cron Sunday: <code>0 2 * * 0</code> → <code>0 2 * * 7</code></li>
        <li><span class="rtag fix">fix</span> Duplicate <code>opponent_id</code> key removed from /next-match builder</li>
        <li><span class="rtag feat">feat</span> Rewrite RSS fallback — proxy timeout → use RSS summary ≥100 chars as source</li>
        <li><span class="rtag perf">perf</span> Rewrite cap raised 4 → 6 per cron run</li>
        <li><span class="rtag fix">fix</span> Kaydet reads eStatus, sends status to backend; backend PATCH + KV update</li>
        <li><span class="rtag feat">feat</span> Badge labels consolidated: YZ, YZ+, Ş:xxx, Video, Manuel, Kaynak, RSS</li>
        <li><span class="rtag feat">feat</span> Sprint H spec + ROADMAP.md added to repo</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('r07')">
      <span class="vtag shipped">v0.7</span>
      <div><div class="rrow-title">Truth &amp; Voice</div><div class="rrow-sub">Facts Firewall · Truth Layer · Story Foundation · Voice Agent Ph.2 · Admin Tools</div></div>
      <div class="rrow-date">May 13, 2026</div>
    </div>
    <div id="r07" class="detail">
      <ul>
        <li><span class="rtag feat">feat</span> Slice 1: Facts Firewall — facts + fact_lineage tables; source text destruction</li>
        <li><span class="rtag feat">feat</span> Slice 1.5: Truth Layer Ph.1–3 — grounding context, verifyArticle, needs_review ⚠️ badge</li>
        <li><span class="rtag feat">feat</span> Slice 2: Story Foundation — 130 stories, state machine, 46 with transitions; all_pass: true</li>
        <li><span class="rtag feat">feat</span> Slice 3.9 Voice Ph.2: 13 Turkish rules; weekly DNA cron; voice_patterns KV; style injection</li>
        <li><span class="rtag feat">feat</span> /admin/tools; next match self-caching KV; /admin/archive-legacy</li>
        <li><span class="rtag feat">feat</span> Sprint D2 multi-source synthesis; H2H widget on T02; tr.json; feed quality hotfix</li>
        <li><span class="rtag feat">feat</span> AdSense + ads.txt; DB migrations 0003–0005</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('r06')">
      <span class="vtag shipped">v0.6</span>
      <div><div class="rrow-title">Source Intelligence</div><div class="rrow-sub">Sprint E feeds · Sprint F source configs · Sprint G sentiment judge</div></div>
      <div class="rrow-date">May 5, 2026</div>
    </div>
    <div id="r06" class="detail">
      <ul>
        <li><span class="rtag feat">feat</span> Sprint E: Fotospor, Transfermarkt, Google News Transfer; hourly cron; keywordFilter fixes</li>
        <li><span class="rtag feat">feat</span> F1: Source independence gate — press-only chains cap at developing</li>
        <li><span class="rtag feat">feat</span> F2: YouTube into unified pipeline; F3: source_configs DB + /admin/sources/ui</li>
        <li><span class="rtag feat">feat</span> Sprint G: rival_pov −25 NVS cap in scoreArticles; Financials page</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('r05')">
      <span class="vtag shipped">v0.5</span>
      <div><div class="rrow-title">Content Rewrite</div><div class="rrow-sub">Sprint C YouTube · Sprint D single-source · Sprint D2 multi-source synthesis</div></div>
      <div class="rrow-date">May 2, 2026</div>
    </div>
    <div id="r05" class="detail">
      <ul>
        <li><span class="rtag feat">feat</span> Sprint C: 5 YT channels; match video templates T-VID-HLT/GOL/BP/INT/REF</li>
        <li><span class="rtag feat">feat</span> Sprint D: synthesizeArticle — single-source rewrite via Render proxy; publish_mode: rewrite</li>
        <li><span class="rtag feat">feat</span> Sprint D2: synthesizeStory — true multi-source (≥3 contributions), independent angle</li>
        <li><span class="rtag feat">feat</span> extractKeyEntities Haiku pre-call; raw RSS removed from KV frontend</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('r04')">
      <span class="vtag shipped">v0.4</span>
      <div><div class="rrow-title">Match Intelligence</div><div class="rrow-sub">12 match templates · Sprint A event flashes · Sprint B widgets</div></div>
      <div class="rrow-date">May 1, 2026</div>
    </div>
    <div id="r04" class="detail">
      <ul>
        <li><span class="rtag feat">feat</span> 12 match templates: T01–T13, T-XG, T-REF; match watcher */5 cron</li>
        <li><span class="rtag feat">feat</span> Sprint A: T-RED, T-VAR, T-OG, T-PEN, T-HT; seen_event_ids dedup</li>
        <li><span class="rtag feat">feat</span> Sprint B: standings + fixtures + team widgets on homepage; fixture widget on match articles</li>
        <li><span class="rtag feat">feat</span> API-Football Pro confirmed; API key as Workers secret; Open-Meteo weather in T01</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('r03')">
      <span class="vtag shipped">v0.3</span>
      <div><div class="rrow-title">Pipeline Reliability</div><div class="rrow-sub">KV ceiling · Supabase dedup · 7-band NVS · age penalty</div></div>
      <div class="rrow-date">April 17, 2026</div>
    </div>
    <div id="r03" class="detail">
      <ul>
        <li><span class="rtag fix">fix</span> KV ceiling 8 → 50; permanent Supabase URL dedup (~€17/mo saved)</li>
        <li><span class="rtag feat">feat</span> 7-band NVS, age penalty (−15@24h, −30@48h), post-scoring story dedup</li>
        <li><span class="rtag feat">feat</span> Match templates T05/T08b/T09 as Haiku-generated Turkish prose</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('r02')">
      <span class="vtag shipped">v0.2</span>
      <div><div class="rrow-title">Content Quality</div><div class="rrow-sub">12 RSS sources · NVS scoring · hero carousel · Render proxy</div></div>
      <div class="rrow-date">April 6, 2026</div>
    </div>

    <div class="rrow" onclick="toggle('r01')">
      <span class="vtag shipped">v0.1</span>
      <div><div class="rrow-title">Live Pipeline</div><div class="rrow-sub">Cloudflare Worker · Claude API · KV cache · cron · Supabase</div></div>
      <div class="rrow-date">March 2026</div>
    </div>

  </div>

  <div class="section-title">Post-Launch Backlog (v1.1+)</div>
  <div class="rlist">

    <div class="rrow" onclick="toggle('b11')">
      <span class="vtag planned">v1.1</span>
      <div><div class="rrow-title">Squad Intelligence — Slice 4.5</div><div class="rrow-sub">squad_members DB · dynamic keyword config · auto-rebuild on squad change</div></div>
      <div class="rrow-date">~1–2 wks</div>
    </div>
    <div id="b11" class="detail">
      <ul>
        <li>squad_members table: name, name_variations JSONB, role, status, position, nationality</li>
        <li>buildKeywordConfig(siteId): Haiku auto-generates keyword list with transliterations weekly</li>
        <li>Transfer window mode: target/rumored players added to keywords May–Aug, Jan–Feb</li>
        <li>Admin UI at /admin/squad — add/edit/remove players, regenerate keywords button</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('b12')">
      <span class="vtag planned">v1.2</span>
      <div><div class="rrow-title">Distribute Agent — Slice 5.5</div><div class="rrow-sub">Push notifications · distribution_log · channel fan-out by NVS tier</div></div>
      <div class="rrow-date">~1–2 wks</div>
    </div>
    <div id="b12" class="detail">
      <ul>
        <li>distribute(article, site, env) replaces direct KV write — fans out by NVS tier</li>
        <li>Push notifications (NVS≥80): Web Push API, service worker on fan site</li>
        <li>push_subscriptions Supabase table; /subscribe-push endpoint</li>
        <li>distribution_log table: article_id, channel, status, sent_at</li>
        <li>Twitter/X: stub only — activate when ad revenue covers $100/mo</li>
      </ul>
    </div>

    <div class="rrow" onclick="toggle('b13')">
      <span class="vtag planned">v1.3</span>
      <div><div class="rrow-title">Visual Asset Agent — Slice 5</div><div class="rrow-sub">Image pipeline · IT6 templates · CDN upload</div></div>
      <div class="rrow-date">~2–3 wks</div>
    </div>

    <div class="rrow" onclick="toggle('b14')">
      <span class="vtag planned">v1.4</span>
      <div><div class="rrow-title">Editorial QA + Authors — Slice 6</div><div class="rrow-sub">Guest submissions · Telegram author channel · two-stage approval</div></div>
      <div class="rrow-date">~2–3 wks</div>
    </div>

    <div class="rrow" onclick="toggle('b15')">
      <span class="vtag planned">v1.5</span>
      <div><div class="rrow-title">Governance — Slice 7</div><div class="rrow-sub">CLO legal rule engine · CFO full cost attribution · weekly reports</div></div>
      <div class="rrow-date">~2 wks</div>
    </div>

    <div class="rrow" onclick="toggle('b16')">
      <span class="vtag planned">v1.6</span>
      <div><div class="rrow-title">Self-Learning — Slice 8</div><div class="rrow-sub">Engagement signals → scoring · source performance table · journalist accuracy</div></div>
      <div class="rrow-date">~3 wks</div>
    </div>

    <div class="rrow" onclick="toggle('b17')">
      <span class="vtag planned">v1.7</span>
      <div><div class="rrow-title">Multi-Dimensional Trust Engine</div><div class="rrow-sub">Content-type multiplier · Corroboration score · Journalist accuracy ranking</div></div>
      <div class="rrow-date">~3–4 wks</div>
    </div>
    <div id="b17" class="detail">
      <h4>Full rank formula</h4>
      <p style="font-size:12px;color:#aaa;margin-bottom:10px"><code>rank = nvs × decay × storyBoost × tierMultiplier × contentTypeMultiplier × journalistMultiplier</code></p>
      <p style="font-size:12px;color:#666;margin-bottom:10px">Currently live: <code>tierMultiplier</code> only (wired in Sprint I1). This release adds the remaining three dimensions.</p>
      <ul>
        <li><strong>D2 — Content-type</strong> (<code>contentTypeMultiplier</code>): fact=1.0×, analysis=0.9×, rumor=0.8× — single line in <code>rankAndEvict</code></li>
        <li><strong>D3 — Corroboration</strong> (upgrading <code>storyBoost</code>): distinct <code>source_family</code> in 6h window — 1 family=no boost, 2=1.2×, 3+=1.5×</li>
        <li><strong>D4 — Journalist accuracy</strong>: ≥80% accuracy=1.3×, 60–79%=1.0×, &lt;60%=0.7×, unknown=1.0×</li>
      </ul>
      <div class="criteria">
        <h5>Prerequisites before starting</h5>
        <ul>
          <li>Sprint I2 complete (source_family flowing through story_contributions)</li>
          <li>Sprint I3/I4 running ≥6 weeks in production (data must accumulate)</li>
          <li>At least 500 journalist_claims rows with resolved outcomes</li>
        </ul>
      </div>
    </div>

    <div class="rrow">
      <span class="vtag blocked">blocked</span>
      <div><div class="rrow-title">Twitter/X auto-post</div><div class="rrow-sub">X API Basic $100/mo — unblocks when ad revenue covers it</div></div>
      <div class="rrow-date">—</div>
    </div>

    <div class="rrow">
      <span class="vtag blocked">blocked</span>
      <div><div class="rrow-title">bjk.com.tr content</div><div class="rrow-sub">CAPTCHA-protected — unblocks with ScrapingBee ($49/mo) or residential proxy</div></div>
      <div class="rrow-date">—</div>
    </div>

  </div>
</div>
<script>
function toggle(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const isOpen = el.classList.contains('open');
  document.querySelectorAll('.detail.open').forEach(d => { d.classList.remove('open'); d.previousElementSibling.classList.remove('active'); });
  if (!isOpen) { el.classList.add('open'); el.previousElementSibling.classList.add('active'); }
}
</script>
</body>
</html>`;
}

function renderAdminQAPage(saved = {}, siteCode, allSites) {
  const nav = adminNav('qa', siteCode, allSites);

  const TESTS = [
    { id:'T01', group:'Feed & Articles', action:'GET kartalix.com/cache', check:'JSON array, no article with today-dated slug but old content, no copy_source entries' },
    { id:'T02', group:'Feed & Articles', action:'Load kartalix.com home page', check:'Cards render, no JS errors in console' },
    { id:'T03', group:'Feed & Articles', action:'Click any article card', check:'Full body text visible, source attribution present, no raw HTML entities' },
    { id:'T04', group:'Feed & Articles', action:'Find publish_mode:rewrite in /cache JSON, open its slug', check:'250–400 word body, not just RSS excerpt' },
    { id:'T05', group:'Feed & Articles', action:'GET kartalix.com/rss', check:'Valid XML, <item> entries present, no 500' },
    { id:'T06', group:'Topic Pages (H4)', action:'GET kartalix.com/konu/transfer', check:'Page loads with nav tabs, card grid appears (client-side /cache fetch)' },
    { id:'T07', group:'Topic Pages (H4)', action:'GET kartalix.com/konu/mac', check:'Page loads, filters to match articles' },
    { id:'T08', group:'Topic Pages (H4)', action:'GET kartalix.com/konu/sakat', check:'Page loads, shows heading even if grid is empty' },
    { id:'T09', group:'Topic Pages (H4)', action:'Check if /konu/* nav tabs are on the home page index.html', check:'PENDING — homepage tabs not added to index.html yet; skip if not done' },
    { id:'T10', group:'Admin Panel', action:'GET kartalix.com/admin → click İçerik', check:'Article list loads, NO "Yükleniyor…" spinner stuck' },
    { id:'T11', group:'Admin Panel (H3)', action:'Find a pending article in İçerik, click "Yayınla ↑"', check:'Button turns green, article in /cache within 5 min' },
    { id:'T12', group:'Admin Panel (H3)', action:'Check non-pending rows in İçerik', check:'"Yayınla ↑" button absent from published/draft rows' },
    { id:'T13', group:'Admin Panel (H1)', action:'GET kartalix.com/admin/rewrite-queue', check:'Returns JSON { queue:[...], count:N } — may be 0 if no overflow today' },
    { id:'T14', group:'Admin Panel', action:'GET kartalix.com/admin/sources/ui', check:'Source table renders, inline edit fields work' },
    { id:'T15', group:'Admin Panel', action:'GET kartalix.com/admin/tools', check:'All cards visible, no 500' },
    { id:'T16', group:'Decay / H2', action:'Check /cache: any copy_source article with published_at older than 12h?', check:'None — hard TTL evicted; stale TRT Haber article should be gone' },
    { id:'T17', group:'Decay / H2', action:'Scan /cache output for publish_mode values', check:'No rss_summary entries (never saved to DB/KV)' },
    { id:'T18', group:'Decay / H2', action:'Check /cache for NVS values', check:'No NVS 0 articles (evicted by floor=5 in rankAndEvict)' },
    { id:'T19', group:'Story Gate (H5)', action:'GET kartalix.com/force-h5', check:'Returns JSON gate check results — no "maxNvs is not defined" error' },
    { id:'T20', group:'Story Gate (H5)', action:'After a synthesis fires, call /force-h5 for same story', check:'Returns eligible:false, reason:already synthesized today' },
    { id:'T21', group:'Story Gate (H5)', action:'Check /cache for publish_mode:synthesis articles', check:'Body 250+ words, no "according to source X" phrasing' },
    { id:'T22', group:'Stale Fix', action:'Hit kartalix.com/clear-cache, wait 5 min, check /cache', check:'No today-dated slug with old content, no Kadıköy/TRT Haber article' },
    { id:'T23', group:'Stale Fix', action:'Check published_at values in /cache after reseed', check:'All dates within last 30 days' },
    { id:'T24', group:'Stale Fix', action:'Run kartalix.com/run, check /cache immediately', check:'No new copy_source entries appear' },
    { id:'T25', group:'Pipeline Health', action:'GET kartalix.com/run', check:'200, JSON with articles_processed, no top-level error' },
    { id:'T26', group:'Pipeline Health', action:'GET kartalix.com/force-h5?story_id={active_story_id}', check:'Either fires synthesis or returns reason — no JS crash' },
    { id:'T27', group:'Pipeline Health', action:'GET kartalix.com/sitemap.xml', check:'Valid XML, contains recent haber slugs' },
    { id:'T28', group:'Pipeline Health', action:'GET kartalix.com/force-synthesis on a recent article URL', check:'Body 250+ words returned, publish_mode:rewrite' },
  ];

  const groups = [...new Set(TESTS.map(t => t.group))];
  const total = TESTS.length;
  const passed = TESTS.filter(t => (saved[t.id]?.verdict) === 'pass').length;
  const failed = TESTS.filter(t => (saved[t.id]?.verdict) === 'fail').length;
  const pending = total - passed - failed;
  const savedAt = saved._saved_at || null;

  const groupHtml = groups.map(g => {
    const rows = TESTS.filter(t => t.group === g).map(t => {
      const s = saved[t.id] || {};
      const v = s.verdict || 'pending';
      const c = s.comment || '';
      const rowBg    = v === 'pass' ? '#0d200d' : v === 'fail' ? '#200d0d' : '#141414';
      const rowBdr   = v === 'pass' ? '#1e5c1e' : v === 'fail' ? '#5c1e1e' : '#252525';
      const idColor  = v === 'pass' ? '#5ed65e' : v === 'fail' ? '#ff6b6b' : '#999';
      return `<tr data-id="${t.id}" style="background:${rowBg};border-bottom:1px solid ${rowBdr}">
  <td style="padding:10px 12px;font-size:13px;font-weight:800;color:${idColor};white-space:nowrap;width:52px;letter-spacing:.03em">${t.id}</td>
  <td style="padding:10px 12px;width:280px"><code style="font-size:12px;color:#e8d87a;background:#1c1c10;padding:3px 7px;border-radius:3px;line-height:1.6;display:inline-block">${t.action}</code></td>
  <td style="padding:10px 12px;font-size:13px;color:#d4d4d4;line-height:1.5">${t.check}</td>
  <td style="padding:10px 12px;white-space:nowrap;width:150px">
    <label style="margin-right:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px"><input type="radio" name="v_${t.id}" value="pass" onchange="mark('${t.id}')" ${v==='pass'?'checked':''}><span style="color:#5ed65e;font-size:13px;font-weight:700">Pass</span></label>
    <label style="cursor:pointer;display:inline-flex;align-items:center;gap:5px"><input type="radio" name="v_${t.id}" value="fail" onchange="mark('${t.id}')" ${v==='fail'?'checked':''}><span style="color:#ff6b6b;font-size:13px;font-weight:700">Fail</span></label>
  </td>
  <td style="padding:10px 12px;width:220px"><textarea id="c_${t.id}" rows="1" oninput="autoGrow(this)" placeholder="not ekle…" style="width:100%;background:#1a1a1a;border:1px solid #333;color:#e0e0e0;font-size:13px;padding:5px 8px;border-radius:3px;resize:none;font-family:inherit;line-height:1.4">${c}</textarea></td>
</tr>`;
    }).join('');
    return `<tr><td colspan="5" style="padding:14px 12px 7px;font-size:11px;font-weight:800;color:#aaa;text-transform:uppercase;letter-spacing:.12em;border-bottom:1px solid #2a2a2a;background:#0d0d0d">${g}</td></tr>${rows}`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — QA</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.6}
.content{max-width:1200px;margin:0 auto;padding:2rem 1.5rem}
h1{font-size:22px;font-weight:800;margin-bottom:4px;color:#fff}
.subtitle{color:#888;font-size:13px;margin-bottom:1.5rem}
.summary{display:flex;gap:2rem;margin-bottom:1.5rem;align-items:center;background:#141414;border:1px solid #252525;padding:14px 20px;border-radius:6px}
.stat{font-size:26px;font-weight:800;line-height:1}
.stat-label{font-size:12px;color:#888;margin-top:3px}
.pass-stat{color:#5ed65e}
.fail-stat{color:#ff6b6b}
.pend-stat{color:#888}
.total-label{font-size:13px;color:#666}
.save-btn{margin-left:auto;background:#E30A17;color:#fff;border:none;padding:9px 22px;font-size:13px;font-weight:700;border-radius:4px;cursor:pointer;letter-spacing:.04em}
.save-btn:disabled{background:#2a2a2a;color:#666;cursor:default}
.saved-at{font-size:12px;color:#666;margin-left:8px}
table{width:100%;border-collapse:collapse}
thead th{padding:10px 12px;text-align:left;font-size:12px;color:#aaa;font-weight:700;background:#111;border-bottom:2px solid #2a2a2a}
</style>
</head>
<body>
${nav}
<div class="content">
  <h1>QA Test Plan</h1>
  <p class="subtitle">Sessions 17–20 · Sprints H1–H5 · Stale article fix</p>

  <div class="summary">
    <div><div class="stat pass-stat" id="sumPass">${passed}</div><div class="stat-label">Pass</div></div>
    <div><div class="stat fail-stat" id="sumFail">${failed}</div><div class="stat-label">Fail</div></div>
    <div><div class="stat pend-stat" id="sumPend">${pending}</div><div class="stat-label">Bekliyor</div></div>
    <div class="total-label">${total} test toplam</div>
    <button class="save-btn" id="saveBtn" onclick="saveAll()">Kaydet</button>
    <span class="saved-at" id="savedAt">${savedAt ? 'Son kayıt: ' + savedAt : ''}</span>
  </div>

  <table>
    <thead><tr>
      <th style="width:52px">ID</th>
      <th style="width:280px">Aksiyon</th>
      <th>Beklenen Sonuç</th>
      <th style="width:150px">Sonuç</th>
      <th style="width:220px">Not</th>
    </tr></thead>
    <tbody id="tbody">${groupHtml}</tbody>
  </table>
</div>

<script>
const ADMIN_SITE = '${siteCode}';
const _origFetch = window.fetch.bind(window);
window.fetch = (input, opts) => {
  if (typeof input === 'string' && input.startsWith('/admin/')) {
    try {
      const u = new URL(input, location.origin);
      if (!u.searchParams.get('site')) u.searchParams.set('site', ADMIN_SITE);
      input = u.pathname + u.search;
    } catch(e) {}
  }
  return _origFetch(input, opts);
};
const results = ${JSON.stringify(saved)};

function mark(id) {
  const row = document.querySelector('tr[data-id="'+id+'"]');
  const v = document.querySelector('input[name="v_'+id+'"]:checked')?.value || 'pending';
  row.style.background = v==='pass' ? '#0a1a0a' : v==='fail' ? '#1a0a0a' : '#111';
  row.style.borderBottomColor = v==='pass' ? '#1a4a1a' : v==='fail' ? '#4a1a1a' : '#1e1e1e';
  if (!results[id]) results[id] = {};
  results[id].verdict = v;
  updateSummary();
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
  const id = el.id.replace('c_','');
  if (!results[id]) results[id] = {};
  results[id].comment = el.value;
}

function updateSummary() {
  const ids = ${JSON.stringify(TESTS.map(t => t.id))};
  let p=0,f=0;
  ids.forEach(id => {
    const v = results[id]?.verdict;
    if (v==='pass') p++;
    else if (v==='fail') f++;
  });
  document.getElementById('sumPass').textContent = p;
  document.getElementById('sumFail').textContent = f;
  document.getElementById('sumPend').textContent = ids.length - p - f;
}

async function saveAll() {
  const btn = document.getElementById('saveBtn');
  btn.disabled = true; btn.textContent = 'Kaydediliyor…';
  const ids = ${JSON.stringify(TESTS.map(t => t.id))};
  ids.forEach(id => {
    const v = document.querySelector('input[name="v_'+id+'"]:checked')?.value;
    const c = document.getElementById('c_'+id)?.value || '';
    if (!results[id]) results[id] = {};
    if (v) results[id].verdict = v;
    results[id].comment = c;
  });
  results._saved_at = new Date().toLocaleString('tr-TR');
  const res = await fetch('/admin/qa/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(results) });
  if (res.ok) {
    btn.textContent = '✓ Kaydedildi'; btn.style.background='#1a4a1a';
    document.getElementById('savedAt').textContent = 'Son kayıt: ' + results._saved_at;
    setTimeout(() => { btn.disabled=false; btn.textContent='Kaydet'; btn.style.background='#E30A17'; }, 2000);
  } else {
    btn.textContent = 'Hata'; btn.style.background='#4a1a1a';
    setTimeout(() => { btn.disabled=false; btn.textContent='Kaydet'; btn.style.background='#E30A17'; }, 2000);
  }
}
</script>
</body>
</html>`;
}

function renderAdminToolsPage(hardcoded, cached, siteCode, allSites) {
  const nav = adminNav('tools', siteCode, allSites);
  const fmt = m => m ? `${m.opponent} — ${m.date} ${m.time} @ ${m.venue || '?'} (fixture #${m.fixture_id || '?'})` : 'none';
  return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Kartalix — Admin Araçları</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#e8e6e0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}
.page{max-width:720px;margin:0 auto;padding:2rem 1.5rem}
.card{background:#111;border:1px solid #222;border-radius:6px;padding:1.25rem 1.5rem;margin-bottom:1.5rem}
h2{font-size:.72rem;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.08em;margin-bottom:1rem}
.row{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:.6rem}
label{font-size:.78rem;color:#888;min-width:120px}
.val{font-size:.85rem;color:#e8e6e0;font-family:monospace}
.val.stale{color:#f0a500}
.val.live{color:#3a9a3a}
btn,.btn{display:inline-flex;align-items:center;gap:.4rem;padding:.5rem 1.2rem;border:none;border-radius:4px;font-size:.8rem;font-weight:600;cursor:pointer;background:#222;color:#e8e6e0;transition:background .2s}
.btn:hover{background:#333}
.btn.danger{background:#3a1a1a;color:#ff8888}
.btn.danger:hover{background:#4a1a1a}
.status{font-size:.78rem;padding:.5rem .75rem;border-radius:4px;background:#1a2a1a;color:#3a9a3a;display:none}
.status.err{background:#2a1a1a;color:#ff8888}
</style>
</head>
<body>
${nav}
<div class="page">

  <div class="card">
    <h2>Pipeline Çalıştır</h2>
    <p style="font-size:.8rem;color:#888;margin-bottom:1rem">Tüm aktif siteler için RSS çekme, puanlama ve yeniden yazma pipeline'ını tetikler. İstek KV'ye yazılır; sonraki 5 dakikalık cron ile çalışır (~5 dk bekleyin).</p>
    <button class="btn" id="run-btn" onclick="runPipeline()">▶ Pipeline Çalıştır</button>
    <div id="run-status" class="status"></div>
  </div>

  <div class="card">
    <h2>Sonraki Maç Konfigürasyonu</h2>
    <div class="row"><label>Kodda sabit</label><span class="val stale">${fmt(hardcoded)}</span></div>
    <div class="row"><label>KV cache</label><span class="val ${cached ? 'live' : 'stale'}">${cached ? fmt(cached) : '— boş, henüz çekilmedi'}</span></div>
    <div style="margin-top:1rem;display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="btn" onclick="refreshMatch()">API'den Güncelle</button>
      <a href="/admin/next-match" target="_blank" class="btn" style="text-decoration:none">JSON Görüntüle</a>
    </div>
    <div id="match-status" class="status"></div>
  </div>

  <div class="card">
    <h2>Editöryal Ses Kuralları</h2>
    <p style="font-size:.8rem;color:#888;margin-bottom:1rem">13 Türkçe ses kuralını KV'ye ekler (idempotent — var olanları tekrar eklemez). İlk kurulumda veya KV sıfırlandıktan sonra çalıştırın.</p>
    <button class="btn" onclick="seedVoice()">Ses Kurallarını Ekle</button>
    <div id="voice-status" class="status"></div>
  </div>

  <div class="card">
    <h2>Eski İçerikleri Arşivle</h2>
    <p style="font-size:.8rem;color:#888;margin-bottom:1rem">publish_mode = null veya rss_summary veya pre_firewall_cleaned olan yayınlanmış makaleleri arşivler.</p>
    <div style="display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="btn" onclick="archivePreview()">Ön İzleme (Sayım)</button>
      <button class="btn danger" onclick="archiveExecute()">Arşivle</button>
    </div>
    <div id="archive-status" class="status"></div>
  </div>

  <div class="card">
    <h2>Ses Tarzı Kütüphanesi (Voice Patterns)</h2>
    <p style="font-size:.8rem;color:#888;margin-bottom:1rem">Son 14 günün en iyi sentez makalelerinden yazım tarzı örnekleri çıkarır. Her Pazar 02:00'de otomatik çalışır. Çıkarılan örnekler tüm Claude üretimlerine enjekte edilir.</p>
    <div style="display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="btn" onclick="runVoicePatterns()">Şimdi Çalıştır</button>
      <a href="/admin/voice-patterns" target="_blank" class="btn" style="text-decoration:none">Kütüphaneyi Görüntüle</a>
    </div>
    <div id="vp-status" class="status"></div>
  </div>

  <div class="card">
    <h2>Anasayfa Önbelleğini Yenile</h2>
    <p style="font-size:.8rem;color:#888;margin-bottom:1rem">Supabase'deki yayınlanmış makaleleri KV önbelleğine yazar. Pipeline duraklaması sonrası anasayfada haber azalırsa kullanın.</p>
    <button class="btn" onclick="rebuildCache()">Önbelleği Yenile</button>
    <div id="rebuild-status" class="status"></div>
  </div>

  <div class="card">
    <h2>Hikaye Sentezi Tetikle</h2>
    <p style="font-size:.8rem;color:#888;margin-bottom:.75rem">Belirli bir hikaye ID'si için Sonnet sentezini zorla tetikler (dedup key'i temizler).</p>
    <div class="row">
      <input id="synth-id" type="text" placeholder="story_id" style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:.4rem .75rem;color:#e8e6e0;font-size:.85rem;width:220px"/>
      <button class="btn" onclick="runSynth()">Sentezle</button>
    </div>
    <div id="synth-status" class="status"></div>
  </div>

</div>
<script>
async function post(url, onSuccess, statusId) {
  const el = document.getElementById(statusId);
  el.textContent = 'Çalışıyor...'; el.className = 'status'; el.style.display = 'block';
  try {
    const r = await fetch(url, { method: 'POST' });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'HTTP ' + r.status);
    el.textContent = onSuccess(d); el.className = 'status';
  } catch(e) { el.textContent = 'Hata: ' + e.message; el.className = 'status err'; }
}
function refreshMatch() {
  post('/admin/next-match', d => \`Güncellendi: \${d.match?.opponent} — \${d.match?.date} \${d.match?.time}\`, 'match-status');
}
function seedVoice() {
  post('/admin/seed-voice', d => \`Eklendi: \${d.added} kural\`, 'voice-status');
}
function archivePreview() {
  const el = document.getElementById('archive-status');
  el.textContent = 'Kontrol ediliyor...'; el.className = 'status'; el.style.display = 'block';
  fetch('/admin/archive-legacy?preview=1', { method: 'POST' })
    .then(r => r.json())
    .then(d => { el.textContent = \`\${d.count} makale arşivlenecek. Devam etmek için "Arşivle" düğmesine tıklayın.\`; el.className = 'status'; })
    .catch(e => { el.textContent = 'Hata: ' + e.message; el.className = 'status err'; });
}
function archiveExecute() {
  if (!confirm('Eski makaleler arşivlenecek. Emin misiniz?')) return;
  post('/admin/archive-legacy?preview=0', d => \`Arşivlendi: \${d.archived} makale\`, 'archive-status');
}
function runVoicePatterns() {
  post('/admin/run-voice-patterns', d => \`Tamamlandı. Kütüphanede \${d.total} örnek var.\`, 'vp-status');
}
function rebuildCache() {
  post('/rebuild-cache', d => \`Tamamlandı: \${d.rebuilt} makale KV'ye yazıldı.\`, 'rebuild-status');
}
function runSynth() {
  const id = document.getElementById('synth-id').value.trim();
  if (!id) { alert('story_id gerekli'); return; }
  post('/force-story-synthesis?story_id=' + encodeURIComponent(id),
    d => d.published ? \`Yayınlandı: \${d.title}\` : 'Sentezlendi (yayın yok)',
    'synth-status');
}
async function runPipeline() {
  const btn = document.getElementById('run-btn');
  const el  = document.getElementById('run-status');
  btn.disabled = true;
  el.textContent = 'İstek gönderiliyor...'; el.className = 'status'; el.style.display = 'block';
  try {
    const r = await fetch('/run');
    const d = await r.json();
    if (d.status === 'blocked') {
      const reason = d.preflight?.cost_blocked ? \`Maliyet limiti aşıldı (\$\${d.preflight.cost_current?.toFixed(2)} / \$\${d.preflight.cost_cap})\` : (d.reason || 'bilinmeyen sebep');
      el.textContent = 'Engellendi: ' + reason; el.className = 'status err';
    } else if (d.status === 'queued') {
      const sites = (d.preflight?.site_codes || []).join(', ');
      el.textContent = \`Kuyruğa alındı — siteler: \${sites} · ~5 dk sonra kontrol edin\`; el.className = 'status';
    } else {
      el.textContent = JSON.stringify(d); el.className = 'status';
    }
  } catch(e) {
    el.textContent = 'Hata: ' + e.message; el.className = 'status err';
  } finally {
    setTimeout(() => { btn.disabled = false; }, 10000);
  }
}
<\/script>
</body>
</html>`;
}

function renderAdminPage(articles = [], siteCode, allSites) {
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
${adminNav('news', siteCode, allSites)}
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
  try {
    const fbRes = await fetch('/article/feedback');
    if (fbRes.ok) {
      const ct = fbRes.headers.get('content-type') || '';
      feedbacks = ct.includes('json') ? await fbRes.json() : [];
    }
  } catch(e) { feedbacks = []; }

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
