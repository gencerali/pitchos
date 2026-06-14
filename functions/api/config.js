// Returns public client config: Supabase URL, anon key, and current site_id.
// This endpoint is intentionally public — anon key is meant to be client-visible.
// Service role key never leaves the server.

import { getSiteId } from './_shared/site.js';
import { json, corsHeaders } from './_shared/auth.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();

  const site_id = await getSiteId(request, env);

  return json({
    supabase_url: env.SUPABASE_URL,
    supabase_anon_key: env.SUPABASE_ANON_KEY,
    site_id: site_id ?? null,
  });
}
