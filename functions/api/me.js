import { getUser, json, err, corsHeaders } from './_shared/auth.js';
import { getSiteId } from './_shared/site.js';
import { sbGet, sbRpc, getStreak } from './_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const [profile, streak, badges, xpRows] = await Promise.all([
    sbGet(env, `profiles?id=eq.${user.id}&site_id=eq.${site_id}&select=*&limit=1`),
    getStreak(env, user.id, site_id),
    sbGet(env, `user_badges?user_id=eq.${user.id}&site_id=eq.${site_id}&select=badge_id,earned_at,badges(*)&order=earned_at.desc`),
    sbGet(env, `xp_events?user_id=eq.${user.id}&site_id=eq.${site_id}&nullified=eq.false&select=xp_earned`),
  ]);

  // User has no profile on this site — deny
  if (!profile.length) return err('No account on this site', 403);

  const total_xp = xpRows.reduce((s, r) => s + r.xp_earned, 0);
  const levelInfo = await sbRpc(env, 'get_user_level', { total_xp });
  const { level, tier_name, tier_number, xp_to_next } = levelInfo[0] ?? {
    level: 1, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 50,
  };

  const levelThreshold = await sbGet(env, `level_thresholds?level=eq.${level}&select=min_xp&limit=1`);
  const xp_at_level = levelThreshold[0]?.min_xp ?? 0;

  return json({
    profile: profile[0],
    xp: { total: total_xp, level, tier_name, tier_number, xp_to_next, xp_at_level },
    streak: {
      current: streak.current_streak,
      longest: streak.longest_streak,
      shield_active: streak.shield_active,
      last_checkin_date: streak.last_checkin_date,
    },
    badges,
  });
}
