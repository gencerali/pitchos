// Core XP award engine. Called by every XP endpoint.
// Uses service role key — bypasses RLS for privileged writes.
// All operations are scoped to site_id — gamification is fully per-site.

const SUPABASE_HEADERS = (env) => ({
  'Content-Type': 'application/json',
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  Prefer: 'return=representation',
});

// ── Supabase REST helpers ─────────────────────────────────────

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

// ── Streak / multiplier ───────────────────────────────────────

export async function getStreak(env, user_id, site_id) {
  const rows = await sbGet(
    env,
    `user_streaks?user_id=eq.${user_id}&site_id=eq.${site_id}&select=*&limit=1`
  );
  return rows[0] ?? {
    current_streak: 0, longest_streak: 0,
    shield_active: false, last_checkin_date: null,
  };
}

export function streakMultiplier(streak_days) {
  if (streak_days >= 10) return 1.50;
  if (streak_days >= 5) return 1.20;
  return 1.00;
}

// ── Shadow ban check ──────────────────────────────────────────

export async function isShadowBanned(env, user_id, site_id) {
  const rows = await sbGet(
    env,
    `profiles?id=eq.${user_id}&site_id=eq.${site_id}&select=shadow_banned&limit=1`
  );
  return rows[0]?.shadow_banned === true;
}

// ── Daily cap helpers ─────────────────────────────────────────

export async function getDailyCount(env, user_id, site_id, action_id) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = await sbGet(
    env,
    `xp_events?user_id=eq.${user_id}&site_id=eq.${site_id}&action_id=eq.${action_id}&created_at=gte.${since}&nullified=eq.false&select=id`
  );
  return rows.length;
}

export async function hasLifetimeEvent(env, user_id, site_id, action_id) {
  const rows = await sbGet(
    env,
    `xp_events?user_id=eq.${user_id}&site_id=eq.${site_id}&action_id=eq.${action_id}&nullified=eq.false&select=id&limit=1`
  );
  return rows.length > 0;
}

// ── Core award function ───────────────────────────────────────

/**
 * Awards XP to a user on a specific site.
 *
 * @param {object} env          - Cloudflare env bindings
 * @param {string} user_id      - Supabase auth user ID
 * @param {string} site_id      - Site UUID (gamification is per-site)
 * @param {string} action_id    - xp_actions.id
 * @param {string} [source_ref] - optional content ID for dedup
 * @returns {{ xp_earned, total_xp, level, tier_name, xp_to_next, badge_unlocks, capped }}
 */
export async function awardXP(env, user_id, site_id, action_id, source_ref = null) {
  // 1. Load action config (xp_actions are global, not per-site)
  const actions = await sbGet(env, `xp_actions?id=eq.${action_id}&active=eq.true&select=*&limit=1`);
  if (!actions.length) return { xp_earned: 0, capped: false, reason: 'unknown_action' };
  const action = actions[0];

  // 2. Shadow ban check — scoped to site
  const banned = await isShadowBanned(env, user_id, site_id);

  // 3. Cap checks
  let fallback_only = false;
  if (action.daily_cap === -1) {
    const alreadyDone = await hasLifetimeEvent(env, user_id, site_id, action_id);
    if (alreadyDone) return { xp_earned: 0, capped: true, reason: 'already_earned' };
  } else if (action.daily_cap > 0) {
    if (source_ref) {
      const dupes = await sbGet(
        env,
        `xp_events?user_id=eq.${user_id}&site_id=eq.${site_id}&action_id=eq.${action_id}&source_ref=eq.${encodeURIComponent(source_ref)}&select=id&limit=1`
      );
      if (dupes.length) return { xp_earned: 0, capped: true, reason: 'already_earned_source' };
    }
    const count = await getDailyCount(env, user_id, site_id, action_id);
    if (count >= action.daily_cap) {
      if (!action.cap_fallback_xp) return { xp_earned: 0, capped: true, reason: 'daily_cap' };
      fallback_only = true;
    }
  }

  // 4. Multiplier from site-scoped streak
  const streak = await getStreak(env, user_id, site_id);
  const multiplier = action.streak_bonus_eligible ? streakMultiplier(streak.current_streak) : 1.00;
  const xp_earned = banned ? 0 : (fallback_only ? action.cap_fallback_xp : Math.floor(action.xp_per_action * multiplier));

  // 5. Insert XP event with site_id
  await sbPost(env, 'xp_events', {
    user_id,
    site_id,
    action_id,
    xp_earned,
    base_xp: action.xp_per_action,
    multiplier,
    source_ref: source_ref ?? null,
    nullified: banned,
  });

  if (banned) return { xp_earned: 0, capped: false };

  // 6. Total XP scoped to this site
  const allXp = await sbGet(
    env,
    `xp_events?user_id=eq.${user_id}&site_id=eq.${site_id}&nullified=eq.false&select=xp_earned`
  );
  const total_xp = allXp.reduce((s, r) => s + r.xp_earned, 0);

  const levelInfo = await sbRpc(env, 'get_user_level', { total_xp });
  const { level, tier_name, tier_number, xp_to_next } = levelInfo[0] ?? {
    level: 1, tier_name: 'Misafir Kartal', tier_number: 1, xp_to_next: 50,
  };

  // 7. Badge checks scoped to site
  const badge_unlocks = await checkBadges(env, user_id, site_id, { level, tier_number, streak, action_id });

  return { xp_earned, total_xp, level, tier_name, xp_to_next, badge_unlocks, capped: false };
}

// ── Badge unlock check ────────────────────────────────────────

async function checkBadges(env, user_id, site_id, { level, streak, action_id }) {
  const unlocked = [];

  const candidates = [
    ...([
      { badge_id: 'tier_taraftar',      min_level: 4  },
      { badge_id: 'tier_kapali_tribun', min_level: 7  },
      { badge_id: 'tier_carsi_ruhu',    min_level: 10 },
      { badge_id: 'tier_efsane',        min_level: 13 },
    ].filter(b => level >= b.min_level)),
    ...([
      { badge_id: 'streak_shield',  min_streak: 15 },
      { badge_id: 'streak_gold',    min_streak: 20 },
      { badge_id: 'streak_sadakat', min_streak: 30 },
    ].filter(b => streak.current_streak >= b.min_streak)),
  ];

  if (action_id === 'read_article') {
    const reads = await sbGet(
      env,
      `xp_events?user_id=eq.${user_id}&site_id=eq.${site_id}&action_id=eq.read_article&nullified=eq.false&select=id&limit=101`
    );
    if (reads.length >= 100) candidates.push({ badge_id: 'articles_100' });
  }

  for (const { badge_id } of candidates) {
    const existing = await sbGet(
      env,
      `user_badges?user_id=eq.${user_id}&site_id=eq.${site_id}&badge_id=eq.${badge_id}&select=id&limit=1`
    );
    if (!existing.length) {
      await sbPost(env, 'user_badges', { user_id, site_id, badge_id });
      const badgeInfo = await sbGet(env, `badges?id=eq.${badge_id}&select=*&limit=1`);
      unlocked.push(badgeInfo[0]);
    }
  }

  return unlocked;
}
