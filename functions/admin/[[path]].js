// Cloudflare Pages Function — proxies /admin/* to the Worker.
// Pages owns the kartalix.com zone and intercepts before Worker routes fire.
// This function runs with Pages priority, forwarding everything to the Worker
// (including cookies, so auth works correctly).
const WORKER = 'https://pitchos-fetch-agent.gencerali.workers.dev';

export async function onRequest({ request }) {
  const url   = new URL(request.url);
  const target = WORKER + url.pathname + url.search;

  const proxied = new Request(target, {
    method:  request.method,
    headers: request.headers,
    body:    ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
  });

  const res = await fetch(proxied);

  // Pass response through unchanged — Set-Cookie is attributed to kartalix.com
  // by the browser because the visible origin is kartalix.com, not workers.dev.
  return new Response(res.body, {
    status:     res.status,
    statusText: res.statusText,
    headers:    res.headers,
  });
}
