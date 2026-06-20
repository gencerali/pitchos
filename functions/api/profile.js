import { getUser, json, err, corsHeaders } from './_shared/auth.js';
import { getSiteId } from './_shared/site.js';
import { sbPatch } from './_shared/xp.js';

const ALLOWED_FIELDS = ['sound_enabled', 'leaderboard_visible', 'push_notifications_enabled'];

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'PATCH') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return err('Invalid body', 400);

  const patch = {};
  for (const key of ALLOWED_FIELDS) {
    if (key in body && typeof body[key] === 'boolean') patch[key] = body[key];
  }
  if (!Object.keys(patch).length) return err('No valid fields to update', 400);

  await sbPatch(env, `profiles?id=eq.${user.id}&site_id=eq.${site_id}`, patch);
  return json({ ok: true });
}
