// Returns the next scheduled fixture for predictions in tribün.
// Uses ESPN's unofficial public API — no key required.
// Priority: 1) admin manual override (KV), 2) next Beşiktaş game, 3) next Turkey national team game.

import { err, corsHeaders } from './_shared/auth.js';

const CACHE_TTL  = 60 * 60; // 1 hour
const ESPN_BASE  = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

// Env vars override these defaults (set in Cloudflare dashboard if IDs change)
const BJK_LEAGUE      = 'tur.1';
const BJK_ESPN_ID     = '3886';    // Beşiktaş JK — Turkish Super Lig
const TURKEY_LEAGUE   = 'fifa.world';
const TURKEY_ESPN_ID  = '221';     // Turkey national team — FIFA World Cup

async function fetchNextESPNFixture(league, teamId) {
  const res = await fetch(`${ESPN_BASE}/${league}/teams/${teamId}/schedule`);
  if (!res.ok) return null;
  const data = await res.json();
  const now = Date.now();
  return (data?.events ?? []).find(e => {
    const state   = e.competitions?.[0]?.status?.type?.state;
    const kickoff = new Date(e.date).getTime();
    return state === 'pre' && kickoff > now;
  }) ?? null;
}

function espnEventToMatch(event) {
  const comp = event.competitions[0];
  const home = comp.competitors.find(c => c.homeAway === 'home');
  const away = comp.competitors.find(c => c.homeAway === 'away');
  return {
    match_id:     event.id,
    kickoff_utc:  event.date,
    home_team:    home?.team?.displayName ?? '',
    home_team_id: home?.team?.id ?? null,
    away_team:    away?.team?.displayName ?? '',
    away_team_id: away?.team?.id ?? null,
    home_logo:    home?.team?.logo ?? null,
    away_logo:    away?.team?.logo ?? null,
    league_name:  event.league?.name ?? null,
    round:        comp.series?.description ?? comp.status?.type?.detail ?? null,
    venue:        comp.venue?.fullName ?? null,
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
  const cacheKey = `upcoming-match:espn:v1:${BJK_ESPN_ID}+${TURKEY_ESPN_ID}`;
  if (env.PITCHOS_CACHE) {
    const cached = await env.PITCHOS_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}`, 'X-Cache': 'HIT' },
      });
    }
  }

  // 3. Fetch BJK and Turkey in parallel; pick whichever is soonest
  const bjkLeague    = env.ESPN_BJK_LEAGUE    ?? BJK_LEAGUE;
  const bjkId        = env.ESPN_BJK_ID        ?? BJK_ESPN_ID;
  const turkeyLeague = env.ESPN_TURKEY_LEAGUE ?? TURKEY_LEAGUE;
  const turkeyId     = env.ESPN_TURKEY_ID     ?? TURKEY_ESPN_ID;

  const [bjkEvent, turkeyEvent] = await Promise.all([
    fetchNextESPNFixture(bjkLeague, bjkId).catch(() => null),
    fetchNextESPNFixture(turkeyLeague, turkeyId).catch(() => null),
  ]);

  let match = null;
  if (bjkEvent && turkeyEvent) {
    const bjkTime    = new Date(bjkEvent.date).getTime();
    const turkeyTime = new Date(turkeyEvent.date).getTime();
    match = espnEventToMatch(bjkTime <= turkeyTime ? bjkEvent : turkeyEvent);
  } else if (bjkEvent) {
    match = espnEventToMatch(bjkEvent);
  } else if (turkeyEvent) {
    match = espnEventToMatch(turkeyEvent);
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
