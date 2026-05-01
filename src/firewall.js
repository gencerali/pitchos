import { callClaude, extractText, MODEL_FETCH } from './utils.js';

// ─── STORY TYPE CLASSIFIER ────────────────────────────────────
// Single Haiku call — classifies news before fact extraction so
// each story type gets the right schema.
export async function classifyStoryType(article, env) {
  const text = `${article.title}. ${article.summary || ''}`.slice(0, 400);
  const prompt = `Classify this Turkish football news article. Return ONLY valid JSON.

Article: ${text}

Story types (pick the best fit):
- transfer: player moving between clubs, loan, signing
- injury: player injury or medical news
- disciplinary: suspension, ban, fine, card accumulation
- contract: contract renewal, extension, buyout, termination
- match_result: a specific finished match, score, goal event
- squad: lineup, formation, squad call-up
- institutional: club ownership, management change, financial restructuring
- other: anything else

{"story_type": "<type>", "story_category": "sporting" | "financial" | "institutional" | "other"}

sporting: transfer, injury, disciplinary, contract, match_result, squad
financial: contract value as primary story, FFP, debt
institutional: ownership, board, management

Return only the JSON.`;

  try {
    const res  = await callClaude(env, MODEL_FETCH, prompt, false, 80);
    const raw  = extractText(res.content);
    const json = raw.match(/\{[\s\S]*\}/);
    if (!json) return { story_type: 'other', story_category: 'other' };
    const parsed = JSON.parse(json[0]);
    return {
      story_type:     parsed.story_type     || 'other',
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
