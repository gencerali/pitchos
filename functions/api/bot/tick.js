// POST /api/bot/tick
// Called 4× daily by cron to simulate bot activity.
// Protected by X-Internal-Secret header.
//
// Body: { "window": "morning" | "afternoon" | "evening" | "night" }
//
// Windows (TRT = UTC+3):
//   morning   07:00 — checkins for ~40% of daily-active bots
//   afternoon 13:00 — article reads + remaining checkins
//   evening   18:00 — score predictions on match days + poll votes
//   night     22:00 — late checkins + reads for remaining bots
//
// Each window processes up to 120 bots in parallel chunks of 15.

import { json, err } from '../_shared/auth.js';
import { sbGet, sbPost, sbPatch, awardXP, getStreak } from '../_shared/xp.js';

const CHUNK = 15;  // parallel Supabase operations per chunk
const MAX_PER_WINDOW = 120;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runChunks(items, fn) {
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    await Promise.allSettled(chunk.map(fn));
  }
}

// Mirrors checkin.js logic without HTTP auth
async function botCheckin(env, user_id, site_id) {
  const todayDate = new Date().toISOString().slice(0, 10);
  const streak    = await getStreak(env, user_id, site_id);

  if (streak.last_checkin_date === todayDate) return; // already checked in today

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let new_streak;
  if (!streak.last_checkin_date) {
    new_streak = 1;
  } else if (streak.last_checkin_date === yesterday) {
    new_streak = (streak.current_streak ?? 0) + 1;
  } else if (streak.last_checkin_date < yesterday && streak.shield_active) {
    // Shield absorbs one missed day
    new_streak = (streak.current_streak ?? 0) + 1;
  } else {
    new_streak = 1;
  }

  const new_longest    = Math.max(new_streak, streak.longest_streak ?? 0);
  const started_at     = new_streak === 1 ? new Date().toISOString() : streak.streak_started_at;
  const shield_consume = streak.shield_active && streak.last_checkin_date < yesterday;

  const streakExists = streak.last_checkin_date !== null;
  if (streakExists) {
    await sbPatch(env, `user_streaks?user_id=eq.${user_id}&site_id=eq.${site_id}`, {
      current_streak:    new_streak,
      longest_streak:    new_longest,
      last_checkin_date: todayDate,
      shield_active:     shield_consume ? false : streak.shield_active,
      streak_started_at: started_at,
      updated_at:        new Date().toISOString(),
    });
  } else {
    await sbPost(env, 'user_streaks', {
      user_id, site_id,
      current_streak: new_streak, longest_streak: new_longest,
      last_checkin_date: todayDate, shield_active: false,
      streak_started_at: new Date().toISOString(),
    });
  }

  await awardXP(env, user_id, site_id, 'daily_checkin');
  if (new_streak > 0 && new_streak % 5 === 0) {
    await awardXP(env, user_id, site_id, 'streak_5_bonus');
  }
}

async function botReadArticle(env, user_id, site_id) {
  const today = new Date().toISOString().slice(0, 10);
  await awardXP(env, user_id, site_id, 'read_article', `live_art_${today}_${user_id.slice(0, 8)}`);
}

async function botPollVote(env, user_id, site_id) {
  // Find the active poll for today
  const today = new Date().toISOString();
  const polls = await sbGet(env,
    `polls?active=eq.true&select=id&order=created_at.desc&limit=1`
  ).catch(() => []);
  if (!polls.length) return;

  const poll_id = polls[0].id;
  const source_ref = `poll_${poll_id}`;

  // Check not already voted
  const voted = await sbGet(env,
    `xp_events?user_id=eq.${user_id}&site_id=eq.${site_id}&action_id=eq.poll_vote&source_ref=eq.${encodeURIComponent(source_ref)}&select=id&limit=1`
  ).catch(() => []);
  if (voted.length) return;

  // Cast a random vote option
  const options = await sbGet(env, `poll_options?poll_id=eq.${poll_id}&select=id&limit=4`).catch(() => []);
  if (!options.length) return;
  const option = options[Math.floor(Math.random() * options.length)];

  // Insert vote
  await sbPost(env, 'poll_votes', {
    poll_id, poll_option_id: option.id, user_id, site_id,
  }).catch(() => {}); // ignore duplicate

  await awardXP(env, user_id, site_id, 'poll_vote', source_ref);
}

async function botPredictScore(env, user_id, site_id, matchId) {
  const source_ref = `match_${matchId}`;
  // Don't predict twice
  const existing = await sbGet(env,
    `xp_events?user_id=eq.${user_id}&site_id=eq.${site_id}&action_id=eq.predict_score&source_ref=eq.${encodeURIComponent(source_ref)}&select=id&limit=1`
  ).catch(() => []);
  if (existing.length) return;

  // Realistic scoreline distribution
  const scorelines = [[2,0],[2,1],[1,0],[3,1],[1,1],[0,0],[1,2],[0,1],[3,0],[2,2]];
  const [hs, as_]  = scorelines[Math.floor(Math.random() * scorelines.length)];

  await sbPost(env, 'score_predictions', {
    user_id, site_id, match_id: matchId,
    home_score: hs, away_score: as_,
    xp_awarded: false, // will be set by evaluate-predictions cron
  }).catch(() => {});

  await awardXP(env, user_id, site_id, 'predict_score', source_ref);
}

// ── Bot selection ─────────────────────────────────────────────────────────────

// Returns bots eligible for checkin today (not yet checked in)
async function getUncheckedInBots(env, site_id, tiers) {
  const today = new Date().toISOString().slice(0, 10);
  const tierFilter = tiers.map(t => `bot_tier.eq.${t}`).join(',');

  // All active bots for these tiers
  const bots = await sbGet(env,
    `profiles?is_bot=eq.true&site_id=eq.${site_id}&or=(${tierFilter})&select=id,bot_activity_rate,bot_tier`
  ).catch(() => []);

  // Bots that already checked in today
  const checked = await sbGet(env,
    `user_streaks?site_id=eq.${site_id}&last_checkin_date=eq.${today}&select=user_id`
  ).catch(() => []);
  const checkedIds = new Set(checked.map(r => r.user_id));

  return bots
    .filter(b => !checkedIds.has(b.id) && Math.random() < b.bot_activity_rate)
    .slice(0, MAX_PER_WINDOW);
}

// Returns bots that read fewer than 3 articles today
async function getReadEligibleBots(env, site_id, tiers) {
  const today = new Date().toISOString().slice(0, 10);
  const tierFilter = tiers.map(t => `bot_tier.eq.${t}`).join(',');

  const bots = await sbGet(env,
    `profiles?is_bot=eq.true&site_id=eq.${site_id}&or=(${tierFilter})&select=id,bot_activity_rate,bot_tier`
  ).catch(() => []);

  // Only active bots that pass activity rate roll
  return bots
    .filter(b => Math.random() < b.bot_activity_rate * 0.7)
    .slice(0, MAX_PER_WINDOW);
}

// Checks if today is a likely match day (Tue and Sat during season, heuristic)
function isMatchDay() {
  const dow = new Date().getDay(); // 0=Sun, 2=Tue, 6=Sat
  return dow === 2 || dow === 6;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function onRequest({ request, env, ctx }) {
  if (request.method !== 'POST') return err('Method not allowed', 405);
  if (request.headers.get('X-Internal-Secret') !== env.XP_TOKEN_SECRET)
    return err('Forbidden', 403);

  const body   = await request.json().catch(() => ({}));
  const window = body.window ?? 'morning';

  const sites = await sbGet(env, `sites?domain=eq.kartalix.com&select=id&limit=1`);
  const site_id = sites[0]?.id;
  if (!site_id) return err('Site not found', 404);

  // Return immediately, run tick in background within CF's extended wall-clock window
  ctx.waitUntil(runWindow(env, site_id, window));
  return json({ status: 'started', window });
}

async function runWindow(env, site_id, window) {
  try {
    if (window === 'morning') {
      // ~40% of daily active bots check in early
      const bots = await getUncheckedInBots(env, site_id, ['power', 'regular']);
      await runChunks(bots, b => botCheckin(env, b.id, site_id));
    }

    else if (window === 'afternoon') {
      // Remaining power/regular check in + all tiers read articles
      const checkins = await getUncheckedInBots(env, site_id, ['power', 'regular', 'casual']);
      await runChunks(checkins, b => botCheckin(env, b.id, site_id));

      const readers = await getReadEligibleBots(env, site_id, ['power', 'regular']);
      await runChunks(readers, b => botReadArticle(env, b.id, site_id));
    }

    else if (window === 'evening') {
      // Remaining checkins for all tiers
      const checkins = await getUncheckedInBots(env, site_id, ['power', 'regular', 'casual']);
      await runChunks(checkins, b => botCheckin(env, b.id, site_id));

      // Poll votes
      const voters = await getReadEligibleBots(env, site_id, ['power', 'regular']);
      await runChunks(voters, b => botPollVote(env, b.id, site_id));

      // Score predictions on match days — fetch the upcoming match ID
      if (isMatchDay()) {
        const upcomingRes = await fetch('https://kartalix.com/api/upcoming-match').catch(() => null);
        if (upcomingRes?.ok) {
          const data = await upcomingRes.json().catch(() => null);
          const matchId = data?.match?.match_id;
          const kickoff = data?.match?.kickoff_utc;
          // Only predict if match is >1h away (bots don't predict last-minute)
          if (matchId && kickoff && new Date(kickoff).getTime() - Date.now() > 3600000) {
            const predictors = await getReadEligibleBots(env, site_id, ['power', 'regular']);
            await runChunks(predictors, b => botPredictScore(env, b.id, site_id, matchId));
          }
        }
      }
    }

    else if (window === 'night') {
      // Final checkins for any bots that haven't yet (including casual)
      const checkins = await getUncheckedInBots(env, site_id, ['power', 'regular', 'casual']);
      await runChunks(checkins, b => botCheckin(env, b.id, site_id));

      // Late article reads
      const readers = await getReadEligibleBots(env, site_id, ['power', 'regular', 'casual']);
      await runChunks(readers, b => botReadArticle(env, b.id, site_id));
    }
  } catch (_) {
    // Tick errors are silent — don't crash the response
  }
}
