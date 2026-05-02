// ─── API-FOOTBALL WRAPPER ─────────────────────────────────────
// Free tier: 100 requests/day. Poll only during match windows.
// All functions return null on error — callers must handle gracefully.
// API key stored as Workers secret: API_FOOTBALL_KEY
// Docs: https://www.api-football.com/documentation-v3

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
        'Origin':          'https://app.kartalix.com',
        'Referer':         'https://app.kartalix.com/',
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

export { BJK_ID, SUPERLIG, SEASON };
