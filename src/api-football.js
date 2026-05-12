// ─── API-FOOTBALL WRAPPER ─────────────────────────────────────
// Free tier: 100 requests/day. Poll only during match windows.
// All functions return null on error — callers must handle gracefully.
// API key stored as Workers secret: API_FOOTBALL_KEY
// Docs: https://www.api-football.com/documentation-v3
import { supabase } from './utils.js';

const BASE_URL  = 'https://v3.football.api-sports.io';
const BJK_ID    = 549;    // Beşiktaş JK (verified 2026-04-29)
const SUPERLIG  = 203;    // Trendyol Süper Lig
const SEASON    = 2025;   // 2025–26 season

export async function apiFetch(path, env) {
  if (!env.API_FOOTBALL_KEY) {
    console.error('API_FOOTBALL_KEY secret not set');
    return null;
  }
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'x-apisports-key': env.API_FOOTBALL_KEY,
        'Origin':          'https://kartalix.com',
        'Referer':         'https://kartalix.com/',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`API-Football HTTP ${res.status} for ${path}`);
      return null;
    }
    const data = await res.json();
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error('API-Football error:', JSON.stringify(data.errors));
      return null;
    }
    return data.response;
  } catch (e) {
    console.error(`API-Football fetch failed [${path}]:`, e.message);
    return null;
  }
}

// ─── NEXT FIXTURE ─────────────────────────────────────────────
// Returns the next scheduled BJK fixture.
export async function getNextFixture(env) {
  const data = await apiFetch(
    `/fixtures?team=${BJK_ID}&season=${SEASON}&next=1&timezone=Europe/Istanbul`,
    env
  );
  if (!data || data.length === 0) return null;
  return normalizeFixture(data[0]);
}

// ─── FIXTURE BY ID ────────────────────────────────────────────
// Returns a single fixture — live or completed.
export async function getFixture(fixtureId, env) {
  const data = await apiFetch(`/fixtures?id=${fixtureId}&timezone=Europe/Istanbul`, env);
  if (!data || data.length === 0) return null;
  return normalizeFixture(data[0]);
}

// ─── FIXTURE STATISTICS ───────────────────────────────────────
// Returns BJK team stats for a completed fixture: xG, possession,
// shots, passes, cards. Used by T12 Match Report.
export async function getFixtureStats(fixtureId, env) {
  const data = await apiFetch(`/fixtures/statistics?fixture=${fixtureId}&team=${BJK_ID}`, env);
  if (!data || data.length === 0) return null;
  const bjk = data.find(t => t.team?.id === BJK_ID);
  if (!bjk) return null;
  const get = (type) => bjk.statistics?.find(s => s.type === type)?.value ?? null;
  return {
    xg:              get('expected_goals'),
    possession:      get('Ball Possession'),
    shots_total:     get('Total Shots'),
    shots_on_target: get('Shots on Goal'),
    passes_acc:      get('Passes %'),
    corners:         get('Corner Kicks'),
    fouls:           get('Fouls'),
    yellow_cards:    get('Yellow Cards'),
    red_cards:       get('Red Cards'),
  };
}

// ─── LIVE FIXTURE ─────────────────────────────────────────────
// Returns the current live BJK fixture, or null if not playing.
export async function getLiveFixture(env) {
  const data = await apiFetch(
    `/fixtures?team=${BJK_ID}&live=all&timezone=Europe/Istanbul`,
    env
  );
  if (!data || data.length === 0) return null;
  return normalizeFixture(data[0]);
}

// ─── LAST N FIXTURES (recent results) ─────────────────────────
export async function getLastFixtures(env, count = 5) {
  const data = await apiFetch(`/fixtures?team=${BJK_ID}&last=${count}&timezone=Europe/Istanbul`, env);
  if (!data) return [];
  return data.map(normalizeFixture);
}

// ─── HEAD TO HEAD ─────────────────────────────────────────────
// Last 10 meetings between BJK and opponent.
export async function getH2H(opponentId, env, count = 10) {
  const data = await apiFetch(`/fixtures/headtohead?h2h=${BJK_ID}-${opponentId}&last=${count}&timezone=Europe/Istanbul`, env);
  if (!data) return [];
  return data.map(normalizeFixture);
}

// ─── INJURIES ─────────────────────────────────────────────────
// Players unavailable for a specific fixture (injury or suspension).
// Uses fixture-scoped endpoint — only returns players missing THAT match.
export async function getInjuries(env, fixtureId) {
  if (!fixtureId) return [];
  const data = await apiFetch(`/injuries?fixture=${fixtureId}&team=${BJK_ID}`, env);
  if (!data) return [];
  const seen = new Set();
  return data
    .filter(i => i.team?.id === BJK_ID)
    .map(i => ({
      name:   i.player?.name   || 'Bilinmeyen',
      type:   i.player?.type   || 'Injury',
      reason: i.player?.reason || '',
      return: i.player?.return || null,
    }))
    .filter(i => {
      if (seen.has(i.name)) return false;
      seen.add(i.name);
      return true;
    });
}

// ─── STANDINGS ────────────────────────────────────────────────
// Current Süper Lig standings. Returns the full table.
export async function getStandings(env) {
  const data = await apiFetch(`/standings?league=${SUPERLIG}&season=${SEASON}`, env);
  if (!data || data.length === 0) return null;
  // API returns nested: response[0].league.standings[0] = array of team rows
  return data[0]?.league?.standings?.[0] || null;
}

// ─── BJK STANDING ROW ─────────────────────────────────────────
// Just the BJK row from standings.
export async function getBJKStanding(env) {
  const table = await getStandings(env);
  if (!table) return null;
  return table.find(row => row.team?.id === BJK_ID) || null;
}

// ─── FIXTURE LINEUP ───────────────────────────────────────────
// Returns confirmed BJK lineup once submitted (~60min before kickoff).
// Returns null if not yet available (caller retries next cron tick).
export async function getFixtureLineup(fixtureId, env) {
  const data = await apiFetch(`/fixtures/lineups?fixture=${fixtureId}`, env);
  if (!data || data.length === 0) return null;
  const bjk = data.find(t => t.team?.id === BJK_ID);
  if (!bjk) return null;
  const startXI = (bjk.startXI || []).map(p => ({
    id:     p.player?.id     ?? null,
    name:   p.player?.name   || '',
    number: p.player?.number ?? null,
    pos:    p.player?.pos    || null,
    grid:   p.player?.grid   || null,
  })).filter(p => p.name);
  if (startXI.length < 8) return null; // incomplete — not ready yet
  return {
    formation:   bjk.formation || null,
    startXI,
    substitutes: (bjk.substitutes || []).map(p => ({
      id:     p.player?.id     ?? null,
      name:   p.player?.name   || '',
      number: p.player?.number ?? null,
      pos:    p.player?.pos    || null,
    })).filter(p => p.name),
    coach: bjk.coach?.name || null,
  };
}

// ─── FIXTURE PLAYERS (ratings, stats) ─────────────────────────
// Use for Man of the Match (T13) — requires a completed fixture ID.
export async function getFixturePlayers(fixtureId, env) {
  const data = await apiFetch(`/fixtures/players?fixture=${fixtureId}&team=${BJK_ID}`, env);
  if (!data || data.length === 0) return [];
  const bjkTeam = data.find(t => t.team?.id === BJK_ID);
  if (!bjkTeam) return [];
  return (bjkTeam.players || []).map(p => ({
    id:          p.player?.id,
    name:        p.player?.name,
    rating:      parseFloat(p.statistics?.[0]?.games?.rating) || 0,
    goals:       p.statistics?.[0]?.goals?.total || 0,
    assists:     p.statistics?.[0]?.goals?.assists || 0,
    minutesPlayed: p.statistics?.[0]?.games?.minutes || 0,
  })).sort((a, b) => b.rating - a.rating);
}

// ─── FIXTURE EVENTS ───────────────────────────────────────────
// Goals, cards, VAR for a completed fixture. Returns formatted string lines
// ready to paste into a Claude prompt as a match timeline.
export async function getFixtureEvents(fixtureId, env) {
  const data = await apiFetch(`/fixtures/events?fixture=${fixtureId}`, env);
  if (!data) return [];
  return data
    .filter(e => e.type === 'Goal' || e.type === 'Card' || e.type === 'Var')
    .map(e => {
      const min    = e.time?.extra ? `${e.time.elapsed}+${e.time.extra}` : `${e.time?.elapsed ?? '?'}`;
      const player = e.player?.name || '';
      const team   = e.team?.name   || '';
      if (e.type === 'Goal') {
        const icon   = e.detail === 'Own Goal' ? '⚽(OG)' : e.detail === 'Penalty' ? '⚽(P)' : e.detail === 'Missed Penalty' ? '❌(P)' : '⚽';
        const assist = e.assist?.name ? ` (asist: ${e.assist.name})` : '';
        return `${min}' ${icon} ${player}${assist} — ${team}`;
      }
      if (e.type === 'Card') {
        const icon = e.detail === 'Red Card' ? '🟥' : e.detail === 'Yellow Card Second Yellow Card' ? '🟥(2.S)' : '🟨';
        return `${min}' ${icon} ${player} — ${team}`;
      }
      if (e.type === 'Var') {
        return `${min}' 📺 VAR — ${e.detail} — ${team}${player ? ': ' + player : ''}`;
      }
      return null;
    }).filter(Boolean);
}

// ─── NORMALIZE FIXTURE ────────────────────────────────────────
// Converts raw API fixture to a clean object used by templates.
function normalizeFixture(f) {
  if (!f) return null;
  const isHome     = f.teams?.home?.id === BJK_ID;
  const opponent   = isHome ? f.teams?.away : f.teams?.home;
  const kickoff    = f.fixture?.date ? new Date(f.fixture.date) : null;
  const status     = f.fixture?.status?.short || '';   // NS, 1H, HT, 2H, FT, etc.
  const isLive     = ['1H', 'HT', '2H', 'ET', 'P'].includes(status);
  const isFinished = ['FT', 'AET', 'PEN'].includes(status);

  const bjkScore  = isHome
    ? f.goals?.home ?? null
    : f.goals?.away ?? null;
  const oppScore  = isHome
    ? f.goals?.away ?? null
    : f.goals?.home ?? null;

  return {
    fixture_id:    f.fixture?.id,
    date:          kickoff ? kickoff.toISOString().slice(0, 10) : null,
    time:          kickoff ? kickoff.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' }) : null,
    kickoff_iso:   f.fixture?.date || null,
    status,
    is_live:       isLive,
    is_finished:   isFinished,
    home:          isHome,
    team:          'Beşiktaş',
    team_id:       BJK_ID,
    opponent:      opponent?.name || '',
    opponent_id:   opponent?.id   || null,
    opponent_logo: opponent?.logo || '',
    league:        f.league?.name || 'Trendyol Süper Lig',
    league_id:     f.league?.id   || SUPERLIG,
    round:         f.league?.round || '',
    venue:         f.fixture?.venue?.name || '',
    venue_city:    f.fixture?.venue?.city || '',
    score_bjk:     bjkScore,
    score_opp:     oppScore,
    referee:       f.fixture?.referee || null,
  };
}

// ─── BJK LAST LINEUP + RATINGS ────────────────────────────────
// Returns last confirmed BJK starting XI + substitutes with per-player ratings.
// Used as the prediction base for T08c lineup card.
export async function getBJKLastLineupData(env) {
  const lastFixtures = await getLastFixtures(env, 1);
  const lastFixtureId = lastFixtures?.[0]?.fixture_id;
  if (!lastFixtureId) return null;
  const [lineup, players] = await Promise.all([
    getFixtureLineup(lastFixtureId, env),
    getFixturePlayers(lastFixtureId, env),
  ]);
  if (!lineup) return null;
  const ratingById = {}, ratingByName = {}, ratingByLast = {};
  for (const p of (players || [])) {
    if (p.id) ratingById[p.id] = p.rating;
    ratingByName[p.name] = p.rating;
    const last = (p.name || '').trim().split(/\s+/).pop().toLowerCase();
    if (last) ratingByLast[last] = p.rating;
  }
  function lookupRating(p) {
    if (p.id && ratingById[p.id]) return ratingById[p.id];
    if (ratingByName[p.name]) return ratingByName[p.name];
    const last = (p.name || '').trim().split(/\s+/).pop().toLowerCase();
    return ratingByLast[last] || null;
  }
  return {
    fixture_id:  lastFixtureId,
    formation:   lineup.formation,
    startXI:     lineup.startXI.map(p => ({ ...p, rating: lookupRating(p) })),
    substitutes: lineup.substitutes.map(p => ({ ...p, rating: lookupRating(p) })),
  };
}

// ─── OPPONENT LAST LINEUP ─────────────────────────────────────
// Returns last confirmed starting XI for any team. Used to show
// opponent's formation on the T08c pitch card.
export async function getOpponentLastLineup(opponentId, env) {
  if (!opponentId) return null;
  const fixtures = await apiFetch(`/fixtures?team=${opponentId}&last=1&timezone=Europe/Istanbul`, env);
  if (!fixtures?.length) return null;
  const fixtureId = fixtures[0]?.fixture?.id;
  if (!fixtureId) return null;
  const lineupData = await apiFetch(`/fixtures/lineups?fixture=${fixtureId}`, env);
  if (!lineupData?.length) return null;
  const oppTeam = lineupData.find(t => t.team?.id === opponentId);
  if (!oppTeam) return null;
  const startXI = (oppTeam.startXI || [])
    .map(p => ({ name: p.player?.name || '', pos: p.player?.pos || null, grid: p.player?.grid || null, rating: null }))
    .filter(p => p.name);
  return startXI.length < 8 ? null : { formation: oppTeam.formation || null, startXI, teamName: oppTeam.team?.name || '' };
}

// ─── GENERIC: TEAM NEXT FIXTURE ───────────────────────────────
// Returns next scheduled fixture for any team. Used for rival tracking.
export async function getNextFixtureForTeam(teamId, leagueId, season, env) {
  const data = await apiFetch(
    `/fixtures?team=${teamId}&league=${leagueId}&season=${season}&next=1&timezone=Europe/Istanbul`,
    env
  );
  if (!data || data.length === 0) return null;
  return normalizeFixture(data[0]);
}

// ─── GENERIC: LAST N FIXTURES FOR TEAM ────────────────────────
export async function getLastFixturesForTeam(teamId, leagueId, season, env, count = 5) {
  const data = await apiFetch(
    `/fixtures?team=${teamId}&league=${leagueId}&season=${season}&last=${count}&timezone=Europe/Istanbul`,
    env
  );
  if (!data) return [];
  return data.map(normalizeFixture);
}

// ─── GENERIC: STANDINGS FOR ANY LEAGUE ────────────────────────
// Returns full standings table for any league/season.
export async function getLeagueStandings(leagueId, season, env) {
  const data = await apiFetch(`/standings?league=${leagueId}&season=${season}`, env);
  if (!data || data.length === 0) return null;
  return data[0]?.league?.standings?.[0] || null;
}

// ─── LEAGUE CONTEXT ───────────────────────────────────────────
// Full contextual picture for a team in a league: position meaning,
// gaps to meaningful cutoffs, rival tracking, form.
// Results cached in KV to avoid redundant API calls within same cron window.
// leagueId/season/teamId are from the site config — fully multi-tenant.
export async function getLeagueContext(teamId, leagueId, season, env, opponentId = null) {
  const cacheKey = `league-context:${leagueId}:${season}:${teamId}`;
  const cached = await env.PITCHOS_CACHE.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      // Merge in fresh season notes (manually updated, not cached)
      const notes = await env.PITCHOS_CACHE.get(`season:notes:${teamId}`);
      if (notes) parsed.season_notes = notes;
      return parsed;
    } catch {}
  }

  const [table, recentFixtures, eurSpots] = await Promise.all([
    getLeagueStandings(leagueId, season, env),
    getLastFixturesForTeam(teamId, leagueId, season, env, 5),
    getEuropeanSpots(leagueId, season, env),
  ]);

  if (!table) return null;

  const teamRow  = table.find(r => r.team?.id === teamId);
  if (!teamRow) return null;

  const position = teamRow.rank;
  const points   = teamRow.points;
  const played   = teamRow.all?.played ?? 0;
  const totalTeams = table.length;
  // Estimate games remaining from the team with most played
  const maxPlayed  = Math.max(...table.map(r => r.all?.played ?? 0));
  const totalRounds = maxPlayed + (table[0]?.all?.played === maxPlayed ? 0 : 1);
  const gamesRemaining = Math.max(0, (totalTeams - 1) * 2 - played);
  const maxPointsPossible = points + gamesRemaining * 3;

  // Parse position meaning from API's description field
  const rawDesc         = teamRow.description || '';
  const positionMeaning = parsePositionMeaning(rawDesc);
  const ownSpot         = spotForPosition(eurSpots, position);

  // Compute gaps to meaningful cutoffs using the full table
  const cutoffs = deriveCutoffs(table);
  const gaps    = {};
  for (const [label, cutoffPos] of Object.entries(cutoffs)) {
    const cutoffRow = table.find(r => r.rank === cutoffPos);
    const cutoffPts = cutoffRow?.points ?? 0;
    const gap       = cutoffPts - points;
    const possible  = gap <= 0 || maxPointsPossible >= cutoffPts;
    const spot      = spotForPosition(eurSpots, cutoffPos);
    gaps[label]     = { position: cutoffPos, points_gap: gap, possible, spot };
  }

  // Recent form (league fixtures only, finished)
  const form = recentFixtures
    .filter(f => f.is_finished && f.league_id === leagueId)
    .slice(0, 5)
    .map(f => f.score_bjk > f.score_opp ? 'G' : f.score_bjk === f.score_opp ? 'B' : 'M');

  // Identify meaningful rivals (teams within 6 points in adjacent meaningful positions)
  const rivals = identifyRivals(table, teamRow, cutoffs);

  // Fetch next fixture for up to 3 rivals (cached 2h separately)
  const rivalFixtures = {};
  await Promise.all(
    rivals.slice(0, 3).map(async r => {
      const rvKey  = `rival-next:${r.id}:${leagueId}`;
      let   cached = await env.PITCHOS_CACHE.get(rvKey);
      if (!cached) {
        const fx = await getNextFixtureForTeam(r.id, leagueId, season, env);
        cached = JSON.stringify(fx);
        await env.PITCHOS_CACHE.put(rvKey, cached, { expirationTtl: 7200 });
      }
      try { rivalFixtures[r.name] = JSON.parse(cached); } catch {}
    })
  );

  // Opponent context (match opponent)
  let opponentCtx = null;
  if (opponentId && opponentId !== teamId) {
    const oppRow = table.find(r => r.team?.id === opponentId);
    if (oppRow) {
      opponentCtx = {
        id:       oppRow.team.id,
        name:     oppRow.team.name,
        position: oppRow.rank,
        points:   oppRow.points,
        description: parsePositionMeaning(oppRow.description || ''),
        motivation: deriveMotivation(oppRow, table, cutoffs),
      };
    }
  }

  const season_notes = await env.PITCHOS_CACHE.get(`season:notes:${teamId}`) || null;

  const result = {
    team:             teamRow.team.name,
    team_id:          teamId,
    position,
    points,
    played,
    games_remaining:  gamesRemaining,
    position_meaning: positionMeaning,
    own_spot:         ownSpot,
    gaps,
    form,
    rivals,
    rival_fixtures:   rivalFixtures,
    opponent:         opponentCtx,
    season_notes,
  };

  // Cache for 1 hour
  await env.PITCHOS_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });
  return result;
}

// ─── EUROPEAN SPOTS ───────────────────────────────────────────
// Fetches league_european_spots rows for a league/season from Supabase.
// Cached in KV for 24h — data never changes mid-season.
export async function getEuropeanSpots(leagueId, season, env) {
  const cacheKey = `eur-spots:${leagueId}:${season}`;
  const cached   = await env.PITCHOS_CACHE.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch {} }

  const rows = await supabase(env, 'GET',
    `/rest/v1/league_european_spots?league_id=eq.${leagueId}&season=eq.${season}&order=position_from.asc`
  );
  if (!rows || rows.length === 0) return [];
  await env.PITCHOS_CACHE.put(cacheKey, JSON.stringify(rows), { expirationTtl: 86400 });
  return rows;
}

// Find the spot entry for a given finishing position.
export function spotForPosition(spots, position) {
  return spots.find(s => position >= s.position_from && position <= s.position_to) || null;
}

// ─── HELPERS ──────────────────────────────────────────────────

function parsePositionMeaning(description) {
  if (!description) return null;
  const d = description.toLowerCase();
  if (d.includes('champions league') || d.includes('ucl')) return 'UEFA Şampiyonlar Ligi';
  if (d.includes('europa league') || d.includes('uel'))     return 'UEFA Avrupa Ligi';
  if (d.includes('conference') || d.includes('uecl'))       return 'UEFA Konferans Ligi';
  if (d.includes('relegation') || d.includes('küme düşme')) return 'Küme Düşme';
  if (d.includes('promotion'))                               return 'Terfi';
  return description;
}

// Derive the position numbers for meaningful cutoffs from the table.
// Uses API description fields — works for any league automatically.
function deriveCutoffs(table) {
  const cutoffs = {};
  let   relegStart = null;

  for (const row of table) {
    const desc = (row.description || '').toLowerCase();
    const pos  = row.rank;
    if ((desc.includes('champions league') || desc.includes('ucl')) && !cutoffs.ucl) {
      cutoffs.ucl = pos;
    }
    if ((desc.includes('europa league') && !desc.includes('conference')) && !cutoffs.uel) {
      cutoffs.uel = pos;
    }
    if (desc.includes('conference') && !cutoffs.uecl) {
      cutoffs.uecl = pos;
    }
    if (desc.includes('relegation') || desc.includes('küme')) {
      if (!relegStart) relegStart = pos;
    }
  }
  if (relegStart) cutoffs.relegation = relegStart;
  return cutoffs;
}

// Identify rivals: teams contesting the same meaningful positions as this team.
function identifyRivals(table, teamRow, cutoffs) {
  const teamPos    = teamRow.rank;
  const teamPts    = teamRow.points;
  const rivals     = [];
  const seen       = new Set([teamRow.team.id]);

  // Teams within 6 points above or below that sit near a cutoff boundary
  const boundaries = Object.values(cutoffs);
  for (const row of table) {
    if (seen.has(row.team.id)) continue;
    const ptsDiff = Math.abs(row.points - teamPts);
    const nearBoundary = boundaries.some(b => Math.abs(row.rank - b) <= 1 || Math.abs(teamPos - b) <= 1);
    if (ptsDiff <= 6 && nearBoundary) {
      rivals.push({ id: row.team.id, name: row.team.name, position: row.rank, points: row.points });
      seen.add(row.team.id);
    }
  }
  return rivals.slice(0, 4);
}

// Derive motivation level for a team based on their standing situation.
function deriveMotivation(row, table, cutoffs) {
  const pos  = row.rank;
  const pts  = row.points;
  const top  = table[0]?.points ?? pts;
  if (Math.abs(pos - (cutoffs.ucl  || 0)) <= 1 && (top - pts) <= 6) return 'şampiyonluk_yarişi';
  if (Math.abs(pos - (cutoffs.ucl  || 0)) <= 2) return 'avrupa_mücadelesi';
  if (Math.abs(pos - (cutoffs.uel  || 0)) <= 2) return 'avrupa_mücadelesi';
  if (pos >= (cutoffs.relegation || 99) - 2)     return 'küme_düşmeme_savaşı';
  if (pos >= (cutoffs.relegation || 99))          return 'küme_düşme_bölgesi';
  return 'orta_sıra';
}

export { BJK_ID, SUPERLIG, SEASON };
