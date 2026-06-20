// POST /api/league/settle — weekly settlement + new group formation
// Called by the Monday 03:00 UTC cron trigger (wrangler.toml: "0 3 * * 1")
// Also handles initial formation when no groups exist for the current week.
//
// Flow per site:
//   1. Settle all unsettled groups from prev week (rank, award XP, promote/relegate)
//   2. Form new groups for current week (reshuffle per tier, groups of 30)
//   3. Award Monday tier bonuses (Altın+25, Platin+50, Elmas+100)
//
// Authorization: requires SETTLE_SECRET header matching env.SETTLE_SECRET

import { json, err, corsHeaders } from '../_shared/auth.js';
import { sbGet, sbPost, sbPatch } from '../_shared/xp.js';

const GROUP_SIZE     = 30;
const PROMO_COUNT    = 3;
const RELEGATE_COUNT = 3;

const TIER_ORDER = ['bronz', 'gümüş', 'altın', 'platin', 'elmas'];
const TIER_ABOVE = { 'bronz': 'gümüş', 'gümüş': 'altın', 'altın': 'platin', 'platin': 'elmas', 'elmas': null };
const TIER_BELOW = { 'elmas': 'platin', 'platin': 'altın', 'altın': 'gümüş', 'gümüş': 'bronz', 'bronz': null };

const MONDAY_BONUS = { 'altın': 25, 'platin': 50, 'elmas': 100 };
const AWARD_XP     = { 1: 200, 2: 100, 3: 50 };

function mondayOf(date = new Date()) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const daysBack = day === 0 ? 6 : day - 1;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysBack));
}

function prevMonday(date = new Date()) {
  const m = mondayOf(date);
  return new Date(m.getTime() - 7 * 24 * 3600 * 1000);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function getAllSites(env) {
  return sbGet(env, 'sites?select=id').catch(() => []);
}

async function settlePrevWeek(env, site_id, prevWeekStr, prevWeekISO, curWeekISO) {
  const groups = await sbGet(env,
    `league_groups?site_id=eq.${site_id}&week_start=eq.${prevWeekStr}&settled=eq.false&select=id,tier,group_number`
  ).catch(() => []);

  for (const group of groups) {
    const members = await sbGet(env,
      `league_group_members?group_id=eq.${group.id}&select=id,user_id`
    ).catch(() => []);
    if (!members.length) continue;

    const idList = members.map(m => m.user_id).join(',');
    const xpRows = await sbGet(env,
      `xp_events?user_id=in.(${idList})&site_id=eq.${site_id}&created_at=gte.${encodeURIComponent(prevWeekISO)}&created_at=lt.${encodeURIComponent(curWeekISO)}&nullified=eq.false&select=user_id,xp_earned&limit=50000`
    ).catch(() => []);

    const xpMap = {};
    for (const r of xpRows) xpMap[r.user_id] = (xpMap[r.user_id] ?? 0) + r.xp_earned;

    const ranked = members
      .map(m => ({ ...m, weekly_xp: xpMap[m.user_id] ?? 0 }))
      .sort((a, b) => b.weekly_xp - a.weekly_xp);

    ranked.forEach((m, i) => { m.rank = i + 1; });

    const tier = group.tier;
    const promoteTarget = TIER_ABOVE[tier];
    const relegateTarget = TIER_BELOW[tier];

    const promotions  = [];
    const relegations = [];

    for (const m of ranked) {
      // Update member row with final rank + weekly_xp
      await sbPatch(env,
        `league_group_members?id=eq.${m.id}`,
        { weekly_xp: m.weekly_xp, rank: m.rank }
      ).catch(() => {});

      // Award XP for top 3
      if (m.rank <= 3 && AWARD_XP[m.rank]) {
        await sbPost(env, 'xp_events', {
          user_id: m.user_id, site_id, action_id: 'league_award',
          xp_earned: AWARD_XP[m.rank], base_xp: AWARD_XP[m.rank],
          multiplier: 1.00, source_ref: `${prevWeekStr}_rank${m.rank}`, nullified: false,
        }).catch(() => {});
      }

      // Badge for #1
      if (m.rank === 1) {
        const existing = await sbGet(env,
          `user_badges?user_id=eq.${m.user_id}&site_id=eq.${site_id}&badge_id=eq.league_champion&select=id&limit=1`
        ).catch(() => []);
        if (!existing.length) {
          await sbPost(env, 'user_badges', { user_id: m.user_id, site_id, badge_id: 'league_champion' }).catch(() => {});
        }
      }

      // Promo / relegate
      if (m.rank <= PROMO_COUNT && promoteTarget) promotions.push(m.user_id);
      if (m.rank > ranked.length - RELEGATE_COUNT && relegateTarget) relegations.push(m.user_id);
    }

    // Update profiles.current_league
    for (const uid of promotions) {
      await sbPatch(env, `profiles?id=eq.${uid}&site_id=eq.${site_id}`, { current_league: promoteTarget }).catch(() => {});
    }
    for (const uid of relegations) {
      await sbPatch(env, `profiles?id=eq.${uid}&site_id=eq.${site_id}`, { current_league: relegateTarget }).catch(() => {});
    }

    // Mark group settled
    await sbPatch(env, `league_groups?id=eq.${group.id}`, { settled: true }).catch(() => {});
  }
}

async function formNewWeek(env, site_id, weekStr) {
  // Check if groups already exist for this week
  const existing = await sbGet(env,
    `league_groups?site_id=eq.${site_id}&week_start=eq.${weekStr}&select=id&limit=1`
  ).catch(() => []);
  if (existing.length) return { skipped: true };

  // Load all users grouped by current_league
  const profiles = await sbGet(env,
    `profiles?site_id=eq.${site_id}&select=id,current_league&leaderboard_visible=eq.true`
  ).catch(() => []);

  const byTier = {};
  for (const tier of TIER_ORDER) byTier[tier] = [];
  for (const p of profiles) {
    const t = p.current_league ?? 'bronz';
    if (byTier[t]) byTier[t].push(p.id);
  }

  const groupsCreated = { total: 0 };

  for (const tier of TIER_ORDER) {
    const users = shuffle(byTier[tier]);
    if (!users.length) continue;

    const chunks = [];
    for (let i = 0; i < users.length; i += GROUP_SIZE) chunks.push(users.slice(i, i + GROUP_SIZE));

    for (let gi = 0; gi < chunks.length; gi++) {
      const groupRow = await sbPost(env, 'league_groups', {
        site_id, tier, week_start: weekStr, group_number: gi + 1, settled: false,
      }).catch(() => null);
      if (!groupRow?.[0]?.id) continue;

      const group_id = groupRow[0].id;
      const members  = chunks[gi].map(uid => ({
        group_id, user_id: uid, site_id, week_start: weekStr, weekly_xp: 0,
      }));

      // Insert in batches of 100 to avoid URL length issues
      for (let bi = 0; bi < members.length; bi += 100) {
        await sbPost(env, 'league_group_members', members.slice(bi, bi + 100)).catch(() => {});
      }
      groupsCreated.total++;
    }
  }

  return groupsCreated;
}

async function awardMondayBonuses(env, site_id) {
  for (const [tier, bonusXp] of Object.entries(MONDAY_BONUS)) {
    if (!bonusXp) continue;
    const users = await sbGet(env,
      `profiles?site_id=eq.${site_id}&current_league=eq.${encodeURIComponent(tier)}&select=id`
    ).catch(() => []);

    for (const u of users) {
      await sbPost(env, 'xp_events', {
        user_id: u.id, site_id, action_id: 'league_tier_bonus',
        xp_earned: bonusXp, base_xp: bonusXp, multiplier: 1.00,
        source_ref: `${new Date().toISOString().split('T')[0]}_tier_bonus`, nullified: false,
      }).catch(() => {});
    }
  }
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  // Simple secret-based auth (shared by cron trigger and manual calls)
  const secret = request.headers.get('X-Settle-Secret');
  if (!secret || secret !== env.SETTLE_SECRET) return err('Unauthorized', 401);

  const now      = new Date();
  const curWeek  = mondayOf(now);
  const prevWeek = prevMonday(now);

  const curWeekStr  = curWeek.toISOString().split('T')[0];
  const prevWeekStr = prevWeek.toISOString().split('T')[0];
  const curWeekISO  = curWeek.toISOString();
  const prevWeekISO = prevWeek.toISOString();

  const sites = await getAllSites(env);
  const results = [];

  for (const site of sites) {
    const sid = site.id;

    await settlePrevWeek(env, sid, prevWeekStr, prevWeekISO, curWeekISO);
    const formation = await formNewWeek(env, sid, curWeekStr);
    await awardMondayBonuses(env, sid);

    results.push({ site_id: sid, week: curWeekStr, formation });
  }

  return json({ ok: true, processed: results });
}
