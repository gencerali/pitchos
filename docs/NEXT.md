# NEXT.md

**The single most underused founder tool. Read this every time you sit down.**

Update this at the END of every work session. Not the start — the end. Future-you walking in cold should know exactly what to do next without thinking.

---

## NEXT ACTION

**NEXT** — **Redesign Phase 1** (foundation sprint, see full plan below):
1. **1A — Thin save**: allow `rss_summary` articles to persist to DB as `rss_link` mode (title + summary + slug only). Gates all volume and SEO. `saveArticles` in `src/publisher.js`.
2. **1B — Permalink from DB**: `serveArticlePage` must query Supabase `content_items` by slug instead of KV. Decayed articles 404 today.
3. **1C — Top 20 + more**: `/cache` endpoint returns `{ top: [...20], more: [...180], total }`. Frontend renders top immediately, "Daha fazla" loads rest.

---

## REDESIGN PLAN — Speed · Volume · Story Arc

Full rationale in last Claude session (2026-06-20). Ground truth: only synthesized articles reach DB today (rss_summary blocked), article permalinks may 404 after KV eviction, Method B is deployed but disabled.

### Priority order

| Phase | Scope | Effort | Do first because |
|---|---|---|---|
| **1A** Thin save | persist rss_summary as `rss_link` in DB | 1 day | gates all volume + SEO |
| **1B** Permalink from DB | `serveArticlePage` reads Supabase | half day | fans share links that 404 today |
| **1C** Top 20 + more | `/cache` splits top/more | half day | stated UX requirement |
| **2A** rssOnly 5-min | rule-based NVS, no Claude, 5-min cron | 1 day | speed is core to news |
| **4A** Enable Method B | `methodb:enabled = 1` KV flag | 1 hour | already built, just needs the flag |
| **4C** Story pages | `/konu/{slug}` permanent pages | 2 days | SEO + reader retention |
| **2B** Flash lane | T1/T2 event-mode → immediate Haiku flash | 1 day | breaking news differentiation |
| **3C** Ingest endpoint | `/ingest` POST for Telegram/VPS | 1 day | unlocks external sources |
| **5** Narrative status | rumor→talks→agreed→official on story card | 2 days | "what's happening now" UX |
| **6** YT multi-fact | `extractFactsFromTranscript` returns array | 2 days | richer facts, needs Ph4 stable first |
| **7** SEO | sitemap from DB, JSON-LD on article pages | 1 day | compound, not immediate |

### Phase 1 — Homepage + Permalink Foundation

**1A — Thin save (rss_link)**
- `saveArticles` currently hard-blocks `publish_mode === 'rss_summary'` — this means only synthesized articles reach `content_items`. Zero long-tail SEO, low total volume.
- Add `rss_link` publish mode: saves title + summary + slug + source_name + nvs_score + original_url. No full_body.
- All articles passing NVS ≥ 30 get a DB row and permanent slug.
- `rss_link` articles render as "başlık + özet + kaynak linki" on the article page.
- KV hard limit: raise from 200 → 400. rss_link half-life: 4–6h (vs. 18–24h for rewrite).

**1B — Permalink from DB**
- `serveArticlePage` in `worker-fetch-agent.js` must `SELECT * FROM content_items WHERE slug = $1`.
- KV TTL 12h means any article older than 12h with no re-rank may 404. DB is permanent.
- If `publish_mode = 'rss_link'`: render summary card + "Kaynağa git" button.
- If `publish_mode = 'rewrite'` or synthesis: render full article.
- Decayed articles still served, just ranked lower on homepage.

**1C — Homepage top 20 + more**
- `/cache` endpoint currently returns full KV pool.
- Change to `{ top: articles.slice(0,20), more: articles.slice(20), total: articles.length }`.
- Frontend renders `top` on load. "Daha fazla" button appends `more` inline (no page reload).
- Mobile: top 10 initially, "daha fazla" loads next 10 then rest.

### Phase 2 — 5-Min RSS Speed Lane

**2A — rssOnly mode**
- Add `opts.rssOnly` flag in `runAllSites` → `processSite`.
- When true: skip `scoreArticles` (no Haiku), use rule-based NVS estimate:
  `base = {T1:80, T2:65, T3:50, T4:30}[trust_tier]`
  `+ delta_boost: milestone+20, decision+15, contradiction+10, routine-10`
  `+ age_penalty: >60min:-15, >120min:-25`
- Skip `synthesizeArticle`. Save as rss_link.
- Keep `extractFactsForStory` fire-and-forget (already in place).
- `*/5` cron: `if isMatchLive → full pipeline; else → rssOnly, 10-min lookback`
- `0 * * * *` hourly: always full pipeline (scoring + synthesis).

**2B — Flash lane (T1/T2 event-mode)**
- When `delta_type ∈ {milestone, decision}` AND `news_mode === event` AND `trust_tier ∈ {T1, T2}`:
  - Bypass hourly synthesis queue
  - Generate 100–150 word flash article via Haiku immediately
  - `publish_mode = 'flash'`, half-life 2h, NVS 85
- Covers "TFF cezayı açıkladı", "BJK imzaladı" use cases.

### Phase 3 — Volume & External Sources

**3A — NVS rule-based pre-score**
Deterministic estimate for rssOnly runs. No Claude. Formula above.

**3B — Synthesis cap**
Raise `SYNTHESIS_CAP_PER_RUN` from 12 → 18. Overflow already queues to KV rewrite queue.

**3C — Ingest endpoint `/ingest`**
POST endpoint with shared secret. Accepts article object, routes straight to rule-based NVS → save → fact extract. Enables:
- Telegram Bot API: monitor BJK channels, push to /ingest
- Twitter VPS: Playwright scraper polling 6 accounts, push to /ingest
- Manual admin entry: break news instantly

### Phase 4 — Method B Live

**4A — Enable observation**
`wrangler kv key put --namespace-id=dedaea653ed542cca25e6cc2551dd1c3 methodb:enabled 1`
Watch `/admin/pipeline` for a week: volume, €/day, article quality. KV `articles:BJK:methodb` builds up.

**4B — Story pages `/konu/{slug}`**
Permanent URL per story. Shows: working title, state badge, timeline of phases, source count, related articles. DB-read, never expires. Included in sitemap.

**4C — Story cards on homepage**
`stories WHERE state IN (developing, confirmed)` injected into KV pool as story-arc cards.
Card shows: title, state badge, "4 kaynak", last updated. Decay: 48h half-life for confirmed, 24h for developing.

**4D — Blue/green cutover**
After a week of observation: `pipeline:active:BJK = methodb`. Instant, reversible.

### Phase 5 — Narrative Status

Add `narrative_status` to `classifyStoryType()` output:
`rumor | talks | agreed | official | denied | concluded`

Trust gate: `official` requires T1/T2 source. Press-only chain caps at `agreed`.
Stored on `stories` table, shown on story cards and story pages.
Story card becomes: "Rashica — GÖRÜŞMELER DEVAM EDİYOR" → "Rashica — ANLAŞILDI" → "Rashica — RESMİ".

### Phase 6 — YouTube Multi-Fact

`extractFactsFromTranscript(transcript, env)` returns `Fact[]` (array). Batch extraction prompt:
```json
[
  {"players":["Rashica"],"clubs":["Beşiktaş"],"numbers":{"contract_years":2},"story_hint":"contract renewal"},
  {"players":["Rashica"],"numbers":{"release_clause":5},"story_hint":"contract clause"}
]
```
Each fact links to same `content_item_id`, gets its own `facts_id`. Story matcher processes independently. One press conference video can move 3 different stories forward.

### Phase 7 — SEO

- Sitemap queries `content_items WHERE status=published` (paginated). Includes story pages.
- Article pages: `<title>`, `og:description`, `canonical`, JSON-LD `datePublished`.
- Story pages in sitemap: Stories accumulate content over days — ideal for transfer saga coverage.
- Raise KV pool limit to 400 but keep homepage at top 20. Long tail lives in DB, indexed by Google.

---

## ⚙️ AT-LAPTOP FOLLOW-UPS (need deploy / credentials / assets — can't be done from a web session)

Everything below is committed & tested on branch `claude/github-file-access-Zqttd`; it just needs a machine with your Cloudflare/Supabase access. Do in order.

### 1. Deploy  *(brings everything from this session live)*
- [ ] `git pull origin claude/github-file-access-Zqttd`
- [ ] `./deploy.sh`  — guided: `wrangler login` → secrets → deploys **both** workers. (`./deploy.sh --quick` later = just redeploy.)
- [ ] Secrets (first time, the script prompts): `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY` for `wrangler-story.toml`.
- [ ] **Run the migration** in Supabase SQL editor: `docs/migrations/0014_method_b.sql` (additive). ⚠ **before** arming Method B.

### 2. Verify after deploy  *(things I couldn't check without a live deploy)*
- [ ] `/admin/config` shows the new **"0. Pipeline (serving)"** toggle card.
- [ ] `/admin/pipeline` compare page loads.
- [ ] Open any article → confirm the **IT6 card** shows as hero + `og:image` (view-source the meta tag).
- [ ] **Homepage feed:** confirm the React widget renders the injected `image_url` cards correctly (the one spot I couldn't see — if layout breaks, revert the `withCards` map in the `/cache` route).
- [ ] `https://kartalix.com/card/<any-slug>.svg` renders.

### 3. Method B — arm, observe, tune, cut over
- [ ] Arm: KV `methodb:enabled = 1` (`wrangler kv key put --namespace-id=dedaea653ed542cca25e6cc2551dd1c3 methodb:enabled 1`). *(Migration must be applied first.)*
- [ ] Watch `/admin/pipeline` a few days: volume, latency, **€/day**, article quality vs legacy.
- [ ] Tune: rules pre-filter (`worker-story-agent.js` `rulesPreFilterDelta`), delta prompt (`detectDeltaLLM`), synthesis voice (`synthesizePhase`).
- [ ] When it beats legacy on the gates → **flip** serving to Method B on `/admin/config` (instant, reversible). Per-site canary: BJK first.
- [ ] Pause anytime: KV `methodb:enabled = 0`.

### 4. IT6 cards — turn on real photos (asset step)
- [ ] Source ~15 **CC0** stadium/crowd/floodlight photos (Pexels/Pixabay — no attribution needed).
- [ ] Host them (own domain or Cloudflare R2).
- [ ] Set KV `card:bg_pool` = JSON array of those URLs → cards become photographic automatically (empty pool = procedural).

### 5. Legal — the budgeted lawyer consult (~€300–500)  *(see ROADMAP stakeholders)*
- [ ] Confirm **API-Football** licence permits commercial image display + ads (option 3 for player/team photos).
- [ ] Confirm **AA (Anadolu Ajansı)** subscription terms if you want licensed press photos.
- [ ] Confirm **Wikimedia** attribution/share-alike mechanics before using CC-BY images.
- [ ] Decision: **avoid AI-generated player likenesses** (personality-rights risk) — confirmed direction.

### 6. (Optional) Enable connectors for future web sessions
- [ ] In `claude.ai/code`, enable **Supabase** + **Cloudflare** connectors *for the session* (per-session, not the app's global list) — then I can run migrations / set KV from a web session. See `code.claude.com/docs/.../claude-code-on-the-web`.

### 7. (Supervised) Finish the shared-presentation DRY refactor
Worker + SPA duplicate render logic (two artifacts, two deploys → "fix twice"). Prepared on the worker side; the SPA side needs a browser check, so do it at a desk.
- **Done (worker side, 2026-06-06):** `src/shared.js` is the single source — `esc`, `isKartalix`, `videoEmbedHtml`, re-exported `articleBodyToHtml`, + staged `badgeFor`/`TEMPLATE_BADGES`/`BADGE_CLASS`/`BADGE_COLOR`/`CAT_ICONS`/`TRUST_LABELS`. Worker now imports `isKartalix` + `videoEmbedHtml` from it (no behavior change).
- [ ] **C (supervised):** make Pages serve `src/shared.js` at a stable URL (e.g. `/shared.js` via `_routes.json`/copy), then in `index.html` `<script type="module">import {...} from '/shared.js'` and replace the SPA's `AV_BADGE_MAP`→`badgeFor`+`BADGE_COLOR`, `isKartalix`, `CAT_ICONS`/`TRUST_LABELS`, and `buildBodyHtml`→`articleBodyToHtml`. Browser-check the article + homepage after. ⚠ deploy **both** artifacts.
- [ ] **A (supervised):** switch the worker's local `BADGE_MAP`/category badge logic to `badgeFor`+`BADGE_CLASS` (so worker + SPA share the badge decision). Verify badges unchanged on the server article page.
- [ ] (Optional, low prio) Unify the per-page client-side `esc` copies via one injected `SHARED_JS` snippet — low value, skip unless tidying.
- ❌ **B (server-render/SPA-hydrate) — parked**, not a todo (A captures ~80% at far less risk).

### Deferred (tracked, not blocking)
- IT2 official-embed resolver (next image tier — genuine in-body source imagery).
- Method B Step 3 (after observation).
- Tech debt: Turkish-aware dedup (`normalizeTitle` / `KEY_TOKEN_RE`) — see ROADMAP "Known Issues / Tech Debt", v1.1.

---

**Done:**
- Method B design + diagram (DECISIONS 2026-06-05).
- Shadow worker scaffold — `worker-story-agent.js`, `wrangler-story.toml`, `0014_method_b.sql` (additive). Inert by default.
- Step 2 core — correlate → rules-pre-filter → Haiku delta → Sonnet synthesis-from-facts into shadow pool; cost counted vs shared cap + methodb-only counter; budget-bounded (`SHADOW_SYNTH_CAP`).
- `/admin/pipeline` compare page (legacy vs methodb side-by-side + last-run tally + methodb cost).
- **Cutover seam** — `getServedArticles` blue/green resolver (per-site `pipeline:active` pointer, defaults legacy, cold-start fallback) wired into the `/cache` serving path; `/admin/pipeline/flip` endpoint driven by the **`/admin/config` "0. Pipeline (serving)" toggle** (the `/admin/pipeline` compare page is read-only and links to config). Instantly reversible, safe-by-default.
- Laptop-free reconcile: **P0.3** (byline+date) and **P2.1** (sitemap exclusions) were already live; P2.1 also now drops thin `copy_source`.
- **IT6 generated cards** (imageless-news fix) — `src/card.js` owned SVG card (headline + category + BJK colours + Kartalix mark + generic motif, no third-party IP, €0, AdSense-safe). `/card/{slug}.svg` route; wired as fallback `image_url` on the article page (hero + og:image + twitter:image) and the `/cache` homepage feed (non-video, imageless only). Needs no lawyer consult (pure own-work). Licensed/embed tiers (IT2/API-Football/AA/Wikimedia) remain for deliberate upgrade — see ROADMAP Visual Assets + lawyer consult.
  - **Procedural style** (grain + floodlight bokeh + pitch lines + watermark) + 6 seed-varied colour variants — less "PPT", more designed news image.
  - **CC0 photo mode**: set KV `card:bg_pool` = JSON array of CC0 image URLs (host on own domain/R2). The route hash-assigns one per slug, fetches + base64-inlines it (SVG-as-`<img>` blocks external fetches), with a dark scrim + headline overlay. Empty pool / any failure → procedural (safe-by-default). **Asset step:** source ~15 CC0 stadium/crowd photos (Pexels/Pixabay).

**Done / descoped:**
- Task 1.1 — Docs reconciliation (ROADMAP/NEXT/DECISIONS). ✅ commit `0f64196`
- Task 1.2 — Per-source-per-content-type NVS+lifetime config. ❌ **descoped 2026-06-03** — tier multiplier + per-type half-life already cover it. See DECISIONS.md 2026-06-03.
- Task 1.3 — Narrow re-score-after-extraction. ↗ **superseded 2026-06-05** by Method B (the re-score is subsumed by scoring-as-triage in the new pipeline). See DECISIONS.md 2026-06-05.

---

## Reconciliation & hardening (2026-06-05)

- **Roadmap reconciled.** Three "open" items were already shipped: Task 1.2 (descoped), **P0.3** byline+date (live at `worker:7581/7582/7483`), **P2.1** sitemap exclusions (`serveSitemap` already drops rss_summary + transient templates; also added thin `copy_source`). Worker-split / cockpit / Lighthouse / mobile items confirmed genuinely open.
- **Test safety net added** (no prior coverage): `scoring-core.test.js` (getEffectiveNVS/getHalfLife/getTrustMultiplier/computeScore) + `dedup.test.js` (normalizeTitle/titleSimilarity/sharedStoryTokens/dedupeByTitle/dedupeByStory). Suite now 100 tests.
- **Bug found + fixed via tests:** the dedup tokenizer truncates a trailing Turkish `ş` (ASCII word boundary), so `Beşiktaş`→`beşikta` and the stopword `beşiktaş` never matched — BJK club name was counting as a meaningful shared token, nudging unrelated articles toward false dedup. Fixed by adding stem forms to `DEDUP_STOPWORDS` (`beşikta`, `kartal`, `siyah`, `beyaz`).
- **Known limitation documented (NOT changed — would shift live dedup):** `normalizeTitle` strips all Turkish diacritics (`\w` is ASCII-only), so `açıkladı`→`aklad`. Degrades titleSimilarity for Turkish. Locked in tests as current behaviour; fix deliberately, with observation, later.
- **Shadow worker hardened:** Method B now returns early (no cursor advance) when the monthly cost cap is hit, so a budget-blocked batch is retried rather than silently skipped.

## Recent sessions summary (2026-05-29 – 2026-06-03)

- **NVS Harmonization P0–P14 complete.** Scoring config-driven (`SCORING_CONFIG_DEFAULTS`, `loadSiteConfig`, `getEffectiveNVS`, `computeScore`); video rail wired (`rail_fallback`); homepage video cap (max 3); curated video NVS override (belgeseller/unutulmaz → NVS 15); push-to-homepage toggle (`push_to_homepage`, `manual_nvs`, `manual_half_life`, `push_enabled_at`); config admin Phase 1+2 live; dedup hardened (within-batch + Duhuliye T3→T4). Full decision log: DECISIONS.md entries from 2026-05-30 onward.
- **Cost infrastructure complete.** `addUsagePhase()` on all call sites; `/admin/financials` breakdown UI; prompt caching (`cache_control: ephemeral`, `anthropic-beta: prompt-caching-2024-07-31`). Commits: `9c09a66`, `4c85d19`.
- **Source facts table.** `source_facts` table created in Supabase. Every pipeline run now stores raw transcript/RSS content for future re-distillation (`src/utils.js:202`, called at `worker-fetch-agent.js:5032`). RSS facts saved from `publishable` array, not `savedWithIds` (fire-and-forget, never blocks pipeline). Commits: `ed5c96a`, `8606867`.
- **Per-video synthesis.** `generateVideoSynthesis` (`src/publisher.js:3122`) replaces channel-specific `generateRabonaDigest`. All three treatments working: `embed` (Haiku intro + iframe), `synthesize` (transcript → article, no iframe), `embed_and_synthesize` (article + iframe at bottom, falls back to embed-only if no transcript). Commit: `2189ded`.

---

## RULES

- One next action. Not three. Not "various things."
- Concrete, not abstract. Bad: "work on Facts Firewall." Good: "Add migration for `fact_lineage` table in `migrations/0042_fact_lineage.sql`."
- If you finish a session without knowing the next action, the session wasn't really done. Take 2 minutes to figure it out before closing the laptop.
- The PM agent reads this and references it in Friday close messages.
