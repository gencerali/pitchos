// Canonical site navigation — single source of truth for the menu IA.
// Used to server-render the nav on worker pages (article/topic/section) so they
// match the homepage menu. Tenant-agnostic: labels/links here, team branding
// comes from site config elsewhere.
//
// Pure + dependency-free so it can be unit-tested with plain node and imported
// by any worker. Keep in sync with the homepage nav until index.html is built
// from this same config.

export const NAV_CONFIG = [
  { label: 'Ana Sayfa', href: '/' },
  {
    label: 'Videolar', href: '/konu/videolar', children: [
      { label: 'Tümü',         href: '/konu/videolar' },
      { label: 'Haberler',     href: '/konu/videolar?tip=haber' },
      { label: 'Maç',          href: '/konu/videolar?tip=mac' },
      { label: 'Röportaj',     href: '/konu/videolar?tip=roportaj' },
      { label: 'Unutulmazlar', href: '/konu/videolar?tip=unutulmaz' },
      { label: 'Belgeseller',  href: '/konu/videolar?tip=belgeseller' },
    ],
  },
  {
    label: 'Analiz', soon: true, children: [
      { label: 'Takım',     soon: true },
      { label: 'Oyuncular', soon: true },
      { label: 'Maçlar',    soon: true },
      { label: 'Lig',       soon: true },
    ],
  },
  { label: 'Yazarlar', soon: true },
  { label: 'Diğer Branşlar', href: '/#diger-branslar' },
  { label: 'Tribün', soon: true, gold: true },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const soonBadge = '<span class="nav-soon">Yakında</span>';

// Returns server-rendered nav HTML (real <a href> for every live link, so it is
// crawlable and works with zero JS). `activePath` marks the current section.
export function buildNav(activePath = '/', { config = NAV_CONFIG } = {}) {
  const isActive = (href) => href && href !== '/'
    ? activePath === href || activePath.startsWith(href.split('?')[0] + '/')
    : activePath === '/';

  const item = (node) => {
    const gold = node.gold ? ' gold' : '';
    // leaf
    if (!node.children) {
      if (node.soon) return `<li class="nav-li${gold}"><span class="nav-link nav-link--soon">${esc(node.label)} ${soonBadge}</span></li>`;
      const active = isActive(node.href) ? ' active' : '';
      return `<li class="nav-li${gold}"><a class="nav-link${active}" href="${esc(node.href)}">${esc(node.label)}</a></li>`;
    }
    // dropdown
    const sub = node.children.map((c) => c.soon
      ? `<span class="nav-mega-item nav-mega-item--soon" role="menuitem">${esc(c.label)} ${soonBadge}</span>`
      : `<a class="nav-mega-item" role="menuitem" href="${esc(c.href)}">${esc(c.label)}</a>`
    ).join('');
    const label = node.soon ? `${esc(node.label)} ${soonBadge}` : esc(node.label);
    return `<li class="nav-li${gold}"><button class="nav-trigger" aria-haspopup="true" aria-expanded="false">${label} <span class="caret">▾</span></button><div class="nav-mega" role="menu">${sub}</div></li>`;
  };

  const items = config.map(item).join('');
  return `<nav class="mainnav" id="mainNav" aria-label="Ana menü">`
    + `<div class="nav-backdrop" id="navBackdrop"></div>`
    + `<div class="mainnav-inner">`
    + `<button class="nav-toggle" id="navToggle" aria-label="Menü" aria-expanded="false"><span class="bars"></span> Menü</button>`
    + `<ul class="nav-list">${items}</ul>`
    + `</div></nav>`
    + `<script>${NAV_SCRIPT}</script>`;
}

// Mobile enhancement: hamburger drawer + accordion submenus. Progressive — if
// this never runs, CSS leaves the menu as a visible stacked list.
const NAV_SCRIPT = `(function(){var n=document.getElementById('mainNav');if(!n)return;n.classList.add('js');`
  + `var t=document.getElementById('navToggle'),b=document.getElementById('navBackdrop');`
  + `function c(){n.classList.remove('open');if(t)t.setAttribute('aria-expanded','false');`
  + `n.querySelectorAll('.nav-li.open').forEach(function(x){x.classList.remove('open');});}`
  + `if(t)t.addEventListener('click',function(){var o=n.classList.toggle('open');t.setAttribute('aria-expanded',o?'true':'false');});`
  + `if(b)b.addEventListener('click',c);`
  + `n.querySelectorAll('.nav-trigger').forEach(function(tr){tr.addEventListener('click',function(e){e.preventDefault();`
  + `var li=tr.closest('.nav-li'),was=li.classList.contains('open');`
  + `n.querySelectorAll('.nav-li.open').forEach(function(o){if(o!==li)o.classList.remove('open');});`
  + `li.classList.toggle('open',!was);});});`
  + `document.addEventListener('keydown',function(e){if(e.key==='Escape')c();});})();`;

export default { NAV_CONFIG, buildNav };
