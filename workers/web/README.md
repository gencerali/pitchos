# pitchos-web — public render worker (migration runbook)

Strangler-pattern worker that will take over public page rendering from the
monolith (`worker-fetch-agent.js`) **one route at a time**, with no downtime and
no SEO risk. Today it just proxies everything to the monolith.

## State now
- `index.js` proxies **all** requests to the monolith → deploying it is a no-op.
- `/_nav-preview?path=/konu/mac` renders the shared nav (`src/shared/nav.js`) so
  you can eyeball the new menu on the workers.dev URL.
- `wrangler.toml` has **no production routes** (workers_dev only) → a deploy
  cannot touch kartalix.com.

## Cut-over loop (per route) — all reversible
1. **Extract** the render fn from the monolith into `src/shared/` (e.g.
   `renderVideoHubPage` → `src/shared/render-video.js`), exported + dependency-light.
2. **Wire** it in `index.js` under MIGRATED ROUTES.
3. **Deploy to staging:** `cd workers/web && wrangler deploy` (goes to
   `pitchos-web.<acct>.workers.dev`, production untouched).
4. **Parity gate:**
   ```
   make parity OLD=https://kartalix.com \
               NEW=https://pitchos-web.<acct>.workers.dev \
               NEWHOST=kartalix.com
   ```
   Must be all-green for the route before proceeding.
5. **Repoint the route:** uncomment the `[[routes]]` block here AND delete the
   same `pattern` from the monolith `wrangler.toml`, then deploy both.
6. **Verify + monitor** Search Console Coverage/Crawl for that path. Rollback =
   re-add the pattern to the monolith and remove it here.

## Suggested order
`/konu/videolar` (+`?tip=`) → `/konu/*` topics → `/haber/*` → `/rss` →
`/sitemap.xml`. Legal pages last. Admin/cron stay in the monolith
(later renamed `pitchos-pipeline`).

## Guarantees
- Complete route inventory is the checklist (see `docs/redesign-menu-and-deploy.md`).
- URLs never change → no redirects needed (except the already-done
  `/privacy.html` → `/gizlilik`).
- `make parity` blocks any cut-over that would change status/canonical/robots/
  title/og/JSON-LD.
