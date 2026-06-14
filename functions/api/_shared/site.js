// Resolves the current site_id from the request hostname.
// Looks up sites.domain in Supabase using the service role key.
// Result is cached in KV for 5 minutes to avoid per-request DB lookups.

export async function getSiteId(request, env) {
  const host = new URL(request.url).hostname;
  const cacheKey = `site:domain:${host}`;

  const cached = await env.PITCHOS_CACHE.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/sites?domain=eq.${encodeURIComponent(host)}&select=id&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;

  const site_id = rows[0].id;
  await env.PITCHOS_CACHE.put(cacheKey, site_id, { expirationTtl: 300 }); // 5 min
  return site_id;
}
