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
  const { match_id, home_score, away_score } = body ?? {};

  if (!match_id || home_score == null || away_score == null) {
    return err('Missing match_id, home_score or away_score');
  }
  if (!Number.isInteger(home_score) || !Number.isInteger(away_score) ||
      home_score < 0 || away_score < 0) {
    return err('Invalid score values');
  }

  try {
    // Validate kickoff via internal upcoming-match endpoint (handles caching + ESPN scan)
    const origin = new URL(request.url).origin;
    const upcomingRes = await fetch(`${origin}/api/upcoming-match`).catch(() => null);
    if (!upcomingRes?.ok) return err('Could not verify match', 503);
    const upcomingBody = await upcomingRes.json().catch(() => null);
    const upcoming = upcomingBody?.match;
    if (!upcoming || String(upcoming.match_id) !== String(match_id)) {
      return err('Match not found');
    }
    const lockTime = new Date(upcoming.kickoff_utc).getTime() - 5 * 60 * 1000;
    if (Date.now() >= lockTime) return err('Tahmin süresi doldu — maç başlamak üzere');

    // One prediction per user per match per site
    const existing = await sbGet(
      env,
      `score_predictions?user_id=eq.${user.id}&site_id=eq.${site_id}&match_id=eq.${match_id}&select=id&limit=1`
    );
    if (existing.length) return err('Bu maç için zaten tahmin yaptınız', 409);

    await sbPost(env, 'score_predictions', { user_id: user.id, site_id, match_id, home_score, away_score });

    const result = await awardXP(env, user.id, site_id, 'predict_score', String(match_id));
    const bonus = await awardXP(env, user.id, site_id, 'first_score_predict');

    return json({
      ...result,
      prediction_saved: true,
      bonus_xp: bonus.xp_earned,
      total_xp: bonus.total_xp ?? result.total_xp,
      level: bonus.level ?? result.level,
      tier_name: bonus.tier_name ?? result.tier_name,
      badge_unlocks: [...(result.badge_unlocks ?? []), ...(bonus.badge_unlocks ?? [])],
    });
  } catch (e) {
    return err(e?.message ?? 'Internal error', 500);
  }
}
