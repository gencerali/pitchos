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
  const { poll_id, option_id } = body ?? {};
  if (!poll_id) return err('Missing poll_id');
  if (!option_id) return err('Missing option_id');

  // Verify poll exists, belongs to this site, and is still active
  const polls = await sbGet(
    env,
    `polls?id=eq.${poll_id}&site_id=eq.${site_id}&active=eq.true&select=id,options&limit=1`
  );
  if (!polls.length) return err('Poll not found or inactive', 404);

  const poll = polls[0];
  const validOption = (poll.options ?? []).find(o => o.id === option_id);
  if (!validOption) return err('Invalid option_id', 400);

  // One vote per user per poll per site
  const existing = await sbGet(
    env,
    `poll_votes?poll_id=eq.${poll_id}&user_id=eq.${user.id}&site_id=eq.${site_id}&select=option_id&limit=1`
  );
  if (existing.length) return err('Bu ankete zaten oy verdiniz', 409);

  await sbPost(env, 'poll_votes', { poll_id, user_id: user.id, site_id, option_id });

  const result = await awardXP(env, user.id, site_id, 'poll_vote', poll_id);
  const bonus  = await awardXP(env, user.id, site_id, 'first_poll_vote');

  // Return updated distribution so the UI can render results immediately
  const allVotes = await sbGet(
    env,
    `poll_votes?poll_id=eq.${poll_id}&site_id=eq.${site_id}&select=option_id`
  );
  const countByOption = {};
  for (const v of allVotes) {
    countByOption[v.option_id] = (countByOption[v.option_id] || 0) + 1;
  }
  const poll_results = (poll.options ?? []).map(o => ({
    ...o,
    vote_count: countByOption[o.id] ?? 0,
  }));

  return json({
    ...result,
    vote_saved: true,
    option_id,
    bonus_xp: bonus.xp_earned,
    total_xp: bonus.total_xp ?? result.total_xp,
    level: bonus.level ?? result.level,
    tier_name: bonus.tier_name ?? result.tier_name,
    badge_unlocks: [...(result.badge_unlocks ?? []), ...(bonus.badge_unlocks ?? [])],
    poll_results,
  });
}
