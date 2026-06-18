// Returns Beşiktaş squad for the Starting 11 prediction UI.
// Uses ESPN's unofficial public API — no key required.
// KV-cached for 24 hours.

import { json, err, corsHeaders } from './_shared/auth.js';

const CACHE_TTL  = 24 * 60 * 60;
const ESPN_BASE  = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

const BJK_LEAGUE  = 'tur.1';
const BJK_ESPN_ID = '3886'; // Beşiktaş JK

const POSITION_ORDER = { Goalkeeper: 0, Defender: 1, Midfielder: 2, Attacker: 3 };
const POSITION_MAP = {
  G: 'Goalkeeper', GK: 'Goalkeeper',
  D: 'Defender',   CB: 'Defender', LB: 'Defender', RB: 'Defender',
  LWB: 'Defender', RWB: 'Defender', SW: 'Defender',
  M: 'Midfielder', CM: 'Midfielder', DM: 'Midfielder', AM: 'Midfielder',
  LM: 'Midfielder', RM: 'Midfielder',
  F: 'Attacker',   CF: 'Attacker', LW: 'Attacker', RW: 'Attacker',
  ST: 'Attacker',  SS: 'Attacker',
};

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const league   = env.ESPN_BJK_LEAGUE ?? BJK_LEAGUE;
  const teamId   = env.ESPN_BJK_ID     ?? BJK_ESPN_ID;
  const cacheKey = `squad:espn:v1:${teamId}`;

  if (env.PITCHOS_CACHE) {
    const cached = await env.PITCHOS_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}`, 'X-Cache': 'HIT' },
      });
    }
  }

  const apiRes = await fetch(`${ESPN_BASE}/${league}/teams/${teamId}/roster`);
  if (!apiRes.ok) return err('Could not fetch squad', 503);
  const data = await apiRes.json();

  // ESPN roster: athletes is either a flat array or an array of position groups with .items
  const raw  = data?.athletes ?? [];
  const flat = raw.length && Array.isArray(raw[0]?.items) ? raw.flatMap(g => g.items) : raw;

  if (!flat.length) return json({ team_id: teamId, players: [] });

  const players = flat
    .map(p => {
      const abbr     = p.position?.abbreviation ?? '';
      const position = POSITION_MAP[abbr] ?? p.position?.displayName ?? 'Unknown';
      return {
        id:       parseInt(p.id, 10) || p.id,
        name:     p.displayName ?? p.fullName ?? p.shortName ?? '',
        position,
        photo:    p.headshot?.href ?? null,
        number:   p.jersey != null ? parseInt(p.jersey, 10) : null,
      };
    })
    .sort((a, b) => {
      const pa = POSITION_ORDER[a.position] ?? 4;
      const pb = POSITION_ORDER[b.position] ?? 4;
      return pa !== pb ? pa - pb : a.name.localeCompare(b.name, 'tr');
    });

  const responseBody = JSON.stringify({ team_id: teamId, players });

  if (env.PITCHOS_CACHE) {
    await env.PITCHOS_CACHE.put(cacheKey, responseBody, { expirationTtl: CACHE_TTL });
  }

  return new Response(responseBody, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}`, 'X-Cache': 'MISS' },
  });
}
