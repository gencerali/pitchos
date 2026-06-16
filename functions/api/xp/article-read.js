import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { getSiteId } from '../_shared/site.js';
import { awardXP } from '../_shared/xp.js';

async function verifyToken(env, token, user_id, article_id) {
  let payload;
  try { payload = JSON.parse(atob(token)); } catch { return false; }
  if (Date.now() - payload.ts > 5 * 60 * 1000) return false;
  if (payload.uid !== user_id || payload.aid !== article_id) return false;
  if (!payload.sig) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.XP_TOKEN_SECRET || 'dev-secret'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  return crypto.subtle.verify(
    'HMAC', key,
    Uint8Array.from(atob(payload.sig), c => c.charCodeAt(0)),
    encoder.encode(`${payload.uid}:${payload.aid}:${payload.ts}`)
  );
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const body = await request.json().catch(() => null);
  if (!body?.token || !body?.article_id) return err('Missing token or article_id');

  if (!await verifyToken(env, body.token, user.id, body.article_id)) {
    return json({ xp_earned: 0, reason: 'invalid_token' });
  }

  const result = await awardXP(env, user.id, site_id, 'read_article', body.article_id);
  return json(result);
}
