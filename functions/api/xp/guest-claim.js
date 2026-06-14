import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { getSiteId } from '../_shared/site.js';
import { sbGet, sbPost } from '../_shared/xp.js';

const GUEST_XP_CAP = 50;

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const body = await request.json().catch(() => null);
  const claimed_xp = Math.min(parseInt(body?.guest_xp ?? 0, 10), GUEST_XP_CAP);
  if (claimed_xp <= 0) return json({ xp_transferred: 0 });

  const existing = await sbGet(
    env,
    `xp_events?user_id=eq.${user.id}&site_id=eq.${site_id}&action_id=eq.guest_claim&select=id&limit=1`
  );
  if (existing.length) return json({ xp_transferred: 0, reason: 'already_claimed' });

  await sbPost(env, 'xp_events', {
    user_id: user.id,
    site_id,
    action_id: 'guest_claim',
    xp_earned: claimed_xp,
    base_xp: claimed_xp,
    multiplier: 1.00,
    source_ref: null,
    nullified: false,
  });

  return json({ xp_transferred: claimed_xp });
}
