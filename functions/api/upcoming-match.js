// Returns the next scheduled fixture for predictions in tribün.
// Priority: 1) admin manual override (KV), 2) next Beşiktaş game, 3) next Turkey national team game.
// All three fall back gracefully so tribün always has a match to predict when either team plays.

import { json, err, corsHeaders } from './_shared/auth.js';

const CACHE_TTL     = 60 * 60; // 1 hour
const BJK_TEAM_ID   = '2672';
const TURKEY_TEAM_ID = '272';

async function fetchNextFixture(teamId, env) {
  const today = new Date().toISOString().slice(0, 10);
  const ahead = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // No status filter — NS, TBD, and other scheduled statuses all qualify.
  // We pick the soonest fixture whose kickoff is still in the future.
  const res = await fetch(
    `https://v3.football.api-sports.io/fixtures?team=${teamId}&from=${today}&to=${ahead}`,
    { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const now = Date.now();
  return (data?.response ?? []).find(f => new Date(f.fixture.date).getTime() > now) ?? null;
}

function fixtureToMatch(fixture) {
  return {
    match_id:      fixture.fixture.id,
    kickoff_utc:   fixture.fixture.date,
    home_team:     fixture.teams.home.name,
    home_team_id:  fixture.teams.home.id,
    away_team:     fixture.teams.away.name,
    away_team_id:  fixture.teams.away.id,
    home_logo:     fixture.teams.home.logo,
    away_logo:     fixture.teams.away.logo,
    league_name:   fixture.league.name,
    round:         fixture.league.round ?? null,
    venue:         fixture.fixture.venue?.name ?? null,
  };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  if (!env.API_FOOTBALL_KEY) return err('Service unavailable', 503);

  // 1. Admin manual override — bypasses API and cache entirely
  if (env.PITCHOS_CACHE) {
    const manual = await env.PITCHOS_CACHE.get('upcoming-match:manual');
    if (manual) {
      return new Response(manual, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Cache': 'MANUAL' },
      });
    }
  }

  // 2. KV cache for both team lookups
  const cacheKey = `upcoming-match:v2:${BJK_TEAM_ID}+${TURKEY_TEAM_ID}`;
  if (env.PITCHOS_CACHE) {
    const cached = await env.PITCHOS_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}`, 'X-Cache': 'HIT' },
      });
    }
  }

  // 3. Fetch BJK and Turkey in parallel; pick whichever is soonest
  const [bjkFixture, turkeyFixture] = await Promise.all([
    fetchNextFixture(BJK_TEAM_ID, env).catch(() => null),
    fetchNextFixture(TURKEY_TEAM_ID, env).catch(() => null),
  ]);

  let match = null;
  if (bjkFixture && turkeyFixture) {
    // Both available — pick the sooner kickoff
    const bjkDate    = new Date(bjkFixture.fixture.date).getTime();
    const turkeyDate = new Date(turkeyFixture.fixture.date).getTime();
    match = fixtureToMatch(bjkDate <= turkeyDate ? bjkFixture : turkeyFixture);
  } else if (bjkFixture) {
    match = fixtureToMatch(bjkFixture);
  } else if (turkeyFixture) {
    match = fixtureToMatch(turkeyFixture);
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
