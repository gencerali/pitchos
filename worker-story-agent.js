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
//    the rules pre-filter keeps pure confirmations from ever reaching an LLM.
//
// Shared CODE, isolated RUNTIME: same ./src/*.js modules as the legacy worker; own cron,
// own CPU/subrequest budget, own failure domain (design §5).

import {
  supabase, getActiveSites, callClaude, extractText, addUsagePhase, addCost, checkCostCap,
  getEditorialNotes, simpleHash, MODEL_FETCH, MODEL_GENERATE,
} from './src/utils.js';
import { fetchYouTubeTranscript } from './src/youtube.js';
import { extractFacts, computeFactTrust, incrementCorroboration } from './src/extractor.js';

// Maps content_items.trust_score (int) → TIER_BASE key for computeFactTrust.
// Mirrors the T1-T4 thresholds used by the site feed config.
function scoreTier(s) {
  if (!s || s <= 30) return 'T4';
  if (s <= 55)       return 'T3';
  if (s <= 75)       return 'T2';
  return 'T1';
}

const ENABLED_KEY = 'methodb:enabled';                       // "1" to arm the pipeline
const cursorKey   = (code) => `methodb:cursor:${code}`;      // ISO ts of last processed content_item
const statusKey   = (code) => `methodb:status:${code}`;      // last-run telemetry (/status + /admin/pipeline)
const shadowKey   = (code) => `articles:${code}:methodb`;    // shadow homepage pool (blue/green green-side)
const costKey     = ()     => `methodb:cost:${new Date().toISOString().slice(0, 7)}`; // monthly methodb-only spend

const BATCH            = 50;  // content_items scanned per site per cron run
const BATCH_MANUAL     = 150; // larger batch for manual /run (admin catch-up)
const SHADOW_SYNTH_CAP = 3;  // Sonnet syntheses per site per run (dev budget guardrail, design §6.1)
const SHADOW_POOL_MAX  = 60; // shadow homepage pool size
const YT_TRANSCRIPT_CAP    = 2;  // Supadata transcript fetches per story-agent run
const SUPADATA_MONTHLY_CAP = 80; // leave 20 credits for main worker (100/month total)
const supKey = () => `methodb:supadata:${new Date().toISOString().slice(0, 7)}`;

async function isSupadataAvailable(env) {
  if (!env.SUPADATA_API_KEY) return false;
  const used = parseInt((await env.PITCHOS_CACHE.get(supKey()).catch(() => '0')) || '0');
  return used < SUPADATA_MONTHLY_CAP;
}
async function incSupadataUsed(env) {
  const k = supKey();
  const used = parseInt((await env.PITCHOS_CACHE.get(k).catch(() => '0')) || '0');
  await env.PITCHOS_CACHE.put(k, String(used + 1), { expirationTtl: 40 * 24 * 3600 }).catch(() => {});
}

// ─── YOUTUBE EXTRACTION TIER DECISION ────────────────────────────────────────
//
// Question per video: "Is a newsworthy authority speaking, and does the transcript
// reveal something the title doesn't?"
//
// Tier 1 — Supadata transcript: authority is speaking, title is a teaser only.
// Tier 2 — title+summary only:  facts are already fully in the title.
// Skip   — no authoritative spoken content worth extracting.
//

// Press conference / post-match statement structure.
// These formats guarantee an official or coach is speaking at length.
const YT_PRESSER_RE = /basın toplantısı|maç sonu açıkl|maç sonu basın|maç sonu yoruml|açılış töreni/i;

// Named BJK principals: executives and head coach.
const YT_EXEC_RE = /önder özen|serdal adalı|ahmet nur çebi|vincenzo italiano\b|italian[oa]\b/i;

// Direct-quote pattern in title: person: 'quote' — title is a teaser, transcript has the rest.
const YT_QUOTE_IN_TITLE_RE = /:\s*["""''«»]/;

// Squad / attendance facts: title contains the complete fact, transcript adds nothing.
const YT_SQUAD_RE = /antrenmanda yer almadı|kadro dışı|antrenmana çıkmadı|ilk 11|muhtemel 11/i;

// Clear non-speech content: training montages, highlights, hype reels.
// Transcripts would just be auto-captioned narration, worthless for fact extraction.
const YT_VISUAL_RE = /günün antrenman|antrenman görüntü|antrenman video|maç özet|gol özet|highlights|kamera arkası|sezonu.*açıyoruz|sezon.*başlıyor/i;

// Decides whether to extract facts and whether a Supadata call is justified.
// Returns { extract: bool, needsTranscript: bool }.
function ytItemExtractDecision(item) {
  const title  = item.title  || '';
  const source = item.source_name || '';

  // ── Always skip: non-speech visual content ────────────────────────────────
  // Training montages, highlights — captions carry no factual value.
  if (YT_VISUAL_RE.test(title)) return { extract: false, needsTranscript: false };

  // ── Tier 1: Günayer (Rabona) — trusted weekly analyst ────────────────────
  // His analysis videos contain structured conclusions not visible in title.
  if (/günayer|rabona/i.test(source)) return { extract: true, needsTranscript: true };

  // ── Tier 1: Press conference / post-match presser ─────────────────────────
  // Structural guarantee: an official or coach is the speaker. Transcript has substance.
  if (YT_PRESSER_RE.test(title)) return { extract: true, needsTranscript: true };

  // ── Tier 1: Named exec/coach + verbatim quote in title ────────────────────
  // e.g. "Önder Özen: '3 isimle finale yaklaştık!'" — quote is a teaser, transcript has more.
  if (YT_EXEC_RE.test(title) && YT_QUOTE_IN_TITLE_RE.test(title)) return { extract: true, needsTranscript: true };

  // ── Tier 2: Named exec/coach mentioned, no direct quote ───────────────────
  // e.g. "İtaliano futbolcularla yemekte buluştu" — the event is the fact, title covers it.
  if (YT_EXEC_RE.test(title)) return { extract: true, needsTranscript: false };

  // ── Tier 2: Squad / training attendance ───────────────────────────────────
  // e.g. "Musrati, Onana... antrenmanda yer almadı" — title lists the complete fact.
  if (YT_SQUAD_RE.test(title)) return { extract: true, needsTranscript: false };

  // ── Skip: everything else ─────────────────────────────────────────────────
  // Journalist takes ("aktardı"), pundit debates, transfer speculation panels,
  // generic hype videos — no authoritative spoken content.
  return { extract: false, needsTranscript: false };
}

// Fetch transcript + run unified fact extraction for a youtube_embed content_item.
// Delegates to src/extractor.js which persists the canonical row (grounding_summary
// in Turkish, key_quotes, source_type, fact_trust, etc.) and writes fact_lineage.
// Returns primary claim object or null on failure.
async function extractYtItemFacts(item, site, env, stats, needsTranscript = true) {
  let text = [item.title, item.summary].filter(Boolean).join('. ');
  let sourceType = 'yt_title';

  if (needsTranscript) {
    const videoId = (item.original_url || '').match(/(?:[?&]v=|\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];
    if (videoId && (await isSupadataAvailable(env))) {
      const transcript = await fetchYouTubeTranscript(videoId, env).catch(() => null);
      if (transcript && transcript.length > 100) {
        text = `${item.title}.\n\n${transcript}`;
        sourceType = 'yt_transcript';
        await incSupadataUsed(env);
        stats.ytTranscripts = (stats.ytTranscripts || 0) + 1;
      }
    }
  }

  const enrichedItem = { ...item, site_id: site.id, trust_tier: scoreTier(item.trust_score) };
  const claims = await extractFacts({ text, sourceType, item: enrichedItem, env });
  if (!claims.length) return null;

  const primary = claims[0];
  return {
    ...primary,
    _synthetic: true,
    _quotes:    primary.key_quotes || [],
  };
}

export default {
  // Hourly cron (wrangler-story.toml). Reacts to ingested content; no freshness polling.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMethodB(env, ctx));
  },

  // Minimal control surface. No public routes are bound to this worker (workers.dev only).
  async fetch(request, env, ctx) {
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
      // Return immediately — processing runs in background via waitUntil.
      // Caller polls /admin/pipeline for results rather than waiting on this response.
      ctx.waitUntil(runMethodB(env, null, { force: true }));
      return Response.json({ ok: true, queued: true });
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
  if (!sites.length) {
    const errStatus = { ts: new Date().toISOString(), error: 'getActiveSites returned [] — SUPABASE_SERVICE_KEY not set for this worker?' };
    console.error('Method B:', errStatus.error);
    // Write a diagnostic status for every known site code so the admin page isn't blank.
    for (const code of ['BJK', 'TEST']) {
      await env.PITCHOS_CACHE.put(statusKey(code), JSON.stringify(errStatus)).catch(() => {});
    }
    return errStatus;
  }
  const results = {};
  for (const site of sites) {
    try {
      results[site.short_code] = await processSiteMethodB(site, env, opts);
    } catch (e) {
      console.error(`Method B [${site.short_code}] failed:`, e.message);
      const errStatus = { ts: new Date().toISOString(), error: e.message };
      await env.PITCHOS_CACHE.put(statusKey(site.short_code), JSON.stringify(errStatus)).catch(() => {});
      results[site.short_code] = errStatus;
    }
  }
  return results;
}

async function processSiteMethodB(site, env, opts = {}) {
  const code = site.short_code;
  const batch = opts.force ? BATCH_MANUAL : BATCH;
  const stats = { phases: {}, models: {} };
  const cap = await checkCostCap(env);

  // Out of monthly budget → do nothing and DON'T advance the cursor, so this batch is
  // retried once budget frees up (rather than silently skipped forever).
  if (cap.blocked) {
    const status = { ts: new Date().toISOString(), skipped: 'cost cap reached', cap: cap.cap, spent: +cap.current.toFixed(4) };
    await env.PITCHOS_CACHE.put(statusKey(code), JSON.stringify(status));
    return status;
  }

  // Cursor: only content_items newer than last run. Default = 30 days ago so the initial
  // run hits recently-ingested items (which have extracted facts) rather than crawling
  // through the entire historical backlog which has no facts and produces nothing.
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const cursorIso = (await env.PITCHOS_CACHE.get(cursorKey(code))) || sevenDaysAgo;
  const rows = await supabase(env, 'GET',
    `/rest/v1/content_items?site_id=eq.${site.id}&created_at=gt.${encodeURIComponent(cursorIso)}` +
    `&order=created_at.asc&limit=${batch}` +
    `&select=id,title,summary,source_name,trust_score,category,story_id,created_at,content_type,original_url`
  ) || [];

  if (rows.length === 0) {
    const status = { ts: new Date().toISOString(), cursorUsed: cursorIso, candidates: 0, note: 'no new content_items' };
    await env.PITCHOS_CACHE.put(statusKey(code), JSON.stringify(status));
    return status;
  }

  // Reuse legacy fact extraction: read existing `facts` rows (design §6.1, no re-extraction).
  // Chunk into 50 per request to stay under URL length limits on PostgREST/Kong.
  const ids = rows.map(r => r.id);
  const FACTS_CHUNK = 50;
  const factChunks = [];
  for (let i = 0; i < ids.length; i += FACTS_CHUNK) {
    factChunks.push(ids.slice(i, i + FACTS_CHUNK));
  }
  const factsRaw = (await Promise.all(
    factChunks.map(chunk => supabase(env, 'GET',
      `/rest/v1/facts?content_item_id=in.(${chunk.join(',')})&select=content_item_id,story_type,entities,numbers,dates,grounding_summary,key_quotes,fact_trust,source_type,claim_status`
    ).then(r => r || []))
  )).flat();
  const factsByItem = new Map(factsRaw.map(f => [f.content_item_id, {
    ...f,
    _quotes: Array.isArray(f.key_quotes) ? f.key_quotes : [],
  }]));

  const tally = {
    candidates: rows.length, withFacts: 0, eventRoute: 0,
    deltaChecks: 0, materialDelta: 0, confirmingSkip: 0, synthesized: 0, fanOut: 0, capBlocked: cap.blocked,
  };
  const newArticles = [];
  let synthCount = 0;
  let ytTranscriptCount = 0;
  // Within-run dedup: prevents two content_items about the same topic+entity from both
  // synthesizing in the same batch (the pool upsert handles across-run dedup via stable slug).
  const synthesizedThisRun = new Set();

  for (const item of rows) {
    let f = factsByItem.get(item.id) || null;
    if (f) tally.withFacts++;

    // youtube_embed items have no extracted facts — decide per-item whether to extract and
    // whether a Supadata transcript call is worth spending (capped at YT_TRANSCRIPT_CAP/run).
    if (!f && item.content_type === 'youtube_embed') {
      const { extract, needsTranscript } = ytItemExtractDecision(item);
      if (extract && (!needsTranscript || ytTranscriptCount < YT_TRANSCRIPT_CAP)) {
        f = await extractYtItemFacts(item, site, env, stats, needsTranscript).catch(e => {
          console.error(`YT fact extract [${item.id}]:`, e.message);
          return null;
        });
        if (f) {
          tally.withFacts++;
          if (needsTranscript) ytTranscriptCount++;
          tally.ytExtracted = (tally.ytExtracted || 0) + 1;
        }
      }
    }

    const mode = routeNewsMode(item, f);

    // Correlate to a topic (needed for the prior claim-track that delta detection diffs against).
    let topicInfo = null;
    if (f) {
      try { topicInfo = await correlateToTopic(item, f, site, env, stats); }
      catch (e) { console.error(`correlate [${code}]:`, e.message); }
    }
    const priorTracks = topicInfo?.priorTracks || { main: null };
    const hasAnyPrior = Object.values(priorTracks).some(t => t !== null);

    let doSynth = false, trigger = 'update', newTracks = {};

    if (!f) {
      // No extracted facts — nothing to correlate or synthesize. Advance cursor silently.
    } else if (mode === 'event') {
      tally.eventRoute++;
      doSynth = true; trigger = 'event';
    } else if (!hasAnyPrior) {
      // All tracks new — always material/initial; no delta LLM needed.
      doSynth = true; trigger = 'initial'; tally.materialDelta++;
    } else {
      // Pre-filter: check if any track shows a possible delta before spending the Haiku call.
      const anyPossible = Object.values(priorTracks).some(prior =>
        rulesPreFilterDelta(prior, f, item).possibleDelta
      );
      if (anyPossible) {
        if (cap.blocked || synthCount >= SHADOW_SYNTH_CAP) {
          // budget/cap reached this run — leave cursor to retry next run
        } else {
          tally.deltaChecks++;
          const deltaResult = await detectDeltaLLMMulti(priorTracks, f, item, env, stats);
          const moving = Object.entries(deltaResult?.tracks || {}).filter(([, d]) => d?.material);
          if (moving.length) {
            doSynth = true;
            trigger = moving[0][1].trigger || 'update';
            newTracks = Object.fromEntries(moving.map(([k, d]) => [k, d.new_track || null]));
            tally.materialDelta++;
          } else {
            tally.confirmingSkip++;
            // Corroboration: same entity, different source → Layer 4 trust increment.
            if (f?.entity_fingerprint && item.source_name)
              incrementCorroboration(f.entity_fingerprint, item.source_name, item.id, env).catch(() => {});
          }
        }
      } else {
        tally.confirmingSkip++;
        // Corroboration: rules pre-filter ruled out material delta → still a corroborating signal.
        if (f?.entity_fingerprint && item.source_name)
          incrementCorroboration(f.entity_fingerprint, item.source_name, item.id, env).catch(() => {});
      }
    }

    // Staleness gate: content_item age is the ground truth for freshness.
    // If the source published more than 7 days ago it is old news regardless of what
    // the facts say — this catches retrospective articles that re-surface stale transfers.
    if (doSynth && item.created_at) {
      const ageMs = Date.now() - new Date(item.created_at).getTime();
      if (ageMs > 7 * 24 * 3600 * 1000) { doSynth = false; tally.confirmingSkip++; }
    }

    if (doSynth && f && !cap.blocked && synthCount < SHADOW_SYNTH_CAP) {
      const allTracks = topicInfo?.topic?.claim_tracks || {};
      const fanEntities = buildFanEntities(topicInfo, newTracks, f);
      // Use fact_trust from unified extractor when available; fall back to factTrust
      // for older rows that predate the MB-NEXT-3 migration.
      const factTrust = f?.fact_trust > 0
        ? f.fact_trust
        : computeFactTrust({ ...f, _sourceType: f?.source_type || 'rss_summary' },
                            { ...item, trust_tier: scoreTier(item.trust_score) });
      let phaseWritten = false;

      for (const entity of fanEntities) {
        if (synthCount >= SHADOW_SYNTH_CAP) break;

        // Per-(topic, item, entity) dedup — survives re-runs across cron ticks.
        const dedupKey = topicInfo?.topic?.id
          ? `synth:mb:${topicInfo.topic.id}:${item.id}:${entity}`
          : null;
        if (dedupKey && await env.PITCHOS_CACHE.get(dedupKey).catch(() => null)) continue;
        // Skip if another item in this same batch already synthesized for this topic+entity.
        // Fall back to normalized primary player name so two items about the same player
        // can't both synthesize even when topic.id is null (topic creation failed).
        const primaryEnt = normEnt(f?.entities?.players?.[0] || f?.entities?.clubs?.[0] || item.id);
        const runKey = `${topicInfo?.topic?.id || primaryEnt}:${entity}`;
        if (synthesizedThisRun.has(runKey)) continue;
        synthesizedThisRun.add(runKey);

        // Cooldown gate for accretive updates only (not events/initials).
        // Low-trust content (factTrust < 50) is gated to max 1 article per topic per 3h.
        // High-trust or concrete-fact content bypasses so breaking news always gets through.
        if (trigger === 'update' && factTrust < 50) {
          const cooldownKey = `methodb:cooldown:${topicInfo?.topic?.id || primaryEnt}:${entity}`;
          const onCooldown = await env.PITCHOS_CACHE.get(cooldownKey).catch(() => null);
          if (onCooldown) { tally.confirmingSkip++; continue; }
        }

        const art = await synthesizePhase(topicInfo?.topic, f, item, env, stats, trigger, allTracks, entity, factTrust);
        if (art) {
          newArticles.push(art);
          synthCount++; tally.synthesized++;
          if (phaseWritten) tally.fanOut++; // second+ article from same phase = fan-out
          if (dedupKey) await env.PITCHOS_CACHE.put(dedupKey, '1', { expirationTtl: 86400 * 30 }).catch(() => {});
          if (trigger === 'update' && factTrust < 50) {
            const cooldownKey = `methodb:cooldown:${topicInfo?.topic?.id || primaryEnt}:${entity}`;
            await env.PITCHOS_CACHE.put(cooldownKey, '1', { expirationTtl: 3 * 3600 }).catch(() => {});
          }
          if (!phaseWritten && topicInfo?.topic) {
            await persistPhase(topicInfo, newTracks, trigger, item, env).catch(() => {});
            phaseWritten = true;
          }
        }
      }
    }
  }

  // Merge into the shadow pool: upsert by slug (stable per topic+entity) so re-runs replace
  // stale versions rather than appending duplicates.
  let pool = [];
  try { const p = JSON.parse((await env.PITCHOS_CACHE.get(shadowKey(code))) || 'null'); pool = p?.articles || []; } catch {}
  const poolMap = new Map(pool.map(a => [a.slug, a]));
  for (const a of newArticles) poolMap.set(a.slug, a);

  // Secondary dedup by (topic_id, focus_entity): guards against topic correlation being
  // intermittent across runs — same story can get slug from topic.id one run and from
  // player name the next, producing two entries. Keep the newest per topic+entity pair.
  const topicEntitySeen = new Map();
  for (const [slug, art] of poolMap) {
    const tid = art._methodb?.topic_id;
    if (!tid) continue;
    const key = `${tid}:${art._methodb?.focus_entity || 'main'}`;
    const prev = topicEntitySeen.get(key);
    if (!prev) { topicEntitySeen.set(key, { slug, t: art.published_at }); continue; }
    if (new Date(art.published_at) >= new Date(prev.t)) {
      poolMap.delete(prev.slug); topicEntitySeen.set(key, { slug, t: art.published_at });
    } else {
      poolMap.delete(slug);
    }
  }
  // Tertiary title dedup: collapses identical-title articles that slipped through
  // (e.g. two sources for the same story when topic correlation failed for both).
  const titleSeen = new Map();
  for (const [slug, art] of poolMap) {
    const normTitle = (art.title || '').toLowerCase().slice(0, 80);
    const prev = titleSeen.get(normTitle);
    if (!prev) { titleSeen.set(normTitle, { slug, t: art.published_at }); continue; }
    if (new Date(art.published_at) >= new Date(prev.t)) {
      poolMap.delete(prev.slug); titleSeen.set(normTitle, { slug, t: art.published_at });
    } else {
      poolMap.delete(slug);
    }
  }

  pool = [...poolMap.values()]
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .slice(0, SHADOW_POOL_MAX);
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

  const status = { ts: new Date().toISOString(), cursorUsed: cursorIso, cursor: newCursor, ...tally, costUsd: +costUsd.toFixed(5), poolSize: pool.length, phases: stats.phases };
  await env.PITCHOS_CACHE.put(statusKey(code), JSON.stringify(status));
  console.log(`Method B [${code}]: ${JSON.stringify(tally)} cost=$${costUsd.toFixed(4)}`);
  return status;
}

// Normalize Turkish characters for robust entity matching across LLM outputs.
// "Bayazıt" === "Bayazit", "İlhan" === "ilhan", etc.
function normEnt(s) {
  return String(s).toLowerCase()
    .replace(/İ/g, 'i').replace(/ı/g, 'i')
    .replace(/Ş/g, 's').replace(/ş/g, 's')
    .replace(/Ğ/g, 'g').replace(/ğ/g, 'g')
    .replace(/Ç/g, 'c').replace(/ç/g, 'c')
    .replace(/Ö/g, 'o').replace(/ö/g, 'o')
    .replace(/Ü/g, 'u').replace(/ü/g, 'u');
}

// ─── STAGE 2: CORRELATE TO TOPIC ─────────────────────────────────────────────
// Entity-fingerprint match against open topics (shared player OR ≥2 shared clubs); creates a
// new topic on no match. On creation, runs a Haiku judge to detect branch_of / sequel_of
// edges against open + recently-closed topics (design §2.3, Step 2).
async function correlateToTopic(item, facts, site, env, stats) {
  const ents = facts?.entities || {};
  const players = (ents.players || []).map(normEnt);
  const clubs   = (ents.clubs   || []).map(normEnt);

  const entityOverlaps = (t) => {
    const te = t.entities || {};
    const tp = (te.players || []).map(normEnt);
    const tc = (te.clubs   || []).map(normEnt);
    return players.some(p => tp.includes(p)) || clubs.filter(c => tc.includes(c)).length >= 2;
  };

  const [open, recentClosed] = await Promise.all([
    supabase(env, 'GET',
      `/rest/v1/topics?site_id=eq.${site.id}&state=eq.open&order=last_event_at.desc&limit=50` +
      `&select=id,story_type,entities,claim_tracks,title,state`
    ).then(r => r || []),
    supabase(env, 'GET',
      `/rest/v1/topics?site_id=eq.${site.id}&state=eq.closed&order=last_event_at.desc&limit=20` +
      `&select=id,story_type,entities,claim_tracks,title,state`
    ).then(r => r || []),
  ]);

  let topic = open.find(entityOverlaps) || null;
  let isNewTopic = false;

  if (!topic) {
    const created = await supabase(env, 'POST', '/rest/v1/topics', {
      site_id: site.id, story_type: facts?.story_type || 'other', news_mode: 'accretive',
      entities: ents, claim_tracks: {}, title: (item.title || '').slice(0, 200),
    });
    topic = Array.isArray(created) ? created[0] : created;
    isNewTopic = true;
  }

  // Step 2: edge detection — only for new topics (existing topics already have their anchor).
  if (isNewTopic && topic?.id) {
    try {
      await detectAndPersistEdge(topic, item, facts, [...open, ...recentClosed], env, stats);
    } catch (e) { console.error('edge detection:', e.message); }
  }

  // Step 3: all non-home clubs → one track per competing club, else 'main'.
  const home = (site.team_name || '').toLowerCase();
  const otherClubs = [...new Set(
    (ents.clubs || [])
      .filter(c => String(c).toLowerCase() !== home)
      .map(c => String(c).toLowerCase().replace(/\s+/g, '_').slice(0, 40))
  )];
  const trackKeys = otherClubs.length ? otherClubs : ['main'];
  const priorTracks = Object.fromEntries(
    trackKeys.map(k => [k, (topic?.claim_tracks || {})[k] || null])
  );
  return { topic, trackKeys, priorTracks, trackKey: trackKeys[0], priorTrack: priorTracks[trackKeys[0]] };
}

// ─── STEP 2: BRANCH / SEQUEL EDGE DETECTION ──────────────────────────────────

const BRANCH_SIGNALS = [
  'soruşturma', 'disiplin', 'şike', 'dava', 'ceza', 'ihraç', 'skandal', 'suçlama',
  'tff', 'pfdk', 'tahkim', 'kovuşturma', 'gözaltı', 'tutuklama',
];
const SEQUEL_SIGNALS = [
  'arayışı', 'yeni hoca', 'yeni teknik', 'döndü', 'iyileşti', 'transfer sonrası',
  'yerine', 'koltuğuna', 'görevine başla', 'imzaladı resmen',
];

// Rules pre-filter: identify candidate parents before spending a Haiku call.
function findEdgeCandidates(newTopic, item) {
  return (item._edgeCandidatePool || []).filter(t => {
    if (t.id === newTopic.id) return false;
    const te = t.entities || {};
    const newEnts = newTopic.entities || {};
    const sharedPlayer = (newEnts.players || []).some(p =>
      (te.players || []).map(s => s.toLowerCase()).includes(String(p).toLowerCase())
    );
    const sharedClubs = (newEnts.clubs || []).filter(c =>
      (te.clubs || []).map(s => s.toLowerCase()).includes(String(c).toLowerCase())
    ).length >= 1;
    return sharedPlayer || sharedClubs;
  });
}

async function detectAndPersistEdge(newTopic, item, facts, allCandidates, env, stats) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  const hasBranchSignal = BRANCH_SIGNALS.some(w => text.includes(w));
  const hasSequelSignal = SEQUEL_SIGNALS.some(w => text.includes(w));
  if (!hasBranchSignal && !hasSequelSignal) return;

  // Attach candidate pool for findEdgeCandidates
  item._edgeCandidatePool = allCandidates;
  const candidates = findEdgeCandidates(newTopic, item)
    .filter(t => {
      if (hasBranchSignal && t.story_type !== newTopic.story_type) return true;
      if (hasSequelSignal) return true;
      return false;
    })
    .slice(0, 5);
  delete item._edgeCandidatePool;

  if (!candidates.length) return;

  const prompt = `You decide if a new football news topic is a BRANCH or SEQUEL of an existing topic.

NEW TOPIC:
type: ${newTopic.story_type}
entities: ${JSON.stringify(newTopic.entities)}
headline: ${item.title || ''}

CANDIDATE PARENTS (≤5):
${candidates.map((t, i) => `${i + 1}. id=${t.id} type=${t.story_type} state=${t.state || 'open'} title=${t.title || ''}`).join('\n')}

branch_of: new topic detaches from parent and changes type (VAR dispute → TFF investigation; match event → scandal).
sequel_of: parent was resolved/closed and new topic naturally follows (coach sacked → coach search; injury → return).

Return ONLY JSON — no explanation:
{"edge_type":"branch_of"|"sequel_of"|null,"parent_topic_id":"<uuid>|null","confidence":0-100}
Only non-null if confidence ≥ 70.`;

  const res = await callClaude(env, MODEL_FETCH, prompt, false, 120);
  addUsagePhase(stats, res.usage, MODEL_FETCH, 'methodb_edge');
  const m = extractText(res.content).match(/\{[\s\S]*?\}/);
  if (!m) return;
  const edge = JSON.parse(m[0]);
  if (!edge.edge_type || !edge.parent_topic_id || edge.confidence < 70) return;

  await Promise.all([
    supabase(env, 'POST', '/rest/v1/topic_edges', {
      from_topic_id: newTopic.id,
      to_topic_id: edge.parent_topic_id,
      edge_type: edge.edge_type,
    }),
    supabase(env, 'PATCH', `/rest/v1/topics?id=eq.${newTopic.id}`, {
      parent_topic_ids: [edge.parent_topic_id],
    }),
  ]);
  console.log(`EDGE [${edge.edge_type}] ${newTopic.id} → ${edge.parent_topic_id} (conf=${edge.confidence})`);
}

// ─── STAGE 3: DELTA DETECTION (Haiku, behind the rules pre-filter) ────────────
// One Haiku call covers all tracks — same token cost as a single-track call.
async function detectDeltaLLMMulti(priorTracks, facts, item, env, stats) {
  const trackList = Object.entries(priorTracks);

  if (trackList.length === 1) {
    // Single track — use the simpler single-track prompt to save tokens.
    const [key, prior] = trackList[0];
    const prompt = `You compare a football news fact against a story's CURRENT known state and decide if it is a MATERIAL update.

CURRENT TRACK STATE (may be null = first time):
${JSON.stringify(prior)}

NEW FACT:
title: ${item.title || ''}
type: ${facts?.story_type || ''}
entities: ${JSON.stringify(facts?.entities || {})}
numbers: ${JSON.stringify(facts?.numbers || {})}
dates: ${JSON.stringify(facts?.dates || {})}

Return ONLY JSON (no explanation):
{"tracks":{"${key}":{"material":true|false,"trigger":"initial"|"update"|"contradiction","new_track":{"status":"...","numbers":{},"dates":{},"confidence":0}}}}
material=true ONLY if the fact changes status, a number/date, or contradicts the current state. A repeat = material:false.`;
    try {
      const res = await callClaude(env, MODEL_FETCH, prompt, false, 400);
      addUsagePhase(stats, res.usage, MODEL_FETCH, 'methodb_delta');
      const m = extractText(res.content).match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : { tracks: {} };
    } catch (e) { console.error('detectDeltaLLMMulti:', e.message); return { tracks: {} }; }
  }

  // Multiple tracks — batch them in one call.
  const prompt = `You compare a football news fact against multiple story claim-tracks and decide, for EACH track, whether this fact is a MATERIAL update.

NEW FACT:
title: ${item.title || ''}
type: ${facts?.story_type || ''}
entities: ${JSON.stringify(facts?.entities || {})}
numbers: ${JSON.stringify(facts?.numbers || {})}
dates: ${JSON.stringify(facts?.dates || {})}

CLAIM TRACKS (one per competing club/narrative):
${trackList.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}

For each track: material=true only if the fact changes status, a number/date, or contradicts the track state. A repeat = false.
Return ONLY valid JSON (no explanation):
{"tracks":{"<track_key>":{"material":true|false,"trigger":"initial"|"update"|"contradiction","new_track":{"status":"...","numbers":{},"dates":{},"confidence":0}}}}`;
  try {
    const res = await callClaude(env, MODEL_FETCH, prompt, false, 600);
    addUsagePhase(stats, res.usage, MODEL_FETCH, 'methodb_delta');
    const m = extractText(res.content).match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { tracks: {} };
  } catch (e) { console.error('detectDeltaLLMMulti:', e.message); return { tracks: {} }; }
}

// ─── STEP 4: FAN-OUT ENTITY LIST ─────────────────────────────────────────────
// Fan-out ONLY when there are 2+ genuinely competing clubs (e.g. "Amrabat → BJK" vs
// "Amrabat → Galatasaray"). A single-club story or a player-vs-club split writes ONE
// article — not one per entity — to prevent near-identical duplicates in the pool.
function buildFanEntities(topicInfo, newTracks, facts) {
  const normalize = s => String(s).toLowerCase().replace(/\s+/g, '_').slice(0, 40);

  // Clubs with a moving track this item (delta-detected).
  const movingClubs = Object.keys(newTracks || {}).filter(k => k !== 'main').map(normalize);
  if (movingClubs.length >= 2) return movingClubs.slice(0, 3); // genuine competition

  // All known track keys when everything is new (initial, newTracks is empty).
  if (!movingClubs.length && topicInfo?.trackKeys) {
    const otherClubs = (topicInfo.trackKeys || []).filter(k => k !== 'main').map(normalize);
    if (otherClubs.length >= 2) return otherClubs.slice(0, 3); // e.g. two clubs in same race
    if (otherClubs.length === 1) return [otherClubs[0]];       // one competing club → one article
  }

  // Single or no competing club → one article from the main/club perspective (no player split).
  if (movingClubs.length === 1) return [movingClubs[0]];
  return ['main'];
}

// ─── STAGE 4: SYNTHESIZE FROM STORED FACTS (Sonnet) ──────────────────────────
// Writes from compact structured facts, NOT by re-fetching source text (design §4/§6).
// allTracks: full claim_tracks map — competing-narrative context.
// focusEntity: when set (fan-out), the article is written from this entity's perspective.
async function synthesizePhase(topic, facts, item, env, stats, trigger, allTracks = {}, focusEntity = null, factTrust = 0) {
  const editorial = await getEditorialNotes(env, ['news', facts?.story_type || '']).catch(() => '');
  const competing = Object.entries(allTracks)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  const entityLine = focusEntity && focusEntity !== 'main'
    ? `\nodak varlık: ${focusEntity} (haberi bu varlığın perspektifinden yaz)`
    : '';
  const prompt = `${editorial}Sen Kartalix'in kıdemli spor muhabirissin — Beşiktaş taraftarı için yazan, sıcak, heyecan verici, güvenilir bir sessin.

DOĞRULANMIŞ OLGULAR (YALNIZCA BUNLARI KULLAN):
başlık ipucu: ${item.title || ''}
tip: ${facts?.story_type || ''}
varlıklar: ${JSON.stringify(facts?.entities || {})}
sayılar: ${JSON.stringify(facts?.numbers || {})}
tarihler: ${JSON.stringify(facts?.dates || {})}${facts?.grounding_summary ? `\nözet: ${facts.grounding_summary}` : ''}${facts?._quotes?.length ? `\nalıntılar: ${JSON.stringify(facts._quotes)}` : ''}
gelişme tipi: ${trigger}${entityLine}${competing ? `\n\nREKABET EDEN ANLATIMLAR (bağlam):\n${competing}` : ''}

YAZIM KURALLARI:
- Çıktın YALNIZCA şu formattan oluşmalı — başka hiçbir şey ekleme:
BAŞLIK: [Türkçe manşet]

[haber gövdesi]
- 60–160 kelime — sadece kaç kelime gerekiyorsa o kadar yaz; doldurucu cümle ekleme
- Taraftara seslen: sevinç, öfke, beklenti — resmi duyuru veya analist raporu değil
- Lede: en önemli gelişmeyi ilk cümlede ver (delta = ${trigger})
- YALNIZCA yukarıdaki olgulara dayan; hoca taktikleri, sözleşme detayları ve diğer ayrıntılar için OLGULARDA olmayan hiçbir şeyi çıkarsama veya uydurma
- "henüz netleşmedi", "spekülatif", "doğrulanamadı" gibi iç süreç ifadelerini metne KOYMA — olguları güçlü yaz, çekinceleri taraftara gösterme
- "habere göre" deme; emoji yok
- Son olarak: editöryal karar notu, "devam etmemi ister misiniz?" veya talimat yorumu YAZMA — görevi yalnızca yukarıdaki haberi yazmak`;
  try {
    const res = await callClaude(env, MODEL_GENERATE, prompt, false, 1200);
    addUsagePhase(stats, res.usage, MODEL_GENERATE, 'methodb_synth');
    const raw = extractText(res.content).trim();
    const m = raw.match(/BAŞLIK:\s*(.+?)\n([\s\S]+)/);
    const title = (m ? m[1] : (item.title || '')).trim().slice(0, 200);
    const body  = (m ? m[2] : raw).trim();
    if (!body || body.length < 60) return null;
    // Reject if model output editorial reasoning instead of an article.
    const DECISION_SIGNALS = [
      /devam etmemi ister misiniz/i, /çatışma tespit edildi/i,
      /editör talimat/i, /yayınlamıyorum/i, /çelişen.*kural/i,
      /\*\*karar:\*\*/i, /odak varlık:.*galatasaray/i,
    ];
    if (DECISION_SIGNALS.some(p => p.test(body))) {
      console.warn('synthesizePhase: rejected chain-of-thought output');
      return null;
    }
    return toShadowKVShape({ title, body, item, facts, topic, trigger, focusEntity, factTrust });
  } catch (e) { console.error('synthesizePhase:', e.message); return null; }
}

// Persist the topic's updated claim-tracks + a phase row (new tables only — legacy never reads them).
// newTracks: map of trackKey → new_track (only the moving tracks returned by detectDeltaLLMMulti).
async function persistPhase(topicInfo, newTracks, trigger, item, env) {
  const { topic, trackKey } = topicInfo;
  const hasUpdates = newTracks && Object.keys(newTracks).length > 0;
  if (hasUpdates) {
    const tracks = { ...(topic.claim_tracks || {}), ...newTracks };
    await supabase(env, 'PATCH', `/rest/v1/topics?id=eq.${topic.id}`, {
      claim_tracks: tracks, last_event_at: new Date().toISOString(),
    });
  }
  const seqRows = await supabase(env, 'GET',
    `/rest/v1/phases?topic_id=eq.${topic.id}&select=seq&order=seq.desc&limit=1`
  ).catch(() => []);
  const nextSeq = ((seqRows?.[0]?.seq ?? -1) + 1);
  // Primary track for the phase row: first moving track, or the topic's default track.
  const primaryTrack = (hasUpdates ? Object.keys(newTracks)[0] : null) || trackKey;
  await supabase(env, 'POST', '/rest/v1/phases', {
    topic_id: topic.id, track_key: primaryTrack, seq: nextSeq, trigger,
    delta: (hasUpdates ? newTracks[primaryTrack] : null) || null,
    opened_by_fact_id: item?.id || null,
  });
}

// Build an object matching the frozen KV article contract (design §7) — `mb-` slug prefix
// avoids any collision with legacy slugs during the shadow window.
function toShadowKVShape({ title, body, item, facts, topic, trigger, focusEntity = null, factTrust = 0 }) {
  const published_at = new Date().toISOString();
  const entityKey = focusEntity || 'main';
  // Stable slug: topic.id is the primary key (survives re-runs of the same story).
  // Fall back to normalized primary entity name — much more stable than title, so two
  // items about the same player still get the same slug even when topic creation failed.
  const stableBase = topic?.id
    || normEnt(facts?.entities?.players?.[0] || '')
    || (facts?._synthetic ? item.id : normEnt(facts?.entities?.clubs?.[0] || ''))
    || (item.title || '').slice(0, 60);
  const slug = 'mb-' + simpleHash(stableBase + ':' + entityKey);
  return {
    title: title || item.title || '',
    summary: (body || '').replace(/\s+/g, ' ').slice(0, 280),
    full_body: body || '',
    source: 'Method B', source_name: item.source_name || '',
    source_url: '', url: '',
    category: facts?.story_type || item.category || 'Haber',
    nvs: Math.min(85, Math.max(30, factTrust)), trust_tier: item.trust_score || null,
    published_at, fetched_at: published_at,
    is_fresh: true, is_kartalix_content: true,
    publish_mode: 'methodb_synth', image_url: '', slug,
    _methodb: { topic_id: topic?.id || null, trigger, focus_entity: entityKey },
  };
}

// ─── STAGE 1: EVENT / ACCRETIVE ROUTER ───────────────────────────────────────
export function routeNewsMode(item, facts) {
  const st = facts?.story_type || '';
  if (st === 'match_result' || st === 'squad') return 'event';
  const t = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  if (/\bresmi\b|resmen|açıkland|imzaladı|duyurdu|kadroya kat|gol|kırmızı kart|kart gördü/.test(t)) return 'event';
  return 'accretive';
}

// ─── RULES PRE-FILTER BEFORE THE DELTA LLM (design §6.3) ─────────────────────
// Pure JS, no tokens. Only a `possibleDelta` is allowed to spend a Haiku diff;
// pure `confirming` repeats never reach the model.
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

  if (CONTRADICTION_WORDS.some(w => text.includes(w))) reasons.push('contradiction_marker');

  const presentStatus = STATUS_WORDS.filter(w => text.includes(w));
  if (presentStatus.length) {
    const cur = (priorTrack?.status || '').toLowerCase();
    if (!cur || !presentStatus.some(w => cur.includes(w))) reasons.push('status_change');
  }

  const hasNewValue = (obj, track) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v == null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (!track || track[k] == null || JSON.stringify(track[k]) !== JSON.stringify(v)) return true;
    }
    return false;
  };
  if (hasNewValue(facts?.numbers, priorTrack?.numbers)) reasons.push('new_number');
  if (hasNewValue(facts?.dates, priorTrack?.dates)) reasons.push('new_date');

  if (!priorTrack) reasons.push('initial');

  return { possibleDelta: reasons.length > 0, reasons };
}
