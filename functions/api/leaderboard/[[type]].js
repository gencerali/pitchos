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
  const site_id = await getSiteId(request, env);
  if (!site_id) return err('Site not found', 404);

  const url = new URL(request.url);
  const requesting_user_id = url.searchParams.get('user_id');

  // Prediction accuracy leaderboard — computed from score_predictions
  if (type === 'accuracy') {
    const allPreds = await sbGet(env, `score_predictions?select=user_id,bonus_awarded,outcome_awarded&limit=50000`).catch(() => []);
    const userMap = {};
    for (const p of allPreds) {
      if (!userMap[p.user_id]) userMap[p.user_id] = { total: 0, exact: 0, outcome: 0 };
      userMap[p.user_id].total++;
      if (p.bonus_awarded) userMap[p.user_id].exact++;
      if (p.outcome_awarded) userMap[p.user_id].outcome++;
    }
    const MIN_PREDS = 5;
    const profiles = await sbGet(env, `profiles?site_id=eq.${site_id}&select=id,username,display_name,avatar_url,is_bot&limit=10000`).catch(() => []);
    const profMap = Object.fromEntries(profiles.filter(p => !p.is_bot).map(p => [p.id, p]));
    const rows = Object.entries(userMap)
      .filter(([uid, d]) => d.total >= MIN_PREDS && profMap[uid])
      .map(([uid, d]) => {
        const prof = profMap[uid];
        return {
          user_id: uid,
          username: prof.display_name || prof.username,
          avatar_url: prof.avatar_url || null,
          total_predictions: d.total,
          exact_count: d.exact,
          outcome_count: d.outcome,
          exact_pct: Math.round((d.exact / d.total) * 100),
          outcome_pct: Math.round((d.outcome / d.total) * 100),
        };
      })
      .sort((a, b) => b.exact_pct - a.exact_pct || b.total_predictions - a.total_predictions)
      .slice(0, 100)
      .map((r, i) => ({ rank: i + 1, ...r }));

    let user_rank = null;
    if (requesting_user_id) {
      const inTop = rows.find(r => r.user_id === requesting_user_id);
      if (inTop) {
        user_rank = inTop;
      } else {
        const ud = userMap[requesting_user_id];
        if (ud && ud.total >= MIN_PREDS) {
          const allRows = Object.entries(userMap)
            .filter(([uid, d]) => d.total >= MIN_PREDS && profMap[uid])
            .map(([uid, d]) => ({ user_id: uid, exact_pct: Math.round((d.exact / d.total) * 100), total_predictions: d.total }))
            .sort((a, b) => b.exact_pct - a.exact_pct || b.total_predictions - a.total_predictions);
          const idx = allRows.findIndex(r => r.user_id === requesting_user_id);
          if (idx !== -1) {
            const prof = profMap[requesting_user_id];
            user_rank = {
              rank: idx + 1, user_id: requesting_user_id,
              username: prof?.display_name || prof?.username,
              total_predictions: ud.total, exact_count: ud.exact, outcome_count: ud.outcome,
              exact_pct: Math.round((ud.exact / ud.total) * 100),
              outcome_pct: Math.round((ud.outcome / ud.total) * 100),
            };
          }
        }
      }
    }

    return new Response(JSON.stringify({ type: 'accuracy', site_id, rows, user_rank }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    });
  }

  if (!VIEW_MAP[type]) return err('Invalid leaderboard type', 404);

  const { view, order } = VIEW_MAP[type];

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

  return new Response(JSON.stringify({ type, site_id, rows: ranked, user_rank }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
