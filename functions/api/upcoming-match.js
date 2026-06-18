// Returns the next scheduled fixture for the configured football team.
// Uses api-football v3. Cached for 1 hour via Cloudflare Cache API.
// Public endpoint — no auth required, team identity is not sensitive.

import { json, err, corsHeaders } from './_shared/auth.js';

const CACHE_TTL = 60 * 60; // 1 hour

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  if (!env.API_FOOTBALL_KEY) return err('Service unavailable', 503);

  const teamId = env.FOOTBALL_TEAM_ID ?? '2672'; // default: Beşiktaş
  const cacheKey = `upcoming-match:team:${teamId}`;

  // Try KV cache first
  if (env.PITCHOS_CACHE) {
    const cached = await env.PITCHOS_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
          'X-Cache': 'HIT',
        },
      });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const ahead = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const apiRes = await fetch(
    `https://v3.football.api-sports.io/fixtures?team=${teamId}&from=${today}&to=${ahead}&status=NS&limit=1`,
    { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } }
  );

  if (!apiRes.ok) return err('Could not fetch fixtures', 503);

  const data = await apiRes.json();
  const fixture = data?.response?.[0];
  if (!fixture) return json({ match: null });

  const match = {
    match_id:      fixture.fixture.id,
    kickoff_utc:   fixture.fixture.date,
    home_team:     fixture.teams.home.name,
    home_team_id:  fixture.teams.home.id,
    away_team:     fixture.teams.away.name,
    away_team_id:  fixture.teams.away.id,
    home_logo:     fixture.teams.home.logo,
    away_logo:     fixture.teams.away.logo,
    league_name:   fixture.league.name,
    round:         fixture.league.round,
    venue:         fixture.fixture.venue?.name ?? null,
  };

  const responseBody = JSON.stringify({ match });

  if (env.PITCHOS_CACHE) {
    await env.PITCHOS_CACHE.put(cacheKey, responseBody, { expirationTtl: CACHE_TTL });
  }

  return new Response(responseBody, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
      'X-Cache': 'MISS',
    },
  });
}
