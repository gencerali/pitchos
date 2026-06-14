// Returns the current user's full gamification state:
// profile, total XP, level, streak, badges, and rank on each leaderboard.

import { getUser, json, err, corsHeaders } from './_shared/auth.js';
import { sbGet, sbRpc, getStreak } from './_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const user = await getUser(request, env);
  if (!user) return err('Unauthorized', 401);

  const [profile, streak, badges, xpRows] = await Promise.all([
    sbGet(env, `profiles?id=eq.${user.id}&select=*&limit=1`),
    getStreak(env, user.id),
    sbGet(env, `user_badges?user_id=eq.${user.id}&select=badge_id,earned_at,badges(*)&order=earned_at.desc`),
    sbGet(env, `xp_events?user_id=eq.${user.id}&nullified=eq.false&select=xp_earned`),
  ]);

  const total_xp = xpRows.reduce((s, r) => s + r.xp_earned, 0);
  const levelInfo = await sbRpc(env, 'get_user_level', { total_xp });
  const { level, tier_name, tier_number, xp_to_next } = levelInfo[0] ?? {
    level: 1, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 50,
  };

  return json({
    profile: profile[0] ?? null,
    xp: {
      total: total_xp,
      level,
      tier_name,
      tier_number,
      xp_to_next,
    },
    streak: {
      current: streak.current_streak,
      longest: streak.longest_streak,
      shield_active: streak.shield_active,
      last_checkin_date: streak.last_checkin_date,
    },
    badges,
  });
}
