// Internal endpoint — called after the actual match lineup is confirmed.
// Records the real lineup, scores all user predictions, awards bonus XP and badges.
// Protected by X-Internal-Secret (same pattern as evaluate-predictions.js).

import { json, err } from '../_shared/auth.js';
import { sbGet, sbPost, sbPatch, awardXP } from '../_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return err('Method not allowed', 405);

  if (request.headers.get('X-Internal-Secret') !== env.INTERNAL_SECRET) {
    return err('Forbidden', 403);
  }

  const body = await request.json().catch(() => null);
  const { match_id, site_id, player_ids, formation } = body ?? {};

  if (!match_id || !site_id || !Array.isArray(player_ids) || player_ids.length !== 11) {
    return err('Missing or invalid match_id, site_id, or player_ids (need exactly 11)');
  }

  // Idempotent: record actual lineup only once
  const already = await sbGet(
    env,
    `actual_lineups?match_id=eq.${match_id}&site_id=eq.${site_id}&select=id&limit=1`
  );
  if (!already.length) {
    await sbPost(env, 'actual_lineups', {
      match_id,
      site_id,
      player_ids,
      formation: formation ?? null,
    });
  }

  // Fetch all unscored predictions for this match
  const predictions = await sbGet(
    env,
    `starting_elevens?match_id=eq.${match_id}&site_id=eq.${site_id}&correct_count=is.null&select=*`
  );

  const actualSet = new Set(player_ids.map(Number));
  const results   = [];

  for (const pred of predictions) {
    const predIds      = (pred.player_ids ?? []).map(Number);
    const correct_count = predIds.filter(id => actualSet.has(id)).length;

    await sbPatch(env, `starting_elevens?id=eq.${pred.id}`, {
      correct_count,
      actual_player_ids: player_ids,
      xp_awarded: true,
    });

    let perfect_xp    = null;
    let badge_unlocks = [];

    // Perfect 11/11 bonus XP (also triggers lineup_perfect_* badges via checkBadges)
    if (correct_count === 11) {
      const bonus = await awardXP(env, pred.user_id, site_id, 'lineup_11_correct', String(match_id));
      perfect_xp    = bonus.xp_earned;
      badge_unlocks = bonus.badge_unlocks ?? [];
    }

    // 8+ correct badges — checked directly against starting_elevens history
    if (correct_count >= 8) {
      const qualifying = await sbGet(
        env,
        `starting_elevens?user_id=eq.${pred.user_id}&site_id=eq.${site_id}&correct_count=gte.8&select=id`
      );
      const n = qualifying.length;
      const predict_thresholds = [
        { badge_id: 'lineup_predict_1',   min: 1   },
        { badge_id: 'lineup_predict_5',   min: 5   },
        { badge_id: 'lineup_predict_10',  min: 10  },
        { badge_id: 'lineup_predict_20',  min: 20  },
        { badge_id: 'lineup_predict_50',  min: 50  },
        { badge_id: 'lineup_predict_100', min: 100 },
      ];
      for (const { badge_id, min } of predict_thresholds) {
        if (n < min) continue;
        const has = await sbGet(
          env,
          `user_badges?user_id=eq.${pred.user_id}&site_id=eq.${site_id}&badge_id=eq.${badge_id}&select=id&limit=1`
        );
        if (!has.length) {
          await sbPost(env, 'user_badges', { user_id: pred.user_id, site_id, badge_id });
          const info = await sbGet(env, `badges?id=eq.${badge_id}&select=*&limit=1`);
          if (info[0]) badge_unlocks.push(info[0]);
        }
      }
    }

    results.push({ user_id: pred.user_id, correct_count, perfect: correct_count === 11, perfect_xp, badge_unlocks });
  }

  return json({ match_id, site_id, evaluated: results.length, results });
}
