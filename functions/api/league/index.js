// GET /api/league — user's group-based league info with live rankings
import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { getSiteId } from '../_shared/site.js';
import { sbGet } from '../_shared/xp.js';

export const TIERS = [
  { id: 'elmas',  label: 'Elmas',  icon: '💎', mult: 1.30, monday_bonus: 100 },
  { id: 'platin', label: 'Platin', icon: '🏆', mult: 1.20, monday_bonus: 50  },
  { id: 'altın',  label: 'Altın',  icon: '🥇', mult: 1.10, monday_bonus: 25  },
  { id: 'gümüş', label: 'Gümüş', icon: '🥈', mult: 1.05, monday_bonus: 0   },
  { id: 'bronz',  label: 'Bronz',  icon: '🥉', mult: 1.00, monday_bonus: 0   },
];
export const TIER_MAP = Object.fromEntries(TIERS.map(t => [t.id, t]));

const PROMO_COUNT    = 3;
const RELEGATE_COUNT = 3;

function mondayOf(date = new Date()) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const daysBack = day === 0 ? 6 : day - 1;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysBack));
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const weekDate   = mondayOf();
  const weekStart  = weekDate.toISOString().split('T')[0];         // YYYY-MM-DD
  const weekStartISO = weekDate.toISOString();                     // for xp_events query

  const [profileRows, memberRows] = await Promise.all([
    sbGet(env, `profiles?id=eq.${user.id}&site_id=eq.${site_id}&select=current_league&limit=1`).catch(() => []),
    sbGet(env, `league_group_members?user_id=eq.${user.id}&site_id=eq.${site_id}&week_start=eq.${weekStart}&select=group_id&limit=1`).catch(() => []),
  ]);

  const currentLeague = profileRows[0]?.current_league ?? 'bronz';
  const tier = TIER_MAP[currentLeague] ?? TIER_MAP['bronz'];

  // User's own weekly XP
  const myXpRows = await sbGet(env,
    `xp_events?user_id=eq.${user.id}&site_id=eq.${site_id}&created_at=gte.${encodeURIComponent(weekStartISO)}&nullified=eq.false&select=xp_earned`
  ).catch(() => []);
  const weekly_xp = myXpRows.reduce((s, r) => s + r.xp_earned, 0);

  const baseResponse = {
    tier: currentLeague, tier_label: tier.label, tier_icon: tier.icon,
    tier_mult: tier.mult, weekly_xp, week_start: weekStart,
    promo_zone: PROMO_COUNT, relegate_zone: RELEGATE_COUNT,
  };

  if (!memberRows.length) {
    return json({ ...baseResponse, group_id: null, group_number: null, rank: null, group_size: null, leaderboard: null });
  }

  const group_id = memberRows[0].group_id;

  const [groupRows, allMembers] = await Promise.all([
    sbGet(env, `league_groups?id=eq.${group_id}&select=group_number,tier,settled&limit=1`).catch(() => []),
    sbGet(env, `league_group_members?group_id=eq.${group_id}&week_start=eq.${weekStart}&select=user_id`).catch(() => []),
  ]);

  const group      = groupRows[0];
  const memberIds  = allMembers.map(m => m.user_id);
  if (!memberIds.length) return json({ ...baseResponse, group_id, group_number: group?.group_number ?? null, rank: null, group_size: 0, leaderboard: [] });

  const idList = memberIds.join(',');
  const [xpRows, profRows] = await Promise.all([
    sbGet(env,
      `xp_events?user_id=in.(${idList})&site_id=eq.${site_id}&created_at=gte.${encodeURIComponent(weekStartISO)}&nullified=eq.false&select=user_id,xp_earned&limit=10000`
    ).catch(() => []),
    sbGet(env,
      `profiles?id=in.(${idList})&site_id=eq.${site_id}&select=id,display_name,avatar_url&limit=60`
    ).catch(() => []),
  ]);

  const xpMap  = {};
  for (const r of xpRows) xpMap[r.user_id] = (xpMap[r.user_id] ?? 0) + r.xp_earned;

  const profMap = Object.fromEntries(profRows.map(p => [p.id, p]));

  const leaderboard = memberIds.map(uid => ({
    user_id:      uid,
    display_name: profMap[uid]?.display_name ?? 'Taraftar',
    avatar_url:   profMap[uid]?.avatar_url ?? null,
    weekly_xp:    xpMap[uid] ?? 0,
    is_me:        uid === user.id,
  }));

  leaderboard.sort((a, b) => b.weekly_xp - a.weekly_xp || a.display_name.localeCompare(b.display_name));
  leaderboard.forEach((m, i) => { m.rank = i + 1; });

  const group_size = leaderboard.length;
  const myRank     = leaderboard.find(m => m.is_me)?.rank ?? null;

  return json({
    ...baseResponse,
    group_id,
    group_number: group?.group_number ?? null,
    rank:         myRank,
    group_size,
    leaderboard,
  });
}
