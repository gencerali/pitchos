// GET /api/xp/video-token?video_id=X
// Server-side HMAC signing for video watch XP — keeps XP_TOKEN_SECRET off the client.

import { getUser, json, err, corsHeaders } from '../_shared/auth.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const user = await getUser(request, env);
  if (!user) return err('Unauthorized', 401);

  const video_id = new URL(request.url).searchParams.get('video_id');
  if (!video_id) return err('Missing video_id');

  const secret = env.XP_TOKEN_SECRET || 'dev-secret';
  const ts  = Date.now();
  const msg = `${user.id}:${video_id}:${ts}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(msg));
  const sig    = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  return json({ token: btoa(JSON.stringify({ uid: user.id, vid: video_id, ts, sig })) });
}
