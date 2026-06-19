import { getUser, json, err, corsHeaders } from './_shared/auth.js';
import { getSiteId } from './_shared/site.js';
import { sbGet } from './_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const url    = new URL(request.url);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const limit  = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') ?? '20', 10) || 20));

  const events = await sbGet(env,
    `xp_events?user_id=eq.${user.id}&site_id=eq.${site_id}&nullified=eq.false` +
    `&select=action_id,xp_earned,created_at,source_ref&order=created_at.desc` +
    `&limit=${limit}&offset=${offset}`
  ).catch(() => []);

  return json({ events, offset, limit, has_more: events.length === limit });
}
