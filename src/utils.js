// ─── MODELS ──────────────────────────────────────────────────
export const MODEL_FETCH   = 'claude-haiku-4-5-20251001';
export const MODEL_SCORE   = 'claude-haiku-4-5-20251001';
export const MODEL_SUMMARY = 'claude-sonnet-4-6';

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
