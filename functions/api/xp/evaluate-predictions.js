// Called by the existing fetch-agent cron after match results are confirmed.
// For each finished match: finds pending predictions, awards exact-score bonuses.
// Protected by a shared secret header — not callable from the browser.

import { json, err } from '../_shared/auth.js';
import { sbGet, sbPost, sbPatch, awardXP } from '../_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return err('Method not allowed', 405);

  // Internal call only
  const secret = request.headers.get('X-Internal-Secret');
  if (secret !== env.INTERNAL_SECRET) return err('Forbidden', 403);

  const body = await request.json().catch(() => null);
  // Expects: { match_id, home_score, away_score }
  const { match_id, home_score, away_score } = body ?? {};
  if (!match_id || home_score == null || away_score == null) {
    return err('Missing match_id, home_score or away_score');
  }

  // Fetch all unevaluated predictions for this match
  const predictions = await sbGet(
    env,
    `score_predictions?match_id=eq.${match_id}&xp_awarded=eq.false&select=*`
  );

  const results = [];
  for (const pred of predictions) {
    const isExact = pred.home_score === home_score && pred.away_score === away_score;

    if (isExact && !pred.bonus_awarded) {
      // Award exact score bonus
      const bonus = await awardXP(env, pred.user_id, 'exact_score_bonus', String(match_id));

      // Unlock Skor Avcısı badge on first ever exact prediction
      await awardXP(env, pred.user_id, 'first_score_predict').catch(() => {});
      // Note: first_score_predict bonus was already awarded at prediction time.
      // The badge 'exact_score_first' needs to be awarded directly:
      const existingBadge = await sbGet(
        env,
        `user_badges?user_id=eq.${pred.user_id}&badge_id=eq.exact_score_first&select=id&limit=1`
      );
      if (!existingBadge.length) {
        await sbPost(env, 'user_badges', { user_id: pred.user_id, badge_id: 'exact_score_first' });
      }

      await sbPatch(env, `score_predictions?id=eq.${pred.id}`, {
        xp_awarded: true,
        bonus_awarded: true,
      });
      results.push({ user_id: pred.user_id, exact: true, bonus_xp: bonus.xp_earned });
    } else {
      await sbPatch(env, `score_predictions?id=eq.${pred.id}`, { xp_awarded: true });
      results.push({ user_id: pred.user_id, exact: false });
    }
  }

  return json({ match_id, evaluated: results.length, results });
}
