// GET /api/xp/article-token?article_id=X
// Returns a short-lived HMAC-signed token the client posts back to /api/xp/article-read
// after 30s dwell. Signing happens server-side so XP_TOKEN_SECRET never reaches the browser.

import { getUser, json, err, corsHeaders } from '../_shared/auth.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const user = await getUser(request, env);
  if (!user) return err('Unauthorized', 401);

  const article_id = new URL(request.url).searchParams.get('article_id');
  if (!article_id) return err('Missing article_id');

  const secret = env.XP_TOKEN_SECRET || 'dev-secret';
  const ts  = Date.now();
  const msg = `${user.id}:${article_id}:${ts}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(msg));
  const sig    = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  return json({ token: btoa(JSON.stringify({ uid: user.id, aid: article_id, ts, sig })) });
}
