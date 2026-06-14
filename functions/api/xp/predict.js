// Score prediction endpoint.
// Validates: match exists, kickoff hasn't passed + 5-min buffer, one prediction per user per match.
// On match result confirmation (separate cron), exact-match bonus is awarded.

import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { awardXP, sbGet, sbPost } from '../_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const user = await getUser(request, env);
  if (!user) return err('Unauthorized', 401);

  const body = await request.json().catch(() => null);
  const { match_id, home_score, away_score } = body ?? {};

  if (!match_id || home_score == null || away_score == null) {
    return err('Missing match_id, home_score or away_score');
  }
  if (!Number.isInteger(home_score) || !Number.isInteger(away_score)) {
    return err('Scores must be integers');
  }
  if (home_score < 0 || away_score < 0) return err('Scores cannot be negative');

  // ── Check kickoff lock via api-football ─────────────────────────────
  // Fetch fixture from api-football to get kickoff time
  const fixtureRes = await fetch(
    `https://v3.football.api-sports.io/fixtures?id=${match_id}`,
    { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } }
  );
  if (!fixtureRes.ok) return err('Could not verify match', 503);
  const fixtureData = await fixtureRes.json();
  const fixture = fixtureData?.response?.[0];
  if (!fixture) return err('Match not found');

  const kickoff = new Date(fixture.fixture.date);
  const lockTime = new Date(kickoff.getTime() - 5 * 60 * 1000); // 5 min before
  if (Date.now() >= lockTime.getTime()) {
    return err('Tahmin süresi doldu — maç başlamak üzere');
  }

  // ── Check for existing prediction (one per user per match) ───────────
  const existing = await sbGet(
    env,
    `score_predictions?user_id=eq.${user.id}&match_id=eq.${match_id}&select=id&limit=1`
  );
  if (existing.length) return err('Bu maç için zaten tahmin yaptınız', 409);

  // ── Save prediction ──────────────────────────────────────────────────
  await sbPost(env, 'score_predictions', {
    user_id: user.id,
    match_id,
    home_score,
    away_score,
  });

  // ── Award XP ─────────────────────────────────────────────────────────
  const result = await awardXP(env, user.id, 'predict_score', String(match_id));
  const bonus = await awardXP(env, user.id, 'first_score_predict');

  return json({
    ...result,
    prediction_saved: true,
    bonus_xp: bonus.xp_earned,
    total_xp: bonus.total_xp ?? result.total_xp,
    level: bonus.level ?? result.level,
    tier_name: bonus.tier_name ?? result.tier_name,
    badge_unlocks: [...(result.badge_unlocks ?? []), ...(bonus.badge_unlocks ?? [])],
  });
}
