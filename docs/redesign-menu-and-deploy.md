# Kartalix Redesign — Menu/IA + Design B + Deployment Spec

> **Status:** build spec (plan). Mock-validated (Direction B). Ready for Claude Code to
> develop and test, task by task. Do **not** touch the pipeline, Facts Firewall,
> `src/` content logic, or Supabase schema except where a task explicitly says so
> (gamification tables are a flagged, separate workstream).
>
> **Chosen design:** Direction **B — Editorial Light** (`mockups/b-editorial/`).
> **Team name / colours / crest are tenant config**, hardcoded only in the mock.

---

## 0. Goals & how they map to KPIs

| Goal | KPI it moves | Mechanism |
|---|---|---|
| Server-render homepage + section pages | SEO, AI/GPT visibility | crawlers/LLMs get full HTML (no JS needed) |
| Sub-navigation (mega-menu) with real `<a href>` links | SEO (internal linking, crawl depth), discoverability | every category/sub-page is linked + indexable |
| New `/analiz` section (structured stats) | SEO long-tail, AI citations, time-on-site | factual, frequently-updated, schema-marked content |
| **Tribün** engagement hub (predictions + points + badges) | DAU/retention | daily habit loop (streaks, leaderboard, quests) |
| Editorial-light skin | ad clarity, readability | light pages blend ad creatives, better long-read |

Skin is chosen for credibility/ads/readability; **the SEO/AI/DAU wins come from
server-rendering + the new sections**, which are skin-independent.

---

## 1. Information Architecture (the new menu)

Top-level nav (each top item except Ana Sayfa opens a sub-menu / mega-menu):

```
Ana Sayfa            /                         (no submenu)
Haberler  ▾          /haberler                  (landing = latest)
  ├ Tümü             /haberler
  ├ Transfer         /konu/transfer
  ├ Maç              /konu/mac
  ├ Kulüp            /konu/kulup
  ├ Sakatlık         /konu/sakatlik
  ├ Avrupa           /konu/avrupa
  └ Diğer Branşlar   /konu/diger-branslar       (basketbol/voleybol/hentbol)
Videolar  ▾          /videolar
  ├ Güncel Videolar  /videolar                  (recent — never padded w/ classics)
  ├ Maç Özetleri     /videolar/ozet
  ├ Röportajlar      /videolar/roportaj
  ├ Basın Toplantısı /videolar/basin
  ├ Unutulmazlar     /videolar/unutulmazlar      (curated classics)
  └ Belgeseller      /videolar/belgesel
Analiz  ▾            /analiz
  ├ Sezon Performansı/analiz                     (form, points, position)
  ├ Maç Analizi      /analiz/mac                 (next-match win prob, H2H)
  ├ Puan Durumu      /analiz/puan-durumu
  └ Karşılaştırma    /analiz/karsilastirma        (H2H / team compare — phase 2)
Tribün  ▾            /tribun                      (engagement hub)
  ├ Tahmin Oyunu     /tribun/tahmin               (match predictor)
  ├ Lider Tablosu    /tribun/lider                (leaderboard; league name = tenant config)
  ├ Görevler         /tribun/gorevler             (point quests: like/comment/share)
  ├ Rozetlerim       /tribun/rozetler             (badges)
  └ Profilim         /profil                       (auth required)
[right] Giriş / Profil  /giris                    (Supabase Auth — phase 4)
```

**Route conventions** (match existing `/haber/{slug}`, `/konu/{topic}`):
- Category filters reuse `/konu/{topic}` (already a worker route + `functions/konu` proxy).
- New section landings (`/videolar`, `/analiz`, `/tribun`) get worker render functions +
  `wrangler.toml` routes + a `functions/<section>/[[path]].js` proxy mirroring `functions/konu`.
- Sub-views use path segments (`/analiz/mac`), parsed inside the section render function.

**Sub-menu naming → category mapping** must come from the firewall categories
(`transfer, match, injury, club, european` + `sport`) and video `classifyVideoType`
(`src/youtube.js`). Add a single `NAV_CONFIG` map (label → route → data filter) so the
menu is **one source of truth** and tenant-overridable.

---

## 2. Menu component spec (Design B)

**Behaviour**
- **Desktop (≥900px):** hover/focus opens a mega-menu panel under the top item. Links are
  always present in the DOM (server-rendered) — hover only toggles visibility.
- **Mobile (<900px):** hamburger → full-height drawer; top items are tappable accordions
  (`<details>`/`<summary>` so it works with **zero JS**).
- **No JS dependency for crawlers:** all sub-links are real `<a href>` in the initial HTML.
  JS only enhances (hover intent, drawer animation, Esc-to-close).

**Accessibility (required, testable)**
- `<nav aria-label="Ana menü">`, sub-triggers are `<button aria-haspopup="true"
  aria-expanded="false">`; Esc closes; focus trap not required but focus-visible rings yes.
- Sub-menu panels `role="menu"`, items keyboard-reachable (Tab), arrow-key nav optional.
- Contrast ≥ 4.5:1 (Design B ink `#16140f` on paper passes).

**Visual (Direction B tokens — see `mockups/b-editorial/theme.css`)**
- Top bar: white, hairline bottom border; Barlow Condensed nav labels, red active underline.
- Mega-menu: white panel, hairline border, subtle shadow; each sub-item = Barlow Condensed
  label + 1-line Inter descriptor (editorial feel). Tribün items get a gold accent dot.
- `YENİ` chip (gold) on Analiz + Tribün until established.

**Markup skeleton (server-rendered, illustrative):**
```html
<nav class="mainnav" aria-label="Ana menü">
  <a href="/" class="nav-home">Ana Sayfa</a>
  <div class="nav-item">
    <button aria-haspopup="true" aria-expanded="false">Videolar ▾</button>
    <div class="nav-mega" role="menu">
      <a role="menuitem" href="/videolar"><b>Güncel Videolar</b><span>En yeni klipler</span></a>
      <a role="menuitem" href="/videolar/ozet"><b>Maç Özetleri</b><span>Geniş özetler</span></a>
      …
    </div>
  </div>
  … Haberler / Analiz / Tribün …
</nav>
```

---

## 3. Rendering & routing architecture

Current reality (confirmed): homepage `/` is the **static `index.html` on Cloudflare
Pages** (client-hydrated from `/cache`); article/topic/admin pages are **server-rendered
strings in `worker-fetch-agent.js`**; `functions/haber|konu/[[path]].js` proxy Pages→Worker;
deploy = git push to `main` (Pages) + `wrangler deploy` (Worker).

**Target:**
1. Promote shared chrome (nav + theme) into **one partial** used by the homepage and every
   worker `render*` page. Single `buildNav(NAV_CONFIG, activePath)` returns the nav HTML.
2. **Server-render the homepage** via a new `renderHomePage(cache, env)` worker function;
   add a `/` route. (Biggest SEO/AI win.) Keep the client JS only for carousel motion,
   reactions, and Tribün interactivity — content ships in HTML.
3. New section pages: `renderVideolarPage`, `renderAnalizPage`, `renderTribunPage`
   (+ sub-view switch), each following the `renderTopicPage`/`renderContentPage` pattern.
4. Add `wrangler.toml` routes (`/`, `/videolar*`, `/analiz*`, `/tribun*`, `/profil`,
   `/giris`) and `functions/<section>/[[path]].js` proxies (copy `functions/konu`).
   Update `_routes.json` excludes accordingly.

**Structured data (per page, JSON-LD) — required for the SEO/AI goal:**
- All: `Organization` (tenant), `BreadcrumbList`, `WebSite`+`SearchAction`.
- Article: `NewsArticle`. Homepage/section lists: `ItemList`.
- Analiz: `SportsEvent` (next match), `SportsTeam`, standings as `ItemList`.

---

## 4. Data sources

| Section | Source (exists today) |
|---|---|
| News / homepage feed | `/cache` (KV), `worker-fetch-agent.js` |
| Videos + sub-types | `/cache` video-mode articles; `classifyVideoType` (`src/youtube.js`) |
| Analiz | `src/api-football.js`: `getStandings`, `getBJKStanding`, `getNextFixture`, `getLastFixtures`, `getH2H`, `getLeagueContext`, `getEuropeanSpots`; + `buildMatchStats` |
| Win-prob model | computed (form ± home/away ± H2H); document the formula; deterministic + testable |
| Tribün (predictions/points/badges) | **NEW — Supabase Auth + tables (does not exist; Phase 4 dependency)** |

---

## 5. Tribün — gamification model (proposal; Phase 4, needs Supabase)

**Point events** (server-verified where possible; idempotent — one action = one award):

| Event | Points | Notes |
|---|---|---|
| Günlük giriş (daily login) | +5 | streak multiplier ×1.1/day, cap ×2 |
| Makale okuma (read) | +1 | capped/day, dwell-gated to deter abuse |
| Beğeni (like) | +2 | one per article |
| Yorum (comment) | +5 | after moderation passes |
| Twitter/X paylaşımı (share) | +10 | best-effort verify (intent + return); cap/day |
| Doğru tahmin (correct pick) | +10 | exact-score bonus +20 |
| Profil tamamlama | +20 | one-time |

**Badges (examples):** İlk Tahmin, 7 Gün Seri, 30 Gün Seri, Yorumcu (10), Sosyal (5 share),
Kahin (5 doğru tahmin üst üste), Maraton (100 makale). Badge defs in config (tenant-extendable).

**Leaderboard:** weekly + all-time; league display name = tenant config (BJK → "Çarşı Ligi").

**Proposed Supabase tables (NOT to be created in the frontend task):**
`profiles`, `point_events(user_id,type,points,ref_id,created_at)`,
`user_badges(user_id,badge_id,earned_at)`,
`predictions(user_id,fixture_id,pick,created_at,resolved,points_awarded)`,
plus a `leaderboard` aggregate (materialized view / cron).
**Anti-abuse:** rate limits, idempotency keys, server-side award only, share verification is
best-effort (document the limitation). Flag this whole section as dependent on the
gamification/Auth workstream — ship Tribün **read-only/mock** until it lands.

---

## 6. Implementation tasks (each = develop + test + acceptance)

> Order = ship safe/visible first → SEO/AI structural win → new sections → gamification.
> Each task is independently committable and reversible behind a flag.

**T1 — Tokenize + extract chrome.** Add `theme` CSS variables + `NAV_CONFIG` + `buildNav()`.
- *Test:* unit — `buildNav(cfg,'/videolar')` returns string containing every sub-route as
  `<a href>` and marks active item. `vitest`.
- *Accept:* nav HTML has all IA links; no tenant string hardcoded outside config.

**T2 — Re-skin homepage to B (visual only).** Apply theme to `index.html`; keep all blocks.
- *Test:* DOM-stub harness (see §7) → `init()` runs with real `cache.txt`, **no throw**,
  and `#ticker/#newsGrid/#videoGrid/#radarItems/#fanPulse` get non-empty `innerHTML`.
- *Accept:* every existing content block still populates; JS parses; Lighthouse a11y ≥ 90.

**T3 — Mega-menu component.** Server-rendered nav + mobile drawer (`<details>` no-JS fallback).
- *Test:* jsdom — links present without JS; `aria-expanded` toggles on click; Esc closes;
  all sub-links resolve to defined routes.
- *Accept:* keyboard-navigable; works with JS disabled; contrast passes.

**T4 — Server-render homepage (`renderHomePage`).** New worker fn + `/` route; client JS
becomes enhancement only.
- *Test:* `vitest` — `renderHomePage(fixtureCache)` returns valid HTML containing headlines
  + JSON-LD (`ItemList`,`Organization`) that `JSON.parse`s with required fields; HTML parses.
- *Accept:* `curl /` returns full content HTML (no empty shell); CWV not regressed.

**T5 — `/videolar` + sub-types.** `renderVideolarPage(type)` + route + proxy.
- *Test:* `vitest` — each sub-type filters the right videos; recent never padded with classics.
- *Accept:* 6 sub-routes render; correct video sets; breadcrumb schema present.

**T6 — `/analiz` + sub-views.** `renderAnalizPage(view)` from api-football + `buildMatchStats`;
win-prob model documented + deterministic.
- *Test:* `vitest` — model fn pure & deterministic (same input → same %; sums to 100);
  `SportsEvent`/`SportsTeam` JSON-LD valid; standings render from a fixture.
- *Accept:* form, win-prob, standings render from real data; schema validates.

**T7 — Homepage teasers + nav `YENİ` chips.** Analitik + Tribün teasers in sidebar; nav links.
- *Test:* harness — teaser nodes populate; links target `/analiz`,`/tribun`.
- *Accept:* internal links present (SEO); teasers match section data.

**T8 — Tribün hub (read-only/mock).** `renderTribunPage(view)` — predictor (model prob),
leaderboard + badges as mock until Auth lands.
- *Test:* `vitest` — page renders each sub-view; predictor shows model %; no write path.
- *Accept:* navigable; clearly labelled pre-auth; no dead links.

**T9 — Ads + performance + schema hardening.** Re-place ad slots; verify CLS/LCP; schema audit.
- *Test:* Lighthouse (or PSI) CLS < 0.1, LCP < 2.5s on mobile fixture; JSON-LD validates.
- *Accept:* ad slots present; CWV within budget.

**T10 — Rollout.** Behind a flag / canary; watch Search Console + analytics + ad revenue 2–4 wks.
- *Accept:* no ranking/CWV regression vs baseline; rollback = flip flag.

**Phase 4 (separate workstream, gated on Supabase Auth):** wire Tribün writes — auth,
`point_events`, badges, real leaderboard, prediction resolution cron, anti-abuse.

---

## 7. How Claude Code tests it (no browser in CI)

1. **JS parse gate:** extract the largest inline `<script>` from `index.html`, run
   `new Function(script)` — must not throw. (Catches syntax errors pre-deploy.)
2. **DOM-stub harness** (`scripts/harness.js` — already prototyped this session): a Node `vm`
   sandbox with a stubbed `document` where `getElementById` returns `null` for IDs **absent**
   from the HTML (mimics the browser). Feed real `cache.txt`; assert `init()` completes with
   no throw and target containers are populated. This is what caught the `cardMediaHTML`
   recursion and would catch any "section X stops rendering" regression.
3. **Worker unit tests (`vitest`, already configured):** `render*` functions are pure
   `(data) → string`; assert output contains required elements, internal links, and valid
   JSON-LD (parse the `<script type="application/ld+json">` blocks, check required fields).
4. **Win-prob determinism:** pure-function test — same fixture in → identical %; legs sum 100.
5. **Visual review without a live deploy:** build self-contained single-file pages (inline the
   CSS) and hand them to the user to open locally (the workflow used for the B/A/C mocks).
   *Optional:* add Playwright + headless Chromium for screenshot diffs **only if** the env
   provides a browser (it currently does not — note in CI setup).
6. **Lighthouse/PSI** for CWV + a11y on a deployed preview (Pages branch deploy) before
   `main` cutover.

Add a `make test-frontend` target running #1–#4 so each task is verifiable locally.

---

## 8. Deployment (per the repo's two-track model)

- **Homepage + static section assets → Cloudflare Pages**, deployed by **git push to `main`**
  (Pages auto-builds). Verify on the Pages **branch preview URL** before merging.
- **Worker render functions + new routes → `wrangler deploy`** (Worker `pitchos-fetch-agent`),
  after adding routes to `wrangler.toml` and proxies under `functions/`.
- **Order per release:** deploy Worker (new routes live) → then merge homepage/Pages → verify
  preview → flip flag. Keep changes behind a feature flag; rollback = flip flag / revert merge.
- **Never** deploy gamification writes until Supabase Auth + tables exist and pass §7 tests.

---

## 9. Multi-tenant guardrails (applies to every task)

- No hardcoded `Beşiktaş`, `Kartal`, `Çarşı`, crest, or colours in structural code — all via
  `tenant config` (team name, palette, crest URL, league display name, nav labels).
- `NAV_CONFIG`, badge defs, and the win-prob weights live in config so a second Pitchos tenant
  restyles + relabels without code changes. The eagle placeholder is generic and stays.
```
