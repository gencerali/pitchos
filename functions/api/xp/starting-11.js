import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { getSiteId } from '../_shared/site.js';
import { awardXP, sbGet, sbPost, sbPatch } from '../_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const body = await request.json().catch(() => null);
  const { match_id, player_ids } = body ?? {};

  if (!match_id || !Array.isArray(player_ids)) return err('Missing match_id or player_ids');
  if (player_ids.length !== 11) return err('Exactly 11 players required');
  if (!player_ids.every(id => Number.isInteger(id) && id > 0)) return err('Invalid player IDs');

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
    if (Date.now() >= new Date(upcoming.kickoff_utc).getTime()) {
      return err('Maç başladı — İlk 11 artık gönderilemez');
    }

    const existing = await sbGet(
      env,
      `starting_elevens?user_id=eq.${user.id}&site_id=eq.${site_id}&match_id=eq.${match_id}&select=id&limit=1`
    );

    const lds = body?.local_day_start ?? null;

    if (existing.length) {
      await sbPatch(
        env,
        `starting_elevens?user_id=eq.${user.id}&site_id=eq.${site_id}&match_id=eq.${match_id}`,
        { player_ids }
      );
      return json({ lineup_saved: true, updated: true, xp_earned: 0 });
    }

    await sbPost(env, 'starting_elevens', { user_id: user.id, site_id, match_id, player_ids });

    const result = await awardXP(env, user.id, site_id, 'submit_starting_11', String(match_id), lds);
    const bonus = await awardXP(env, user.id, site_id, 'first_starting_11', null, lds);

    return json({
      ...result,
      lineup_saved: true,
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
