// Internal cron endpoint — called after match lineup is confirmed.
// Evaluates all starting_elevens predictions for a match, awards tiered XP + badges.
// Protected by X-Internal-Secret.

import { json, err } from '../_shared/auth.js';
import { sbGet, sbPost, sbPatch, awardXP } from '../_shared/xp.js';

// XP tier: only the highest tier achieved is awarded
const TIERS = [
  { action_id: 'lineup_11_correct', min_correct: 11 },
  { action_id: 'lineup_10_correct', min_correct: 10 },
  { action_id: 'lineup_9_correct',  min_correct: 9  },
  { action_id: 'lineup_8_correct',  min_correct: 8  },
];

// Badges for cumulative successful predictions (≥8 correct)
const PREDICT_BADGES = [
  { badge_id: 'lineup_predict_100', min_count: 100 },
  { badge_id: 'lineup_predict_50',  min_count: 50  },
  { badge_id: 'lineup_predict_20',  min_count: 20  },
  { badge_id: 'lineup_predict_10',  min_count: 10  },
  { badge_id: 'lineup_predict_5',   min_count: 5   },
  { badge_id: 'lineup_predict_1',   min_count: 1   },
];

// Badges for cumulative perfect predictions (11/11)
const PERFECT_BADGES = [
  { badge_id: 'lineup_perfect_5', min_count: 5 },
  { badge_id: 'lineup_perfect_1', min_count: 1 },
];

async function grantBadgeIfNew(env, user_id, site_id, badge_id) {
  const existing = await sbGet(env,
    `user_badges?user_id=eq.${user_id}&site_id=eq.${site_id}&badge_id=eq.${badge_id}&select=id&limit=1`
  );
  if (existing.length) return null;
  await sbPost(env, 'user_badges', { user_id, site_id, badge_id });
  const info = await sbGet(env, `badges?id=eq.${badge_id}&select=*&limit=1`);
  return info[0] ?? null;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return err('Method not allowed', 405);
  if (request.headers.get('X-Internal-Secret') !== env.INTERNAL_SECRET) {
    return err('Forbidden', 403);
  }

  const body = await request.json().catch(() => null);
  const { match_id, site_id, player_ids: actual_ids } = body ?? {};

  if (!match_id || !site_id || !Array.isArray(actual_ids) || actual_ids.length !== 11) {
    return err('Missing match_id, site_id, or player_ids (must be 11)');
  }

  const actualSet = new Set(actual_ids.map(Number));

  // Store the actual lineup
  await sbPost(env, 'actual_lineups', {
    match_id: String(match_id),
    site_id,
    player_ids: actual_ids,
  }).catch(() => {
    // ignore duplicate — already recorded
  });

  const predictions = await sbGet(
    env,
    `starting_elevens?match_id=eq.${match_id}&site_id=eq.${site_id}&xp_awarded=eq.false&select=*`
  );

  const results = [];

  for (const pred of predictions) {
    const predicted = (pred.player_ids ?? []).map(Number);
    const correct_count = predicted.filter(id => actualSet.has(id)).length;

    const tier = TIERS.find(t => correct_count >= t.min_correct) ?? null;

    let xp_earned = 0;
    const badge_unlocks = [];

    if (tier) {
      const xpResult = await awardXP(env, pred.user_id, site_id, tier.action_id, String(match_id));
      xp_earned = xpResult.xp_earned;
    }

    // Mark this prediction evaluated
    await sbPatch(env, `starting_elevens?id=eq.${pred.id}`, {
      xp_awarded: true,
      correct_count,
      actual_player_ids: actual_ids,
    });

    // Badge checks — count all evaluated predictions for this user with ≥8 correct
    if (correct_count >= 8) {
      const successPreds = await sbGet(env,
        `starting_elevens?user_id=eq.${pred.user_id}&site_id=eq.${site_id}&xp_awarded=eq.true&correct_count=gte.8&select=id`
      );
      const successCount = successPreds.length;

      for (const { badge_id, min_count } of PREDICT_BADGES) {
        if (successCount >= min_count) {
          const badge = await grantBadgeIfNew(env, pred.user_id, site_id, badge_id);
          if (badge) badge_unlocks.push(badge);
        }
      }
    }

    if (correct_count === 11) {
      const perfectPreds = await sbGet(env,
        `starting_elevens?user_id=eq.${pred.user_id}&site_id=eq.${site_id}&xp_awarded=eq.true&correct_count=eq.11&select=id`
      );
      const perfectCount = perfectPreds.length;

      for (const { badge_id, min_count } of PERFECT_BADGES) {
        if (perfectCount >= min_count) {
          const badge = await grantBadgeIfNew(env, pred.user_id, site_id, badge_id);
          if (badge) badge_unlocks.push(badge);
        }
      }
    }

    results.push({ user_id: pred.user_id, correct_count, xp_earned, badge_unlocks });
  }

  return json({ match_id, site_id, evaluated: results.length, results });
}
