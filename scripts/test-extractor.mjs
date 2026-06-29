#!/usr/bin/env node
/**
 * test-extractor.mjs — Dry-run the new unified extractor against real past content_items.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=xxx \
 *   ANTHROPIC_API_KEY=xxx \
 *   node scripts/test-extractor.mjs [--limit N] [--days N]
 *
 *   --limit N   number of items to test (default 6)
 *   --days N    look back N days (default 3)
 *
 * Nothing is written to the DB. Shows new extraction vs existing fact.
 */

import { extractFacts } from '../src/extractor.js';

const args   = process.argv.slice(2);
const LIMIT  = parseInt(args[args.indexOf('--limit') + 1] || '6',  10);
const DAYS   = parseInt(args[args.indexOf('--days')  + 1] || '3',  10);

const ENV = {
  SUPABASE_URL:         process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  ANTHROPIC_API_KEY:    process.env.ANTHROPIC_API_KEY,
};
if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_KEY || !ENV.ANTHROPIC_API_KEY) {
  console.error('Required: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY');
  process.exit(1);
}

async function sbGet(path) {
  const res = await fetch(`${ENV.SUPABASE_URL}${path}`, {
    headers: { apikey: ENV.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}` },
  });
  return res.ok ? res.json() : [];
}

// trust_score int → tier label for TIER_BASE lookup
function trustTier(score) {
  if (!score)    return 'T4';
  if (score >= 85) return 'T1';
  if (score >= 65) return 'T2';
  if (score >= 45) return 'T3';
  return 'T4';
}

const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

// Fetch items with body text, diverse content types
const rows = await sbGet(
  `/rest/v1/content_items?published_at=gte.${since}` +
  `&full_body=not.is.null` +
  `&select=id,site_id,title,summary,full_body,source_url,original_url,source_name,trust_score,published_at,content_type` +
  `&order=trust_score.desc,published_at.desc&limit=${LIMIT * 3}`
);

if (!rows.length) {
  console.error('No content_items found.'); process.exit(0);
}

// Pick a diverse sample: prefer rumor/fact content types with body > 400 chars
const pool = rows.filter(r => r.full_body && r.full_body.length > 400
  && !['kartalix_generated', 'analysis'].includes(r.content_type));
const sample = pool.slice(0, LIMIT);

if (!sample.length) {
  console.error('No suitable items found.'); process.exit(0);
}

// For each item, also fetch its existing fact from the DB
const ids = sample.map(r => `"${r.id}"`).join(',');
const existingFacts = await sbGet(
  `/rest/v1/facts?content_item_id=in.(${ids})` +
  `&select=content_item_id,story_type,grounding_summary,key_quotes,claim_status,source_type,fact_trust,extraction_tier`
);
const factsByItem = new Map(existingFacts.map(f => [f.content_item_id, f]));

// ─── Run extraction ───────────────────────────────────────────

console.log(`\n${'═'.repeat(80)}`);
console.log(`EXTRACTOR DRY-RUN — ${sample.length} items, last ${DAYS} days`);
console.log(`${'═'.repeat(80)}\n`);

let passCount = 0, failCount = 0;

for (const row of sample) {
  const item = {
    id:           row.id,
    site_id:      row.site_id,
    trust_tier:   trustTier(row.trust_score),
    trust_score:  row.trust_score,
    published_at: row.published_at,
    url:          row.source_url || row.original_url || null,
    source_name:  row.source_name,
  };

  const text       = row.full_body || row.summary || row.title;
  const sourceType = row.content_type === 'youtube_embed' ? 'yt_title' : 'rss_full';
  const existing   = factsByItem.get(row.id) ?? null;

  console.log(`▶ ${row.title.slice(0, 80)}`);
  console.log(`  source: ${row.source_name} | trust_score: ${row.trust_score} | type: ${sourceType} | len: ${text.length}`);
  if (existing) {
    console.log(`  EXISTING FACT:`);
    console.log(`    story_type:       ${existing.story_type}`);
    console.log(`    claim_status:     ${existing.claim_status ?? '(null)'}`);
    console.log(`    fact_trust:       ${existing.fact_trust ?? '(null)'}`);
    console.log(`    grounding_summary:${existing.grounding_summary ? ' "' + existing.grounding_summary.slice(0, 100) + '"' : ' (null)'}`);
    console.log(`    key_quotes:       ${JSON.stringify(existing.key_quotes ?? '(null)').slice(0, 80)}`);
  } else {
    console.log(`  EXISTING FACT: (none)`);
  }

  try {
    const claims = await extractFacts({ text, sourceType, item, env: ENV, dryRun: true });
    if (!claims.length) {
      console.log(`  NEW EXTRACTION: (no claims extracted)\n`);
      failCount++;
      continue;
    }
    passCount++;
    console.log(`  NEW EXTRACTION: ${claims.length} claim(s)`);
    for (const [i, c] of claims.entries()) {
      console.log(`  ── Claim ${i + 1} ──`);
      console.log(`    story_type:        ${c.story_type}`);
      console.log(`    claim_status:      ${c.claim_status}`);
      console.log(`    claim_confidence:  ${c.claim_confidence}`);
      console.log(`    fact_trust:        ${c.fact_trust}`);
      console.log(`    event_date:        ${c.event_date ?? '(null)'}`);
      console.log(`    primary_entity:    ${c.primary_entity ? `${c.primary_entity.name} (${c.primary_entity.type})` : '(null)'}`);
      console.log(`    negotiation_status:${c.negotiation_status ?? '(null)'}`);
      console.log(`    entity_fingerprint:${c.entity_fingerprint ?? '(null)'}`);
      console.log(`    grounding_summary: "${c.grounding_summary.slice(0, 120)}"`);
      if (c.key_quotes.length) {
        for (const q of c.key_quotes) {
          console.log(`    quote: "${q.text}" — ${q.speaker ?? 'unknown'} (${q.role ?? '?'})`);
        }
      }
      const nums = Object.entries(c.numbers).filter(([, v]) => v != null && (Array.isArray(v) ? v.length > 0 : true));
      if (nums.length) console.log(`    numbers:           ${JSON.stringify(c.numbers)}`);
      const ents = [...(c.entities.players || []), ...(c.entities.clubs || [])];
      if (ents.length) console.log(`    entities:          ${ents.join(', ')}`);
    }
  } catch (e) {
    console.log(`  NEW EXTRACTION ERROR: ${e.message}`);
    failCount++;
  }
  console.log();
}

console.log(`${'─'.repeat(80)}`);
console.log(`Results: ${passCount} extracted, ${failCount} failed / no claims, ${sample.length} total`);
console.log('(No DB writes — dry-run mode)\n');
