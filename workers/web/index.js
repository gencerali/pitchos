// pitchos-web — public read/render worker (strangler base).
//
// Today this worker PROXIES every request to the existing monolith, so
// deploying it is a zero-behaviour-change no-op. We migrate routes off the
// monolith one at a time by adding a handler in the MIGRATED ROUTES block
// below, then gate the cut-over with `make parity OLD=… NEW=…`.
//
// Until a route is migrated, it falls through to the proxy and behaves exactly
// like production. Nothing here touches the cron pipeline or admin.

import { buildNav } from '../../src/shared/nav.js';

// The current monolith (same origin the functions/* proxies already use).
const ORIGIN = 'https://pitchos-fetch-agent.gencerali.workers.dev';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── demo: render the shared nav so it can be eyeballed on the workers.dev
    //    URL before any real route is migrated. Remove once migration starts.
    if (url.pathname === '/_nav-preview') {
      return new Response(navPreviewHtml(url.searchParams.get('path') || '/'), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // ── MIGRATED ROUTES ───────────────────────────────────────────────────
    // Move public render routes here, one at a time, importing the render
    // function from src/shared/. Each must pass `make parity` before its route
    // is repointed to this worker in wrangler.toml. Examples (commented):
    //
    //   if (url.pathname.startsWith('/konu/videolar')) {
    //     const { renderVideoHubPage } = await import('../../src/shared/render-video.js');
    //     return html(await renderVideoHubPage(url.searchParams.get('tip') || '', env));
    //   }
    //   if (url.pathname.startsWith('/konu/'))  return html(renderTopicPage(...));
    //   if (url.pathname.startsWith('/haber/')) return html(renderArticleHTML(...));
    // ──────────────────────────────────────────────────────────────────────

    // Default: transparent proxy to the monolith (no behaviour change).
    const target = ORIGIN + url.pathname + url.search;
    const proxied = new Request(target, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });
    const res = await fetch(proxied);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  },
};

function navPreviewHtml(activePath) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>nav preview</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Inter&display=swap" rel="stylesheet">
<style>body{background:#111;color:#eee;font-family:Inter,sans-serif;margin:0}
.mainnav{background:#111;border-bottom:1px solid #1e1e1e}.nav-list{display:flex;gap:0;list-style:none;margin:0;padding:0 1rem}
.nav-link,.nav-trigger{font-family:'Barlow Condensed';font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#999;background:none;border:0;padding:.7rem .95rem;font-size:.82rem;display:inline-flex;gap:.3rem;text-decoration:none}
.nav-link.active{color:#fff;border-bottom:2px solid #E30A17}.nav-link--soon,.nav-mega-item--soon{color:#777;cursor:default}
.nav-li{position:relative}.nav-mega{display:none;position:absolute;top:100%;left:0;background:#16181c;border:1px solid #2a2d33;border-top:2px solid #E30A17;padding:.4rem;min-width:200px}
.nav-li:hover .nav-mega{display:block}.nav-mega-item{display:block;padding:.5rem .7rem;color:#e7e3da;text-decoration:none;font-family:'Barlow Condensed';text-transform:uppercase;font-size:.85rem}
.nav-mega-item:hover{background:#22252b}.nav-soon{font-family:'Barlow Condensed';font-size:.5rem;font-weight:800;color:#111;background:#F5A623;padding:.07rem .3rem;border-radius:3px}
.nav-li.gold .nav-mega{border-top-color:#F5A623}p{padding:1rem}</style></head>
<body>${buildNav(activePath)}<p>pitchos-web · shared nav preview · activePath=${activePath}</p></body></html>`;
}
