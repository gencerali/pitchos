// GET /api/leaderboard/:type?user_id=UUID
// type: alltime | monthly | weekly | seasonal | streak
// All boards are scoped to the requesting site's site_id.

import { json, err, corsHeaders } from '../_shared/auth.js';
import { getSiteId } from '../_shared/site.js';
import { sbGet } from '../_shared/xp.js';

const VIEW_MAP = {
  alltime:  { view: 'leaderboard_alltime',  order: 'total_xp.desc'    },
  monthly:  { view: 'leaderboard_monthly',  order: 'monthly_xp.desc'  },
  weekly:   { view: 'leaderboard_weekly',   order: 'weekly_xp.desc'   },
  seasonal: { view: 'leaderboard_seasonal', order: 'seasonal_xp.desc' },
  streak:   { view: 'leaderboard_streak',   order: 'current_streak.desc,longest_streak.desc' },
};

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const type = params.type;
  if (!VIEW_MAP[type]) return err('Invalid leaderboard type', 404);

  const site_id = await getSiteId(request, env);
  if (!site_id) return err('Site not found', 404);

  const { view, order } = VIEW_MAP[type];
  const url = new URL(request.url);
  const requesting_user_id = url.searchParams.get('user_id');

  // Top 100 for this site
  const rows = await sbGet(
    env,
    `${view}?site_id=eq.${site_id}&order=${order}&limit=100`
  );
  const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));

  // Requesting user's rank (may be outside top 100)
  let user_rank = null;
  if (requesting_user_id) {
    const inTop = ranked.find(r => r.user_id === requesting_user_id);
    if (inTop) {
      user_rank = inTop;
    } else {
      const all = await sbGet(env, `${view}?site_id=eq.${site_id}&order=${order}`);
      const idx = all.findIndex(r => r.user_id === requesting_user_id);
      if (idx !== -1) user_rank = { rank: idx + 1, ...all[idx] };
    }
  }

  return json({ type, site_id, rows: ranked, user_rank });
}
