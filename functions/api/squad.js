// Returns Beşiktaş squad for the Starting 11 prediction UI.
// Uses ESPN's unofficial public API — no key required.
// Finds BJK's team ID dynamically from the league teams list, then fetches roster.
// KV-cached for 24 hours.

import { json, err, corsHeaders } from './_shared/auth.js';

const CACHE_TTL  = 24 * 60 * 60;
const ESPN_BASE  = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const BJK_LEAGUE = 'tur.1';
const BJK_NAMES  = ['beşiktaş', 'besiktas'];
const BJK_ABBR   = 'BJK';

const POSITION_ORDER = { Goalkeeper: 0, Defender: 1, Midfielder: 2, Attacker: 3 };
const POSITION_MAP   = {
  G: 'Goalkeeper', GK: 'Goalkeeper',
  D: 'Defender',   CB: 'Defender', LB: 'Defender', RB: 'Defender',
  LWB: 'Defender', RWB: 'Defender', SW: 'Defender',
  M: 'Midfielder', CM: 'Midfielder', DM: 'Midfielder', AM: 'Midfielder',
  LM: 'Midfielder', RM: 'Midfielder',
  F: 'Attacker',   CF: 'Attacker', LW: 'Attacker', RW: 'Attacker',
  ST: 'Attacker',  SS: 'Attacker',
};

async function findBJKTeamId(league) {
  const res = await fetch(`${ESPN_BASE}/${league}/teams`);
  if (!res.ok) return null;
  const data = await res.json();
  const teams = data?.sports?.[0]?.leagues?.[0]?.teams ?? data?.teams ?? [];
  const entry = teams.find(t => {
    const team = t.team ?? t;
    const n = (team.displayName ?? team.name ?? '').toLowerCase();
    const a = (team.abbreviation ?? '').toUpperCase();
    return BJK_NAMES.some(name => n.includes(name)) || a === BJK_ABBR;
  });
  return (entry?.team ?? entry)?.id ?? null;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  // Params come from upcoming-match response (squad_espn_id, squad_team_name, squad_league).
  const url       = new URL(request.url);
  const qLeague   = url.searchParams.get('league');
  const qTeamId   = url.searchParams.get('team_id');
  const qTeamName = url.searchParams.get('team_name');
  const league    = qLeague ?? env.ESPN_BJK_LEAGUE ?? BJK_LEAGUE;
  const cacheKey  = `squad:espn:v3:${league}:${qTeamId ?? qTeamName ?? 'bjk'}`;

  if (env.PITCHOS_CACHE) {
    const cached = await env.PITCHOS_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}`, 'X-Cache': 'HIT' },
      });
    }
  }

  // Resolve team ID: direct param → name lookup → BJK fallback
  let teamId = qTeamId ?? env.ESPN_BJK_ID ?? null;
  if (!teamId && qTeamName) {
    // Look up the team by display name in the league's teams list
    const teamsRes = await fetch(`${ESPN_BASE}/${league}/teams`).catch(() => null);
    if (teamsRes?.ok) {
      const teamsData = await teamsRes.json();
      const teams = teamsData?.sports?.[0]?.leagues?.[0]?.teams ?? teamsData?.teams ?? [];
      const entry = teams.find(t => {
        const team = t.team ?? t;
        return (team.displayName ?? team.name ?? '').toLowerCase()
          .includes(qTeamName.toLowerCase());
      });
      teamId = (entry?.team ?? entry)?.id ?? null;
    }
  }
  if (!teamId) teamId = await findBJKTeamId(league);
  if (!teamId) return err('Could not resolve team ID', 503);

  const apiRes = await fetch(`${ESPN_BASE}/${league}/teams/${teamId}/roster`);
  if (!apiRes.ok) return err('Could not fetch squad', 503);
  const data = await apiRes.json();

  // ESPN roster: athletes is either a flat array or grouped by position with .items
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
