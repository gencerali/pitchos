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
// Turkish suffix stripping: removes common inflectional endings so
// "Amrabat'ı", "Amrabat'tan", "Amrabatı" all → "amrabat".
const TR_SUFFIXES = /('?(?:nın|nin|nun|nün|ın|in|un|ün|nda|nde|dan|den|tan|ten|ya|ye|da|de|yı|yi|yu|yü|ı|i|u|ü|yı|nı|nle|le|la|yla|yda|yde|yta|yte|lı|li|lu|lü|lar|ler|lardan|lerden|lara|lere|larda|lerde|larla|lerle|ları|leri))+$/i;

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

// ─── COMBINED EXTRACT + SCORE (Phase 1) ──────────────────────
// Single Haiku call on the full article body — replaces the old
// classifyStoryType + extractFactsForStory two-call pattern.
// Persists to facts + fact_lineage and returns the extracted data.
export async function extractAndScore(bodyText, article, env) {
  const source = (bodyText || '').trim()
    ? `${article.title}.\n${bodyText}`.slice(0, 2500)
    : `${article.title}. ${article.summary || ''}`.slice(0, 800);

  const prompt = `Analyze this Turkish football article for Beşiktaş fan site Kartalix. Return ONLY valid JSON. Extract only what is EXPLICITLY stated in the text — never infer or add facts not present.

story_type (pick exactly one): transfer | injury | disciplinary | contract | match_result | squad | institutional | other
story_category: sporting | financial | institutional | other
nvs_score: integer 0-100 (Beşiktaş relevance × newsworthiness; 100=breaking BJK news, 0=no BJK angle)
claim_confidence: "confirmed" (official source/signing confirmed) | "high" (senior journalist, named source) | "medium" (credible rumor) | "low" (unverified speculation) | "rumor" (pure gossip, no named source)
key_quotes: up to 3 verbatim short quotes or key phrases from the article (empty array if none)
source_sentences: up to 3 verbatim sentences from the article that best ground the main claim — pick the most informative, max 200 chars each. Each has a "role": "lead_claim" | "supporting_detail" | "direct_quote" | "denial" | "contradiction". Empty array if article is too short.
primary_entity: the single main subject (player or person). null if no clear individual subject.
negotiation_status (transfer stories only, null otherwise): "rumor" | "interest" | "talks_opened" | "fee_agreed" | "personal_terms" | "medical" | "signed" | "official" | "collapsed" | "denied"

{
  "story_type": "...",
  "story_category": "...",
  "nvs_score": 0,
  "claim_confidence": "medium",
  "key_quotes": [],
  "source_sentences": [{"text": "...", "role": "lead_claim"}],
  "primary_entity": {"name": "...", "type": "player"},
  "negotiation_status": null,
  "entities": { "players": [], "clubs": [], "competitions": [] },
  "numbers": { "transfer_fee": null, "contract_years": null, "ban_games": null, "recovery_weeks": null, "fine_amount": null, "other": [] },
  "dates": { "primary_date": null, "other": [] }
}

Article:
${source}

Return only the JSON.`;

  try {
    const res    = await callClaude(env, MODEL_FETCH, prompt, false, 700);
    const raw    = extractText(res.content);
    const m      = raw.match(/\{[\s\S]*\}/);
    if (!m) return _fallbackExtractAndScore();

    const p = JSON.parse(m[0]);
    const storyType = normalizeStoryType(p.story_type);

    const sourceSentences = Array.isArray(p.source_sentences)
      ? p.source_sentences
          .filter(s => s && typeof s.text === 'string' && s.text.trim())
          .map(s => ({ text: s.text.trim().slice(0, 200), role: s.role || 'lead_claim' }))
          .slice(0, 3)
      : [];

    const primaryEntity = p.primary_entity?.name ? {
      name:       p.primary_entity.name,
      type:       p.primary_entity.type || 'player',
      normalized: normalizeEntityName(p.primary_entity.name),
    } : null;

    const entityFingerprint = buildEntityFingerprint(storyType, primaryEntity?.name);

    const VALID_NEG_STATUS = new Set(['rumor','interest','talks_opened','fee_agreed','personal_terms','medical','signed','official','collapsed','denied']);
    const negotiationStatus = (storyType === 'transfer' && VALID_NEG_STATUS.has(p.negotiation_status))
      ? p.negotiation_status : null;

    const VALID_CONFIDENCE = new Set(['confirmed','high','medium','low','rumor']);
    const claimConfidence = VALID_CONFIDENCE.has(p.claim_confidence) ? p.claim_confidence : 'medium';

    const facts = {
      story_type:          storyType,
      story_category:      p.story_category || 'other',
      nvs_score:           typeof p.nvs_score === 'number' ? Math.max(0, Math.min(100, Math.round(p.nvs_score))) : null,
      claim_confidence:    claimConfidence,
      key_quotes:          Array.isArray(p.key_quotes) ? p.key_quotes.filter(q => typeof q === 'string' && q.trim()) : [],
      source_sentences:    sourceSentences,
      primary_entity:      primaryEntity,
      negotiation_status:  negotiationStatus,
      entity_fingerprint:  entityFingerprint,
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

    const factsRows = await supabasePost(env, '/rest/v1/facts', {
      content_item_id:          article.id      ?? null,
      site_id:                  article.site_id ?? null,
      story_type:               facts.story_type,
      entities:                 facts.entities,
      numbers:                  facts.numbers,
      dates:                    facts.dates,
      source_sentences:         facts.source_sentences.length ? facts.source_sentences : null,
      claim_confidence:         facts.claim_confidence,
      primary_entity:           facts.primary_entity,
      negotiation_status:       facts.negotiation_status,
      entity_fingerprint:       facts.entity_fingerprint,
      extraction_tier:          'llm_full',
      source_published_at:      article.published_at ?? null,
      extraction_model:         MODEL_FETCH,
      extraction_input_tokens:  res.usage?.input_tokens  ?? null,
      extraction_output_tokens: res.usage?.output_tokens ?? null,
    });

    await supabasePost(env, '/rest/v1/fact_lineage', {
      content_item_id:          article.id ?? null,
      facts_id:                 factsRows?.[0]?.id ?? null,
      source_url:               article.url || article.original_url || '',
      source_name:              article.source_name || '',
      source_text_length:       source.length,
      extraction_model:         MODEL_FETCH,
      extraction_tokens_in:     res.usage?.input_tokens  ?? null,
      extraction_tokens_out:    res.usage?.output_tokens ?? null,
      destruction_confirmed_at: new Date().toISOString(),
    });

    return { ...facts, _id: factsRows?.[0]?.id ?? null, _usage: res.usage ?? null };
  } catch {
    return _fallbackExtractAndScore();
  }
}

function _fallbackExtractAndScore() {
  return {
    story_type: 'other', story_category: 'other', nvs_score: null, key_quotes: [],
    claim_confidence: 'medium', source_sentences: [], primary_entity: null,
    negotiation_status: null, entity_fingerprint: null,
    _id: null, _usage: null,
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
