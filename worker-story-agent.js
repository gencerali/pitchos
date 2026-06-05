// worker-story-agent.js — Method B shadow worker (pitchos-story-agent).
//
// Fact-based news generator, run in parallel to the legacy pipeline. PRODUCER only:
// it reads already-ingested content_items + their facts, correlates them into topics,
// and (Step 2+) synthesizes phase articles into a SHADOW KV key. It never serves pages
// and never writes the live homepage. See docs/method-b-design.md.
//
// SAFETY: inert by default. runMethodB() no-ops unless KV flag `methodb:enabled` == "1".
// Shadow output goes to `articles:{site}:methodb`; the live key `articles:{site}` and the
// blue/green pointer `pipeline:active` are untouched until an explicit cutover.
//
// Shared CODE, isolated RUNTIME: same ./src/*.js modules as the legacy worker; own cron,
// own CPU/subrequest budget, own failure domain (design §5).

import { supabase, getActiveSites, addUsagePhase, flushCostStats } from './src/utils.js';

const ENABLED_KEY = 'methodb:enabled';            // "1" to arm the pipeline
const cursorKey   = (code) => `methodb:cursor:${code}`;   // ISO timestamp of last processed content_item
const statusKey   = (code) => `methodb:status:${code}`;   // last-run telemetry (for /status + /admin/pipeline)
const shadowKey   = (code) => `articles:${code}:methodb`; // shadow homepage pool (blue/green green-side)

const BATCH = 50; // content_items processed per site per run during dev

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
      const out = { enabled, sites: {} };
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
    // Manual trigger for dev tuning. Guarded by KV admin key.
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
  if (!armed && !opts.force) {
    return { skipped: 'methodb:enabled != 1' };
  }
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
  // Per-pipeline cost accounting (design §6.3). No LLM calls in the scaffold → cost ≈ 0;
  // Step 2 tags every callClaude via addUsagePhase(stats, usage, model, phase).
  const stats = { pipeline: 'methodb', costEur: 0, phases: {}, models: {} };

  // Cursor: process only content_items newer than last run. Read-only against legacy data
  // (we never mutate content_items during shadow — the cursor lives in KV).
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

  // Reuse legacy fact extraction: read existing facts rows rather than re-extracting (design §6.1).
  const ids = rows.map(r => r.id);
  const facts = await supabase(env, 'GET',
    `/rest/v1/facts?content_item_id=in.(${ids.join(',')})&select=content_item_id,story_type,entities,numbers,dates`
  ) || [];
  const factsByItem = new Map(facts.map(f => [f.content_item_id, f]));

  // Tally what the (Step 2) pipeline WOULD do — no LLM spend yet.
  const tally = { candidates: rows.length, withFacts: 0, eventRoute: 0, possibleDelta: 0, confirmingSkip: 0 };

  for (const item of rows) {
    const f = factsByItem.get(item.id) || null;
    if (f) tally.withFacts++;

    // ── Stage 1: EVENT / ACCRETIVE router (design §2.2) ──
    const mode = routeNewsMode(item, f);
    if (mode === 'event') { tally.eventRoute++; continue; }

    // ── Stage 2: correlate to topic ──  TODO(Step 2): entity fingerprint + judge → topics row
    // const topic = await correlateToTopic(item, f, site, env, stats);

    // ── Stage 3: delta detection with the CHEAP RULES PRE-FILTER FIRST (design §6.3) ──
    // Only a possible-delta would (in Step 2) spend a Haiku call; pure confirmations are free.
    const priorTrack = null; // TODO(Step 2): load from topic.claim_tracks[trackKey]
    const pre = rulesPreFilterDelta(priorTrack, f, item);
    if (pre.possibleDelta) {
      tally.possibleDelta++;
      // TODO(Step 2): const delta = await detectDeltaLLM(priorTrack, f, env, stats);
      //               if (delta.material) { open phase → synthesizePhase(...) into shadow pool }
    } else {
      tally.confirmingSkip++;
      // confirming repeat → bump confidence only, no article, no LLM. (Step 2)
    }
  }

  // Advance cursor to the newest row processed.
  const newCursor = rows[rows.length - 1].created_at;
  await env.PITCHOS_CACHE.put(cursorKey(code), newCursor);

  // Shadow pool placeholder. NOT marked ready — Step 2 fills this with real phase articles,
  // and the cutover gate requires ≥ minPool fresh items (design §7).
  const existingShadow = await env.PITCHOS_CACHE.get(shadowKey(code));
  if (!existingShadow) {
    await env.PITCHOS_CACHE.put(shadowKey(code), JSON.stringify({ ready: false, articles: [], updated_at: new Date().toISOString() }));
  }

  if (stats.costEur > 0) await flushCostStats(env, code, stats).catch(() => {});

  const status = { ts: new Date().toISOString(), cursor: newCursor, ...tally };
  await env.PITCHOS_CACHE.put(statusKey(code), JSON.stringify(status));
  console.log(`Method B [${code}]: ${JSON.stringify(tally)}`);
  return status;
}

// ─── STAGE 1: EVENT / ACCRETIVE ROUTER ───────────────────────────────────────
// One-shot punctual news (goal, card, official announcement) fires immediately;
// developing news accumulates. TODO(Step 2): fold in source trust for the fire-now decision.
export function routeNewsMode(item, facts) {
  const st = facts?.story_type || '';
  if (st === 'match_result' || st === 'squad') return 'event';
  const t = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  if (/\bresmi\b|resmen|açıkland|imzaladı|duyurdu|kadroya kat|gol|kırmızı kart|kart gördü/.test(t)) return 'event';
  return 'accretive';
}

// ─── STAGE 3: RULES PRE-FILTER BEFORE THE DELTA LLM (design §6.3) ─────────────
// Pure JS, no tokens. Returns whether the new fact MIGHT be a material change vs the
// topic's current claim-track. Only a `possibleDelta` is allowed to spend a Haiku diff
// in Step 2; pure `confirming` repeats never reach the model. This is the cost guardrail
// that keeps per-fact delta detection from dominating the €16/mo budget.
const STATUS_WORDS = [
  'ilgileniyor', 'görüşme', 'gorusme', 'teklif', 'anlaşma', 'anlasma', 'el sıkış', 'el sikis',
  'sağlık kontrol', 'saglik kontrol', 'imza', 'imzaladı', 'imzaladi', 'resmi', 'resmen',
  'kiralık', 'kiralik', 'bonservis', 'sakat', 'ameliyat', 'döndü', 'dondu', 'antrenman',
];
const CONTRADICTION_WORDS = [
  'yalanladı', 'yalanladi', 'iptal', 'vazgeçti', 'vazgecti', 'bitti', 'çıkmaza', 'cikmaza',
  'rest çekti', 'rest cekti', 'geri adım', 'geri adim', 'son buldu', 'reddetti', 'olmadı', 'olmadi',
];

export function rulesPreFilterDelta(priorTrack, facts, item) {
  const reasons = [];
  const text = `${item?.title || ''} ${item?.summary || ''}`.toLowerCase();

  // 1) contradiction markers → always a possible delta
  if (CONTRADICTION_WORDS.some(w => text.includes(w))) reasons.push('contradiction_marker');

  // 2) status keyword present that differs from the track's current status
  const presentStatus = STATUS_WORDS.filter(w => text.includes(w));
  if (presentStatus.length) {
    const cur = (priorTrack?.status || '').toLowerCase();
    if (!cur || !presentStatus.some(w => cur.includes(w))) reasons.push('status_change');
  }

  // 3) a new number or date that the track doesn't already hold
  const nums = facts?.numbers || {};
  const dates = facts?.dates || {};
  const hasNewValue = (obj, track) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v == null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (!track || track[k] == null || JSON.stringify(track[k]) !== JSON.stringify(v)) return true;
    }
    return false;
  };
  if (hasNewValue(nums, priorTrack?.numbers)) reasons.push('new_number');
  if (hasNewValue(dates, priorTrack?.dates)) reasons.push('new_date');

  // No prior track at all = the first contribution = initial phase (a delta by definition).
  if (!priorTrack) reasons.push('initial');

  return { possibleDelta: reasons.length > 0, reasons };
}
