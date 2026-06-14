// Offline checks for the canonical shared nav (src/shared/nav.js). Plain node, no deps.
import { buildNav } from '../src/shared/nav.js';

let pass = true;
const fail = (m) => { console.error('  ✗ ' + m); pass = false; };

const home = buildNav('/');
const vid  = buildNav('/konu/videolar');

for (const l of ['Ana Sayfa', 'Videolar', 'Analiz', 'Yazarlar', 'Diğer Branşlar', 'Tribün'])
  if (!home.includes(l)) fail('missing top label: ' + l);

for (const t of ['haber', 'mac', 'roportaj', 'unutulmaz', 'belgeseller'])
  if (!home.includes('/konu/videolar?tip=' + t)) fail('missing video tip: ' + t);

if (!home.includes('Yazarlar <span class="nav-soon">Yakında</span>')) fail('Yazarlar not badged Yakında');
if (/href="[^"]*"[^>]*>Yazarlar/.test(home)) fail('Yazarlar should not be a link (soon)');
if (!home.includes('nav-link active" href="/"')) fail('home not marked active');
if (!vid.includes('nav-trigger')) fail('videolar dropdown missing');
if (home.includes('href="#"')) fail('dead href="#" present');
if (buildNav('/', { config: [{ label: '<x>&', href: '/y' }] }).includes('<x>')) fail('label not HTML-escaped');

console.log(pass ? 'nav-check OK' : 'nav-check FAILED');
process.exit(pass ? 0 : 1);
