#!/usr/bin/env node
/* Frontend smoke harness for the static homepage (index.html).
 *
 * Runs the page's inline app script under a stubbed DOM where getElementById
 * returns null for IDs that are ABSENT from the HTML (mimicking a real browser),
 * feeds it a cache payload, and asserts that init() completes without throwing
 * and that the key content containers actually get populated.
 *
 * Catches the class of regression where one render function throws and silently
 * kills every init step after it (e.g. the cardMediaHTML self-recursion bug).
 *
 * Usage:
 *   node scripts/frontend-harness.js [index.html] [cache.json]
 * Defaults: index.html , cache.txt
 * Exit code: 0 = pass, 1 = fail.
 */
const fs = require('fs');
const vm = require('vm');

const HTML_PATH  = process.argv[2] || 'index.html';
const CACHE_PATH = process.argv[3] || 'cache.txt';

const html = fs.readFileSync(HTML_PATH, 'utf8');

// IDs that genuinely exist in the markup; getElementById returns null otherwise.
const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));

// Largest inline (non-src) <script> is the app.
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let body = scripts.sort((a, b) => b.length - a.length)[0];

// 1) parse gate
try { new Function(body); } catch (e) { fail('SCRIPT PARSE ERROR: ' + e.message); }

// Surface the async init() rejection.
body = body.replace(/\n(\s*)init\(\);/, "\n$1init().then(()=>__ok()).catch(__reportErr);");

let cache;
try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
catch (e) { fail('CACHE PARSE ERROR (' + CACHE_PATH + '): ' + e.message); }

const seen = {}; // id -> last innerHTML set
const appended = {}; // id -> count of appendChild calls (grids build via appendChild)
function makeEl(id) {
  const el = {
    _id: id, _html: '', dataset: {}, children: [], childNodes: [],
    style: new Proxy({ cssText: '' }, { get: (t, p) => (p in t ? t[p] : ''), set: (t, p, v) => { t[p] = v; return true; } }),
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild() { if (id) appended[id] = (appended[id] || 0) + 1; }, removeChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return makeEl('closest'); }, focus() {}, click() {}, scrollIntoView() {}, insertAdjacentHTML() {},
  };
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = String(v); if (id) seen[id] = el._html; } });
  Object.defineProperty(el, 'textContent', { get() { return ''; }, set() {} });
  return el;
}
const cacheEls = {};
const document = {
  getElementById(id) { if (ids.has(id)) return cacheEls[id] || (cacheEls[id] = makeEl(id)); return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement() { return makeEl('new'); }, addEventListener() {},
  body: makeEl('body'), head: makeEl('head'), documentElement: makeEl('html'), cookie: '',
};
let threw = null, completed = false;
const base = {
  console, document,
  location: { pathname: '/', href: 'https://kartalix.com/', search: '', hash: '', replace() {}, assign() {} },
  history: { replaceState() {}, pushState() {} },
  navigator: { clipboard: { writeText() { return Promise.resolve(); } }, userAgent: 'node', share: undefined },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(cache) }),
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  IntersectionObserver: function () { return { observe() {}, unobserve() {}, disconnect() {} }; },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  addEventListener() {}, removeEventListener() {}, scrollTo() {}, scroll() {}, open() {}, alert() {},
  Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Set, Map, Promise,
  parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, Intl,
  __reportErr: (e) => { threw = (e && e.stack) || String(e); },
  __ok: () => { completed = true; },
};
const sandbox = new Proxy(base, { has: () => true, get: (t, p) => (p in t ? t[p] : undefined), set: (t, p, v) => { t[p] = v; return true; } });
base.window = sandbox; base.globalThis = sandbox; base.self = sandbox;

try { vm.runInNewContext(body, sandbox, { filename: 'app.js' }); }
catch (e) { fail('SYNC THROW: ' + (e.stack || e)); }

setTimeout(() => {
  if (threw) fail('init() THREW:\n' + threw);
  if (!completed) fail('init() did not complete (hung or swallowed).');

  // A container counts as populated if it got non-empty innerHTML OR appended children
  // (grids like #newsGrid build via createElement + appendChild).
  const filled = (id) => (seen[id] && seen[id].length > 0) || (appended[id] > 0);

  const arr = Array.isArray(cache) ? cache : (cache.articles || []);
  const required = ['ticker', 'newsGrid'];        // always expected when there are articles
  const optional = ['radarItems', 'fanPulse', 'videoGrid', 'carouselTrack'];
  const missing = required.filter(id => ids.has(id) && !filled(id));
  if (arr.length > 0 && missing.length) {
    fail('these containers stayed EMPTY after init: ' + missing.join(', '));
  }
  const emptyOpt = optional.filter(id => ids.has(id) && !filled(id));
  console.log('PASS — init() completed; populated:',
    [...required, ...optional].filter(filled).join(', ') || '(none)');
  if (emptyOpt.length) console.log('note — optional containers empty (may be expected):', emptyOpt.join(', '));
  process.exit(0);
}, 500);

function fail(msg) { console.error('FAIL — ' + msg); process.exit(1); }
