import { json, err, corsHeaders } from './_shared/auth.js';
import { sbGet } from './_shared/xp.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const slug = new URL(request.url).searchParams.get('slug');
  if (!slug) return err('slug required', 400);

  const rows = await sbGet(env,
    `content_items?slug=eq.${encodeURIComponent(slug)}&status=not.in.(rejected,archived)&select=*&limit=1`
  ).catch(() => null);

  if (!rows?.length) return err('Article not found', 404);

  const r = rows[0];
  return json({
    slug: r.slug,
    title: r.title || '',
    summary: r.summary || '',
    full_body: r.full_body || '',
    source: r.source_name || '',
    source_name: r.source_name || '',
    category: r.category || 'Haber',
    published_at: r.fetched_at || r.created_at,
    image_url: r.image_url || '',
    nvs: r.nvs_score || 0,
    url: r.original_url || '#',
    original_url: r.original_url || '#',
    is_kartalix_content: r.content_type === 'kartalix_generated',
    template_id: r.template_id || null,
    publish_mode: r.publish_mode || '',
    opponent_id: r.opponent_id || null,
    id: r.id,
  });
}
