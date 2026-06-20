import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { getSiteId } from '../_shared/site.js';
import { getStreak, sbGet, sbPost, sbPatch } from '../_shared/xp.js';

const REVIVAL_COST = 100;
const REVIVAL_COOLDOWN_DAYS = 7;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const body = await request.json().catch(() => ({}));
  const prev_streak = parseInt(body.prev_streak || 0);
  if (!prev_streak || prev_streak < 2) return err('Invalid prev_streak', 400);

  // Check XP balance
  const xpRows = await sbGet(env, `xp_events?user_id=eq.${user.id}&site_id=eq.${site_id}&nullified=eq.false&select=xp_earned`);
  const total_xp = xpRows.reduce((s, r) => s + r.xp_earned, 0);
  if (total_xp < REVIVAL_COST) return json({ ok: false, reason: 'insufficient_xp', total_xp });

  // Check cooldown — no revival action in the last 7 days
  const cooldownSince = new Date(Date.now() - REVIVAL_COOLDOWN_DAYS * 86400000).toISOString();
  const recentRevival = await sbGet(env,
    `xp_events?user_id=eq.${user.id}&site_id=eq.${site_id}&action_id=eq.streak_revival&created_at=gte.${encodeURIComponent(cooldownSince)}&select=id&limit=1`
  );
  if (recentRevival.length) return json({ ok: false, reason: 'cooldown' });

  const streak = await getStreak(env, user.id, site_id);

  // Deduct XP — insert a negative event
  await sbPost(env, 'xp_events', {
    user_id: user.id,
    site_id,
    action_id: 'streak_revival',
    xp_earned: -REVIVAL_COST,
    base_xp: REVIVAL_COST,
    multiplier: 1.00,
    source_ref: null,
    nullified: false,
  });

  // Restore streak to prev_streak - 1 (the missed day is forgiven)
  const restored_streak = Math.max(1, prev_streak - 1);
  const new_longest = Math.max(restored_streak, streak.longest_streak ?? 0);
  const todayLocal = new Date().toISOString().slice(0, 10);

  const streakExists = await sbGet(env, `user_streaks?user_id=eq.${user.id}&site_id=eq.${site_id}&select=user_id&limit=1`);
  if (streakExists.length) {
    await sbPatch(env, `user_streaks?user_id=eq.${user.id}&site_id=eq.${site_id}`, {
      current_streak: restored_streak,
      longest_streak: new_longest,
      last_checkin_date: todayLocal,
      updated_at: new Date().toISOString(),
    });
  } else {
    await sbPost(env, 'user_streaks', {
      user_id: user.id, site_id,
      current_streak: restored_streak,
      longest_streak: new_longest,
      last_checkin_date: todayLocal,
      shield_active: false,
      streak_started_at: new Date().toISOString(),
    });
  }

  const newXpRows = await sbGet(env, `xp_events?user_id=eq.${user.id}&site_id=eq.${site_id}&nullified=eq.false&select=xp_earned`);
  const new_total_xp = newXpRows.reduce((s, r) => s + r.xp_earned, 0);

  return json({ ok: true, restored_streak, new_total_xp, cost: REVIVAL_COST });
}
