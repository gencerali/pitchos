// Returns active polls for this site with current vote distributions.
// Optionally checks whether the authenticated user has already voted.

import { getUser, json, err, corsHeaders } from './_shared/auth.js';
import { getSiteId } from './_shared/site.js';
import { sbGet } from './_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const site_id = await getSiteId(request, env);
  if (!site_id) return err('Site not found', 404);

  const user = await getUser(request, env);

  const now = new Date().toISOString();
  const polls = await sbGet(
    env,
    `polls?site_id=eq.${site_id}&active=eq.true&and=(or(starts_at.is.null,starts_at.lte.${now}),or(expires_at.is.null,expires_at.gte.${now}))&order=created_at.desc&limit=5&select=*`
  );

  if (!polls.length) return json({ polls: [] });

  const enriched = await Promise.all(polls.map(async (poll) => {
    const votes = await sbGet(
      env,
      `poll_votes?poll_id=eq.${poll.id}&site_id=eq.${site_id}&select=option_id`
    );

    const countByOption = {};
    for (const v of votes) {
      countByOption[v.option_id] = (countByOption[v.option_id] || 0) + 1;
    }

    const options = (poll.options ?? []).map(opt => ({
      ...opt,
      vote_count: countByOption[opt.id] ?? 0,
    }));

    let user_vote = null;
    if (user) {
      const myVote = await sbGet(
        env,
        `poll_votes?poll_id=eq.${poll.id}&user_id=eq.${user.id}&site_id=eq.${site_id}&select=option_id&limit=1`
      );
      user_vote = myVote[0]?.option_id ?? null;
    }

    return {
      id: poll.id,
      question: poll.question,
      options,
      total_votes: votes.length,
      user_vote,
    };
  }));

  return json({ polls: enriched });
}
