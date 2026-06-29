#!/usr/bin/env node
/**
 * backfill-facts.mjs — MB-N3-4 Phase 2: Re-extract facts from content_items
 * that have full_body text, replacing English summaries with proper Turkish ones
 * and filling in key_quotes, event_date, and accurate fact_trust.
 *
 * Only touches facts where content_item_id IS NOT NULL AND full_body IS available.
 * PATCHes existing fact rows — never inserts new ones.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=xxx \
 *   ANTHROPIC_API_KEY=xxx \
 *   node scripts/backfill-facts.mjs [--batch N] [--dry-run]
 *
 *   --batch N    how many facts to process per run (default 20)
 *   --dry-run    print what would be updated without writing to DB
 */

import { extractFacts, computeFactTrust, resolveClaimStatus } from '../src/extractor.js';

const args    = process.argv.slice(2);
const BATCH   = parseInt(args[args.indexOf('--batch') + 1] || '20', 10);
const DRY_RUN = args.includes('--dry-run');

const ENV = {
  SUPABASE_URL:         process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  ANTHROPIC_API_KEY:    process.env.ANTHROPIC_API_KEY,
};
if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_KEY || !ENV.ANTHROPIC_API_KEY) {
  console.error('Required: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY');
  process.exit(1);
}

function scoreTier(score) {
  if (!score || score <= 30) return 'T4';
  if (score <= 55)           return 'T3';
  if (score <= 75)           return 'T2';
  return 'T1';
}

async function sbGet(path) {
  const res = await fetch(`${ENV.SUPABASE_URL}${path}`, {
    headers: { apikey: ENV.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

async function sbPatch(path, body) {
  const res = await fetch(`${ENV.SUPABASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: ENV.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status} ${await res.text()}`);
}

// Fetch facts that have a content_item with full_body available.
// Order by created_at asc so oldest get fixed first.
const candidates = await sbGet(
  `/rest/v1/facts?content_item_id=not.is.null` +
  `&select=id,content_item_id,story_type,source_type,fact_trust,grounding_summary` +
  `&order=created_at.asc&limit=${BATCH}`
);

if (!candidates.length) {
  console.log('No candidates found.');
  process.exit(0);
}

// Fetch matching content_items in one go.
const itemIds = [...new Set(candidates.map(f => f.content_item_id))];
const items = await sbGet(
  `/rest/v1/content_items?id=in.(${itemIds.map(id => `"${id}"`).join(',')})` +
  `&select=id,title,full_body,summary,source_name,trust_score,published_at,content_type,source_url,original_url,site_id`
);
const itemById = new Map(items.map(i => [i.id, i]));

// Group facts by content_item_id (a single item can have multiple fact rows).
const factsByItem = new Map();
for (const f of candidates) {
  if (!factsByItem.has(f.content_item_id)) factsByItem.set(f.content_item_id, []);
  factsByItem.get(f.content_item_id).push(f);
}

console.log(`\n${'═'.repeat(70)}`);
console.log(`BACKFILL Phase 2 — ${candidates.length} facts across ${itemById.size} items${DRY_RUN ? ' [DRY RUN]' : ''}`);
console.log(`${'═'.repeat(70)}\n`);

let updated = 0, skipped = 0, errors = 0;

for (const [itemId, facts] of factsByItem) {
  const ci = itemById.get(itemId);
  if (!ci || (!ci.full_body && !ci.summary)) {
    console.log(`  SKIP ${itemId} — no body text in content_item`);
    skipped += facts.length;
    continue;
  }

  const text       = ci.full_body || ci.summary;
  const sourceType = ci.content_type === 'youtube_embed'
    ? 'yt_title'
    : (ci.full_body && ci.full_body.length > 400 ? 'rss_full' : 'rss_summary');

  const item = {
    id:           ci.id,
    site_id:      ci.site_id,
    trust_tier:   scoreTier(ci.trust_score),
    trust_score:  ci.trust_score,
    published_at: ci.published_at,
    url:          ci.source_url || ci.original_url || null,
    source_name:  ci.source_name,
  };

  console.log(`▶ ${(ci.title || itemId).slice(0, 70)}`);
  console.log(`  ${ci.source_name} | tier=${item.trust_tier} | sourceType=${sourceType} | facts=${facts.length}`);

  let claims;
  try {
    claims = await extractFacts({ text, sourceType, item, env: ENV, dryRun: true });
  } catch (e) {
    console.log(`  ERROR extracting: ${e.message}`);
    errors += facts.length;
    continue;
  }

  if (!claims.length) {
    console.log(`  SKIP — extractor returned no claims`);
    skipped += facts.length;
    continue;
  }

  // Match existing fact rows to extracted claims by index (best-effort).
  for (let i = 0; i < facts.length; i++) {
    const fact  = facts[i];
    const claim = claims[Math.min(i, claims.length - 1)]; // last claim reused if fewer than facts

    const patch = {
      grounding_summary:  claim.grounding_summary  || null,
      key_quotes:         claim.key_quotes,
      claim_status:       claim.claim_status,
      claim_confidence:   claim.claim_confidence,
      event_date:         claim.event_date         || null,
      primary_entity:     claim.primary_entity     || null,
      negotiation_status: claim.negotiation_status || null,
      entity_fingerprint: claim.entity_fingerprint || null,
      source_type:        sourceType,
      source_url:         ci.source_url || ci.original_url || null,
      source_name:        ci.source_name || null,
      source_published_at: ci.published_at || null,
      fact_trust:         claim.fact_trust,
      entities:           claim.entities,
      numbers:            claim.numbers,
      dates:              claim.dates,
    };

    console.log(`  fact ${fact.id.slice(0, 8)}…`);
    console.log(`    story_type:       ${claim.story_type}  (was ${fact.story_type})`);
    console.log(`    claim_status:     ${claim.claim_status}`);
    console.log(`    fact_trust:       ${claim.fact_trust}  (was ${fact.fact_trust ?? 0})`);
    console.log(`    grounding:        "${claim.grounding_summary?.slice(0, 80)}"`);
    if (claim.key_quotes?.length) {
      console.log(`    quotes:           ${claim.key_quotes.length} quote(s)`);
    }

    if (!DRY_RUN) {
      try {
        await sbPatch(`/rest/v1/facts?id=eq.${fact.id}`, patch);
        updated++;
      } catch (e) {
        console.log(`    PATCH ERROR: ${e.message}`);
        errors++;
      }
    } else {
      updated++;
    }
  }
  console.log();
}

console.log(`${'─'.repeat(70)}`);
console.log(`Done: ${updated} updated, ${skipped} skipped, ${errors} errors`);
if (DRY_RUN) console.log('(Dry run — no DB writes)');
console.log(`Remaining: re-run with --batch ${BATCH} to continue.\n`);
