#!/usr/bin/env node
/**
 * dry-run-pipeline.mjs — Pipeline dry-run report for 50 recent content_items.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=xxx \
 *   ANTHROPIC_API_KEY=xxx \
 *   node scripts/dry-run-pipeline.mjs [--limit N] [--live-extract N]
 *
 *   --limit N          how many content_items to fetch (default 50)
 *   --live-extract N   how many passing articles get a real extractAndScore call (default 10)
 *
 * What it does:
 *   1. Fetches N recent content_items from Supabase (all sites, last 48h)
 *   2. Runs each through the JS pre-filter stages (no LLM calls)
 *   3. For --live-extract articles that pass, calls extractAndScore (real Haiku)
 *   4. Prints a Markdown report to stdout (pipe to a file for sharing)
 */

import { preFilter } from '../src/processor.js';
import { extractAndScore } from '../src/firewall.js';

// ─── CLI args ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const LIMIT        = parseInt(args[args.indexOf('--limit')        + 1] || '50', 10);
const LIVE_EXTRACT = parseInt(args[args.indexOf('--live-extract') + 1] || '10', 10);

// ─── Env ──────────────────────────────────────────────────────
const ENV = {
  SUPABASE_URL:        process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  ANTHROPIC_API_KEY:   process.env.ANTHROPIC_API_KEY,
};
if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY required.');
  process.exit(1);
}

// ─── Supabase helper ──────────────────────────────────────────
async function sbGet(path) {
  const res = await fetch(`${ENV.SUPABASE_URL}${path}`, {
    headers: { apikey: ENV.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${ENV.SUPABASE_SERVICE_KEY}` },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// ─── Fetch content_items ──────────────────────────────────────
const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
const rows = await sbGet(
  `/rest/v1/content_items?published_at=gte.${since}&select=id,site_id,title,summary,full_text,url,original_url,source_name,trust_tier,published_at&order=published_at.desc&limit=${LIMIT}`
);

if (!rows.length) {
  console.error('No content_items found in the last 48h.');
  process.exit(0);
}

// Map DB rows to the shape preFilter expects
const articles = rows.map(r => ({
  ...r,
  trust:       r.trust_tier,
  full_text:   r.full_text || '',
}));

// ─── Run JS pre-filter (no LLM) ──────────────────────────────
// Use a 72h lookback so no articles are dropped just for being old
const { articles: passing, rejected, counts } = preFilter(articles, new Set(), 72 * 3600 * 1000);

// ─── Stage breakdown ──────────────────────────────────────────
const stages = {};
for (const r of rejected) {
  stages[r._stage] = (stages[r._stage] || 0) + 1;
}

// ─── Live fact extraction (real Haiku calls) ──────────────────
const toExtract  = passing.slice(0, LIVE_EXTRACT);
const extracted  = [];
const extractErr = [];

if (ENV.ANTHROPIC_API_KEY && toExtract.length) {
  for (const a of toExtract) {
    try {
      const facts = await extractAndScore(a.full_text || '', a, ENV);
      extracted.push({ article: a, facts });
    } catch (e) {
      extractErr.push({ article: a, error: e.message });
    }
    // brief pause between Haiku calls
    await new Promise(r => setTimeout(r, 400));
  }
} else if (!ENV.ANTHROPIC_API_KEY) {
  console.warn('# Note: ANTHROPIC_API_KEY not set — skipping live extraction.');
}

// ─── Markdown report ──────────────────────────────────────────
const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
const lines = [];

lines.push(`# Pipeline Dry-Run Report`);
lines.push(`_Generated: ${now} UTC — ${articles.length} articles fetched, last 48h_`);
lines.push('');

// Summary stats
lines.push('## Summary');
lines.push('');
lines.push(`| Metric | Count |`);
lines.push(`|--------|-------|`);
lines.push(`| Fetched from DB | ${articles.length} |`);
lines.push(`| Passed all JS filters | ${passing.length} (${pct(passing.length, articles.length)}) |`);
lines.push(`| Rejected | ${rejected.length} (${pct(rejected.length, articles.length)}) |`);
for (const [stage, count] of Object.entries(stages).sort((a, b) => b[1] - a[1])) {
  lines.push(`| &nbsp;&nbsp;↳ ${stage} | ${count} (${pct(count, articles.length)}) |`);
}
lines.push(`| Live fact extractions | ${extracted.length} |`);
lines.push('');

// Trust tier breakdown
const tiers = {};
for (const a of articles) tiers[a.trust_tier || 'unknown'] = (tiers[a.trust_tier || 'unknown'] || 0) + 1;
const tierPass = {};
for (const a of passing)  tierPass[a.trust_tier || 'unknown'] = (tierPass[a.trust_tier || 'unknown'] || 0) + 1;

lines.push('## Pass Rate by Trust Tier');
lines.push('');
lines.push('| Tier | Total | Passed | Pass Rate |');
lines.push('|------|-------|--------|-----------|');
for (const t of Object.keys(tiers).sort()) {
  const total = tiers[t];
  const pass  = tierPass[t] || 0;
  lines.push(`| ${t} | ${total} | ${pass} | ${pct(pass, total)} |`);
}
lines.push('');

// Per-article firewall decisions
lines.push('## Per-Article Firewall Decisions');
lines.push('');
lines.push('| # | Trust | Source | Title | Decision | Stage | Detail |');
lines.push('|---|-------|--------|-------|----------|-------|--------|');
let rowNum = 0;
const allWithDecision = [
  ...passing.map(a => ({ a, decision: 'PASS', stage: '-', detail: '' })),
  ...rejected.map(r => ({ a: r, decision: 'DROP', stage: r._stage, detail: r.drop_detail || '' })),
].sort((x, y) => {
  const ta = x.a.published_at || '';
  const tb = y.a.published_at || '';
  return tb < ta ? -1 : tb > ta ? 1 : 0;
});

for (const { a, decision, stage, detail } of allWithDecision.slice(0, 80)) {
  rowNum++;
  const tier    = a.trust_tier || a.trust || '?';
  const source  = esc(a.source_name || '').slice(0, 20);
  const title   = esc(a.title || '').slice(0, 60);
  const detStr  = esc(String(detail || '').slice(0, 40));
  const dec     = decision === 'PASS' ? '✅ PASS' : `❌ DROP`;
  lines.push(`| ${rowNum} | ${tier} | ${source} | ${title} | ${dec} | ${stage} | ${detStr} |`);
}
lines.push('');

// Extracted facts
if (extracted.length) {
  lines.push('## Extracted Facts (Live Haiku Calls)');
  lines.push('');
  lines.push(`_${extracted.length} articles processed — ${extractErr.length} errors_`);
  lines.push('');

  for (const { article: a, facts: f } of extracted) {
    lines.push(`### ${esc(a.title || '').slice(0, 80)}`);
    lines.push(`_${a.source_name || '?'} · ${a.trust_tier || '?'} · ${a.published_at?.slice(0, 10) || '?'}_`);
    lines.push('');
    lines.push(`**story_type:** ${f.story_type} | **category:** ${f.story_category} | **nvs_score:** ${f.nvs_score ?? 'n/a'}`);
    if (f.entities.players.length)      lines.push(`- Players: ${f.entities.players.join(', ')}`);
    if (f.entities.clubs.length)        lines.push(`- Clubs: ${f.entities.clubs.join(', ')}`);
    if (f.entities.competitions.length) lines.push(`- Competitions: ${f.entities.competitions.join(', ')}`);
    const nums = Object.entries(f.numbers).filter(([k, v]) => v != null && k !== 'other' && String(v).trim());
    if (nums.length) lines.push(`- Numbers: ${nums.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    if (f.dates.primary_date)           lines.push(`- Date: ${f.dates.primary_date}`);
    if (f.key_quotes?.length)           lines.push(`- Quotes: ${f.key_quotes.map(q => `"${q}"`).join(' / ')}`);
    lines.push('');
  }

  if (extractErr.length) {
    lines.push('### Extraction Errors');
    lines.push('');
    for (const { article: a, error } of extractErr) {
      lines.push(`- **${esc(a.title || '').slice(0, 60)}**: ${esc(error)}`);
    }
    lines.push('');
  }
}

// Story type distribution from extracted facts
if (extracted.length) {
  const stypes = {};
  for (const { facts: f } of extracted) stypes[f.story_type] = (stypes[f.story_type] || 0) + 1;
  lines.push('## Story Type Distribution (from extracted facts)');
  lines.push('');
  lines.push('| story_type | count |');
  lines.push('|------------|-------|');
  for (const [t, c] of Object.entries(stypes).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${t} | ${c} |`);
  }
  lines.push('');
}

console.log(lines.join('\n'));

// ─── Helpers ──────────────────────────────────────────────────
function pct(n, d) { return d ? `${Math.round(100 * n / d)}%` : '0%'; }
function esc(s)    { return String(s).replace(/\|/g, '\\|'); }
