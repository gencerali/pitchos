// Returns aggregate prediction stats for a match — used in the community section.
// Public endpoint: shows counts without revealing individual users.

import { json, err, corsHeaders } from './_shared/auth.js';
import { getSiteId } from './_shared/site.js';
import { sbGet } from './_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const site_id = await getSiteId(request, env);
  if (!site_id) return err('Site not found', 404);

  const url = new URL(request.url);
  const match_id = url.searchParams.get('match_id');
  if (!match_id) return err('Missing match_id');

  const predictions = await sbGet(
    env,
    `score_predictions?match_id=eq.${match_id}&site_id=eq.${site_id}&select=home_score,away_score`
  );

  if (!predictions.length) return json({ match_id, total: 0, popular_score: null, distribution: [] });

  const countMap = {};
  for (const p of predictions) {
    const key = `${p.home_score}-${p.away_score}`;
    countMap[key] = (countMap[key] || 0) + 1;
  }

  const distribution = Object.entries(countMap)
    .map(([score, count]) => {
      const [h, a] = score.split('-').map(Number);
      return { home_score: h, away_score: a, count };
    })
    .sort((a, b) => b.count - a.count);

  const popular = distribution[0];
  const popular_score = popular
    ? `${popular.home_score}-${popular.away_score}`
    : null;

  return json({
    match_id,
    total: predictions.length,
    popular_score,
    distribution: distribution.slice(0, 10),
  });
}
