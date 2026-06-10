#!/usr/bin/env node
/* SEO parity check — old worker vs new worker (migration safety gate).
 *
 * For each public, indexable URL it fetches OLD and NEW and compares the
 * signals Google actually cares about:
 *   HARD (mismatch => FAIL): HTTP status, <link rel=canonical>, <meta robots>,
 *     <title>, og:title/description/image/url, <h1>, and the JSON-LD @type set
 *     (+ presence of headline/datePublished on NewsArticle).
 *   SOFT (mismatch => WARN): normalized visible-text length delta (volatile bits
 *     like "12 dakika önce", article counts, ISO timestamps, nonces are masked).
 *
 * The full HTML is intentionally NOT byte-diffed — relative times, ordering and
 * ads make that always-fail. We assert the SEO-critical surface is identical.
 *
 * Usage:
 *   node scripts/parity-check.cjs --old https://kartalix.com \
 *                                 --new https://pitchos-web.<acct>.workers.dev \
 *                                 [--new-host kartalix.com] [--articles 8]
 *   node scripts/parity-check.cjs --self-test     # offline logic test (no network)
 *
 * --new-host sets the Host header on NEW requests so the new worker renders the
 * production canonical (kartalix.com) even when reached on a workers.dev URL.
 * Exit code: 0 = all pass, 1 = any hard mismatch / fetch error.
 */
'use strict';

const DEFAULT_PATHS = [
  '/',
  '/konu/videolar',
  '/konu/videolar?tip=haber',
  '/konu/videolar?tip=mac',
  '/konu/videolar?tip=roportaj',
  '/konu/videolar?tip=unutulmaz',
  '/konu/videolar?tip=belgeseller',
  '/konu/transfer',
  '/konu/mac',
  '/hakkimizda',
  '/iletisim',
  '/gizlilik',
  '/kosullar',
  '/kaynak-atif',
  '/editoryal-politika',
  '/rss',
  '/sitemap.xml',
];

// ── signal extraction ───────────────────────────────────────────────────────
function attr(html, re) { const m = html.match(re); return m ? m[1].trim() : null; }

function extractSignals(html) {
  const s = {
    title:    attr(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    canonical:attr(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
           || attr(html, /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i),
    robots:   attr(html, /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i),
    ogTitle:  attr(html, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i),
    ogDesc:   attr(html, /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i),
    ogImage:  attr(html, /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']*)["']/i),
    ogUrl:    attr(html, /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']*)["']/i),
    h1:       attr(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i),
    jsonld:   [],
  };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const n of nodes) if (n && n['@type']) {
        s.jsonld.push({ type: String(n['@type']), hasHeadline: !!n.headline, hasDate: !!(n.datePublished || n.dateModified) });
      }
    } catch { s.jsonld.push({ type: 'PARSE_ERROR', hasHeadline: false, hasDate: false }); }
  }
  s.jsonTypes = s.jsonld.map(j => j.type).sort();
  if (s.h1) s.h1 = s.h1.replace(/<[^>]+>/g, '').trim();
  return s;
}

// mask volatile content so a soft text-length compare is meaningful
function normalizeText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\d+\s*(dakika|saat|gün|hafta|ay|yıl)\s*önce/gi, '§T')
    .replace(/\b(Dün|Bugün)\b/gi, '§T')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/g, '§D')
    .replace(/\b\d+\s*(haber|video|içerik)\b/gi, '§N')
    .replace(/[0-9a-f]{16,}/gi, '§H')   // nonces / long hex ids
    .replace(/\s+/g, ' ')
    .trim();
}

// ── comparison ──────────────────────────────────────────────────────────────
const HARD = ['status', 'canonical', 'robots', 'title', 'ogTitle', 'ogDesc', 'ogImage', 'ogUrl', 'h1'];

function compare(oldR, newR) {
  const diffs = [], warns = [];
  if (oldR.status !== newR.status) diffs.push(`status: ${oldR.status} → ${newR.status}`);
  if (oldR.status >= 400 || newR.status >= 400) {
    return { diffs: diffs.length ? diffs : [`status ${oldR.status}/${newR.status}`], warns };
  }
  const a = oldR.sig, b = newR.sig;
  for (const k of HARD.slice(1)) {
    if ((a[k] || '') !== (b[k] || '')) diffs.push(`${k}:\n      old=${trunc(a[k])}\n      new=${trunc(b[k])}`);
  }
  if (a.jsonTypes.join(',') !== b.jsonTypes.join(',')) {
    diffs.push(`json-ld @types: [${a.jsonTypes.join(', ')}] → [${b.jsonTypes.join(', ')}]`);
  } else {
    for (let i = 0; i < a.jsonld.length; i++) {
      if (a.jsonld[i].hasHeadline !== b.jsonld[i].hasHeadline) diffs.push(`json-ld[${i}] ${a.jsonld[i].type} headline presence differs`);
      if (a.jsonld[i].hasDate !== b.jsonld[i].hasDate) diffs.push(`json-ld[${i}] ${a.jsonld[i].type} date presence differs`);
    }
  }
  // soft: normalized visible-text length within 3%
  const la = normalizeText(oldR.body).length, lb = normalizeText(newR.body).length;
  const delta = la ? Math.abs(la - lb) / la : (lb ? 1 : 0);
  if (delta > 0.03) warns.push(`text length differs ${(delta * 100).toFixed(1)}% (old ${la} / new ${lb})`);
  return { diffs, warns };
}
function trunc(v) { v = v == null ? '(none)' : String(v); return v.length > 90 ? v.slice(0, 90) + '…' : v; }

// ── fetch ───────────────────────────────────────────────────────────────────
async function getPage(base, path, hostHeader) {
  const url = base.replace(/\/$/, '') + path;
  const headers = { 'User-Agent': 'kartalix-parity-check' };
  if (hostHeader) headers['Host'] = hostHeader;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { headers, redirect: 'manual', signal: ctrl.signal });
      clearTimeout(t);
      const body = await res.text();
      return { status: res.status, body, sig: extractSignals(body) };
    } catch (e) {
      if (attempt === 2) return { status: 0, body: '', sig: extractSignals(''), error: e.message };
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

async function sampleArticles(oldBase, n, hostHeader) {
  try {
    const r = await getPage(oldBase, '/sitemap.xml', hostHeader);
    const locs = [...r.body.matchAll(/<loc>([^<]+\/haber\/[^<]+)<\/loc>/g)].map(m => m[1]);
    const picks = [];
    for (let i = 0; i < locs.length && picks.length < n; i += Math.max(1, Math.floor(locs.length / n))) {
      picks.push(new URL(locs[i]).pathname);
    }
    return picks;
  } catch { return []; }
}

// ── self-test (offline) ─────────────────────────────────────────────────────
function selfTest() {
  const base = `<!doctype html><html><head><title>X</title>
    <link rel="canonical" href="https://kartalix.com/konu/mac"/>
    <meta name="robots" content="index, follow"/>
    <meta property="og:title" content="Maç"/><meta property="og:description" content="d"/>
    <meta property="og:image" content="i.jpg"/><meta property="og:url" content="https://kartalix.com/konu/mac"/>
    <script type="application/ld+json">{"@type":"NewsArticle","headline":"h","datePublished":"2026-01-01"}</script>
    </head><body><h1>Maç</h1><p>12 dakika önce · 30 haber</p></body></html>`;
  const volatile = base.replace('12 dakika önce · 30 haber', '3 saat önce · 28 haber');
  const broken  = base.replace('https://kartalix.com/konu/mac"/>\n    <meta name="robots"', 'https://OTHER/x"/>\n    <meta name="robots"');

  const ok = compare({ status: 200, body: base, sig: extractSignals(base) },
                     { status: 200, body: volatile, sig: extractSignals(volatile) });
  const bad = compare({ status: 200, body: base, sig: extractSignals(base) },
                      { status: 200, body: broken, sig: extractSignals(broken) });
  let pass = true;
  if (ok.diffs.length) { console.error('SELF-TEST FAIL: volatile-only pages flagged a HARD diff:', ok.diffs); pass = false; }
  else console.log('self-test 1 OK — volatile timestamps/counts ignored, no false FAIL');
  if (!bad.diffs.some(d => d.startsWith('canonical'))) { console.error('SELF-TEST FAIL: canonical change not caught', bad.diffs); pass = false; }
  else console.log('self-test 2 OK — changed canonical caught as HARD diff');
  process.exit(pass ? 0 : 1);
}

// ── main ────────────────────────────────────────────────────────────────────
function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : def; }

(async function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const oldBase = arg('old'), newBase = arg('new');
  if (!oldBase || !newBase) {
    console.error('Usage: node scripts/parity-check.cjs --old <url> --new <url> [--new-host kartalix.com] [--articles 8]');
    console.error('       node scripts/parity-check.cjs --self-test');
    process.exit(2);
  }
  const newHost = arg('new-host', null);
  const nArt = parseInt(arg('articles', '6'), 10);

  const paths = DEFAULT_PATHS.slice();
  const arts = await sampleArticles(oldBase, nArt, null);
  paths.push(...arts);
  console.log(`Comparing ${paths.length} URLs\n  OLD ${oldBase}\n  NEW ${newBase}${newHost ? '  (Host: ' + newHost + ')' : ''}\n`);

  let failed = 0, warned = 0;
  for (const p of paths) {
    const [o, n] = await Promise.all([getPage(oldBase, p, null), getPage(newBase, p, newHost)]);
    if (o.error || n.error) { console.log(`✗ FAIL ${p}\n    fetch error: old=${o.error || 'ok'} new=${n.error || 'ok'}`); failed++; continue; }
    const { diffs, warns } = compare(o, n);
    if (diffs.length) { console.log(`✗ FAIL ${p}`); diffs.forEach(d => console.log('    • ' + d)); failed++; }
    else if (warns.length) { console.log(`⚠ WARN ${p}`); warns.forEach(w => console.log('    • ' + w)); warned++; }
    else console.log(`✓ OK   ${p}`);
  }
  console.log(`\n${paths.length - failed - warned} ok · ${warned} warn · ${failed} fail`);
  process.exit(failed ? 1 : 0);
})();
