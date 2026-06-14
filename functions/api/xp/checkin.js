import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { getSiteId } from '../_shared/site.js';
import { awardXP, getStreak, sbGet, sbPost, sbPatch, streakMultiplier } from '../_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const todayUTC = new Date().toISOString().slice(0, 10);
  const streak = await getStreak(env, user.id, site_id);

  if (streak.last_checkin_date === todayUTC) {
    return json({ already_checked_in: true, current_streak: streak.current_streak });
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let new_streak;
  let shield_consumed = false;

  if (streak.last_checkin_date === yesterday) {
    new_streak = (streak.current_streak ?? 0) + 1;
  } else if (!streak.last_checkin_date) {
    new_streak = 1;
  } else {
    const daysBehind = Math.floor(
      (Date.now() - new Date(streak.last_checkin_date).getTime()) / 86400000
    );
    if (daysBehind === 2 && streak.shield_active) {
      new_streak = (streak.current_streak ?? 0) + 1;
      shield_consumed = true;
    } else {
      new_streak = 1;
    }
  }

  const new_longest = Math.max(new_streak, streak.longest_streak ?? 0);
  const started_at = new_streak === 1 ? new Date().toISOString() : streak.streak_started_at;

  const streakExists = await sbGet(
    env,
    `user_streaks?user_id=eq.${user.id}&site_id=eq.${site_id}&select=user_id&limit=1`
  );

  if (streakExists.length) {
    await sbPatch(env, `user_streaks?user_id=eq.${user.id}&site_id=eq.${site_id}`, {
      current_streak: new_streak,
      longest_streak: new_longest,
      last_checkin_date: todayUTC,
      shield_active: shield_consumed ? false : streak.shield_active,
      streak_started_at: started_at,
      updated_at: new Date().toISOString(),
    });
  } else {
    await sbPost(env, 'user_streaks', {
      user_id: user.id,
      site_id,
      current_streak: new_streak,
      longest_streak: new_longest,
      last_checkin_date: todayUTC,
      shield_active: false,
      streak_started_at: new Date().toISOString(),
    });
  }

  const result = await awardXP(env, user.id, site_id, 'daily_checkin');

  let streak_bonus = null;
  if (new_streak > 0 && new_streak % 5 === 0) {
    streak_bonus = await awardXP(env, user.id, site_id, 'streak_5_bonus');
  }

  let shield_awarded = false;
  if (new_streak === 15) {
    const fresh = await getStreak(env, user.id, site_id);
    if (!fresh.shield_active) {
      await sbPatch(env, `user_streaks?user_id=eq.${user.id}&site_id=eq.${site_id}`, {
        shield_active: true,
      });
      shield_awarded = true;
    }
  }

  return json({
    current_streak: new_streak,
    longest_streak: new_longest,
    shield_consumed,
    shield_awarded,
    multiplier: streakMultiplier(new_streak),
    xp_earned: result.xp_earned,
    streak_bonus_xp: streak_bonus?.xp_earned ?? 0,
    total_xp: streak_bonus?.total_xp ?? result.total_xp,
    level: streak_bonus?.level ?? result.level,
    tier_name: streak_bonus?.tier_name ?? result.tier_name,
    xp_to_next: streak_bonus?.xp_to_next ?? result.xp_to_next,
    badge_unlocks: [
      ...(result.badge_unlocks ?? []),
      ...(streak_bonus?.badge_unlocks ?? []),
    ],
  });
}
