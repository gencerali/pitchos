// Catch-all for any URL not matched by a Worker route, specific Pages Function,
// or static asset. Returns 404 instead of the SPA index.html fallback.
export async function onRequest() {
  return new Response(
    `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>404 — Kartalix</title></head><body style="font-family:system-ui,sans-serif;background:#181818;color:#e8e6e0;padding:3rem 2rem"><p style="font-size:1.1rem">Sayfa bulunamadı.</p><a href="/" style="color:#E30A17">← Ana Sayfa</a></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
  );
}
