// src/extractor.js — Unified fact extraction for all source types.
//
// Single entry point: extractFacts({ text, sourceType, item, env })
// Returns array of canonical claim objects (1–5 per source), each persisted
// as a facts row. All columns always populated — no more hollow rows.
//
// Source types: rss_full | rss_summary | yt_transcript | yt_title |
//               twitter | instagram | api | manual
//
// Trust model: 4 layers (source tier + source type ceiling + content richness
// + corroboration). Computed as fact_trust [0-100] on every write.
// Replaces ad-hoc proxyNVS in story agent.

import { callClaude, extractText, MODEL_FETCH, normalizeStoryType } from './utils.js';

const TR_SUFFIXES = /'(?:nın|nin|nun|nün|ın|in|un|ün|nda|nde|dan|den|tan|ten|ya|ye|da|de|yı|yi|yu|yü|a|e|ı|i|u|ü|nı|nle|le|la|yla|yda|yde|yta|yte|lı|li|lu|lü|lar|ler|lardan|lerden|lara|lere|larda|lerde|larla|lerle|ları|leri)+$/i;

function buildEntityFingerprint(storyType, name) {
  if (!name) return null;
  const norm = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(TR_SUFFIXES, '').replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!norm || norm.length < 3) return null;
  return `${storyType}:${norm}`;
}

// ─── TRUST TABLES ─────────────────────────────────────────────

const TIER_BASE = {
  T1: 90, official: 90,
  T2: 70, broadcast: 70,
  T3: 50, journalist: 50, press: 50,
  T4: 25, digital: 25, aggregator: 25,
};

const SOURCE_CEILING = {
  api:                  100,
  yt_transcript:         85,
  rss_full:              80,
  manual:                80,
  twitter_official:      75,
  instagram_official:    75,
  rss_summary:           60,
  twitter:               40,
  yt_title:              35,
  instagram:             35,
};

export function computeFactTrust(claim, item) {
  const base    = TIER_BASE[item.trust_tier] ?? 50;
  const ceiling = SOURCE_CEILING[claim._sourceType] ?? 60;

  let bonus = 0;
  const nums = claim.numbers || {};
  const hasNumber = nums.transfer_fee != null || nums.contract_years != null
    || nums.ban_games != null || nums.recovery_weeks != null
    || (Array.isArray(nums.other) && nums.other.length > 0);
  if (hasNumber)                                              bonus += 10;
  if (claim.dates?.primary_date)                             bonus += 10;
  if (Array.isArray(claim.key_quotes) && claim.key_quotes.length > 0) bonus += 10;
  if ((claim.entities?.players || []).length >= 2)           bonus +=  5;
  if (claim.claim_confidence === 'high' || claim.claim_confidence === 'confirmed') bonus += 5;
  if (claim.claim_confidence === 'low'  || claim.claim_confidence === 'rumor')     bonus -= 10;
  if (claim.story_type === 'other')                          bonus -=  5;

  return Math.max(0, Math.min(ceiling, base + bonus));
}

export function resolveClaimStatus(rawStatus, factTrust) {
  if (rawStatus === 'denied' || rawStatus === 'completed' || rawStatus === 'obsolete') return rawStatus;
  if (factTrust < 35) return 'rumor';
  if (!rawStatus || rawStatus === 'rumor') return factTrust >= 60 ? 'developing' : 'rumor';
  return rawStatus;
}

// ─── PROMPT BUILDER ───────────────────────────────────────────

const MAX_CLAIMS_BY_TYPE = { rss_full: 5, yt_transcript: 5, manual: 3 };

function buildPrompt(text, sourceType, sourceDateIso) {
  const maxClaims = MAX_CLAIMS_BY_TYPE[sourceType] ?? 2;
  const dateHint  = sourceDateIso
    ? `\nKaynak yayın tarihi: ${sourceDateIso}. Bu tarihe göre göreceli ifadeleri ("bugün", "yarın", "bu hafta") mutlak tarihe çevir.`
    : '';

  const richness = ['rss_full', 'yt_transcript', 'manual'].includes(sourceType) ? 'full' : 'compact';

  const quoteInstr = richness === 'full'
    ? `"key_quotes": [{"text": "birebir alıntı ≤20 kelime", "speaker": "Ad Soyad veya null", "role": "pozisyon veya null"}]`
    : `"key_quotes": []`;

  return `Türkçe futbol haberinden yapısal olgular çıkar. Kartalix Beşiktaş haber sitesi içindir.
YALNIZCA geçerli JSON döndür: {"claims":[...]}.${dateHint}

Tipik olarak 1 iddia. Röportajlar veya çok konulu kaynaklar için en fazla ${maxClaims} — yalnızca açıkça ayrı konular (farklı oyuncu, farklı olay).
YALNIZCA metinde açıkça belirtilenleri çıkar. Tahmin etme, uydurmaa.

Her iddia nesnesi:
{
  "story_type": "transfer|injury|disciplinary|contract|match_result|squad|institutional|other",
  "claim_status": "rumor|developing|confirmed|denied|completed",
  "claim_confidence": "confirmed|high|medium|low|rumor",
  "event_date": "YYYY-MM-DD veya null — olayın yaşandığı tarih (yayın tarihi değil)",
  "primary_entity": {"name": "SOYADI (Amrabat değil Sofyan Amrabat)", "type": "player|coach|official"} veya null,
  "negotiation_status": "rumor|interest|talks_opened|fee_agreed|personal_terms|medical|signed|official|collapsed|denied" veya null (yalnızca transfer),
  "grounding_summary": "1-2 cümle Türkçe özet. Asla verbatim kopyalama. Haberin özünü yaz.",
  ${quoteInstr},
  "entities": {"players": [], "clubs": [], "competitions": []},
  "numbers": {"transfer_fee": null, "contract_years": null, "ban_games": null, "recovery_weeks": null, "fine_amount": null, "other": []},
  "dates": {"primary_date": null, "other": []}
}

claim_status kuralları:
- "rumor": tek kaynak, isimsiz/doğrulanmamış
- "developing": birden fazla kaynak veya güvenilir kaynak ama henüz resmi değil
- "confirmed": resmi açıklama, imza, kulüp duyurusu
- "denied": oyuncu/kulüp/yetkili tarafından açıkça reddedildi
- "completed": olay tamamlandı (transfer gerçekleşti, sözleşme bitti vb.)

claim_confidence: confirmed=resmi/imzalı, high=kıdemli gazeteci/isimli kaynak, medium=güvenilir iddia, low=spekülasyon, rumor=isimsiz kaynak.

Kaynak:
${text}

Yalnızca {"claims":[...]} döndür.`;
}

// ─── RESPONSE PARSER ──────────────────────────────────────────

const VALID_CLAIM_STATUS  = new Set(['rumor','developing','confirmed','denied','completed','obsolete']);
const VALID_CONFIDENCE    = new Set(['confirmed','high','medium','low','rumor']);
const VALID_NEG_STATUS    = new Set(['rumor','interest','talks_opened','fee_agreed','personal_terms','medical','signed','official','collapsed','denied']);

function parseClaims(rawText) {
  const m = rawText.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return []; }

  const rawClaims = Array.isArray(parsed.claims) && parsed.claims.length
    ? parsed.claims
    : parsed.story_type ? [parsed]
    : [];

  return rawClaims.map(p => ({
    story_type:         normalizeStoryType(p.story_type),
    claim_status:       VALID_CLAIM_STATUS.has(p.claim_status) ? p.claim_status : 'rumor',
    claim_confidence:   VALID_CONFIDENCE.has(p.claim_confidence) ? p.claim_confidence : 'medium',
    event_date:         typeof p.event_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.event_date) ? p.event_date : null,
    primary_entity:     p.primary_entity?.name ? p.primary_entity : null,
    negotiation_status: VALID_NEG_STATUS.has(p.negotiation_status) ? p.negotiation_status : null,
    grounding_summary:  typeof p.grounding_summary === 'string' ? p.grounding_summary.trim().slice(0, 500) : '',
    key_quotes:         Array.isArray(p.key_quotes)
      ? p.key_quotes.filter(q => typeof q?.text === 'string' && q.text.length > 3).map(q => ({
          text:    q.text.slice(0, 200),
          speaker: q.speaker || null,
          role:    q.role    || null,
        }))
      : [],
    entities: {
      players:      Array.isArray(p.entities?.players)      ? p.entities.players      : [],
      clubs:        Array.isArray(p.entities?.clubs)        ? p.entities.clubs        : [],
      competitions: Array.isArray(p.entities?.competitions) ? p.entities.competitions : [],
    },
    numbers: {
      transfer_fee:    p.numbers?.transfer_fee    ?? null,
      contract_years:  p.numbers?.contract_years  ?? null,
      ban_games:       p.numbers?.ban_games        ?? null,
      recovery_weeks:  p.numbers?.recovery_weeks  ?? null,
      fine_amount:     p.numbers?.fine_amount      ?? null,
      other:           Array.isArray(p.numbers?.other) ? p.numbers.other : [],
    },
    dates: {
      primary_date: p.dates?.primary_date ?? null,
      other:        Array.isArray(p.dates?.other) ? p.dates.other : [],
    },
  }));
}

// ─── DB WRITE ─────────────────────────────────────────────────

async function supabasePost(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Prefer':        'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path}: ${res.status}`);
  return res.json();
}

async function supabaseGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    headers: {
      'apikey':        env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path}: ${res.status}`);
  return res.json();
}

async function supabasePatch(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path}: ${res.status}`);
}

/**
 * incrementCorroboration — Layer 4 of the fact trust model.
 *
 * When a new content_item confirms an existing fact (same entity_fingerprint,
 * different source_name), increments corroboration_count on the existing fact
 * rows and recomputes fact_trust. Also promotes claim_status if the new trust
 * crosses a threshold (rumor → developing at 60).
 *
 * Each corroborating source adds +5 to fact_trust, capped at +20 (4 sources)
 * and never exceeding the source_type ceiling.
 *
 * Non-fatal: failures are logged but never propagate.
 */
export async function incrementCorroboration(fingerprint, currentSourceName, currentItemId, env) {
  if (!fingerprint || !currentSourceName || !currentItemId) return;
  try {
    const existing = await supabaseGet(env,
      `/rest/v1/facts?entity_fingerprint=eq.${encodeURIComponent(fingerprint)}` +
      `&source_name=neq.${encodeURIComponent(currentSourceName)}` +
      `&content_item_id=neq.${currentItemId}` +
      `&corroboration_count=lt.4` +
      `&select=id,corroboration_count,fact_trust,claim_status,source_type`
    );
    if (!existing?.length) return;

    await Promise.all(existing.map(fact => {
      const newCount   = (fact.corroboration_count || 0) + 1;
      const ceiling    = SOURCE_CEILING[fact.source_type] ?? 60;
      const newTrust   = Math.min(ceiling, (fact.fact_trust || 0) + 5);
      const newStatus  = resolveClaimStatus(fact.claim_status, newTrust);
      return supabasePatch(env,
        `/rest/v1/facts?id=eq.${fact.id}`,
        { corroboration_count: newCount, fact_trust: newTrust, claim_status: newStatus }
      );
    }));

    console.log(`corroboration: +1 on ${existing.length} fact(s) for fingerprint ${fingerprint}`);
  } catch (e) {
    console.error('incrementCorroboration:', e.message);
  }
}

async function writeFactRow(claim, item, sourceType, env, usage, claimIdx) {
  const factTrust   = computeFactTrust({ ...claim, _sourceType: sourceType }, item);
  const claimStatus = resolveClaimStatus(claim.claim_status, factTrust);
  const fingerprint = buildEntityFingerprint(claim.story_type, claim.primary_entity?.name);

  // MB-N3-5: upsert guard — patch existing row instead of inserting a duplicate
  let existingId = null;
  if (item.id) {
    try {
      const fpFilter = fingerprint
        ? `&entity_fingerprint=eq.${encodeURIComponent(fingerprint)}`
        : `&story_type=eq.${encodeURIComponent(claim.story_type)}`;
      const hits = await supabaseGet(env,
        `/rest/v1/facts?content_item_id=eq.${item.id}${fpFilter}&select=id&limit=1`
      );
      existingId = hits?.[0]?.id ?? null;
    } catch (_) {}
  }

  const payload = {
    content_item_id:          item.id          ?? null,
    site_id:                  item.site_id     ?? null,
    story_type:               claim.story_type,
    entities:                 claim.entities,
    numbers:                  claim.numbers,
    dates:                    claim.dates,
    event_date:               claim.event_date ?? null,
    claim_confidence:         claim.claim_confidence,
    claim_status:             claimStatus,
    primary_entity:           claim.primary_entity,
    negotiation_status:       claim.negotiation_status,
    entity_fingerprint:       fingerprint,
    grounding_summary:        claim.grounding_summary || null,
    key_quotes:               claim.key_quotes,
    source_type:              sourceType,
    source_url:               item.url || item.original_url || null,
    source_name:              item.source_name || null,
    source_published_at:      item.published_at ?? null,
    fact_trust:               factTrust,
    extraction_tier:          (sourceType === 'rss_full' || sourceType === 'yt_transcript') ? 'llm_full' : 'llm_light',
    extraction_model:         MODEL_FETCH,
    extraction_input_tokens:  claimIdx === 0 ? (usage?.input_tokens  ?? null) : null,
    extraction_output_tokens: claimIdx === 0 ? (usage?.output_tokens ?? null) : null,
  };

  let id;
  if (existingId) {
    await supabasePatch(env, `/rest/v1/facts?id=eq.${existingId}`, payload);
    id = existingId;
  } else {
    const row = await supabasePost(env, '/rest/v1/facts', payload);
    id = row?.[0]?.id ?? null;
  }

  return { ...claim, claim_status: claimStatus, fact_trust: factTrust, entity_fingerprint: fingerprint, _id: id };
}

// ─── MAIN ENTRY POINT ─────────────────────────────────────────

/**
 * extractFacts({ text, sourceType, item, env })
 *
 * text:       source content (body, transcript, caption, tweet, etc.)
 * sourceType: 'rss_full' | 'rss_summary' | 'yt_transcript' | 'yt_title' |
 *             'twitter'  | 'instagram'   | 'api'           | 'manual'
 * item:       content_item row (id, site_id, trust_tier, published_at,
 *             url/original_url, source_name)
 * env:        Worker env (SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY)
 *
 * Returns array of persisted claim objects (primary first).
 * Each has: ...canonical fields, _id (facts row uuid), fact_trust [0-100].
 * Returns [] on total failure (never throws).
 */
export async function extractFacts({ text, sourceType, item, env, dryRun = false }) {
  try {
    const sourceDateIso = item.published_at
      ? new Date(item.published_at).toISOString().slice(0, 10)
      : null;

    const prompt = buildPrompt(text.slice(0, sourceType === 'yt_transcript' ? 4000 : 2500), sourceType, sourceDateIso);
    const res    = await callClaude(env, MODEL_FETCH, prompt, false, 900);
    const claims = parseClaims(extractText(res.content));
    if (!claims.length) return [];

    if (dryRun) {
      return claims.map(claim => {
        const factTrust   = computeFactTrust({ ...claim, _sourceType: sourceType }, item);
        const claimStatus = resolveClaimStatus(claim.claim_status, factTrust);
        const fingerprint = buildEntityFingerprint(claim.story_type, claim.primary_entity?.name);
        return { ...claim, claim_status: claimStatus, fact_trust: factTrust, entity_fingerprint: fingerprint, _id: null, _dryRun: true };
      });
    }

    const persisted = await Promise.all(
      claims.map((claim, idx) => writeFactRow(claim, item, sourceType, env, res.usage, idx))
    );

    // Legal lineage — first claim only (all share the same source article)
    await supabasePost(env, '/rest/v1/fact_lineage', {
      content_item_id:          item.id  ?? null,
      facts_id:                 persisted[0]._id ?? null,
      source_url:               item.url || item.original_url || '',
      source_name:              item.source_name || '',
      source_text_length:       text.length,
      extraction_model:         MODEL_FETCH,
      extraction_tokens_in:     res.usage?.input_tokens  ?? null,
      extraction_tokens_out:    res.usage?.output_tokens ?? null,
      destruction_confirmed_at: new Date().toISOString(),
    }).catch(() => {}); // lineage failure is non-fatal

    return persisted;
  } catch (e) {
    console.error('extractor.extractFacts:', e.message);
    return [];
  }
}

/**
 * extractFactsPrimary — convenience wrapper returning only the primary claim,
 * backward-compatible with callers that expect a single facts object.
 * Also returns _all_fact_ids for saveArticles backfill.
 */
export async function extractFactsPrimary({ text, sourceType, item, env }) {
  const claims = await extractFacts({ text, sourceType, item, env });
  if (!claims.length) return _fallback();
  return {
    ...claims[0],
    _all_fact_ids: claims.map(c => c._id).filter(Boolean),
  };
}

function _fallback() {
  return {
    story_type: 'other', claim_status: 'rumor', claim_confidence: 'medium',
    grounding_summary: '', key_quotes: [], event_date: null,
    primary_entity: null, negotiation_status: null, entity_fingerprint: null,
    fact_trust: 0, _id: null, _all_fact_ids: [],
    entities: { players: [], clubs: [], competitions: [] },
    numbers:  { transfer_fee: null, contract_years: null, ban_games: null, recovery_weeks: null, fine_amount: null, other: [] },
    dates:    { primary_date: null, other: [] },
  };
}
