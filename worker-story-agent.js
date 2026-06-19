// worker-story-agent.js — Method B shadow worker (pitchos-story-agent).
//
// Fact-based news generator, run in parallel to the legacy pipeline. PRODUCER only:
// reads already-ingested content_items + their facts, correlates them into topics,
// detects material deltas, and synthesizes phase articles into a SHADOW KV pool
// (`articles:{site}:methodb`). It never serves pages and never writes the live homepage.
// See docs/method-b-design.md.
//
// SAFETY:
//  - inert by default — runMethodB() no-ops unless KV flag `methodb:enabled` == "1".
//  - shadow-only — writes ONLY new tables (topics/phases) + shadow KV; never touches
//    content_items, the live `articles:{site}` key, or the `pipeline:active` pointer.
//  - budget-bounded — Sonnet synthesis capped per run; honours the shared cost cap;
//    routine facts (delta_type=routine) are skipped before any LLM call.
//
// Shared CODE, isolated RUNTIME: same ./src/*.js modules as the legacy worker; own cron,
// own CPU/subrequest budget, own failure domain (design §5).

import {
  supabase, getActiveSites, callClaude, extractText, addUsagePhase, addCost, checkCostCap,
  getEditorialNotes, simpleHash, MODEL_FETCH, MODEL_GENERATE,
} from './src/utils.js';

const ENABLED_KEY = 'methodb:enabled';                       // "1" to arm the pipeline
const cursorKey   = (code) => `methodb:cursor:${code}`;      // ISO ts of last processed content_item
const statusKey   = (code) => `methodb:status:${code}`;      // last-run telemetry (/status + /admin/pipeline)
const shadowKey   = (code) => `articles:${code}:methodb`;    // shadow homepage pool (blue/green green-side)
const costKey     = ()     => `methodb:cost:${new Date().toISOString().slice(0, 7)}`; // monthly methodb-only spend

const BATCH            = 50; // content_items scanned per site per run
const SHADOW_SYNTH_CAP = 4;  // Sonnet syntheses per site per run (dev budget guardrail, design §6.1)
const SHADOW_POOL_MAX  = 60; // shadow homepage pool size

export default {
  // Hourly cron (wrangler-story.toml). Reacts to ingested content; no freshness polling.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMethodB(env, ctx));
  },

  // Minimal control surface. No public routes are bound to this worker (workers.dev only).
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      const sites = await getActiveSites(env);
      const enabled = (await env.PITCHOS_CACHE.get(ENABLED_KEY)) === '1';
      const monthCost = parseFloat((await env.PITCHOS_CACHE.get(costKey())) || '0');
      const out = { enabled, methodb_month_cost_usd: +monthCost.toFixed(5), sites: {} };
      for (const s of sites) {
        const code = s.short_code;
        const [cursor, status] = await Promise.all([
          env.PITCHOS_CACHE.get(cursorKey(code)),
          env.PITCHOS_CACHE.get(statusKey(code)),
        ]);
        out.sites[code] = { cursor: cursor || null, lastRun: status ? JSON.parse(status) : null };
      }
      return Response.json(out);
    }
    if (url.pathname === '/run' && request.method === 'POST') {
      const key = request.headers.get('x-methodb-key');
      const expected = await env.PITCHOS_CACHE.get('methodb:admin_key');
      if (!expected || key !== expected) return new Response('unauthorized', { status: 401 });
      const result = await runMethodB(env, null, { force: true });
      return Response.json(result);
    }
    return new Response('pitchos-story-agent (Method B shadow worker). See /status.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};

// ─── ORCHESTRATION ───────────────────────────────────────────────────────────

export async function runMethodB(env, ctx, opts = {}) {
  const armed = (await env.PITCHOS_CACHE.get(ENABLED_KEY)) === '1';
  if (!armed && !opts.force) return { skipped: 'methodb:enabled != 1' };
  const sites = await getActiveSites(env);
  const results = {};
  for (const site of sites) {
    try {
      results[site.short_code] = await processSiteMethodB(site, env);
    } catch (e) {
      console.error(`Method B [${site.short_code}] failed:`, e.message);
      results[site.short_code] = { error: e.message };
    }
  }
  return results;
}

async function processSiteMethodB(site, env) {
  const code = site.short_code;
  const stats = { phases: {}, models: {} };
  const cap = await checkCostCap(env);

  // Out of monthly budget → do nothing and DON'T advance the cursor, so this batch is
  // retried once budget frees up (rather than silently skipped forever).
  if (cap.blocked) {
    const status = { ts: new Date().toISOString(), skipped: 'cost cap reached', cap: cap.cap, spent: +cap.current.toFixed(4) };
    await env.PITCHOS_CACHE.put(statusKey(code), JSON.stringify(status));
    return status;
  }

  // Cursor: only content_items newer than last run. Read-only against legacy data.
  const cursorIso = (await env.PITCHOS_CACHE.get(cursorKey(code))) || '1970-01-01T00:00:00Z';
  const rows = await supabase(env, 'GET',
    `/rest/v1/content_items?site_id=eq.${site.id}&created_at=gt.${encodeURIComponent(cursorIso)}` +
    `&order=created_at.asc&limit=${BATCH}` +
    `&select=id,title,summary,source_name,trust_tier,category,story_id,created_at`
  ) || [];

  if (rows.length === 0) {
    const status = { ts: new Date().toISOString(), candidates: 0, note: 'no new content_items' };
    await env.PITCHOS_CACHE.put(statusKey(code), JSON.stringify(status));
    return status;
  }

  // Reuse legacy fact extraction: read existing `facts` rows (design §6.1, no re-extraction).
  const ids = rows.map(r => r.id);
  const facts = await supabase(env, 'GET',
    `/rest/v1/facts?content_item_id=in.(${ids.join(',')})&select=content_item_id,story_type,entities,numbers,dates,delta_type,news_mode`
  ) || [];
  const factsByItem = new Map(facts.map(f => [f.content_item_id, f]));

  const tally = {
    candidates: rows.length, withFacts: 0, eventRoute: 0,
    materialDelta: 0, confirmingSkip: 0, synthesized: 0, capBlocked: cap.blocked,
  };
  const newArticles = [];
  let synthCount = 0;

  for (const item of rows) {
    const f = factsByItem.get(item.id) || null;
    if (f) tally.withFacts++;

    const deltaType = f?.delta_type || null;
    const mode      = f?.news_mode  || 'accretive';

    // Correlate to a topic (needed for the prior claim-track that claimTrackMoved diffs against).
    let topicInfo = null;
    if (f) {
      try { topicInfo = await correlateToTopic(item, f, site, env); }
      catch (e) { console.error(`correlate [${code}]:`, e.message); }
    }
    const priorTrack = topicInfo?.priorTrack || null;

    let doSynth = false, trigger = 'update', newTrack = null;

    if (!deltaType || deltaType === 'routine') {
      // Confirming repeat — no article, just bump confidence via claim-track update.
      tally.confirmingSkip++;
    } else if (mode === 'event' || ['milestone', 'statement', 'decision'].includes(deltaType)) {
      // Standalone newsworthy event — fire immediately (no claim-track diff needed).
      tally.eventRoute++;
      doSynth = true; trigger = deltaType;
    } else {
      // development or contradiction — check if claim-track actually moved (pure JS, zero cost).
      if (!cap.blocked && synthCount < SHADOW_SYNTH_CAP) {
        if (claimTrackMoved(priorTrack, f)) {
          doSynth = true; trigger = deltaType; tally.materialDelta++;
        } else {
          tally.confirmingSkip++;
        }
      }
    }

    if (doSynth && !cap.blocked && synthCount < SHADOW_SYNTH_CAP) {
      const art = await synthesizePhase(topicInfo?.topic, f, item, env, stats, trigger);
      if (art) {
        newArticles.push(art);
        synthCount++; tally.synthesized++;
        if (topicInfo?.topic) await persistPhase(topicInfo, newTrack, trigger, item, env).catch(() => {});
      }
    }
  }

  // Merge into the shadow pool (most-recent first, deduped by slug, capped).
  let pool = [];
  try { const p = JSON.parse((await env.PITCHOS_CACHE.get(shadowKey(code))) || 'null'); pool = p?.articles || []; } catch {}
  const seen = new Set(pool.map(a => a.slug));
  for (const a of newArticles) if (!seen.has(a.slug)) { pool.unshift(a); seen.add(a.slug); }
  pool = pool.slice(0, SHADOW_POOL_MAX);
  await env.PITCHOS_CACHE.put(shadowKey(code), JSON.stringify({ ready: pool.length > 0, articles: pool, updated_at: new Date().toISOString() }));

  // Advance cursor.
  const newCursor = rows[rows.length - 1].created_at;
  await env.PITCHOS_CACHE.put(cursorKey(code), newCursor);

  // Cost: count against the SHARED cap (same Anthropic bill) + a methodb-only counter for the compare page.
  const costUsd = Object.values(stats.phases).reduce((s, p) => s + (p.cost || 0), 0);
  if (costUsd > 0) {
    await addCost(env, costUsd).catch(() => {});
    const prev = parseFloat((await env.PITCHOS_CACHE.get(costKey())) || '0');
    await env.PITCHOS_CACHE.put(costKey(), String((prev + costUsd).toFixed(6))).catch(() => {});
  }

  const status = { ts: new Date().toISOString(), cursor: newCursor, ...tally, costUsd: +costUsd.toFixed(5), poolSize: pool.length, phases: stats.phases };
  await env.PITCHOS_CACHE.put(statusKey(code), JSON.stringify(status));
  console.log(`Method B [${code}]: ${JSON.stringify(tally)} cost=$${costUsd.toFixed(4)}`);
  return status;
}

// ─── STAGE 2: CORRELATE TO TOPIC ─────────────────────────────────────────────
// Entity-fingerprint match against open topics (shared player OR ≥2 shared clubs); creates a
// new topic on no match. TODO(Step 3): add the Haiku judge + branch_of/sequel_of edges.
async function correlateToTopic(item, facts, site, env) {
  const ents = facts?.entities || {};
  const players = (ents.players || []).map(s => String(s).toLowerCase());
  const clubs   = (ents.clubs   || []).map(s => String(s).toLowerCase());

  const open = await supabase(env, 'GET',
    `/rest/v1/topics?site_id=eq.${site.id}&state=eq.open&order=last_event_at.desc&limit=50` +
    `&select=id,story_type,entities,claim_tracks,title`
  ) || [];

  const overlaps = (t) => {
    const te = t.entities || {};
    const tp = (te.players || []).map(s => String(s).toLowerCase());
    const tc = (te.clubs   || []).map(s => String(s).toLowerCase());
    return players.some(p => tp.includes(p)) || clubs.filter(c => tc.includes(c)).length >= 2;
  };

  let topic = open.find(overlaps) || null;
  if (!topic) {
    const created = await supabase(env, 'POST', '/rest/v1/topics', {
      site_id: site.id, story_type: facts?.story_type || 'other', news_mode: 'accretive',
      entities: ents, claim_tracks: {}, title: (item.title || '').slice(0, 200),
    });
    topic = Array.isArray(created) ? created[0] : created;
  }

  // Claim-track key: the non-home club (competing-narrative axis), else 'main'.
  const home = (site.team_name || '').toLowerCase();
  const other = (ents.clubs || []).find(c => String(c).toLowerCase() !== home && String(c).toLowerCase());
  const trackKey = other ? String(other).toLowerCase().replace(/\s+/g, '_').slice(0, 40) : 'main';
  const priorTrack = (topic?.claim_tracks || {})[trackKey] || null;
  return { topic, trackKey, priorTrack };
}


// Semantic label for the synthesis prompt lede instruction.
const TRIGGER_LABELS = {
  milestone:    'kesinleşme/onay — bilinmeyen bir şey artık netleşti',
  statement:    'resmi açıklama veya kamuoyu tepkisi',
  decision:     'resmi karar — yetkili makam açıkladı',
  contradiction: 'tekzip veya çöküş — önceki haber geçersizleşti',
  development:  'süregelen gelişme — hikâye ilerledi',
  event:        'anlık haber',
};

// ─── STAGE 4: SYNTHESIZE FROM STORED FACTS (Sonnet) ──────────────────────────
// Writes from compact structured facts, NOT by re-fetching source text (design §4/§6).
async function synthesizePhase(topic, facts, item, env, stats, trigger) {
  const editorial = await getEditorialNotes(env, ['news', facts?.story_type || '']).catch(() => '');
  const triggerLabel = TRIGGER_LABELS[trigger] || trigger;
  const prompt = `${editorial}Sen Kartalix'in kıdemli spor editörüsün. Aşağıdaki DOĞRULANMIŞ OLGULARDAN özgün bir Türkçe haber yaz.

OLGULAR:
başlık ipucu: ${item.title || ''}
tip: ${facts?.story_type || ''}
varlıklar: ${JSON.stringify(facts?.entities || {})}
sayılar: ${JSON.stringify(facts?.numbers || {})}
tarihler: ${JSON.stringify(facts?.dates || {})}
gelişme tipi: ${triggerLabel}

KURALLAR:
- Çıktı tam olarak şu formatta:
BAŞLIK: [Türkçe manşet]

[haber gövdesi]
- 180–320 kelime, güçlü Kartalix sesi
- Lede: "${triggerLabel}" çerçevesinde en son gelişmeyi ilk cümlede ver
- Sadece olgulara dayan, uydurma; "habere göre" deme; emoji yok`;
  try {
    const res = await callClaude(env, MODEL_GENERATE, prompt, false, 1200);
    addUsagePhase(stats, res.usage, MODEL_GENERATE, 'methodb_synth');
    const raw = extractText(res.content).trim();
    const m = raw.match(/BAŞLIK:\s*(.+?)\n([\s\S]+)/);
    const title = (m ? m[1] : (item.title || '')).trim().slice(0, 200);
    const body  = (m ? m[2] : raw).trim();
    if (!body || body.length < 200) return null;
    return toShadowKVShape({ title, body, item, facts, topic, trigger });
  } catch (e) { console.error('synthesizePhase:', e.message); return null; }
}

// Persist the topic's updated claim-track + a phase row (new tables only — legacy never reads them).
async function persistPhase(topicInfo, newTrack, trigger, item, env) {
  const { topic, trackKey } = topicInfo;
  if (newTrack) {
    const tracks = { ...(topic.claim_tracks || {}), [trackKey]: newTrack };
    await supabase(env, 'PATCH', `/rest/v1/topics?id=eq.${topic.id}`, {
      claim_tracks: tracks, last_event_at: new Date().toISOString(),
    });
  }
  await supabase(env, 'POST', '/rest/v1/phases', {
    topic_id: topic.id, track_key: trackKey, seq: 0, trigger,
    delta: newTrack || null,
  });
}

// Build an object matching the frozen KV article contract (design §7) — `mb-` slug prefix
// avoids any collision with legacy slugs during the shadow window.
function toShadowKVShape({ title, body, item, facts, topic, trigger }) {
  const published_at = new Date().toISOString();
  const slug = 'mb-' + simpleHash((title || item.title || '') + published_at);
  return {
    title: title || item.title || '',
    summary: (body || '').replace(/\s+/g, ' ').slice(0, 280),
    full_body: body || '',
    source: 'Method B', source_name: item.source_name || '',
    source_url: '', url: '',
    category: facts?.story_type || item.category || 'Haber',
    nvs: 0, trust_tier: item.trust_tier || null,
    published_at, fetched_at: published_at,
    is_fresh: true, is_kartalix_content: true,
    publish_mode: 'methodb_synth', image_url: '', slug,
    _methodb: { topic_id: topic?.id || null, trigger },
  };
}

// ─── CLAIM-TRACK MOVED CHECK (pure JS, zero cost) ────────────────────────────
// Used for development/contradiction facts: true if any structured value in the
// new fact differs from the prior claim-track state.
export function claimTrackMoved(prior, facts) {
  if (!prior) return true; // first contribution always moves
  const pn = prior.numbers || {};
  const pd = prior.dates   || {};
  for (const [k, v] of Object.entries(facts?.numbers || {})) {
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    if (JSON.stringify(pn[k]) !== JSON.stringify(v)) return true;
  }
  for (const [k, v] of Object.entries(facts?.dates || {})) {
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    if (JSON.stringify(pd[k]) !== JSON.stringify(v)) return true;
  }
  return facts?.delta_type === 'contradiction';
}
