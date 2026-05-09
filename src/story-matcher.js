import { callClaude, extractText, supabase, generateSlug, MODEL_FETCH, MODEL_GENERATE, getEditorialNotes } from './utils.js';
import { fetchViaReadability } from './publisher.js';

// ─── CONFIDENCE DELTAS ────────────────────────────────────────
const DELTA = {
  initial:       30,
  confirming:    20,
  updating:      10,
  contradicting: -10,
};

// Official sources (bjk.com.tr) cross the generation threshold on first contribution.
const OFFICIAL_INITIAL_DELTA = 60;

// ─── SOURCE INDEPENDENCE GATE ─────────────────────────────────
// Stories can only reach 'confirmed' if at least one contribution came from
// a broadcast or official source. Press/aggregator-only cite chains are capped
// at 'developing' regardless of confidence score.
// Prevents: "5 tabloids reprinting one rumour = confirmed story"
const QUALITY_TIERS = new Set(['official', 'broadcast']);

// ─── ARCHIVAL WINDOWS (days of silence before archiving) ──────
// Keyed by story_type — each type has a natural lifecycle length.
// Falls back to story_category if type not listed, then to 7 days.
const ARCHIVE_DAYS_BY_TYPE = {
  transfer:      15,   // rumours take weeks; silence means deal died or was covered
  injury:         7,   // player recovers or situation resolves quickly
  disciplinary:   5,   // short lifecycle — bans are served, fines paid
  contract:      30,   // negotiations stretch for months
  institutional: 30,   // board/ownership stories are slow-moving
  other:          7,
};
const ARCHIVE_DAYS_BY_CATEGORY = {
  financial:     30,
  institutional: 30,
  other:          7,
};

// ─── OPEN STATES (accept new contributions) ───────────────────
const OPEN_STATES = ['emerging', 'developing', 'confirmed', 'active', 'scheduled', 'pre_match', 'live', 'post_match'];

// ─── MATCH STORY TIME-BASED STATE ────────────────────────────
// Match stories advance by clock, not confidence.
//   scheduled  → T-∞ to T-3d
//   pre_match  → T-3d to T-30min
//   live       → T-30min to T+110min (full-time)
//   post_match → T+110min to T+48h
//   archived   → T+48h+
function nextMatchStoryState(matchDate) {
  const now             = Date.now();
  const kickoff         = new Date(matchDate).getTime();
  const minsFromKickoff = (now - kickoff) / 60000;
  const daysToKickoff   = (kickoff - now) / 86400000;
  if (minsFromKickoff > 48 * 60) return 'archived';
  if (minsFromKickoff > 110)     return 'post_match';
  if (minsFromKickoff >= -30)    return 'live';
  if (daysToKickoff   <= 3)      return 'pre_match';
  return 'scheduled';
}

// ─── STAGE 1: ENTITY FINGERPRINT ─────────────────────────────
// Pure JS. Returns open stories that share at least one player
// or club name with the incoming facts.
function entityOverlap(factsEntities, storyEntities) {
  const factsPlayers = (factsEntities?.players || []).map(s => s.toLowerCase());
  const factsClubs   = (factsEntities?.clubs   || []).map(s => s.toLowerCase());
  const storyPlayers = (storyEntities?.players || []).map(s => s.toLowerCase());
  const storyClubs   = (storyEntities?.clubs   || []).map(s => s.toLowerCase());

  // Player match: strong signal — any shared player is a candidate
  const playerMatch = factsPlayers.some(p => storyPlayers.includes(p));
  if (playerMatch) return true;

  // Club match: weak signal — single club (e.g. "Beşiktaş") matches almost every story.
  // Only use as signal when 2+ clubs overlap (e.g. both "Beşiktaş" and "Werder Bremen").
  const clubMatches = factsClubs.filter(c => storyClubs.includes(c));
  return clubMatches.length >= 2;
}

export async function getOpenStories(siteId, env) {
  const stateFilter = OPEN_STATES.map(s => `"${s}"`).join(',');
  return await supabase(env, 'GET',
    `/rest/v1/stories?site_id=eq.${siteId}&state=in.(${OPEN_STATES.join(',')})&order=last_contribution_at.desc&limit=50&select=id,story_type,story_category,state,entities,title,confidence`
  ) || [];
}

// ─── STAGE 2: CLAUDE JUDGE ────────────────────────────────────
// Receives facts + candidate stories. Returns match decision.
// facts.story_type is pre-classified — passed as hint so Claude
// doesn't re-classify from scratch when creating a new story.
async function judgeMatch(facts, article, candidates, env) {
  const candidatesText = candidates.length > 0
    ? candidates.map(s =>
        `ID: ${s.id}\nType: ${s.story_type}\nTitle: ${s.title || '(no title)'}\nEntities: ${JSON.stringify(s.entities)}\nConfidence: ${s.confidence}\nState: ${s.state}`
      ).join('\n\n')
    : '(no candidates — determine if this is a new story)';

  const typeHint = facts.story_type && facts.story_type !== 'other'
    ? `\nPRE-CLASSIFIED STORY TYPE: ${facts.story_type} (${facts.story_category || 'sporting'}) — use this unless a match is found`
    : '';

  const prompt = `You are a football news story matcher. Determine if this new article belongs to an existing open story, or if it represents a new story.

NEW ARTICLE FACTS:
Title: ${article.title}
Entities: ${JSON.stringify(facts.entities)}
Numbers: ${JSON.stringify(facts.numbers)}
Dates: ${JSON.stringify(facts.dates)}${typeHint}

OPEN STORIES:
${candidatesText}

Return ONLY valid JSON. No other text.

If the article matches an existing story:
{
  "match": "<story_id>",
  "contribution_type": "confirming" | "updating" | "contradicting",
  "confidence_delta": <number>,
  "reason": "<one sentence>"
}

If this is a new story:
{
  "match": "new",
  "story_type": "<use the pre-classified type above if provided, otherwise: transfer, injury, contract, disciplinary, institutional, other>",
  "story_category": "sporting" | "financial" | "institutional" | "other",
  "title": "<short working title for this story>",
  "contribution_type": "initial",
  "confidence_delta": 30,
  "reason": "<one sentence>"
}

Rules:
- Only match if you are confident it is the same ongoing event, not just the same topic
- Use "contradicting" if the new article contradicts key facts of the matched story
- Use "updating" if it adds new facts without confirming or contradicting
- Use "confirming" if it corroborates the existing story facts`;

  const res  = await callClaude(env, MODEL_FETCH, prompt, false, 400);
  const text = extractText(res.content);
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('story-matcher: no JSON in Claude response');
  return { decision: JSON.parse(json[0]), usage: res.usage };
}

// ─── STATE MACHINE ────────────────────────────────────────────
// Cascades: a single contribution can jump multiple states if confidence warrants.
function nextState(currentState, newConfidence, contributionType, hasQuality = false) {
  // Debunked: contradicting contribution drives confidence below floor — story is false/denied
  if (contributionType === 'contradicting' && newConfidence < 15) return 'debunked';

  if (contributionType === 'contradicting' && newConfidence < 60) {
    if (currentState === 'confirmed' || currentState === 'active') return 'developing';
  }
  if ((currentState === 'emerging' || currentState === 'developing') && newConfidence >= 60) {
    // Source independence gate: press-only chains cap at 'developing'
    return hasQuality ? 'confirmed' : 'developing';
  }
  if (currentState === 'emerging' && newConfidence >= 40) return 'developing';
  return currentState;
}

async function recordTransition(storyId, fromState, toState, trigger, env, notes = null) {
  if (fromState === toState) return;
  await supabase(env, 'POST', '/rest/v1/story_state_transitions', {
    story_id:     storyId,
    from_state:   fromState,
    to_state:     toState,
    trigger,
    notes,
  });
}

// ─── CREATE NEW STORY ─────────────────────────────────────────
async function createStory(facts, article, decision, siteId, env) {
  const isQualitySource = QUALITY_TIERS.has(article.trust_tier);
  const initialDelta = article.trust_tier === 'official' ? OFFICIAL_INITIAL_DELTA : DELTA.initial;
  const initialState = nextState('emerging', initialDelta, 'initial', isQualitySource);

  // Use pre-classified type from extractFactsForStory when judge didn't provide one
  const storyType     = decision.story_type     || facts.story_type     || 'other';
  const storyCategory = decision.story_category || facts.story_category || 'other';

  const entities = isQualitySource
    ? { ...facts.entities, _quality_source: true }
    : facts.entities;

  const rows = await supabase(env, 'POST', '/rest/v1/stories', {
    site_id:        siteId,
    story_type:     storyType,
    story_category: storyCategory,
    state:          initialState,
    entities,
    confidence:     initialDelta,
    title:          decision.title || article.title,
    first_contribution_at: new Date().toISOString(),
    last_contribution_at:  new Date().toISOString(),
  });
  const story = rows?.[0];
  if (!story) throw new Error('story-matcher: failed to create story row');

  await recordTransition(story.id, null, initialState, 'new_contribution', env, 'Story created');
  return story;
}

// ─── ADD CONTRIBUTION ─────────────────────────────────────────
async function addContribution(storyId, article, facts, decision, env) {
  await supabase(env, 'POST', '/rest/v1/story_contributions', {
    story_id:          storyId,
    content_item_id:   article.id   || null,
    facts_id:          facts._id    || null,
    contribution_type: decision.contribution_type,
    confidence_delta:  decision.confidence_delta ?? DELTA[decision.contribution_type] ?? 0,
  });
}

// ─── UPDATE STORY AFTER CONTRIBUTION ─────────────────────────
async function applyContribution(story, decision, article, env) {
  const delta         = decision.confidence_delta ?? DELTA[decision.contribution_type] ?? 0;
  const newConfidence = Math.max(0, Math.min(100, story.confidence + delta));

  // Quality source flag: true once any official/broadcast source has contributed
  const isQualitySource = QUALITY_TIERS.has(article?.trust_tier);
  const hadQuality      = story.entities?._quality_source === true;
  const hasQuality      = isQualitySource || hadQuality;

  const newState  = nextState(story.state, newConfidence, decision.contribution_type, hasQuality);
  const trigger   = newState !== story.state ? 'confidence_threshold' : 'new_contribution';

  const patch = {
    confidence:           newConfidence,
    state:                newState,
    last_contribution_at: new Date().toISOString(),
  };
  if (isQualitySource && !hadQuality) {
    patch.entities = { ...story.entities, _quality_source: true };
  }

  await supabase(env, 'PATCH', `/rest/v1/stories?id=eq.${story.id}`, patch);
  await recordTransition(story.id, story.state, newState, trigger, env, decision.reason);

  return { ...story, confidence: newConfidence, state: newState };
}

// ─── GENERATION TRIGGER ───────────────────────────────────────
// Called when a story reaches 'confirmed'. Fetches full source content,
// synthesizes an original 300–500 word Kartalix article via Claude Sonnet.
// Source text is never stored — discarded after generation.
// See DECISIONS.md 2026-04-29 — Synthesis generation.
async function generateStoryArticle(story, facts, article, siteId, env) {
  // 1. Fetch full text of the triggering source article
  let sourceText = '';
  if (article.url && article.url !== '#') {
    const { content } = await fetchViaReadability(article.url);
    sourceText = content;
  }
  // Fall back to RSS summary if Readability fails or URL is missing
  if (!sourceText) {
    sourceText = article.summary || article.description || '';
  }

  // 2. Build structured context from extracted facts
  const factLines = [
    story.story_type                  ? `Konu tipi: ${story.story_type}` : null,
    facts.entities?.players?.length   ? `Oyuncular: ${facts.entities.players.join(', ')}` : null,
    facts.entities?.clubs?.length     ? `Kulüpler: ${facts.entities.clubs.join(', ')}` : null,
    facts.entities?.competitions?.length ? `Organizasyon: ${facts.entities.competitions.join(', ')}` : null,
    facts.numbers?.transfer_fee       ? `Rakam: ${facts.numbers.transfer_fee}` : null,
    facts.numbers?.contract_years     ? `Sözleşme: ${facts.numbers.contract_years} yıl` : null,
    facts.dates?.announcement         ? `Tarih: ${facts.dates.announcement}` : null,
    ...(facts.numbers?.other || []).map(n => `Diğer: ${n}`),
  ].filter(Boolean).join('\n');

  // 3. Synthesize original article with Claude Sonnet
  const editorialNotes = await getEditorialNotes(env, ['news', story.story_type || '']);
  const prompt = `${editorialNotes}Sen Kartalix'in kıdemli spor editörüsün. Beşiktaş ile ilgili aşağıdaki kaynak haberi oku ve özgün bir Kartalix haberi yaz.

DOĞRULANMIŞ BİLGİLER:
${factLines || '(bağlam aşağıdaki kaynaktan çıkarılacak)'}

KAYNAK HABER:
Başlık: ${article.title || story.title || ''}
${sourceText.slice(0, 4000)}

YAZIM KURALLARI:
- 300–500 kelime, profesyonel Türkçe haber üslubu
- İlk paragraf (lede): kim, ne, nerede, ne zaman — en önemli bilgiyi öne al
- 2–3 gelişme paragrafı: detaylar, rakamlar, bağlam, arka plan
- Son paragraf: bu haberden sonra ne bekleniyor, süreç nasıl ilerleyecek
- Tamamen özgün cümleler kur — kaynaktan kopyalama
- "Kaynaklara göre", "habere göre", "bir kaynaktan öğrenildiğine göre" gibi ifadeler KULLANMA
- Haberi Kartalix'in kendi haberi gibi yaz, referans verme
- Emoji kullanma, başlık yazma — sadece haber gövdesini yaz

Sadece Türkçe haber metnini yaz.`;

  let body = '';
  try {
    const res = await callClaude(env, MODEL_GENERATE, prompt, false, 1500);
    body = extractText(res.content).trim();
    const wordCount = body.split(/\s+/).length;
    console.log(`SYNTHESIS: story ${story.id} → ${wordCount} words`);
  } catch (e) {
    console.error('Synthesis failed:', e.message, '| story:', story.id);
    // Graceful fallback — at least save what we have
    body = sourceText.slice(0, 600) || article.title || story.title || '';
  }

  if (!body) return null;

  // 4. Save to content_items — source text is discarded here, only the generated body persists
  const title   = story.title || article.title;
  const summary = body.replace(/\n+/g, ' ').slice(0, 300);
  const slug    = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:        siteId,
    source_type:    'kartalix',
    source_name:    'Kartalix',
    original_url:   '',
    title,
    summary,
    full_body:      body,
    category:       article.category || 'Club',
    content_type:   'kartalix_generated',
    sport:          'football',
    nvs_score:      75,
    publish_mode:   'synthesis_generated',
    status:         'published',
    story_id:       story.id,
    slug,
    published_at:   new Date().toISOString(),
    reviewed_at:    new Date().toISOString(),
    reviewed_by:    'auto',
  });

  // 5. Advance story to active
  await supabase(env, 'PATCH', `/rest/v1/stories?id=eq.${story.id}`, {
    state:            'active',
    generation_count: (story.generation_count || 0) + 1,
    published_at:     new Date().toISOString(),
  });
  await recordTransition(story.id, 'confirmed', 'active', 'new_contribution', env, 'Article synthesized');

  console.log(`STORY SYNTHESIZED: "${title.slice(0, 60)}" → story ${story.id}`);
  return saved?.[0] || null;
}

// ─── MAIN ENTRY POINT ─────────────────────────────────────────
// Called once per ingested article after facts are extracted.
// openStories is pre-fetched once per processSite run and passed in to avoid
// N×Supabase reads when matching multiple articles.
export async function matchOrCreateStory(article, facts, siteId, env, openStories = null) {
  if (!openStories) openStories = await getOpenStories(siteId, env);

  // Stage 1: find candidates by entity overlap
  const candidates = openStories.filter(s => entityOverlap(facts.entities, s.entities));

  // Stage 2: Claude judge — runs against candidates (or all open if no entity overlap)
  const judgeInput  = candidates.length > 0 ? candidates : openStories.slice(0, 10);
  const { decision, usage } = await judgeMatch(facts, article, judgeInput, env);

  if (decision.match === 'new') {
    // Match stories are seeded by the fixture API, not press articles — skip creation
    if (decision.story_type === 'match') {
      return { story: null, decision, isNew: false, usage };
    }
    const story = await createStory(facts, article, decision, siteId, env);
    await addContribution(story.id, article, facts, decision, env);
    if (story.state === 'confirmed') {
      await generateStoryArticle(story, facts, article, siteId, env);
    }
    return { story, decision, isNew: true, usage };
  }

  // Match found — find the story object
  const matched = openStories.find(s => s.id === decision.match);
  if (!matched) {
    if (decision.story_type === 'match') return { story: null, decision, isNew: false, usage };
    const story = await createStory(facts, article, { ...decision, match: 'new' }, siteId, env);
    await addContribution(story.id, article, facts, { ...decision, contribution_type: 'initial', confidence_delta: 30 }, env);
    if (story.state === 'confirmed') {
      await generateStoryArticle(story, facts, article, siteId, env);
    }
    return { story, decision, isNew: true, usage };
  }

  // Match stories: time-driven state — record contribution but never touch state
  if (matched.story_type === 'match') {
    await addContribution(matched.id, article, facts, decision, env);
    await supabase(env, 'PATCH', `/rest/v1/stories?id=eq.${matched.id}`, {
      last_contribution_at: new Date().toISOString(),
    });
    return { story: matched, decision, isNew: false, usage };
  }

  await addContribution(matched.id, article, facts, decision, env);
  const updated = await applyContribution(matched, decision, article, env);
  if (updated.state === 'confirmed' && matched.state !== 'confirmed') {
    await generateStoryArticle(updated, facts, article, siteId, env);
  }
  return { story: updated, decision, isNew: false, usage };
}

// ─── MATCH STORY — PROACTIVE CREATION ────────────────────────
// Called hourly from processSite after getNextFixture.
// Idempotent: returns existing story if already created for this fixture.
export async function createMatchStory(match, siteId, env) {
  const fixtureId = match.fixture_id;
  if (!fixtureId) throw new Error('createMatchStory: fixture_id required');

  const matchDate = `${match.date}T${match.time || '20:00'}:00+03:00`;
  const newState  = nextMatchStoryState(matchDate);

  // Idempotency: look up existing story by fixture_id in JSONB entities
  const existing = await supabase(env, 'GET',
    `/rest/v1/stories?site_id=eq.${siteId}&story_type=eq.match&entities->>fixture_id=eq.${fixtureId}&select=id,state,entities&limit=1`
  );

  if (existing?.length > 0) {
    const story = existing[0];
    if (newState !== story.state) {
      await supabase(env, 'PATCH', `/rest/v1/stories?id=eq.${story.id}`, { state: newState });
      await recordTransition(story.id, story.state, newState, 'time_elapsed', env, `Match date: ${matchDate}`);
    }
    return { ...story, state: newState };
  }

  if (newState === 'archived') return null; // past match, skip

  const homeTeam = match.home ? 'Beşiktaş' : (match.opponent || 'Opponent');
  const awayTeam = match.home ? (match.opponent || 'Opponent') : 'Beşiktaş';

  const rows = await supabase(env, 'POST', '/rest/v1/stories', {
    site_id:        siteId,
    story_type:     'match',
    story_category: 'sporting',
    state:          newState,
    entities: {
      fixture_id: fixtureId,
      match_date: matchDate,
      clubs:      ['Beşiktaş', match.opponent].filter(Boolean),
      players:    [],
    },
    confidence:     100,
    title:          `${homeTeam} - ${awayTeam} (${match.date})`,
    first_contribution_at: new Date().toISOString(),
    last_contribution_at:  new Date().toISOString(),
  });

  const story = rows?.[0];
  if (!story) throw new Error('createMatchStory: failed to create story row');
  await recordTransition(story.id, null, newState, 'fixture_scheduled', env, 'Match story created');
  console.log(`MATCH STORY: created fixture ${fixtureId} (${homeTeam} - ${awayTeam}) → ${newState}`);
  return story;
}

// Look up the active match story for a fixture (for templates to set story_id)
export async function getMatchStory(fixtureId, siteId, env) {
  const rows = await supabase(env, 'GET',
    `/rest/v1/stories?site_id=eq.${siteId}&story_type=eq.match&entities->>fixture_id=eq.${fixtureId}&select=id,state,entities,title&limit=1`
  );
  return rows?.[0] || null;
}

// ─── MATCH STORY — TIME ADVANCEMENT CRON ─────────────────────
// Called on the daily 0 4 cron. Advances all open match stories
// based on current clock position relative to their match_date.
export async function advanceMatchStoryStates(siteId, env) {
  const stories = await supabase(env, 'GET',
    `/rest/v1/stories?site_id=eq.${siteId}&story_type=eq.match&state=not.in.(archived)&select=id,state,entities`
  ) || [];

  let advanced = 0;
  for (const story of stories) {
    const matchDate = story.entities?.match_date;
    if (!matchDate) continue;
    const newState = nextMatchStoryState(matchDate);
    if (newState !== story.state) {
      await supabase(env, 'PATCH', `/rest/v1/stories?id=eq.${story.id}`, { state: newState });
      await recordTransition(story.id, story.state, newState, 'time_elapsed', env, `Match date: ${matchDate}`);
      advanced++;
    }
  }
  return { advanced };
}

// ─── ARCHIVAL CRON ────────────────────────────────────────────
// Call this on a daily cron. Archives stories with no recent contribution.
export async function archiveStaleStories(siteId, env) {
  const openStories = await getOpenStories(siteId, env);
  const now = Date.now();
  let archived = 0;

  for (const story of openStories) {
    const days = ARCHIVE_DAYS_BY_TYPE[story.story_type]
              ?? ARCHIVE_DAYS_BY_CATEGORY[story.story_category]
              ?? 7;
    const cutoff = days * 24 * 60 * 60 * 1000;
    const lastContrib = new Date(story.last_contribution_at).getTime();

    if (now - lastContrib > cutoff) {
      await supabase(env, 'PATCH', `/rest/v1/stories?id=eq.${story.id}`, { state: 'archived' });
      await recordTransition(story.id, story.state, 'archived', 'time_elapsed', env,
        `No contribution for ${days}+ days`);
      archived++;
    }
  }

  return { archived };
}
