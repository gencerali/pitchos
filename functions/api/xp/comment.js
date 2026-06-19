import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { getSiteId } from '../_shared/site.js';
import { awardXP } from '../_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const body = await request.json().catch(() => null);
  const { article_slug } = body ?? {};
  if (!article_slug) return err('Missing article_slug');

  const lds = body?.local_day_start ?? null;
  const result = await awardXP(env, user.id, site_id, 'comment', article_slug, lds);
  const bonus = await awardXP(env, user.id, site_id, 'first_comment', null, lds);

  return json({
    ...result,
    bonus_xp: bonus.xp_earned,
    total_xp: bonus.total_xp ?? result.total_xp,
    level: bonus.level ?? result.level,
    tier_name: bonus.tier_name ?? result.tier_name,
    badge_unlocks: [...(result.badge_unlocks ?? []), ...(bonus.badge_unlocks ?? [])],
  });
}
