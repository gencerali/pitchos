// ─── MODELS ──────────────────────────────────────────────────
export const MODEL_FETCH    = 'claude-haiku-4-5-20251001';
export const MODEL_SCORE    = 'claude-haiku-4-5-20251001';
export const MODEL_SUMMARY  = 'claude-sonnet-4-6';
export const MODEL_GENERATE = 'claude-sonnet-4-6'; // synthesis generation — full articles

// ─── COST ESTIMATES (EUR per 1M tokens) ──────────────────────
const COST = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6':         { input: 2.75, output: 13.75 },
};

// ─── SQUAD KEYWORD LIST (BJK players, coaches, staff) ────────
// Used to filter journalist/international feeds by player name
export const BJK_KEYWORDS = [
  'beşiktaş','besiktas','bjk','kartal',
  'ersin destanoğlu','ersin destanoglu','ersin',
  'devis vasquez','vasquez',
  'amir murillo','murillo',
  'emmanuel agbadou','agbadou',
  'tiago djalo','djalo',
  'felix uduokhai','uduokhai',
  'emirhan topçu','emirhan topcu','emirhan',
  'rıdvan yılmaz','ridvan yilmaz','rıdvan',
  'taylan bulut','taylan',
  'gökhan sazdağı','gokhan sazdagi',
  'orkun kökçü','orkun kokcu','orkun',
  'wilfred ndidi','ndidi',
  'kristjan asllani','asllani',
  'salih uçan','salih ucan',
  'kartal kayra yılmaz','kartal kayra',
  'milot rashica','rashica',
  'junior olaitan','olaitan',
  'tammy abraham','abraham',
  'vaclav cerny','cerny',
  'el bilal touré','el bilal toure','el bilal',
  'hyeon-gyu oh','hyeon gyu oh','hyeon-gyu','oh hyeon',
  'jota silva','jota',
  'cengiz ünder','cengiz under','cengiz',
  'mustafa hekimoğlu','hekimoğlu','hekimoglu',
  'sergen yalçın','sergen yalcin','sergen',
  'serdal adalı','serdal adali','serdal',
  'mert günok','mert gunok',
  'jean onana','onana',
];

// ─── CLAUDE API CALL ─────────────────────────────────────────
export async function callClaude(env, model, prompt, useWebSearch, maxTokens = 2000) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }
  return response.json();
}

// ─── SUPABASE HELPER ─────────────────────────────────────────
export async function supabase(env, method, path, body, extraHeaders = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=representation',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    console.error(`Supabase ${method} ${path} failed:`, await res.text());
    return null;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function getActiveSites(env) {
  const res = await supabase(env, 'GET', '/rest/v1/sites?status=eq.live&select=*');
  return res || [];
}

// ─── EDITORIAL NOTES ─────────────────────────────────────────
// Scopes: 'global' applies everywhere. Narrower scopes: 'match', 'transfer',
// 'news', 'T01', 'T05', 'T08b', 'T09', 'T10', 'T11', etc.
// Returns a formatted instruction block to prepend to any Claude prompt.
export async function getEditorialNotes(env, scopes = []) {
  try {
    const raw = await env.PITCHOS_CACHE.get('editorial:notes');
    if (!raw) return '';
    const notes = JSON.parse(raw);
    const relevant = notes.filter(n =>
      n.active !== false &&
      (n.scope === 'global' || scopes.includes(n.scope))
    );
    if (relevant.length === 0) return '';
    return `EDİTÖR TALİMATLARI — bu kurallara kesinlikle uy, bunlar en yüksek önceliklidir:\n${relevant.map(n => `- [${n.scope}] ${n.text}`).join('\n')}\n\n`;
  } catch(e) {
    return '';
  }
}

export async function saveEditorialNote(env, scope, text) {
  const raw = await env.PITCHOS_CACHE.get('editorial:notes');
  const notes = raw ? JSON.parse(raw) : [];
  const note = { id: crypto.randomUUID(), scope, text: text.trim(), active: true, created_at: new Date().toISOString() };
  notes.unshift(note);
  await env.PITCHOS_CACHE.put('editorial:notes', JSON.stringify(notes));
  return note;
}

export async function deleteEditorialNote(env, id) {
  const raw = await env.PITCHOS_CACHE.get('editorial:notes');
  if (!raw) return;
  const notes = JSON.parse(raw).filter(n => n.id !== id);
  await env.PITCHOS_CACHE.put('editorial:notes', JSON.stringify(notes));
}

export async function listEditorialNotes(env) {
  const raw = await env.PITCHOS_CACHE.get('editorial:notes');
  return raw ? JSON.parse(raw) : [];
}

// ─── RAW ARTICLE FEEDBACK ─────────────────────────────────────
// Stores unstructured editor comments on specific articles.
// Separate from editorial:notes — these get distilled into guidelines.
export async function saveRawFeedback(env, { article_slug, article_title, template_id, comment }) {
  const raw = await env.PITCHOS_CACHE.get('editorial:raw_feedback');
  const items = raw ? JSON.parse(raw) : [];
  const item = {
    id: crypto.randomUUID(),
    article_slug: article_slug || '',
    article_title: article_title || '',
    template_id: template_id || '',
    comment: comment.trim(),
    created_at: new Date().toISOString(),
    processed: false,
  };
  items.unshift(item);
  await env.PITCHOS_CACHE.put('editorial:raw_feedback', JSON.stringify(items.slice(0, 500)));
  return item;
}

export async function getRawFeedbacks(env, { unprocessedOnly = false } = {}) {
  const raw = await env.PITCHOS_CACHE.get('editorial:raw_feedback');
  if (!raw) return [];
  const items = JSON.parse(raw);
  return unprocessedOnly ? items.filter(i => !i.processed) : items;
}

export async function markFeedbacksProcessed(env, ids) {
  const raw = await env.PITCHOS_CACHE.get('editorial:raw_feedback');
  if (!raw) return;
  const idSet = new Set(ids);
  const items = JSON.parse(raw).map(i => idSet.has(i.id) ? { ...i, processed: true } : i);
  await env.PITCHOS_CACHE.put('editorial:raw_feedback', JSON.stringify(items));
}

export async function deleteRawFeedback(env, id) {
  const raw = await env.PITCHOS_CACHE.get('editorial:raw_feedback');
  if (!raw) return;
  const items = JSON.parse(raw).filter(i => i.id !== id);
  await env.PITCHOS_CACHE.put('editorial:raw_feedback', JSON.stringify(items));
}

// ─── REFERENCE ARTICLES ──────────────────────────────────────
// Pasted examples of articles the editor likes — fed into distill/redistill
// so Claude can extract style principles from them.
export async function saveReferenceArticle(env, { source, text }) {
  const raw = await env.PITCHOS_CACHE.get('editorial:references');
  const items = raw ? JSON.parse(raw) : [];
  const item = { id: crypto.randomUUID(), source: (source || '').trim(), text: text.trim().slice(0, 3000), created_at: new Date().toISOString() };
  items.unshift(item);
  await env.PITCHOS_CACHE.put('editorial:references', JSON.stringify(items.slice(0, 50)));
  return item;
}

export async function getReferenceArticles(env) {
  const raw = await env.PITCHOS_CACHE.get('editorial:references');
  return raw ? JSON.parse(raw) : [];
}

export async function deleteReferenceArticle(env, id) {
  const raw = await env.PITCHOS_CACHE.get('editorial:references');
  if (!raw) return;
  const items = JSON.parse(raw).filter(i => i.id !== id);
  await env.PITCHOS_CACHE.put('editorial:references', JSON.stringify(items));
}

// ─── SLUG GENERATION ─────────────────────────────────────────
export function generateSlug(title, published_at) {
  const date = (published_at || new Date().toISOString()).slice(0, 10);
  const s = (title || '')
    .toLowerCase()
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 70)
    .replace(/-$/, '');
  return `${date}-${s}`;
}

// ─── TEXT / USAGE HELPERS ────────────────────────────────────
export function extractText(content = []) {
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

export function addUsagePhase(stats, usage, model, phase) {
  if (!usage) return;
  addUsage(stats, usage, model);
  const rates = COST[model] || { input: 3, output: 15 };
  const cost = ((usage.input_tokens  / 1_000_000) * rates.input) +
               ((usage.output_tokens / 1_000_000) * rates.output);
  if (phase === 'scout') {
    stats.scout_tokens_in  += usage.input_tokens  || 0;
    stats.scout_tokens_out += usage.output_tokens || 0;
    stats.scout_cost_eur   += cost;
  } else if (phase === 'write') {
    stats.write_tokens_in  += usage.input_tokens  || 0;
    stats.write_tokens_out += usage.output_tokens || 0;
    stats.write_cost_eur   += cost;
  }
}

// ─── COST GUARD ──────────────────────────────────────────────
// KV key cost:YYYY-MM stores running monthly Anthropic spend in USD.
// Rates in COST table use USD pricing despite the 'costEur' variable name.
export async function addCost(env, usd) {
  if (!usd || usd <= 0) return;
  const key = `cost:${new Date().toISOString().slice(0, 7)}`;
  const cur = parseFloat((await env.PITCHOS_CACHE.get(key)) || '0');
  await env.PITCHOS_CACHE.put(key, String((cur + usd).toFixed(6)));
}

export async function checkCostCap(env) {
  const key = `cost:${new Date().toISOString().slice(0, 7)}`;
  const current = parseFloat((await env.PITCHOS_CACHE.get(key)) || '0');
  const cap = parseFloat(env.MONTHLY_CLAUDE_CAP || '8');
  if (current >= cap) {
    console.warn(`COST CAP: $${current.toFixed(4)} of $${cap.toFixed(2)} used — AI calls blocked`);
  } else if (current >= cap * 0.8) {
    console.warn(`COST WARN: $${current.toFixed(4)} of $${cap.toFixed(2)} used (${(current / cap * 100).toFixed(0)}%) — approaching cap`);
  }
  return { blocked: current >= cap, current, cap };
}

// ─── MISC ─────────────────────────────────────────────────────
export function simpleHash(str) {
  str = String(str || '');
  let h = 0;
  for (const c of str) h = Math.imul(31, h) + c.charCodeAt(0) | 0;
  return Math.abs(h).toString(36);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isTodayArticle(timeAgo = '') {
  const s = timeAgo.toLowerCase();
  if (s.includes('dün') || s.includes('gün önce') || s.includes('hafta') || s.includes('ay')) return false;
  return true;
}
