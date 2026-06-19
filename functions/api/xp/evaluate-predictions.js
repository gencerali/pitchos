// Internal cron endpoint — called by the fetch-agent after match results are confirmed.
// Awards bonuses for correct outcome (W/D/L) and exact score. Protected by X-Internal-Secret.

import { json, err } from '../_shared/auth.js';
import { sbGet, sbPost, sbPatch, awardXP } from '../_shared/xp.js';

function outcome(home, away) {
  return home > away ? 'home' : home < away ? 'away' : 'draw';
}

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

  const actualOutcome = outcome(home_score, away_score);

  const predictions = await sbGet(
    env,
    `score_predictions?match_id=eq.${match_id}&site_id=eq.${site_id}&xp_awarded=eq.false&select=*`
  );

  const results = [];
  for (const pred of predictions) {
    const isExact   = pred.home_score === home_score && pred.away_score === away_score;
    const isCorrect = !isExact && outcome(pred.home_score, pred.away_score) === actualOutcome;

    let bonus_xp    = null;
    let outcome_xp  = null;

    if (isExact && !pred.bonus_awarded) {
      const bonus = await awardXP(env, pred.user_id, site_id, 'exact_score_bonus', String(match_id));
      bonus_xp = bonus.xp_earned;

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
        xp_awarded: true, bonus_awarded: true, outcome_awarded: true,
        actual_home_score: home_score, actual_away_score: away_score,
      });
      results.push({ user_id: pred.user_id, exact: true, correct_outcome: true, bonus_xp });
    } else if (isCorrect && !pred.outcome_awarded) {
      const outcomeResult = await awardXP(env, pred.user_id, site_id, 'correct_outcome_bonus', String(match_id));
      outcome_xp = outcomeResult.xp_earned;

      await sbPatch(env, `score_predictions?id=eq.${pred.id}`, {
        xp_awarded: true, outcome_awarded: true,
        actual_home_score: home_score, actual_away_score: away_score,
      });
      results.push({ user_id: pred.user_id, exact: false, correct_outcome: true, outcome_xp });
    } else {
      await sbPatch(env, `score_predictions?id=eq.${pred.id}`, {
        xp_awarded: true,
        actual_home_score: home_score, actual_away_score: away_score,
      });
      results.push({ user_id: pred.user_id, exact: false, correct_outcome: false });
    }
  }

  return json({ match_id, site_id, evaluated: results.length, results });
}
