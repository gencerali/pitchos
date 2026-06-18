// worker-sync.js — pitchos-intel: daily ESPN sync for fixtures + squad
//
// No public routes except /sync for manual trigger.
// Deploy:  npx wrangler deploy -c wrangler-intel.toml
// Secrets: npx wrangler secret put SUPABASE_SERVICE_KEY -c wrangler-intel.toml

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const BJK_ID    = '1895';
const LEAGUE    = 'tur.1';

// Turkish Süper Lig season ends ~May; starting year convention (2025 = 2025-26 season)
function currentSeason() {
  const m = new Date().getMonth(); // 0-based
  const y = new Date().getFullYear();
  return m >= 7 ? y : y - 1; // Aug+ → new season started
}

async function espnGet(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; pitchos-intel/1.0)' },
  });
  if (!res.ok) throw new Error(`ESPN ${res.status} ${url}`);
  return res.json();
}

function sbHeaders(env) {
  const key = env.SUPABASE_SERVICE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  };
}

async function sbUpsert(env, table, rows) {
  if (!rows.length) return 0;
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=espn_id`,
    { method: 'POST', headers: sbHeaders(env), body: JSON.stringify(rows) }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${table}: ${res.status} ${body.slice(0, 200)}`);
  }
  return rows.length;
}

async function syncFixtures(env) {
  const season = currentSeason();
  const url = `${ESPN_BASE}/${LEAGUE}/teams/${BJK_ID}/schedule?season=${season}&limit=100`;
  const data = await espnGet(url);
  const events = data.events ?? [];

  const rows = [];
  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;

    const bjk = comp.competitors?.find(c => c.team?.id === BJK_ID);
    const opp = comp.competitors?.find(c => c.team?.id !== BJK_ID);
    if (!bjk || !opp) continue;

    const completed = comp.status?.type?.completed ?? false;
    const bjkScore  = completed && bjk.score !== '' ? parseInt(bjk.score, 10) : null;
    const oppScore  = completed && opp.score !== '' ? parseInt(opp.score, 10) : null;

    // Determine competition type from ESPN slug when available
    const compType = comp.type?.slug ?? comp.name ?? '';
    let competition = 'league';
    if (/cup|kupa/i.test(compType))     competition = 'cup';
    if (/europa|champions|ucl|uel/i.test(compType)) competition = 'european';

    rows.push({
      espn_id:      String(ev.id),
      season:       String(season),
      match_date:   ev.date,
      is_home:      bjk.homeAway === 'home',
      opponent_id:  String(opp.team.id),
      opponent:     opp.team.displayName,
      opponent_logo: opp.team.logos?.[0]?.href ?? null,
      venue:        comp.venue?.fullName ?? null,
      venue_city:   comp.venue?.address?.city ?? null,
      completed,
      bjk_score:    isNaN(bjkScore) ? null : bjkScore,
      opp_score:    isNaN(oppScore) ? null : oppScore,
      competition,
      synced_at:    new Date().toISOString(),
    });
  }

  return sbUpsert(env, 'fixtures', rows);
}

async function syncSquad(env) {
  const url = `${ESPN_BASE}/teams/${BJK_ID}/roster`;
  const data = await espnGet(url);

  // ESPN may return athletes as flat array or grouped by position
  let athletes = data.athletes ?? [];
  if (athletes.length && (athletes[0].items || athletes[0].athletes)) {
    athletes = athletes.flatMap(g => g.items ?? g.athletes ?? []);
  }

  const rows = athletes.map(a => ({
    espn_id:      String(a.id),
    full_name:    a.fullName ?? a.displayName ?? '',
    short_name:   a.shortName ?? null,
    position:     a.position?.name ?? a.position?.abbreviation ?? null,
    jersey:       a.jersey != null ? parseInt(a.jersey, 10) : null,
    nationality:  a.citizenship ?? a.birthPlace?.country ?? null,
    photo_url:    a.headshot?.href ?? null,
    date_of_birth: a.dateOfBirth ?? null,
    active:       true,
    synced_at:    new Date().toISOString(),
  }));

  return sbUpsert(env, 'squad_members', rows);
}

async function runSync(env) {
  const out = { fixtures: 0, squad: 0, errors: [] };

  await Promise.allSettled([
    syncFixtures(env).then(n => { out.fixtures = n; }).catch(e => out.errors.push(`fixtures: ${e.message}`)),
    syncSquad(env).then(n => { out.squad = n; }).catch(e => out.errors.push(`squad: ${e.message}`)),
  ]);

  return out;
}

export default {
  async scheduled(_event, env, _ctx) {
    await runSync(env);
  },

  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/sync') {
      return new Response('pitchos-intel', { status: 200 });
    }
    const results = await runSync(env);
    return new Response(JSON.stringify(results, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
