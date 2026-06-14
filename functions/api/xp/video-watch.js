import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { getSiteId } from '../_shared/site.js';
import { awardXP } from '../_shared/xp.js';

async function verifyToken(env, token, user_id, video_id) {
  let payload;
  try { payload = JSON.parse(atob(token)); } catch { return false; }
  if (Date.now() - payload.ts > 5 * 60 * 1000) return false;
  if (payload.uid !== user_id || payload.vid !== video_id) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.XP_TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key,
    Uint8Array.from(atob(payload.sig), c => c.charCodeAt(0)),
    encoder.encode(`${payload.uid}:${payload.vid}:${payload.ts}`)
  );
  if (!valid) return false;

  const dedupKey = `xp:video:${payload.sig.slice(0, 16)}`;
  if (await env.PITCHOS_CACHE.get(dedupKey)) return false;
  await env.PITCHOS_CACHE.put(dedupKey, '1', { expirationTtl: 600 });
  return true;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const body = await request.json().catch(() => null);
  if (!body?.token || !body?.video_id) return err('Missing token or video_id');

  if (!await verifyToken(env, body.token, user.id, body.video_id)) {
    return json({ xp_earned: 0, reason: 'invalid_token' });
  }

  const result = await awardXP(env, user.id, site_id, 'watch_video_30s', body.video_id);
  return json(result);
}
