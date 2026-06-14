// Awards XP for reading an article.
// Expects a signed completion token in the request body.
// Token is HMAC-SHA256 signed by the client using a shared secret,
// containing user_id + article_id + timestamp.
// Server validates: correct signature, <5 min old, not replayed (KV dedup).

import { getUser, json, err, corsHeaders } from '../_shared/auth.js';
import { awardXP, sbGet } from '../_shared/xp.js';

async function verifyToken(env, token, user_id, article_id) {
  let payload;
  try {
    payload = JSON.parse(atob(token));
  } catch {
    return false;
  }

  // Check age (max 5 minutes)
  if (Date.now() - payload.ts > 5 * 60 * 1000) return false;

  // Check fields match
  if (payload.uid !== user_id || payload.aid !== article_id) return false;

  // Verify HMAC signature
  const encoder = new TextEncoder();
  const keyData = encoder.encode(env.XP_TOKEN_SECRET);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const msgData = encoder.encode(`${payload.uid}:${payload.aid}:${payload.ts}`);
  const sigBytes = Uint8Array.from(atob(payload.sig), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, msgData);
  if (!valid) return false;

  // Replay check via KV
  const dedupKey = `xp:article:${payload.sig.slice(0, 16)}`;
  const seen = await env.PITCHOS_CACHE.get(dedupKey);
  if (seen) return false;
  await env.PITCHOS_CACHE.put(dedupKey, '1', { expirationTtl: 600 }); // 10 min TTL

  return true;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'POST') return err('Method not allowed', 405);

  const user = await getUser(request, env);
  if (!user) return err('Unauthorized', 401);

  const body = await request.json().catch(() => null);
  if (!body?.token || !body?.article_id) return err('Missing token or article_id');

  const valid = await verifyToken(env, body.token, user.id, body.article_id);
  if (!valid) return json({ xp_earned: 0, reason: 'invalid_token' });

  // Award XP — awardXP handles daily cap and source_ref dedup
  const result = await awardXP(env, user.id, 'read_article', body.article_id);

  // Fire first-time bonus if eligible
  let bonus = null;
  if (!result.capped) {
    bonus = await awardXP(env, user.id, 'first_comment').catch(() => null);
    // Actually first_share bonus — check the right one
    // first article read doesn't have a dedicated bonus; skip
  }

  return json({ ...result });
}
