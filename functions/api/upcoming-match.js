// Returns the next scheduled fixture for predictions in tribün.
// Uses ESPN's unofficial public API — no key required.
// Searches scoreboard by team name so ESPN internal IDs don't matter.
// Priority: 1) admin manual override (KV), 2) next Turkey national team game, 3) next Beşiktaş game.

import { err, corsHeaders } from './_shared/auth.js';

const CACHE_TTL = 60 * 60; // 1 hour
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

// Team name fragments to match (case-insensitive)
const TURKEY_NAMES = ['türkiye', 'turkey'];
const TURKEY_ABBR  = 'TUR';
const BJK_NAMES    = ['beşiktaş', 'besiktas'];
const BJK_ABBR     = 'BJK';

// Leagues to search in, ordered by priority per team
const TURKEY_LEAGUES = ['fifa.world', 'uefa.euro_qualifying', 'uefa.nations', 'intl.friendlies.m'];
const BJK_LEAGUES    = ['tur.1', 'uefa.el', 'uefa.ucl'];

function teamMatches(competitor, names, abbr) {
  const n = (competitor.team?.displayName ?? '').toLowerCase();
  const a = (competitor.team?.abbreviation ?? '').toUpperCase();
  return names.some(name => n.includes(name)) || a === abbr;
}

// Scan a league's scoreboard day by day, looking for the first future game
// involving the target team (identified by name/abbreviation, not ESPN ID).
// Returns { event, teamId, league } so the caller knows which ESPN team was matched.
async function scanScoreboard(league, names, abbr, maxDays = 45) {
  const now = Date.now();

  for (let i = 0; i <= maxDays; i++) {
    const dateStr = new Date(now + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    let res, data;
    try {
      res  = await fetch(`${ESPN_BASE}/${league}/scoreboard?dates=${dateStr}`);
      if (!res.ok) return null;
      data = await res.json();
    } catch (_) { return null; }

    const events = data?.events ?? [];

    // Stop early if off-season (no events for 7+ consecutive days)
    if (events.length === 0 && i >= 7) return null;

    for (const event of events) {
      if (new Date(event.date).getTime() <= now) continue;
      const comps = event.competitions?.[0]?.competitors ?? [];
      const matched = comps.find(c => teamMatches(c, names, abbr));
      if (matched) return { event, league, teamId: matched.team?.id ?? null };
    }
  }
  return null;
}

// Try every league in the list; return the first result found.
async function fetchNextEventForTeam(leagues, names, abbr) {
  for (const league of leagues) {
    const result = await scanScoreboard(league, names, abbr);
    if (result) return result;
  }
  return null;
}

function espnEventToMatch({ event, league, teamId }) {
  const comp        = event.competitions?.[0] ?? {};
  const competitors = comp.competitors ?? [];
  const home = competitors.find(c => c.homeAway === 'home') ?? competitors[0] ?? {};
  const away = competitors.find(c => c.homeAway === 'away') ?? competitors[1] ?? {};

  return {
    match_id:       String(event.id),
    kickoff_utc:    event.date,
    home_team:      home.team?.displayName ?? '',
    home_team_id:   home.team?.id ?? null,
    away_team:      away.team?.displayName ?? '',
    away_team_id:   away.team?.id ?? null,
    home_logo:      home.team?.logo ?? null,
    away_logo:      away.team?.logo ?? null,
    league_name:    event.league?.name ?? null,
    round:          comp.series?.description ?? comp.status?.type?.shortDetail ?? null,
    venue:          comp.venue?.fullName ?? null,
    // Squad params — tells the front-end which team's roster to fetch
    squad_espn_id:  teamId,
    squad_league:   league,
  };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  // 1. Admin manual override — bypasses API and cache entirely
  if (env.PITCHOS_CACHE) {
    const manual = await env.PITCHOS_CACHE.get('upcoming-match:manual');
    if (manual) {
      return new Response(manual, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Cache': 'MANUAL' },
      });
    }
  }

  // 2. KV cache
  const cacheKey = 'upcoming-match:espn:v2';
  if (env.PITCHOS_CACHE) {
    const cached = await env.PITCHOS_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}`, 'X-Cache': 'HIT' },
      });
    }
  }

  // 3. Search ESPN scoreboard — Turkey first (World Cup), then BJK (Super Lig)
  const turkeyLeagues = (env.ESPN_TURKEY_LEAGUES ?? TURKEY_LEAGUES.join(',')).split(',');
  const bjkLeagues    = (env.ESPN_BJK_LEAGUES    ?? BJK_LEAGUES.join(',')).split(',');

  const [turkeyResult, bjkResult] = await Promise.all([
    fetchNextEventForTeam(turkeyLeagues, TURKEY_NAMES, TURKEY_ABBR).catch(() => null),
    fetchNextEventForTeam(bjkLeagues,    BJK_NAMES,    BJK_ABBR).catch(() => null),
  ]);

  let match = null;
  if (turkeyResult && bjkResult) {
    const t = new Date(turkeyResult.event.date).getTime();
    const b = new Date(bjkResult.event.date).getTime();
    match = espnEventToMatch(t <= b ? turkeyResult : bjkResult);
  } else if (turkeyResult) {
    match = espnEventToMatch(turkeyResult);
  } else if (bjkResult) {
    match = espnEventToMatch(bjkResult);
  }

  const responseBody = JSON.stringify({ match });

  if (env.PITCHOS_CACHE && match) {
    await env.PITCHOS_CACHE.put(cacheKey, responseBody, { expirationTtl: CACHE_TTL });
  }

  return new Response(responseBody, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': match ? `public, max-age=${CACHE_TTL}` : 'no-cache',
      'X-Cache': 'MISS',
    },
  });
}
