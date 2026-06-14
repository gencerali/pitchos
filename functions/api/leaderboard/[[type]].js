// GET /api/leaderboard/:type
// type: alltime | monthly | weekly | seasonal | streak
// Returns top 100 users for the requested board.
// Also accepts ?user_id= to inject the requesting user's rank even if outside top 100.

import { json, err, corsHeaders } from '../_shared/auth.js';
import { sbGet } from '../_shared/xp.js';

const VALID_TYPES = ['alltime', 'monthly', 'weekly', 'seasonal', 'streak'];

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
  if (!VALID_TYPES.includes(type)) return err('Invalid leaderboard type', 404);

  const { view, order } = VIEW_MAP[type];
  const url = new URL(request.url);
  const requesting_user_id = url.searchParams.get('user_id');

  // Fetch top 100
  const rows = await sbGet(env, `${view}?order=${order}&limit=100`);
  const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));

  // Inject requesting user's rank if outside top 100
  let user_rank = null;
  if (requesting_user_id) {
    const inTop = ranked.find(r => r.user_id === requesting_user_id);
    if (inTop) {
      user_rank = inTop;
    } else {
      // Get all rows to compute rank (expensive but acceptable for now)
      const allRows = await sbGet(env, `${view}?order=${order}`);
      const idx = allRows.findIndex(r => r.user_id === requesting_user_id);
      if (idx !== -1) user_rank = { rank: idx + 1, ...allRows[idx] };
    }
  }

  return json({ type, rows: ranked, user_rank });
}
