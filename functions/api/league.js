// GET /api/league — user's weekly XP and league tier
// Weekly window = Monday 00:00 UTC → Sunday 23:59 UTC

import { getUser, json, err, corsHeaders } from './_shared/auth.js';
import { getSiteId } from './_shared/site.js';
import { sbGet } from './_shared/xp.js';

const LEAGUES = [
  { name: 'Elmas',  icon: '💎', min_xp: 1500, next_name: null,    next_min: null },
  { name: 'Platin', icon: '🏆', min_xp: 700,  next_name: 'Elmas', next_min: 1500 },
  { name: 'Altın',  icon: '🥇', min_xp: 300,  next_name: 'Platin', next_min: 700 },
  { name: 'Gümüş', icon: '🥈', min_xp: 100,  next_name: 'Altın', next_min: 300 },
  { name: 'Bronz',  icon: '🥉', min_xp: 0,    next_name: 'Gümüş', next_min: 100 },
];

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const now = new Date();
  // Monday of current week at 00:00 UTC
  const dayOfWeek = now.getUTCDay(); // 0 = Sunday
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday
  )).toISOString();

  const rows = await sbGet(env,
    `xp_events?user_id=eq.${user.id}&site_id=eq.${site_id}&created_at=gte.${encodeURIComponent(weekStart)}&nullified=eq.false&select=xp_earned`
  ).catch(() => []);

  const weekly_xp = rows.reduce((s, r) => s + r.xp_earned, 0);
  const league = LEAGUES.find(l => weekly_xp >= l.min_xp) ?? LEAGUES[LEAGUES.length - 1];

  return json({
    weekly_xp,
    week_start: weekStart,
    league: league.name,
    league_icon: league.icon,
    next_league: league.next_name,
    next_league_min_xp: league.next_min,
    xp_to_next: league.next_min !== null ? Math.max(0, league.next_min - weekly_xp) : 0,
  });
}
