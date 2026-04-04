/**
 * PitchOS — Fetch Agent (Cloudflare Worker)
 * ==========================================
 * Runs every hour via Cron Trigger.
 * For each active site:
 *   1. Fetches latest news via Claude API (web search enabled)
 *   2. Scores each article with NVS
 *   3. Routes: auto-publish | review queue | discard
 *   4. Caches published articles to KV (fan site reads from here)
 *   5. Logs cost + results to Supabase
 *
 * SETUP INSTRUCTIONS:
 * -------------------
 * 1. Create a Cloudflare Worker called "pitchos-fetch-agent"
 * 2. Add these environment variables in Worker Settings → Variables:
 *    - ANTHROPIC_API_KEY    → your Claude API key
 *    - SUPABASE_URL         → your Supabase project URL
 *    - SUPABASE_SERVICE_KEY → your Supabase service role key (not anon key)
 * 3. Create a KV namespace called "PITCHOS_CACHE" and bind it to this worker
 * 4. Add a Cron Trigger: "0 * * * *" (every hour)
 * 5. Paste this entire file as your worker code
 */

// ─── MODELS ──────────────────────────────────────────────────
const MODEL_FETCH   = 'claude-haiku-4-5-20251001';   // cheap, fast — for fetching
const MODEL_SCORE   = 'claude-haiku-4-5-20251001';   // cheap — NVS scoring
const MODEL_SUMMARY = 'claude-sonnet-4-6';           // quality — final summaries

// ─── COST ESTIMATES (EUR per 1M tokens) ──────────────────────
const COST = {
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.00  },
  'claude-sonnet-4-6':          { input: 2.75,  output: 13.75 },
};

// ─── MAIN ENTRY POINT ────────────────────────────────────────
export default {

  // HTTP trigger (for manual testing: fetch worker URL)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const result = await runAllSites(env);
      return Response.json(result);
    }
    if (url.pathname === '/cache') {
      const siteCode = url.searchParams.get('site') || 'BJK';
      const cached = await env.PITCHOS_CACHE.get(`articles:${siteCode}`);
      return new Response(cached || '[]', {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('PitchOS Fetch Agent — OK', { status: 200 });
  },

  // Cron trigger (runs every hour automatically)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAllSites(env));
  }
};

// ─── ORCHESTRATOR ────────────────────────────────────────────
async function runAllSites(env) {
  const sites = await getActiveSites(env);
  const results = [];

  for (const site of sites) {
    try {
      const result = await processSite(site, env);
      results.push({ site: site.short_code, ...result });
    } catch (err) {
      console.error(`Failed site ${site.short_code}:`, err);
      results.push({ site: site.short_code, error: err.message });
      await logFetch(env, site.id, 'failed', {}, err.message);
    }
  }

  return { processed: results.length, results };
}

// ─── PROCESS ONE SITE ────────────────────────────────────────
async function processSite(site, env) {
  const startTime = Date.now();
  const stats = {
    fetched: 0, published: 0, queued: 0,
    rejected: 0, claudeCalls: 0,
    tokensIn: 0, tokensOut: 0, costEur: 0
  };

  // 1. Fetch raw articles via Claude with web search
  const { articles, usage: fetchUsage } = await fetchArticles(site, env);
  stats.fetched = articles.length;
  stats.claudeCalls++;
  addUsage(stats, fetchUsage, MODEL_FETCH);

  if (articles.length === 0) {
    await logFetch(env, site.id, 'partial', stats, 'No articles returned');
    return stats;
  }

  // 2. Score all articles in one batch call
  const { scored, usage: scoreUsage } = await scoreArticles(articles, site, env);
  stats.claudeCalls++;
  addUsage(stats, scoreUsage, MODEL_SCORE);

  // 3. Route by NVS score
  const toPublish = scored.filter(a => a.nvs >= site.auto_publish_threshold);
  const toQueue   = scored.filter(a => a.nvs >= site.review_threshold && a.nvs < site.auto_publish_threshold);
  const toDiscard = scored.filter(a => a.nvs < site.review_threshold);

  stats.published = toPublish.length;
  stats.queued    = toQueue.length;
  stats.rejected  = toDiscard.length;

  // 4. Save to Supabase
  if (toPublish.length > 0) {
    await saveArticles(env, site.id, toPublish, 'published');
  }
  if (toQueue.length > 0) {
    await saveArticles(env, site.id, toQueue, 'pending');
  }

  // 5. Cache published articles to KV (fan site reads this)
  const existing = await getCachedArticles(env, site.short_code);
  const merged   = mergeAndDedupe([...toPublish, ...existing], 20);
  await env.PITCHOS_CACHE.put(
    `articles:${site.short_code}`,
    JSON.stringify(merged),
    { expirationTtl: 7200 } // 2 hours TTL as safety net
  );

  // 6. Log to Supabase
  await logFetch(env, site.id, 'success', stats);

  stats.durationMs = Date.now() - startTime;
  return stats;
}

// ─── FETCH ARTICLES via Claude + Web Search ──────────────────
async function fetchArticles(site, env) {
  const prompt = `Search the web for the latest ${site.team_name} football news published in the last 24 hours.
Find news about: transfers, match results, injuries, squad updates, press conferences, and club news.
Return ONLY a valid JSON array with up to 8 articles. No markdown, no explanation.
Each object must have:
- title (string, compelling headline)
- summary (string, 2-3 sentences, factual)
- source (string, publication name)
- url (string, original article URL)
- category (one of: Transfer|Match|Injury|Squad|Club|European)
- published_at (string, ISO date if known, else "unknown")
- language ("${site.languages[0]}")
Do not invent facts. Only include real recent news.`;

  const response = await callClaude(env, MODEL_FETCH, prompt, true);

  let articles = [];
  try {
    const text = extractText(response.content);
    const clean = text.replace(/```json|```/gi, '').trim();
    articles = JSON.parse(clean);
    if (!Array.isArray(articles)) articles = [];
  } catch (e) {
    console.error('Parse error in fetchArticles:', e);
  }

  return { articles, usage: response.usage };
}

// ─── SCORE ARTICLES (batch NVS) ──────────────────────────────
async function scoreArticles(articles, site, env) {
  const prompt = `You are a news value scorer for ${site.team_name} football content.
Score each article in this JSON array on the News Value Score (NVS) scale 0-100.
Scoring dimensions (total 100):
- Specificity (25): Named people, figures, confirmed facts vs vague claims
- Source authority (25): Club official=25, verified journalist=20, media outlet=15, unknown=5
- Novelty (20): Is this genuinely new information?
- Recency (15): Published today=15, yesterday=10, older=5
- Relevance (10): Directly about ${site.team_name}=10, tangential=5
- Engagement signal (5): Breaking/exclusive=5, routine=2

Input articles:
${JSON.stringify(articles, null, 2)}

Return ONLY a valid JSON array (same order) where each object adds:
- nvs (integer 0-100)
- nvs_notes (one sentence explaining the score)
No markdown, no explanation outside the JSON.`;

  const response = await callClaude(env, MODEL_SCORE, prompt, false);

  let scored = [];
  try {
    const text = extractText(response.content);
    const clean = text.replace(/```json|```/gi, '').trim();
    scored = JSON.parse(clean);
    if (!Array.isArray(scored)) scored = articles.map(a => ({ ...a, nvs: 50 }));
  } catch (e) {
    // Fallback: assign neutral score
    scored = articles.map(a => ({ ...a, nvs: 50, nvs_notes: 'Scoring failed, defaulted' }));
  }

  return { scored, usage: response.usage };
}

// ─── CLAUDE API CALL ─────────────────────────────────────────
async function callClaude(env, model, prompt, useWebSearch) {
  const body = {
    model,
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  };

  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  return response.json();
}

// ─── SUPABASE HELPERS ─────────────────────────────────────────
async function getActiveSites(env) {
  const res = await supabase(env, 'GET', '/rest/v1/sites?status=eq.live&select=*');
  return res || [];
}

async function saveArticles(env, siteId, articles, status) {
  const rows = articles.map(a => ({
    site_id:      siteId,
    source_type:  'rss',
    source_name:  a.source || 'Unknown',
    original_url: a.url || null,
    title:        a.title,
    summary:      a.summary,
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
    'Prefer': 'resolution=ignore-duplicates'
  });
}

async function logFetch(env, siteId, status, stats, errorMsg) {
  const row = {
    site_id:            siteId,
    trigger_type:       'cron',
    status,
    items_fetched:      stats.fetched    || 0,
    items_scored:       stats.fetched    || 0,
    items_published:    stats.published  || 0,
    items_queued:       stats.queued     || 0,
    items_rejected:     stats.rejected   || 0,
    claude_calls:       stats.claudeCalls || 0,
    tokens_input:       stats.tokensIn   || 0,
    tokens_output:      stats.tokensOut  || 0,
    estimated_cost_eur: stats.costEur    || 0,
    model_used:         `${MODEL_FETCH}+${MODEL_SCORE}`,
    error_message:      errorMsg || null,
    duration_ms:        stats.durationMs || null,
  };
  await supabase(env, 'POST', '/rest/v1/fetch_logs', row);
}

async function supabase(env, method, path, body, extraHeaders = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    console.error(`Supabase ${method} ${path} failed:`, await res.text());
    return null;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─── KV CACHE HELPERS ────────────────────────────────────────
async function getCachedArticles(env, siteCode) {
  const cached = await env.PITCHOS_CACHE.get(`articles:${siteCode}`);
  return cached ? JSON.parse(cached) : [];
}

function mergeAndDedupe(articles, limit) {
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

// ─── UTILITIES ───────────────────────────────────────────────
function extractText(content = []) {
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

function addUsage(stats, usage, model) {
  if (!usage) return;
  const rates = COST[model] || { input: 3, output: 15 };
  stats.tokensIn  += usage.input_tokens  || 0;
  stats.tokensOut += usage.output_tokens || 0;
  stats.costEur   += ((usage.input_tokens  / 1_000_000) * rates.input) +
                     ((usage.output_tokens / 1_000_000) * rates.output);
}

function simpleHash(str = '') {
  let h = 0;
  for (const c of str) h = Math.imul(31, h) + c.charCodeAt(0) | 0;
  return Math.abs(h).toString(36);
}
