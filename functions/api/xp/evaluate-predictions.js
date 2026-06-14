// Internal cron endpoint — called by the fetch-agent after match results are confirmed.
// Awards exact-score bonuses for the given match. Protected by X-Internal-Secret header.

import { json, err } from '../_shared/auth.js';
import { sbGet, sbPost, sbPatch, awardXP } from '../_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return err('Method not allowed', 405);

  if (request.headers.get('X-Internal-Secret') !== env.INTERNAL_SECRET) {
    return err('Forbidden', 403);
  }

  const body = await request.json().catch(() => null);
  const { match_id, site_id, home_score, away_score } = body ?? {};
  if (!match_id || !site_id || home_score == null || away_score == null) {
    return err('Missing match_id, site_id, home_score or away_score');
  }

  const predictions = await sbGet(
    env,
    `score_predictions?match_id=eq.${match_id}&site_id=eq.${site_id}&xp_awarded=eq.false&select=*`
  );

  const results = [];
  for (const pred of predictions) {
    const isExact = pred.home_score === home_score && pred.away_score === away_score;

    if (isExact && !pred.bonus_awarded) {
      const bonus = await awardXP(env, pred.user_id, site_id, 'exact_score_bonus', String(match_id));

      // Skor Avcısı badge — first ever exact prediction
      const hasBadge = await sbGet(
        env,
        `user_badges?user_id=eq.${pred.user_id}&site_id=eq.${site_id}&badge_id=eq.exact_score_first&select=id&limit=1`
      );
      if (!hasBadge.length) {
        await sbPost(env, 'user_badges', {
          user_id: pred.user_id,
          site_id,
          badge_id: 'exact_score_first',
        });
      }

      await sbPatch(env, `score_predictions?id=eq.${pred.id}`, {
        xp_awarded: true, bonus_awarded: true,
      });
      results.push({ user_id: pred.user_id, exact: true, bonus_xp: bonus.xp_earned });
    } else {
      await sbPatch(env, `score_predictions?id=eq.${pred.id}`, { xp_awarded: true });
      results.push({ user_id: pred.user_id, exact: false });
    }
  }

  return json({ match_id, site_id, evaluated: results.length, results });
}
