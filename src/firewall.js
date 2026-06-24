import { callClaude, extractText, MODEL_FETCH } from './utils.js';

// ─── CONTROLLED STORY TYPE SET ───────────────────────────────
const VALID_STORY_TYPES = new Set(['transfer', 'injury', 'disciplinary', 'contract', 'institutional', 'match_result', 'squad', 'other']);

// Maps Claude free-text output → nearest controlled type.
// Claude sometimes invents compound types ("transfer_interest", "player_contract_extension").
// This catches them by keyword scan before they reach the DB.
export function normalizeStoryType(raw) {
  if (!raw) return 'other';
  if (VALID_STORY_TYPES.has(raw)) return raw;
  const t = raw.toLowerCase();
  if (t.includes('transfer') || t.includes('signing') || t.includes('loan')) return 'transfer';
  if (t.includes('injur') || t.includes('medical') || t.includes('recovery')) return 'injury';
  if (t.includes('disciplin') || t.includes('suspension') || t.includes('ban') || t.includes('fine')) return 'disciplinary';
  if (t.includes('contract') || t.includes('renewal') || t.includes('extension') || t.includes('buyout')) return 'contract';
  if (t.includes('institutional') || t.includes('management') || t.includes('ownership') || t.includes('executive') || t.includes('appointment') || t.includes('managerial')) return 'institutional';
  if (t.includes('match') || t.includes('result') || t.includes('score') || t.includes('goal')) return 'match_result';
  if (t.includes('squad') || t.includes('lineup') || t.includes('formation')) return 'squad';
  return 'other';
}

// ─── STORY TYPE CLASSIFIER ────────────────────────────────────
// Single Haiku call — classifies news before fact extraction so
// each story type gets the right schema.
export async function classifyStoryType(article, env) {
  const text = `${article.title}. ${article.summary || ''}`.slice(0, 400);
  const prompt = `Classify this Turkish football news article. Return ONLY valid JSON.

Article: ${text}

You MUST return one of exactly these story_type values — no others, no variations:
- transfer: player moving between clubs, loan, signing, transfer interest
- injury: player injury, medical news, recovery timeline
- disciplinary: suspension, ban, fine, card accumulation
- contract: contract renewal, extension, buyout, termination
- match_result: a specific finished match, score, goal event
- squad: lineup announcement, formation, call-up
- institutional: club ownership, management change, board decision, financial restructuring
- other: anything not covered above

{"story_type": "<one of the 8 values above>", "story_category": "sporting" | "financial" | "institutional" | "other"}

sporting: transfer, injury, disciplinary, contract, match_result, squad
financial: contract value as primary story, FFP, debt
institutional: ownership, board, management

Return only the JSON. Do not invent new story_type values.`;

  try {
    const res  = await callClaude(env, MODEL_FETCH, prompt, false, 80);
    const raw  = extractText(res.content);
    const json = raw.match(/\{[\s\S]*\}/);
    if (!json) return { story_type: 'other', story_category: 'other' };
    const parsed = JSON.parse(json[0]);
    return {
      story_type:     normalizeStoryType(parsed.story_type),
      story_category: parsed.story_category || 'other',
    };
  } catch {
    return { story_type: 'other', story_category: 'other' };
  }
}

// ─── MATCH LIFECYCLE TYPES ────────────────────────────────────
// These story types are time-boxed events — handled by templates.
// They should NOT feed into the long-running story system.
export const SKIP_STORY_TYPES = new Set(['match_result', 'squad']);

// ─── ENTITY FINGERPRINT ──────────────────────────────────────
// Stable cross-article key: "story_type:normalized_name"
// Turkish suffix stripping: apostrophe is REQUIRED to start the suffix group.
// Proper nouns always use an apostrophe before case suffixes in Turkish
// ("Amrabat'ı", "Ndidi'ye", "Sörloth'a") so requiring it prevents stripping
// trailing letters that are part of a foreign name (e.g. "Ndidi" → "ndid" ✗).
const TR_SUFFIXES = /'(?:nın|nin|nun|nün|ın|in|un|ün|nda|nde|dan|den|tan|ten|ya|ye|da|de|yı|yi|yu|yü|a|e|ı|i|u|ü|nı|nle|le|la|yla|yda|yde|yta|yte|lı|li|lu|lü|lar|ler|lardan|lerden|lara|lere|larda|lerde|larla|lerle|ları|leri)+$/i;

function normalizeEntityName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip diacritics for ASCII form
    .replace(TR_SUFFIXES, '')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function buildEntityFingerprint(storyType, primaryEntityName) {
  if (!primaryEntityName) return null;
  const normalized = normalizeEntityName(primaryEntityName);
  if (!normalized || normalized.length < 3) return null;
  return `${storyType}:${normalized}`;
}

// ─── SUPABASE GET ─────────────────────────────────────────────
async function supabaseGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'apikey':        env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// ─── DELTA DETECTION ──────────────────────────────────────────
// Compares a new claim against the most recent facts row sharing the same
// entity_fingerprint to determine whether this is new news, a corroboration,
// a status update, or a contradiction/denial.
const NEG_STATUS_ORDER = ['rumor','interest','talks_opened','fee_agreed','personal_terms','medical','signed','official'];
const NEG_STATUS_TERMINAL = new Set(['collapsed','denied']);
const VALID_NEG_STATUS    = new Set([...NEG_STATUS_ORDER, 'collapsed', 'denied']);
const VALID_CONFIDENCE    = new Set(['confirmed','high','medium','low','rumor']);

async function detectDeltaType(env, siteId, fingerprint, newNegStatus) {
  if (!fingerprint || !siteId) return 'new_claim';
  try {
    const rows = await supabaseGet(env,
      `/rest/v1/facts?site_id=eq.${siteId}&entity_fingerprint=eq.${encodeURIComponent(fingerprint)}&order=created_at.desc&limit=1&select=negotiation_status`
    );
    if (!rows?.length) return 'new_claim';
    const priorNeg = rows[0].negotiation_status;
    if (!newNegStatus) return 'corroboration';
    // Classify new terminal status by its specific meaning
    if (newNegStatus === 'denied')    return 'denial';
    if (newNegStatus === 'collapsed') return 'collapsed';
    // Prior was terminal but new is non-terminal → story revived, contradicts prior conclusion
    if (NEG_STATUS_TERMINAL.has(priorNeg)) return 'contradiction';
    if (priorNeg === newNegStatus) return 'corroboration';
    const priorIdx = NEG_STATUS_ORDER.indexOf(priorNeg);
    const newIdx   = NEG_STATUS_ORDER.indexOf(newNegStatus);
    if (priorIdx >= 0 && newIdx >= 0) return newIdx > priorIdx ? 'update' : 'contradiction';
    return 'corroboration';
  } catch {
    return 'new_claim';
  }
}

// ─── PARSE ONE RAW CLAIM ──────────────────────────────────────
function parseOneClaim(p) {
  const storyType = normalizeStoryType(p.story_type);

  const primaryEntity = p.primary_entity?.name ? {
    name:       p.primary_entity.name,
    type:       p.primary_entity.type || 'player',
    normalized: normalizeEntityName(p.primary_entity.name),
  } : null;

  // key_quotes: accept both [{text,speaker,role}] and legacy string[]
  const keyQuotes = Array.isArray(p.key_quotes)
    ? p.key_quotes
        .map(q => typeof q === 'string' ? { text: q, speaker: null, role: null } : q)
        .filter(q => q?.text?.trim())
        .slice(0, 2)
    : [];

  return {
    story_type:         storyType,
    story_category:     p.story_category || 'other',
    nvs_score:          typeof p.nvs_score === 'number' ? Math.max(0, Math.min(100, Math.round(p.nvs_score))) : null,
    claim_confidence:   VALID_CONFIDENCE.has(p.claim_confidence) ? p.claim_confidence : 'medium',
    grounding_summary:  typeof p.grounding_summary === 'string' ? p.grounding_summary.trim().slice(0, 500) : null,
    key_quotes:         keyQuotes,
    primary_entity:     primaryEntity,
    entity_fingerprint: buildEntityFingerprint(storyType, primaryEntity?.name),
    negotiation_status: (storyType === 'transfer' && VALID_NEG_STATUS.has(p.negotiation_status))
                          ? p.negotiation_status : null,
    entities: {
      players:      Array.isArray(p.entities?.players)      ? p.entities.players      : [],
      clubs:        Array.isArray(p.entities?.clubs)        ? p.entities.clubs        : [],
      competitions: Array.isArray(p.entities?.competitions) ? p.entities.competitions : [],
    },
    numbers: {
      transfer_fee:   p.numbers?.transfer_fee   ?? null,
      contract_years: p.numbers?.contract_years ?? null,
      ban_games:      p.numbers?.ban_games      ?? null,
      recovery_weeks: p.numbers?.recovery_weeks ?? null,
      fine_amount:    p.numbers?.fine_amount    ?? null,
      other:          Array.isArray(p.numbers?.other) ? p.numbers.other : [],
    },
    dates: {
      primary_date: p.dates?.primary_date ?? null,
      other:        Array.isArray(p.dates?.other) ? p.dates.other : [],
    },
  };
}

// ─── COMBINED EXTRACT + SCORE (Phase 1) ──────────────────────
// Multi-claim extraction: one Haiku call returns up to 5 distinct news
// claims from the source. Each claim gets its own facts row and delta
// detection. Returns the primary claim fields (backward-compatible) plus
// _all_fact_ids for the content_item_id backfill in saveArticles.
//
// grounding_summary: LLM's own paraphrase of the claim (FSEK-safe — not verbatim).
// key_quotes: [{text, speaker, role}] — short attributed direct quotes only.
export async function extractAndScore(bodyText, article, env) {
  const source = (bodyText || '').trim()
    ? `${article.title}.\n${bodyText}`.slice(0, 2500)
    : `${article.title}. ${article.summary || ''}`.slice(0, 800);

  const prompt = `Analyze this Turkish football article for Kartalix (Beşiktaş fan site).
Extract ALL distinct news claims. Return ONLY valid JSON {"claims":[...]}.

Typically 1 claim. Up to 5 for interviews or multi-topic sources (each must be a clearly separate story: different player, different event, or unrelated topic).
Extract only what is EXPLICITLY stated. Never infer or hallucinate.

Each claim object:
{
  "story_type": "transfer|injury|disciplinary|contract|match_result|squad|institutional|other",
  "story_category": "sporting|financial|institutional|other",
  "nvs_score": 0-100,
  "claim_confidence": "confirmed|high|medium|low|rumor",
  "primary_entity": {"name": "SURNAME ONLY (Amrabat not Sofyan Amrabat)", "type": "player|coach|official"} or null,
  "negotiation_status": "rumor|interest|talks_opened|fee_agreed|personal_terms|medical|signed|official|collapsed|denied" or null (transfer only),
  "grounding_summary": "YOUR OWN 1-2 sentence paraphrase. Never copy verbatim from source.",
  "key_quotes": [{"text": "exact words ≤15 words", "speaker": "Full Name", "role": "kulüp başkanı"}],
  "entities": {"players": [], "clubs": [], "competitions": []},
  "numbers": {"transfer_fee": null, "contract_years": null, "ban_games": null, "recovery_weeks": null, "fine_amount": null, "other": []},
  "dates": {"primary_date": null, "other": []}
}

nvs_score: Beşiktaş relevance × newsworthiness. 100=breaking BJK news, 0=no BJK angle.
claim_confidence: confirmed=official/signed, high=senior journalist/named source, medium=credible rumor, low=speculation, rumor=no named source.

Article:
${source}

Return only {"claims":[...]}`;

  try {
    const res = await callClaude(env, MODEL_FETCH, prompt, false, 900);
    const raw = extractText(res.content);
    const m   = raw.match(/\{[\s\S]*\}/);
    if (!m) return _fallbackExtractAndScore();

    const parsed = JSON.parse(m[0]);
    const rawClaims = Array.isArray(parsed.claims) && parsed.claims.length
      ? parsed.claims
      : parsed.story_type ? [parsed] // graceful fallback: model returned flat object
      : [];
    if (!rawClaims.length) return _fallbackExtractAndScore();

    const claims = rawClaims.map(parseOneClaim);

    // Insert all claims as separate facts rows + detect delta per claim
    const factIds = [];
    await Promise.all(claims.map(async (claim, idx) => {
      const deltaType = await detectDeltaType(env, article.site_id, claim.entity_fingerprint, claim.negotiation_status);
      const row = await supabasePost(env, '/rest/v1/facts', {
        content_item_id:          article.id         ?? null,
        site_id:                  article.site_id    ?? null,
        story_type:               claim.story_type,
        entities:                 claim.entities,
        numbers:                  claim.numbers,
        dates:                    claim.dates,
        grounding_summary:        claim.grounding_summary || null,
        claim_confidence:         claim.claim_confidence,
        primary_entity:           claim.primary_entity,
        negotiation_status:       claim.negotiation_status,
        entity_fingerprint:       claim.entity_fingerprint,
        delta_type:               deltaType,
        extraction_tier:          'llm_full',
        source_published_at:      article.published_at ?? null,
        extraction_model:         MODEL_FETCH,
        extraction_input_tokens:  idx === 0 ? (res.usage?.input_tokens  ?? null) : null,
        extraction_output_tokens: idx === 0 ? (res.usage?.output_tokens ?? null) : null,
      });
      factIds[idx] = row?.[0]?.id ?? null;
    }));

    // Lineage for first claim only (all share the same source article)
    await supabasePost(env, '/rest/v1/fact_lineage', {
      content_item_id:          article.id ?? null,
      facts_id:                 factIds[0] ?? null,
      source_url:               article.url || article.original_url || '',
      source_name:              article.source_name || '',
      source_text_length:       source.length,
      extraction_model:         MODEL_FETCH,
      extraction_tokens_in:     res.usage?.input_tokens  ?? null,
      extraction_tokens_out:    res.usage?.output_tokens ?? null,
      destruction_confirmed_at: new Date().toISOString(),
    });

    // Primary claim = first (highest editorial prominence); secondary claims stored
    // in _all_fact_ids so saveArticles can backfill content_item_id on all rows.
    const primary = claims[0];
    return {
      ...primary,
      _id:           factIds[0] ?? null,
      _all_fact_ids: factIds,
      _usage:        res.usage ?? null,
    };
  } catch {
    return _fallbackExtractAndScore();
  }
}

function _fallbackExtractAndScore() {
  return {
    story_type: 'other', story_category: 'other', nvs_score: null, key_quotes: [],
    claim_confidence: 'medium', grounding_summary: null, primary_entity: null,
    negotiation_status: null, entity_fingerprint: null,
    _id: null, _all_fact_ids: [], _usage: null,
    entities: { players: [], clubs: [], competitions: [] },
    numbers:  { transfer_fee: null, contract_years: null, ban_games: null, recovery_weeks: null, fine_amount: null, other: [] },
    dates:    { primary_date: null, other: [] },
  };
}

// ─── TRANSFER FACT SCHEMA ─────────────────────────────────────
// Extraction scope: named entities (players, clubs, competitions),
// numbers (fees, contract length, goals, minutes), dates only.
// No paraphrase. No key claims. No sentences. Entities are facts;
// expression is what FSEK Article 36 protects.

export function buildExtractionPrompt(sourceText) {
  return `Extract structured facts from this Turkish football transfer news. Return ONLY valid JSON. Extract only what is explicitly stated — do not add, derive, or generate any text not present in the source.

Return this exact structure:
{
  "entities": {
    "players": [],
    "clubs": [],
    "competitions": []
  },
  "numbers": {
    "transfer_fee": null,
    "contract_years": null,
    "release_clause": null,
    "other": []
  },
  "dates": {
    "announcement": null,
    "contract_end": null,
    "transfer_window": null,
    "other": []
  }
}

Source text:
${sourceText}

Return only the JSON object. No other text.`;
}

export function parseFirewallResponse(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Firewall: no JSON in response');
  const raw = JSON.parse(match[0]);
  return {
    entities: {
      players:      Array.isArray(raw.entities?.players)      ? raw.entities.players      : [],
      clubs:        Array.isArray(raw.entities?.clubs)        ? raw.entities.clubs        : [],
      competitions: Array.isArray(raw.entities?.competitions) ? raw.entities.competitions : [],
    },
    numbers: {
      transfer_fee:   raw.numbers?.transfer_fee   ?? null,
      contract_years: raw.numbers?.contract_years ?? null,
      release_clause: raw.numbers?.release_clause ?? null,
      other:          Array.isArray(raw.numbers?.other) ? raw.numbers.other : [],
    },
    dates: {
      announcement:    raw.dates?.announcement    ?? null,
      contract_end:    raw.dates?.contract_end    ?? null,
      transfer_window: raw.dates?.transfer_window ?? null,
      other:           Array.isArray(raw.dates?.other) ? raw.dates.other : [],
    },
  };
}

export async function extractFacts(article, env) {
  // Input: title + RSS summary only. Never full_text for P4 sources.
  const sourceText       = `${article.title}. ${article.summary || ''}`.slice(0, 800);
  const sourceTextLength = sourceText.length;

  const prompt = buildExtractionPrompt(sourceText);
  const res    = await callClaude(env, MODEL_FETCH, prompt, false, 500);
  const facts  = parseFirewallResponse(extractText(res.content));

  // Save to facts table, get back the row ID
  const factsRows = await supabasePost(env, '/rest/v1/facts', {
    content_item_id:         article.id   ?? null,
    site_id:                 article.site_id ?? null,
    story_type:              'transfer',
    entities:                facts.entities,
    numbers:                 facts.numbers,
    dates:                   facts.dates,
    extraction_model:        MODEL_FETCH,
    extraction_input_tokens:  res.usage?.input_tokens  ?? null,
    extraction_output_tokens: res.usage?.output_tokens ?? null,
  });

  // Audit log: source_text_length recorded, source text is NOT stored.
  // destruction_confirmed_at = legal evidence source text was discarded.
  await supabasePost(env, '/rest/v1/fact_lineage', {
    content_item_id:         article.id ?? null,
    facts_id:                factsRows?.[0]?.id ?? null,
    source_url:              article.url || article.original_url || '',
    source_name:             article.source_name || '',
    source_text_length:      sourceTextLength,
    extraction_model:        MODEL_FETCH,
    extraction_tokens_in:    res.usage?.input_tokens  ?? null,
    extraction_tokens_out:   res.usage?.output_tokens ?? null,
    destruction_confirmed_at: new Date().toISOString(),
  });

  // Return facts with the saved row ID so story-matcher can link contributions
  return { ...facts, _id: factsRows?.[0]?.id ?? null };
}

async function supabasePost(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: {
      'Content-Type': 'application/json',
      'apikey':        env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Prefer':        'return=representation',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─── PER-TYPE EXTRACTION PROMPTS ─────────────────────────────
function buildInjuryExtractionPrompt(sourceText) {
  return `Extract structured facts from this Turkish football injury/suspension news. Return ONLY valid JSON. Extract only what is explicitly stated.

{
  "entities": { "players": [], "clubs": [], "competitions": [] },
  "numbers": { "ban_games": null, "recovery_weeks": null, "other": [] },
  "dates": { "injury_date": null, "expected_return": null, "other": [] }
}

Source: ${sourceText}

Return only the JSON.`;
}

function buildContractExtractionPrompt(sourceText) {
  return `Extract structured facts from this Turkish football contract news. Return ONLY valid JSON. Extract only what is explicitly stated.

{
  "entities": { "players": [], "clubs": [], "competitions": [] },
  "numbers": { "contract_years": null, "contract_value": null, "release_clause": null, "other": [] },
  "dates": { "signing_date": null, "contract_end": null, "other": [] }
}

Source: ${sourceText}

Return only the JSON.`;
}

function buildDisciplinaryExtractionPrompt(sourceText) {
  return `Extract structured facts from this Turkish football disciplinary news. Return ONLY valid JSON. Extract only what is explicitly stated.

{
  "entities": { "players": [], "clubs": [], "competitions": [] },
  "numbers": { "ban_games": null, "fine_amount": null, "other": [] },
  "dates": { "decision_date": null, "ban_start": null, "other": [] }
}

Source: ${sourceText}

Return only the JSON.`;
}

function buildGenericExtractionPrompt(sourceText) {
  return `Extract named entities and key numbers from this Turkish football news. Return ONLY valid JSON. Extract only what is explicitly stated.

{
  "entities": { "players": [], "clubs": [], "competitions": [] },
  "numbers": { "other": [] },
  "dates": { "other": [] }
}

Source: ${sourceText}

Return only the JSON.`;
}

// ─── EXTRACT FACTS FOR STORY SYSTEM ──────────────────────────
// Two-step: classify story type, then extract with the right schema.
// Used for story intake on all P4 articles.
// Distinct from extractFacts (transfer-only — used by writeTransfer).
export async function extractFactsForStory(article, env) {
  const sourceText = `${article.title}. ${article.summary || ''}`.slice(0, 800);

  const { story_type, story_category } = await classifyStoryType(article, env);

  let prompt;
  if      (story_type === 'transfer')            prompt = buildExtractionPrompt(sourceText);
  else if (story_type === 'injury')              prompt = buildInjuryExtractionPrompt(sourceText);
  else if (story_type === 'disciplinary')        prompt = buildDisciplinaryExtractionPrompt(sourceText);
  else if (story_type === 'contract')            prompt = buildContractExtractionPrompt(sourceText);
  else                                           prompt = buildGenericExtractionPrompt(sourceText);

  const res   = await callClaude(env, MODEL_FETCH, prompt, false, 400);
  const raw   = extractText(res.content);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('extractFactsForStory: no JSON in response');

  const parsed = JSON.parse(match[0]);
  const facts = {
    entities: {
      players:      Array.isArray(parsed.entities?.players)      ? parsed.entities.players      : [],
      clubs:        Array.isArray(parsed.entities?.clubs)        ? parsed.entities.clubs        : [],
      competitions: Array.isArray(parsed.entities?.competitions) ? parsed.entities.competitions : [],
    },
    numbers:  parsed.numbers  || {},
    dates:    parsed.dates    || {},
    story_type,
    story_category,
  };

  const factsRows = await supabasePost(env, '/rest/v1/facts', {
    content_item_id:          article.id      ?? null,
    site_id:                  article.site_id ?? null,
    story_type,
    entities:                 facts.entities,
    numbers:                  facts.numbers,
    dates:                    facts.dates,
    extraction_model:         MODEL_FETCH,
    extraction_input_tokens:  res.usage?.input_tokens  ?? null,
    extraction_output_tokens: res.usage?.output_tokens ?? null,
  });

  await supabasePost(env, '/rest/v1/fact_lineage', {
    content_item_id:          article.id ?? null,
    facts_id:                 factsRows?.[0]?.id ?? null,
    source_url:               article.url || article.original_url || '',
    source_name:              article.source_name || '',
    source_text_length:       sourceText.length,
    extraction_model:         MODEL_FETCH,
    extraction_tokens_in:     res.usage?.input_tokens  ?? null,
    extraction_tokens_out:    res.usage?.output_tokens ?? null,
    destruction_confirmed_at: new Date().toISOString(),
  });

  return { ...facts, _id: factsRows?.[0]?.id ?? null };
}

// ─── PRODUCE: TRANSFER ARTICLE ────────────────────────────────
// Generates a Kartalix article from extracted facts only.
// This function never receives or sees source text — by design.
export async function writeTransfer(facts, env) {
  const { entities, numbers, dates } = facts;

  const player = entities.players[0] ?? null;
  const clubs  = entities.clubs.slice(0, 2);

  if (!player && clubs.length === 0) {
    throw new Error('writeTransfer: insufficient facts — no player or clubs extracted');
  }

  const factLines = [
    player           ? `Oyuncu: ${player}`                     : null,
    clubs[0]         ? `Kulüp 1: ${clubs[0]}`                  : null,
    clubs[1]         ? `Kulüp 2: ${clubs[1]}`                  : null,
    numbers.transfer_fee    ? `Bonservis: ${numbers.transfer_fee}`    : null,
    numbers.contract_years  ? `Sözleşme: ${numbers.contract_years}`   : null,
    numbers.release_clause  ? `Madde: ${numbers.release_clause}`      : null,
    dates.announcement      ? `Tarih: ${dates.announcement}`          : null,
    dates.transfer_window   ? `Transfer dönemi: ${dates.transfer_window}` : null,
    ...entities.competitions.map(c => `Organizasyon: ${c}`),
    ...numbers.other.map(n => `Diğer: ${n}`),
  ].filter(Boolean).join('\n');

  const prompt = `Beşiktaş transfer haberini aşağıdaki gerçekleri kullanarak yaz. Sadece verilen bilgileri kullan — hiçbir şey ekleme, yorumlama veya tahmin etme.

Gerçekler:
${factLines}

2-3 cümle, tarafsız haber üslubu. Türkçe yaz.
İlk satır: haber başlığı (tire veya tırnak işareti kullanma).
Geri kalan satırlar: haber metni.`;

  const res  = await callClaude(env, MODEL_FETCH, prompt, false, 400);
  const body = extractText(res.content).trim();

  return {
    full_body:    body,
    publish_mode: 'template_transfer',
    facts,
    usage:        res.usage,
  };
}
