import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { getSiteId } from '../_shared/site.js';
import { awardXP, sbGet, sbPost } from '../_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const body = await request.json().catch(() => null);
  const { article_url, comment_text } = body ?? {};

  if (!article_url || !comment_text) return err('Missing article_url or comment_text');
  if (comment_text.trim().length < 15) return err('Yorum çok kısa (min 15 karakter)');
  if (comment_text.trim().length > 1000) return err('Yorum çok uzun (max 1000 karakter)');

  // Duplicate check: user's last 3 comments on this article
  const recent = await sbGet(
    env,
    `article_comments?article_url=eq.${encodeURIComponent(article_url)}&select=comment&order=created_at.desc&limit=3`
  );
  const normalized = comment_text.trim().toLowerCase();
  if (recent.some(r => r.comment.trim().toLowerCase() === normalized)) {
    return err('Aynı yorumu tekrar gönderemezsiniz');
  }

  // Per-user cooldown: max 3 comments per article per 10 minutes (site-scoped)
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recentXp = await sbGet(
    env,
    `xp_events?user_id=eq.${user.id}&site_id=eq.${site_id}&action_id=eq.comment&source_ref=eq.${encodeURIComponent(article_url)}&created_at=gte.${tenMinAgo}&select=id`
  );
  if (recentXp.length >= 3) {
    return err('10 dakika içinde bu makaleye en fazla 3 yorum yapabilirsiniz');
  }

  // Resolve display name
  const profile = await sbGet(
    env,
    `profiles?id=eq.${user.id}&site_id=eq.${site_id}&select=username,display_name&limit=1`
  );
  const fullName = profile[0]?.display_name ?? profile[0]?.username ?? 'Kartal';
  const [namePart, surnamePart] = fullName.split(' ');

  await sbPost(env, 'article_comments', {
    article_url,
    name: namePart ?? fullName,
    surname: surnamePart ?? '',
    comment: comment_text.trim(),
    approved: true,
  });

  const result = await awardXP(env, user.id, site_id, 'comment', article_url);
  const bonus = await awardXP(env, user.id, site_id, 'first_comment');

  return json({
    ...result,
    bonus_xp: bonus.xp_earned,
    total_xp: bonus.total_xp ?? result.total_xp,
    level: bonus.level ?? result.level,
    tier_name: bonus.tier_name ?? result.tier_name,
    badge_unlocks: [...(result.badge_unlocks ?? []), ...(bonus.badge_unlocks ?? [])],
  });
}
