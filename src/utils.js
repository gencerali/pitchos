// ─── MODELS ──────────────────────────────────────────────────
export const MODEL_FETCH    = 'claude-haiku-4-5-20251001';
export const MODEL_SCORE    = 'claude-haiku-4-5-20251001';
export const MODEL_SUMMARY  = 'claude-sonnet-4-6';
export const MODEL_GENERATE = 'claude-sonnet-4-6'; // synthesis generation — full articles

// ─── COST ESTIMATES (USD per 1M tokens) ──────────────────────
const COST = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
};

// ─── BJK KEYWORD LIST ────────────────────────────────────────
// Used to filter feeds and titles for BJK relevance.
// Organized into tiers so additions stay maintainable.
// Review quarterly. Major churn expected during transfer windows.
//
// Tier 1 — Club identity (rarely changes)
// Tier 2 — Current first-team squad
// Tier 3 — Current management & coaching staff
// Tier 4 — Recent former players still in news cycle (last 24 months)
// Tier 5 — Legends regularly mentioned in retrospectives
// Tier 6 — Recent former management still news-relevant

export const BJK_KEYWORDS = [
  // ─── Tier 1 — Club identity ────────────────────────────────
  'beşiktaş','besiktas','bjk','kartal','kara kartal','kara kartallar',
  'kartallar','siyah-beyaz','siyah beyaz','siyah-beyazlı','siyah beyazlı',
  'beşiktaş jk','besiktas jk',
  'tüpraş stadyumu','tupras stadyumu','vodafone park','vodafone arena',
  'beşiktaş park','besiktas park','dolmabahçe stadı','dolmabahce stadi',
  'nevzat demir','nevzat demir tesisleri',
  'çarşı','carsi','beşiktaş akademi','besiktas akademi',
  'bjk u19','bjk u17','beşiktaş u19','beşiktaş u17',

  // ─── Tier 2 — Current first-team squad ─────────────────────
  // Goalkeepers
  'ersin destanoğlu','ersin destanoglu','ersin',
    'devis vasquez','vasquez',
  // Defenders
  'amir murillo','murillo',
  'emmanuel agbadou','agbadou',
  'tiago djalo','djalo',
  'felix uduokhai','uduokhai',
  'emirhan topçu','emirhan topcu','emirhan',
  'rıdvan yılmaz','ridvan yilmaz','rıdvan',
  'taylan bulut','taylan',
  'gökhan sazdağı','gokhan sazdagi',
  // Midfielders
  'orkun kökçü','orkun kokcu','orkun',
  'wilfred ndidi','ndidi',
  'kristjan asllani','asllani',
  'salih uçan','salih ucan',
  'kartal kayra yılmaz','kartal kayra',
  'jean onana',
  // Wingers / attacking mid
  'milot rashica','rashica',
  'junior olaitan','olaitan',
  'vaclav cerny','cerny',
  'jota silva','jota',
  'cengiz ünder','cengiz under','cengiz',
  // Forwards
  'tammy abraham','abraham',
  'el bilal touré','el bilal toure','el bilal',
  'hyeon-gyu oh','hyeon gyu oh','hyeon-gyu','oh hyeon',
  'mustafa hekimoğlu','hekimoğlu','hekimoglu',
  'semih kılıçsoy','semih kilicsoy','semih',
  // Add/remove as squad changes — verify against API-Football squad endpoint periodically

  // ─── Tier 3 — Current management & coaching staff ──────────
  'sergen yalçın','sergen yalcin','sergen',
  'serdal adalı','serdal adali','serdal',

  // ─── Tier 4 — Recent former players still in news (24mo) ───
  'rafa silva','rafa',
  'al-musrati','al musrati','musrati',
  'gedson fernandes','gedson',
  'rachid ghezzal','ghezzal',
  'ciro immobile','immobile',

  'vincent aboubakar','aboubakar',
  'arthur masuaku','masuaku',
  'kenan karaman','kenan',
  'necip uysal','necip',
  'ernest muçi','ernest muci','muçi','muci',
  'demir ege tıknaz','demir ege tiknaz','demir ege', 'mert günok','mert gunok',

  // ─── Tier 5 — Legends regularly mentioned ──────────────────
  'bobô','bobo',
  'pascal nouma','nouma',
  'ricardo quaresma','quaresma',
  'demba ba',
  'ahmet dursun',
  'ali gültiken','ali gultiken','gültiken','gultiken',
  'rıza çalımbay','riza calimbay','çalımbay','calimbay',
  'metin tekin',
  'feyyaz uçar','feyyaz ucar','feyyaz',
  'gökhan inler','gokhan inler','inler','holosko',

  // ─── Tier 6 — Recent former management ─────────────────────
  'hasan arat','arat',
  'fikret orman',
  'ahmet nur çebi','ahmet nur cebi',
  'süleyman seba', 'suleyman seba',
  'hakki yeten'
];

// Tokenises text into a Set of words by splitting on whitespace, apostrophes, and punctuation.
// Used by bjkMatch to prevent single-word keywords from matching inside longer agglutinated words
// (e.g. 'orman' must not match 'sormanıza'; 'onana' must not match as substring of 'Onuachu').
function tokenSet(normalised) {
  return new Set(normalised.split(/[\s‘’''',\.;:!?()\[\]{}\/"«»]+/).filter(Boolean));
}

// Checks whether text mentions any BJK keyword.
// Single-word keywords: exact token match (whole word only, prevents agglutination false-positives).
// Multi-word / hyphenated keywords (e.g. 'siyah-beyaz', 'fikret orman'): substring match on full text
//   because the phrase is specific enough to not appear inside an unrelated longer phrase.
// Case handling: both toLowerCase() and toLocaleLowerCase('tr') checked to handle Turkish İ/I/i/ı.
export function bjkMatch(text, keywords = BJK_KEYWORDS) {
  const lo = text.toLowerCase();
  const tr = text.toLocaleLowerCase('tr');
  const wsLo = tokenSet(lo);
  const wsTr = tokenSet(tr);
  return keywords.some(kw => {
    const kwLo = kw.toLowerCase();
    const kwTr = kw.toLocaleLowerCase('tr');
    if (kw.includes(' ') || kw.includes('-')) return lo.includes(kwLo) || tr.includes(kwTr);
    return wsLo.has(kwLo) || wsTr.has(kwTr);
  });
}

// Returns the first matched keyword (or null if none).
// Used for pipeline_log.drop_detail population.
export function bjkMatchDetail(text, keywords = BJK_KEYWORDS) {
  const lo = text.toLowerCase();
  const tr = text.toLocaleLowerCase('tr');
  const wsLo = tokenSet(lo);
  const wsTr = tokenSet(tr);
  for (const kw of keywords) {
    const kwLo = kw.toLowerCase();
    const kwTr = kw.toLocaleLowerCase('tr');
    const match = (kw.includes(' ') || kw.includes('-'))
      ? lo.includes(kwLo) || tr.includes(kwTr)
      : wsLo.has(kwLo) || wsTr.has(kwTr);
    if (match) return kw;
  }
  return null;
}

// ─── CLAUDE API CALL ─────────────────────────────────────────
export async function callClaude(env, model, prompt, useWebSearch, maxTokens = 2000, system = null) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (system !== null) body.system = system;
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
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

// Upsert a raw source fact. Fire-and-forget — never throws, never blocks the main pipeline.
// On duplicate (site_id + original_url), silently ignores (existing fact preserved).
export async function saveSourceFact(env, siteId, {
  sourceType, sourceName, originalUrl, title,
  content = null, publishedAt = null, metadata = {},
}) {
  try {
    await supabase(env, 'POST',
      '/rest/v1/source_facts?on_conflict=site_id,original_url',
      {
        site_id:      siteId,
        source_type:  sourceType,
        source_name:  sourceName,
        original_url: originalUrl,
        title,
        content,
        published_at: publishedAt,
        fetched_at:   new Date().toISOString(),
        metadata,
      },
      { 'Prefer': 'resolution=ignore-duplicates,return=minimal' }
    );
  } catch (e) {
    console.error('saveSourceFact failed:', e.message);
  }
}

export async function getActiveSites(env) {
  const res = await supabase(env, 'GET', '/rest/v1/sites?status=eq.live&order=created_at.asc&select=*');
  return res || [];
}

// ─── EDITORIAL NOTES ─────────────────────────────────────────
// Scopes: 'global' applies everywhere. Narrower scopes: 'match', 'transfer',
// 'news', 'T01', 'T05', 'T08b', 'T09', 'T10', 'T11', etc.
// Returns a formatted instruction block to prepend to any Claude prompt.
export async function getEditorialNotes(env, scopes = []) {
  try {
    const [rawNotes, rawPatterns] = await Promise.all([
      env.PITCHOS_CACHE.get('editorial:notes'),
      env.PITCHOS_CACHE.get('editorial:voice_patterns'),
    ]);

    let block = '';

    if (rawNotes) {
      const notes = JSON.parse(rawNotes);
      const relevant = notes.filter(n =>
        n.active !== false &&
        (n.scope === 'global' || scopes.includes(n.scope))
      );
      if (relevant.length > 0) {
        block += `EDİTÖR TALİMATLARI — bu kurallara kesinlikle uy, bunlar en yüksek önceliklidir:\n${relevant.map(n => `- [${n.scope}] ${n.text}`).join('\n')}\n\n`;
      }
    }

    if (rawPatterns) {
      const patterns = JSON.parse(rawPatterns);
      if (patterns.length > 0) {
        // Pick 3 weighted-random style examples to inject as style guidance
        const pool = patterns.flatMap(p => Array(Math.max(1, Math.round((p.weight || 1) * 2))).fill(p));
        const picked = [];
        const used = new Set();
        for (let i = 0; i < Math.min(3, patterns.length); i++) {
          let tries = 0;
          while (tries++ < 20) {
            const idx = Math.floor(Math.random() * pool.length);
            const p = pool[idx];
            if (!used.has(p.id)) { used.add(p.id); picked.push(p); break; }
          }
        }
        if (picked.length > 0) {
          block += `YAZIM TARZI ÖRNEKLERİ — aşağıdaki cümle ritmi ve dil tarzını yansıt (içerik değil, sadece ses ve üslup):\n${picked.map(p => `• ${p.example_sentences}`).join('\n')}\n\n`;
        }
      }
    }

    return block;
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
  const rates = COST[model] || { input: 3.00, output: 15.00 };
  const inp   = usage.input_tokens  || 0;
  const out   = usage.output_tokens || 0;
  const cw    = usage.cache_creation_input_tokens || 0; // cache write: 1.25x input rate
  const cr    = usage.cache_read_input_tokens     || 0; // cache read: 0.10x input rate
  stats.tokensIn  += inp + cw + cr;
  stats.tokensOut += out;
  stats.costEur   += ((inp / 1_000_000) * rates.input) +
                     ((out / 1_000_000) * rates.output) +
                     ((cw  / 1_000_000) * rates.input * 1.25) +
                     ((cr  / 1_000_000) * rates.input * 0.10);
}

export function addUsagePhase(stats, usage, model, phase) {
  if (!usage) return;
  addUsage(stats, usage, model);
  const rates = COST[model] || { input: 3.00, output: 15.00 };
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const cw  = usage.cache_creation_input_tokens || 0;
  const cr  = usage.cache_read_input_tokens     || 0;
  const cost = ((inp / 1_000_000) * rates.input) +
               ((out / 1_000_000) * rates.output) +
               ((cw  / 1_000_000) * rates.input * 1.25) +
               ((cr  / 1_000_000) * rates.input * 0.10);
  // Legacy fields for backward compat
  if (phase === 'scout') {
    stats.scout_tokens_in  += inp;
    stats.scout_tokens_out += out;
    stats.scout_cost_eur   += cost;
  } else if (phase === 'write') {
    stats.write_tokens_in  += inp;
    stats.write_tokens_out += out;
    stats.write_cost_eur   += cost;
  }
  // Per-phase breakdown
  if (!stats.phases) stats.phases = {};
  if (!stats.phases[phase]) stats.phases[phase] = { calls: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
  stats.phases[phase].calls    += 1;
  stats.phases[phase].cost     += cost;
  stats.phases[phase].tokensIn += inp + cw + cr;
  stats.phases[phase].tokensOut += out;
  // Per-model breakdown
  if (!stats.models) stats.models = {};
  if (!stats.models[model]) stats.models[model] = { calls: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
  stats.models[model].calls    += 1;
  stats.models[model].cost     += cost;
  stats.models[model].tokensIn += inp + cw + cr;
  stats.models[model].tokensOut += out;
}

// ─── COST GUARD ──────────────────────────────────────────────
// KV key cost:YYYY-MM stores running monthly Anthropic spend in USD.
// Rates in COST table use USD pricing despite the 'costEur' variable name.
export async function addCost(env, usd) {
  if (!usd || usd <= 0) return;
  const month = new Date().toISOString().slice(0, 7);
  const key = `cost:${month}`;
  const capRaw = await env.PITCHOS_CACHE.get('cost:cap');
  const cap = parseFloat(capRaw || env.MONTHLY_CLAUDE_CAP || '8');
  const cur = parseFloat((await env.PITCHOS_CACHE.get(key)) || '0');
  const next = cur + usd;
  await env.PITCHOS_CACHE.put(key, String(next.toFixed(6)));
  // Daily spend (Cost Ceiling 1.6): per-day counter, auto-expires after ~35 days.
  // Error-guarded so it can never break cost accounting or the pipeline.
  try {
    const dayKey = `cost:day:${new Date().toISOString().slice(0, 10)}`;
    const dayCur = parseFloat((await env.PITCHOS_CACHE.get(dayKey)) || '0');
    await env.PITCHOS_CACHE.put(dayKey, String((dayCur + usd).toFixed(6)), { expirationTtl: 35 * 24 * 3600 });
  } catch { /* daily tracking is best-effort */ }
  if (cap > 0) {
    const pct = next / cap * 100;
    const now = new Date().toISOString();
    for (const threshold of [80, 90, 100]) {
      if (pct >= threshold) {
        const alarmKey = `cost:alarm:${threshold}:${month}`;
        const existing = await env.PITCHOS_CACHE.get(alarmKey);
        if (!existing) await env.PITCHOS_CACHE.put(alarmKey, now);
      }
    }
  }
}

export async function flushCostStats(env, siteCode, stats) {
  if (!stats || stats.costEur <= 0) return;
  const now   = new Date();
  const month = now.toISOString().slice(0, 7);
  const day   = now.toISOString().slice(0, 10);
  const phases = stats.phases || {};
  const models = stats.models || {};
  for (const [key, ttl] of [
    [`cost:${siteCode}:${month}`, null],
    [`cost:${siteCode}:${day}`,   90 * 24 * 3600],
  ]) {
    const raw = await env.PITCHOS_CACHE.get(key);
    const cur = raw ? JSON.parse(raw) : { total: 0, phases: {}, models: {}, runs: 0, updated: '' };
    cur.total   = +(((cur.total || 0) + stats.costEur).toFixed(6));
    cur.runs    = (cur.runs || 0) + 1;
    cur.updated = now.toISOString();
    for (const [ph, pd] of Object.entries(phases)) {
      if (!cur.phases[ph]) cur.phases[ph] = { calls: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
      cur.phases[ph].calls    += pd.calls    || 0;
      cur.phases[ph].cost     += pd.cost     || 0;
      cur.phases[ph].tokensIn += pd.tokensIn || 0;
      cur.phases[ph].tokensOut += pd.tokensOut || 0;
    }
    for (const [mdl, md] of Object.entries(models)) {
      if (!cur.models[mdl]) cur.models[mdl] = { calls: 0, cost: 0, tokensIn: 0, tokensOut: 0 };
      cur.models[mdl].calls    += md.calls    || 0;
      cur.models[mdl].cost     += md.cost     || 0;
      cur.models[mdl].tokensIn += md.tokensIn || 0;
      cur.models[mdl].tokensOut += md.tokensOut || 0;
    }
    const opts = ttl ? { expirationTtl: ttl } : {};
    await env.PITCHOS_CACHE.put(key, JSON.stringify(cur), opts);
  }
}

export async function checkCostCap(env) {
  const now = new Date();
  const key = `cost:${now.toISOString().slice(0, 7)}`;
  const current = parseFloat((await env.PITCHOS_CACHE.get(key)) || '0');
  const capRaw = await env.PITCHOS_CACHE.get('cost:cap');
  const cap = parseFloat(capRaw || env.MONTHLY_CLAUDE_CAP || '8');
  let blocked = current >= cap;
  let reason = blocked ? 'monthly' : null;
  if (blocked) {
    console.warn(`COST CAP: $${current.toFixed(4)} of $${cap.toFixed(2)} used — AI calls blocked`);
  } else if (current >= cap * 0.8) {
    console.warn(`COST WARN: $${current.toFixed(4)} of $${cap.toFixed(2)} used (${(current / cap * 100).toFixed(0)}%) — approaching cap`);
  }
  // Daily enforcement (Cost Ceiling 1.6 / Step 4) — opt-in via cost:daily_enforce=1. Default OFF.
  if (!blocked && (await env.PITCHOS_CACHE.get('cost:daily_enforce')) === '1') {
    const todaySpend = parseFloat((await env.PITCHOS_CACHE.get(`cost:day:${now.toISOString().slice(0, 10)}`)) || '0');
    const capOverride = parseFloat((await env.PITCHOS_CACHE.get('cost:daily_cap')) || '');
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const dailyCap = capOverride > 0 ? capOverride : cap / daysInMonth;
    if (todaySpend >= dailyCap) {
      blocked = true; reason = 'daily';
      console.warn(`COST DAILY CAP: $${todaySpend.toFixed(4)} of $${dailyCap.toFixed(2)} daily — AI calls blocked`);
    }
  }
  return { blocked, current, cap, reason };
}

// ─── COST CEILING 1.6 / Step 2: month-end trajectory (pure read; no side effects) ──
// Projects month-end spend from BOTH the month-to-date average and a trailing-7-day
// average, then uses the HIGHER (more conservative) projection — so a recent spike
// (e.g. Method B turning on) isn't masked by a cheap early month. Nothing acts on this
// yet; Step 3 (alarm) and Step 5 (graph/warnings) consume it. `now` is injectable for tests.
export async function costTrajectory(env, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  const today = now.toISOString().slice(0, 10);
  const num = async (k) => parseFloat((await env.PITCHOS_CACHE.get(k)) || '0');

  const monthSpend = await num(`cost:${month}`);
  const todaySpend = await num(`cost:day:${today}`);
  const capRaw = await env.PITCHOS_CACHE.get('cost:cap');
  const cap = parseFloat(capRaw || env.MONTHLY_CLAUDE_CAP || '8');

  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  // trailing 7 calendar days (incl. today); daily keys persist across months (TTL ~35d)
  let sum7 = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    sum7 += await num(`cost:day:${d}`);
  }
  const avgPerDayMTD = dayOfMonth > 0 ? monthSpend / dayOfMonth : 0;
  const avg7d = sum7 / 7;

  const projMTD = avgPerDayMTD * daysInMonth;
  const proj7d = avg7d * daysInMonth;
  const projectedMonthEnd = Math.max(projMTD, proj7d);
  const projectionBasis = proj7d > projMTD ? '7d' : 'mtd';

  return {
    monthSpend, todaySpend, cap, dayOfMonth, daysInMonth,
    avgPerDayMTD, avg7d, projMTD, proj7d, projectedMonthEnd, projectionBasis,
    pctOfCap: cap > 0 ? (monthSpend / cap) * 100 : 0,
    projectedPctOfCap: cap > 0 ? (projectedMonthEnd / cap) * 100 : 0,
    onTrack: projectedMonthEnd <= cap,
  };
}

// Cost Ceiling 1.6 / Step 3: pure alarm-condition decision from a trajectory snapshot.
// Daily cap defaults to an even spread (cap / daysInMonth) unless overridden.
export function costAlarmConditions(traj, dailyCapOverride) {
  const dailyCap = dailyCapOverride > 0 ? dailyCapOverride : (traj.daysInMonth > 0 ? traj.cap / traj.daysInMonth : traj.cap);
  return {
    dailyCap,
    trajectoryOver: !traj.onTrack,             // projected month-end > cap
    dailyOver: traj.todaySpend > dailyCap,     // today already past the daily slice
  };
}

// Cost Ceiling 1.6 / Step 5a: pure daily-archive roll-up. Merges recent live daily entries
// over the archive (live wins) and prunes anything older than `retentionDays` from `today`.
export function rollupDailyCost(archive = {}, daily = {}, today, retentionDays = 730) {
  const merged = { ...archive, ...daily };
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() - retentionDays * 86400000;
  const out = {};
  for (const [d, v] of Object.entries(merged)) {
    const t = new Date(`${d}T00:00:00Z`).getTime();
    if (!Number.isNaN(t) && t >= cutoff) out[d] = v;
  }
  return out;
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
