// GET /api/public-user?uid=UUID
// Public profile endpoint — no auth required.
// Returns profile, XP, streak, and earned badges for any user on this site.

import { json, err, corsHeaders } from './_shared/auth.js';
import { getSiteId } from './_shared/site.js';
import { sbGet, sbRpc } from './_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const url = new URL(request.url);
  const uid = url.searchParams.get('uid');
  if (!uid) return err('uid required', 400);

  const site_id = await getSiteId(request, env);
  if (!site_id) return err('Site not found', 404);

  const [profiles, xpRows, userBadges, streakRows] = await Promise.all([
    sbGet(env, `profiles?id=eq.${encodeURIComponent(uid)}&site_id=eq.${encodeURIComponent(site_id)}&select=id,username,display_name,avatar_url,created_at&limit=1`),
    sbGet(env, `xp_events?user_id=eq.${encodeURIComponent(uid)}&site_id=eq.${encodeURIComponent(site_id)}&nullified=eq.false&select=xp_earned`),
    sbGet(env, `user_badges?user_id=eq.${encodeURIComponent(uid)}&site_id=eq.${encodeURIComponent(site_id)}&select=badge_id,earned_at&order=earned_at.asc`),
    sbGet(env, `user_streaks?user_id=eq.${encodeURIComponent(uid)}&site_id=eq.${encodeURIComponent(site_id)}&select=current_streak,longest_streak&limit=1`),
  ]);

  if (!profiles?.length) return err('User not found', 404);

  const total_xp = (xpRows || []).reduce((s, r) => s + (r.xp_earned || 0), 0);
  const levelRows = await sbRpc(env, 'get_user_level', { total_xp });
  const lvl = levelRows?.[0] ?? { level: 1, tier_name: 'Misafir Kartal', xp_to_next: 50 };

  return json({
    profile: profiles[0],
    xp: {
      total: total_xp,
      level: lvl.level,
      tier_name: lvl.tier_name,
      xp_to_next: lvl.xp_to_next,
    },
    streak: {
      current: streakRows?.[0]?.current_streak ?? 0,
      longest: streakRows?.[0]?.longest_streak ?? 0,
    },
    badges: userBadges || [],
  });
}
