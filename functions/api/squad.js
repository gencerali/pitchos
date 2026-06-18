// Returns the squad for a football team.
// Used by the Starting 11 prediction UI. KV-cached for 24 hours.

import { json, err, corsHeaders } from './_shared/auth.js';

const CACHE_TTL = 24 * 60 * 60; // 24 hours

const POSITION_ORDER = { Goalkeeper: 0, Defender: 1, Midfielder: 2, Attacker: 3 };

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  if (!env.API_FOOTBALL_KEY) return err('Service unavailable', 503);

  const url = new URL(request.url);
  const teamId = url.searchParams.get('team_id') ?? (env.FOOTBALL_TEAM_ID ?? '2672');

  const cacheKey = `squad:team:${teamId}`;

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

  const apiRes = await fetch(
    `https://v3.football.api-sports.io/players/squads?team=${teamId}`,
    { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } }
  );

  if (!apiRes.ok) return err('Could not fetch squad', 503);

  const data = await apiRes.json();
  const rawSquad = data?.response?.[0]?.players ?? [];

  if (!rawSquad.length) return json({ team_id: Number(teamId), players: [] });

  const players = rawSquad
    .map(p => ({
      id: p.id,
      name: p.name,
      position: p.position,
      photo: p.photo ?? null,
      number: p.number ?? null,
    }))
    .sort((a, b) => {
      const pa = POSITION_ORDER[a.position] ?? 4;
      const pb = POSITION_ORDER[b.position] ?? 4;
      return pa !== pb ? pa - pb : a.name.localeCompare(b.name, 'tr');
    });

  const responseBody = JSON.stringify({ team_id: Number(teamId), players });

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
