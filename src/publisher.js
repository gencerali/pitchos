import { callClaude, supabase, extractText, simpleHash, MODEL_FETCH, MODEL_SCORE, MODEL_SUMMARY } from './utils.js';
import { normalizeTitle, titleSimilarity } from './processor.js';

// ─── WRITE ARTICLES ───────────────────────────────────────────
export async function writeArticles(articles, site, env, model = MODEL_SUMMARY, useFullText = false) {
  if (articles.length === 0) return { written: [], usage: null };

  const groups = [];
  for (const a of articles) {
    const norm = normalizeTitle(a.title);
    const existing = groups.find(g => titleSimilarity(norm, normalizeTitle(g[0].title)) > 0.3);
    if (existing) existing.push(a);
    else groups.push([a]);
  }
  console.log(`writeArticles (model=${model.includes('sonnet') ? 'sonnet' : 'haiku'}, fullText=${useFullText}): ${groups.length} groups`);

  const results = await Promise.allSettled(
    groups.map(group => writeOneArticle(group, site, env, model, useFullText))
  );

  const written = [];
  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  for (const r of results) {
    if (r.status === 'fulfilled') {
      written.push(r.value.article);
      totalUsage.input_tokens  += r.value.usage?.input_tokens  || 0;
      totalUsage.output_tokens += r.value.usage?.output_tokens || 0;
    } else {
      console.error('writeOneArticle failed:', r.reason?.message);
    }
  }
  return { written, usage: totalUsage };
}

async function writeOneArticle(group, site, env, model, useFullText) {
  const lead = group.reduce((best, a) => (a.nvs || 0) > (best.nvs || 0) ? a : best, group[0]);

  const context = group.map(a => {
    const content = useFullText && a.full_text
      ? a.full_text.slice(0, 2000)
      : (a.summary || '').slice(0, 400);
    return `KAYNAK: ${a.source}\nBAŞLIK: ${a.title}\nİÇERİK: ${content}`;
  }).join('\n\n---\n\n');

  const prompt = `Sen ${site.team_name} için profesyonel bir spor gazetecisisin. Aşağıdaki kaynakları kullanarak kısa Türkçe haber yaz (maksimum 120 kelime).

${context}

Sadece ham JSON döndür (başka metin yok):
{"headline":"başlık","body":"giriş\\n\\ngelişme\\n\\nsonuç","sources":["kaynak"],"category":"${lead.category || 'Club'}","nvs_score":${lead.nvs || 50}}`;

  const writeTokens = model.includes('sonnet') ? 1000 : 500;
  const response = await callClaude(env, model, prompt, false, writeTokens);
  const text = extractText(response.content);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in writeOneArticle response');

  const parsed = JSON.parse(match[0]);
  return {
    article: {
      ...lead,
      title:        parsed.headline || lead.title,
      summary:      (parsed.body || '').split('\n\n')[0] || lead.summary,
      full_body:    parsed.body    || '',
      source:       (parsed.sources || [lead.source]).join(', '),
      category:     parsed.category || lead.category,
      nvs:          parsed.nvs_score ?? lead.nvs,
      golden_score: lead.golden_score,
    },
    usage: response.usage,
  };
}

// ─── SUPABASE SAVES ───────────────────────────────────────────
export async function saveArticles(env, siteId, articles, status) {
  const rows = articles.map(a => ({
    site_id:      siteId,
    source_type:  'rss',
    source_name:  a.source_name || a.source || 'Unknown',
    original_url: a.url || null,
    title:        a.title,
    summary:      a.summary,
    raw_body:     a.full_body || null,
    category:     a.category || 'Club',
    language:     a.language || 'tr',
    nvs_score:    a.nvs || 0,
    nvs_notes:    a.nvs_notes || null,
    content_hash: simpleHash(a.title + a.summary),
    status,
    reviewed_by:  status === 'published' ? 'auto' : null,
    reviewed_at:  status === 'published' ? new Date().toISOString() : null,
  }));
  await supabase(env, 'POST', '/rest/v1/content_items', rows, {
    'Prefer': 'resolution=ignore-duplicates',
  });
}

export async function logFetch(env, siteId, status, stats, errorMsg) {
  console.log(`logFetch [${status}] scout: ${stats.scout_tokens_in}in €${(stats.scout_cost_eur||0).toFixed(4)} | write: ${stats.write_tokens_in}in €${(stats.write_cost_eur||0).toFixed(4)} | total €${(stats.costEur||0).toFixed(4)}`);
  const row = {
    site_id:            siteId,
    trigger_type:       'cron',
    status,
    items_fetched:      stats.fetched      || 0,
    items_scored:       stats.fetched      || 0,
    items_published:    stats.published    || 0,
    items_queued:       stats.queued       || 0,
    items_rejected:     stats.rejected     || 0,
    claude_calls:       stats.claudeCalls  || 0,
    tokens_input:       stats.tokensIn     || 0,
    tokens_output:      stats.tokensOut    || 0,
    estimated_cost_eur: stats.costEur      || 0,
    model_used:         `${MODEL_FETCH}+${MODEL_SCORE}+${MODEL_SUMMARY}`,
    error_message:      errorMsg || null,
    duration_ms:        stats.durationMs   || null,
  };
  await supabase(env, 'POST', '/rest/v1/fetch_logs', row);
}

// ─── KV CACHE ─────────────────────────────────────────────────
export async function cacheToKV(env, site, toPublish, toQueue) {
  const existing = await getCachedArticles(env, site.short_code);
  const mergedKV  = mergeAndDedupe([...toPublish, ...toQueue, ...existing], 20);
  await env.PITCHOS_CACHE.put(
    `articles:${site.short_code}`,
    JSON.stringify(mergedKV.map(a => ({
      title:        a.title        || '',
      summary:      a.summary      || '',
      full_body:    a.full_body    || '',
      source:       a.source       || a.source_name || '',
      url:          a.url          || a.original_url || '',
      category:     a.category     || 'Haber',
      nvs:          a.nvs          || a.nvs_score   || 0,
      golden_score: a.golden_score || null,
      time_ago:     a.time_ago     || 'Güncel',
      is_fresh:     a.is_fresh     ?? true,
      sport:        a.sport        || 'football',
    }))),
    { expirationTtl: 7200 }
  );
}

export async function getCachedArticles(env, siteCode) {
  const cached = await env.PITCHOS_CACHE.get(`articles:${siteCode}`);
  return cached ? JSON.parse(cached) : [];
}

export function mergeAndDedupe(articles, limit) {
  const seen = new Set();
  return articles
    .filter(a => {
      const hash = simpleHash(a.title);
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    })
    .sort((a, b) => (b.nvs || 0) - (a.nvs || 0))
    .slice(0, limit);
}
