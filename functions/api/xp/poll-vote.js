import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { awardXP } from '../_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const user = await getUser(request, env);
  if (!user) return err('Unauthorized', 401);

  const body = await request.json().catch(() => null);
  if (!body?.poll_id) return err('Missing poll_id');

  // awardXP deduplicates by source_ref — same poll can only award once per user
  const result = await awardXP(env, user.id, 'poll_vote', body.poll_id);

  // First poll vote one-time bonus
  const bonus = await awardXP(env, user.id, 'first_poll_vote');

  return json({
    ...result,
    bonus_xp: bonus.xp_earned,
    total_xp: bonus.total_xp ?? result.total_xp,
    level: bonus.level ?? result.level,
    tier_name: bonus.tier_name ?? result.tier_name,
    badge_unlocks: [...(result.badge_unlocks ?? []), ...(bonus.badge_unlocks ?? [])],
  });
}
