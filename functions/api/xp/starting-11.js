// Starting 11 submission endpoint.
// Validates: exactly 11 players, match in future, one per user per match.

import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { awardXP, sbGet, sbPost } from '../_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const user = await getUser(request, env);
  if (!user) return err('Unauthorized', 401);

  const body = await request.json().catch(() => null);
  const { match_id, player_ids } = body ?? {};

  if (!match_id || !Array.isArray(player_ids)) return err('Missing match_id or player_ids');
  if (player_ids.length !== 11) return err('Exactly 11 players required');
  if (!player_ids.every(id => Number.isInteger(id) && id > 0)) return err('Invalid player IDs');

  // ── Check kickoff hasn't passed ──────────────────────────────────────
  const fixtureRes = await fetch(
    `https://v3.football.api-sports.io/fixtures?id=${match_id}`,
    { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } }
  );
  if (!fixtureRes.ok) return err('Could not verify match', 503);
  const fixtureData = await fixtureRes.json();
  const fixture = fixtureData?.response?.[0];
  if (!fixture) return err('Match not found');

  if (Date.now() >= new Date(fixture.fixture.date).getTime()) {
    return err('Maç başladı — İlk 11 artık gönderilemez');
  }

  // ── Check for existing submission ────────────────────────────────────
  const existing = await sbGet(
    env,
    `starting_elevens?user_id=eq.${user.id}&match_id=eq.${match_id}&select=id&limit=1`
  );
  if (existing.length) return err('Bu maç için zaten İlk 11 gönderdiniz', 409);

  // ── Save starting 11 ─────────────────────────────────────────────────
  await sbPost(env, 'starting_elevens', {
    user_id: user.id,
    match_id,
    player_ids,
  });

  // ── Award XP ─────────────────────────────────────────────────────────
  const result = await awardXP(env, user.id, 'submit_starting_11', String(match_id));
  const bonus = await awardXP(env, user.id, 'first_starting_11');

  return json({
    ...result,
    lineup_saved: true,
    bonus_xp: bonus.xp_earned,
    total_xp: bonus.total_xp ?? result.total_xp,
    level: bonus.level ?? result.level,
    tier_name: bonus.tier_name ?? result.tier_name,
    badge_unlocks: [...(result.badge_unlocks ?? []), ...(bonus.badge_unlocks ?? [])],
  });
}
