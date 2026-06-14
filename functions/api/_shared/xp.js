// Core XP award engine. Called by every XP endpoint.
// Uses service role key — bypasses RLS for privileged writes.

const SUPABASE_HEADERS = (env) => ({
  'Content-Type': 'application/json',
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  Prefer: 'return=representation',
});

// ── Supabase REST helper ──────────────────────────────────────

export async function sbGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: SUPABASE_HEADERS(env),
  });
  if (!res.ok) throw new Error(`Supabase GET ${path}: ${res.status}`);
  return res.json();
}

export async function sbPost(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: SUPABASE_HEADERS(env),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase POST ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

export async function sbPatch(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...SUPABASE_HEADERS(env), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path}: ${res.status}`);
}

export async function sbRpc(env, fn, params) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: SUPABASE_HEADERS(env),
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Supabase RPC ${fn}: ${res.status}`);
  return res.json();
}

// ── Daily cap check ───────────────────────────────────────────

// Returns how many times the user performed action_id in the last 24 hours.
export async function getDailyCount(env, user_id, action_id) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await sbGet(
    env,
    `xp_events?user_id=eq.${user_id}&action_id=eq.${action_id}&created_at=gte.${since}&nullified=eq.false&select=id`
  );
  return rows.length;
}

// Returns true if the user has ever earned this action_id (for one-time bonuses).
export async function hasLifetimeEvent(env, user_id, action_id) {
  const rows = await sbGet(
    env,
    `xp_events?user_id=eq.${user_id}&action_id=eq.${action_id}&nullified=eq.false&select=id&limit=1`
  );
  return rows.length > 0;
}

// ── Streak / multiplier ───────────────────────────────────────

export async function getStreak(env, user_id) {
  const rows = await sbGet(env, `user_streaks?user_id=eq.${user_id}&select=*&limit=1`);
  return rows[0] ?? { current_streak: 0, longest_streak: 0, shield_active: false, last_checkin_date: null };
}

export function streakMultiplier(streak_days) {
  if (streak_days >= 10) return 1.50;
  if (streak_days >= 5) return 1.20;
  return 1.00;
}

// ── Shadow ban check ──────────────────────────────────────────

export async function isShadowBanned(env, user_id) {
  const rows = await sbGet(env, `profiles?id=eq.${user_id}&select=shadow_banned&limit=1`);
  return rows[0]?.shadow_banned === true;
}

// ── Core award function ───────────────────────────────────────

/**
 * Awards XP to a user.
 *
 * @param {object} env          - Cloudflare env bindings
 * @param {string} user_id      - Supabase auth user ID
 * @param {string} action_id    - xp_actions.id
 * @param {string} [source_ref] - optional content ID for dedup
 * @returns {{ xp_earned, total_xp, level, tier_name, badge_unlocks, capped }}
 */
export async function awardXP(env, user_id, action_id, source_ref = null) {
  // 1. Load action config
  const actions = await sbGet(env, `xp_actions?id=eq.${action_id}&active=eq.true&select=*&limit=1`);
  if (!actions.length) return { xp_earned: 0, capped: false, reason: 'unknown_action' };
  const action = actions[0];

  // 2. Shadow ban — silently nullify
  const banned = await isShadowBanned(env, user_id);

  // 3. Daily cap check
  if (action.daily_cap === -1) {
    // One-time lifetime action
    const alreadyDone = await hasLifetimeEvent(env, user_id, action_id);
    if (alreadyDone) return { xp_earned: 0, capped: true, reason: 'already_earned' };
  } else if (action.daily_cap > 0) {
    // Dedup by source_ref within the same action (same article can't award twice)
    if (source_ref) {
      const dupes = await sbGet(
        env,
        `xp_events?user_id=eq.${user_id}&action_id=eq.${action_id}&source_ref=eq.${encodeURIComponent(source_ref)}&select=id&limit=1`
      );
      if (dupes.length) return { xp_earned: 0, capped: true, reason: 'already_earned_source' };
    }
    const count = await getDailyCount(env, user_id, action_id);
    if (count >= action.daily_cap) return { xp_earned: 0, capped: true, reason: 'daily_cap' };
  }

  // 4. Calculate multiplier
  const streak = await getStreak(env, user_id);
  const multiplier = action.streak_bonus_eligible ? streakMultiplier(streak.current_streak) : 1.00;
  const xp_earned = banned ? 0 : Math.floor(action.xp_per_action * multiplier);

  // 5. Insert XP event
  await sbPost(env, 'xp_events', {
    user_id,
    action_id,
    xp_earned,
    base_xp: action.xp_per_action,
    multiplier,
    source_ref: source_ref ?? null,
    nullified: banned,
  });

  if (banned) return { xp_earned: 0, capped: false };

  // 6. Compute new total XP and level
  const allXp = await sbGet(
    env,
    `xp_events?user_id=eq.${user_id}&nullified=eq.false&select=xp_earned`
  );
  const total_xp = allXp.reduce((s, r) => s + r.xp_earned, 0);

  const levelInfo = await sbRpc(env, 'get_user_level', { total_xp });
  const { level, tier_name, tier_number, xp_to_next } = levelInfo[0] ?? { level: 1, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 50 };

  // 7. Check for tier-boundary badge unlocks
  const badge_unlocks = await checkBadges(env, user_id, { level, tier_number, streak });

  return { xp_earned, total_xp, level, tier_name, xp_to_next, badge_unlocks, capped: false };
}

// ── Badge check ───────────────────────────────────────────────

async function checkBadges(env, user_id, { level, tier_number, streak }) {
  const unlocked = [];

  const tierBadges = [
    { badge_id: 'tier_taraftar',      min_level: 4  },
    { badge_id: 'tier_kapali_tribun', min_level: 7  },
    { badge_id: 'tier_carsi_ruhu',    min_level: 10 },
    { badge_id: 'tier_efsane',        min_level: 13 },
  ];

  const streakBadges = [
    { badge_id: 'streak_shield',  min_streak: 15 },
    { badge_id: 'streak_gold',    min_streak: 20 },
    { badge_id: 'streak_sadakat', min_streak: 30 },
  ];

  const candidates = [
    ...tierBadges.filter(b => level >= b.min_level),
    ...streakBadges.filter(b => streak.current_streak >= b.min_streak),
  ];

  for (const { badge_id } of candidates) {
    const existing = await sbGet(
      env,
      `user_badges?user_id=eq.${user_id}&badge_id=eq.${badge_id}&select=id&limit=1`
    );
    if (!existing.length) {
      await sbPost(env, 'user_badges', { user_id, badge_id });
      const badgeInfo = await sbGet(env, `badges?id=eq.${badge_id}&select=*&limit=1`);
      unlocked.push(badgeInfo[0]);
    }
  }

  return unlocked;
}
