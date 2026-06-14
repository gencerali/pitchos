// Awards XP for watching 30 continuous seconds of a YouTube video.
// Same signed-token pattern as article-read.

import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { awardXP } from '../_shared/xp.js';

async function verifyToken(env, token, user_id, video_id) {
  let payload;
  try {
    payload = JSON.parse(atob(token));
  } catch {
    return false;
  }

  if (Date.now() - payload.ts > 5 * 60 * 1000) return false;
  if (payload.uid !== user_id || payload.vid !== video_id) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.XP_TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const msgData = encoder.encode(`${payload.uid}:${payload.vid}:${payload.ts}`);
  const sigBytes = Uint8Array.from(atob(payload.sig), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, msgData);
  if (!valid) return false;

  const dedupKey = `xp:video:${payload.sig.slice(0, 16)}`;
  const seen = await env.PITCHOS_CACHE.get(dedupKey);
  if (seen) return false;
  await env.PITCHOS_CACHE.put(dedupKey, '1', { expirationTtl: 600 });

  return true;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const user = await getUser(request, env);
  if (!user) return err('Unauthorized', 401);

  const body = await request.json().catch(() => null);
  if (!body?.token || !body?.video_id) return err('Missing token or video_id');

  const valid = await verifyToken(env, body.token, user.id, body.video_id);
  if (!valid) return json({ xp_earned: 0, reason: 'invalid_token' });

  const result = await awardXP(env, user.id, 'watch_video_30s', body.video_id);
  return json(result);
}
