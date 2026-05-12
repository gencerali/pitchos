// Cloudflare Pages Function — proxies /article/* to the Worker.
const WORKER = 'https://pitchos-fetch-agent.gencerali.workers.dev';

export async function onRequest({ request }) {
  const url    = new URL(request.url);
  const target = WORKER + url.pathname + url.search;

  const proxied = new Request(target, {
    method:  request.method,
    headers: request.headers,
    body:    ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
  });

  const res = await fetch(proxied);

  return new Response(res.body, {
    status:     res.status,
    statusText: res.statusText,
    headers:    res.headers,
  });
}
