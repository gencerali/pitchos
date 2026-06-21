# NEXT.md

**The single most underused founder tool. Read this every time you sit down.**

Update this at the END of every work session. Not the start — the end. Future-you walking in cold should know exactly what to do next without thinking.

---

## GAMIFICATION BACKLOG

Items deferred from the gamification build session (2026-06-14):

- **Social login (Google / Apple / X)** — UI removed, code ready to re-add. Needs OAuth credentials in each provider's console + Supabase Dashboard → Auth → Providers. Google is easiest; Apple requires $99/yr developer account. Wire up with `sb.auth.signInWithOAuth({ provider, options: { redirectTo: 'https://kartalix.com' } })`.
- **XP Admin Panel** — `/admin/gamification`: edit XP values per action, economy simulator, level threshold editor, shadow-ban list, audit log.
- **Set super-admin** — run `UPDATE public.profiles SET role = 'admin' WHERE id = (SELECT id FROM auth.users WHERE email = 'gencerali@gmail.com');` once first login is confirmed.
- **Smoke test XP flow** — log in → read article 30s → confirm XP in `/api/leaderboard/alltime`.
- **Sound design** — royalty-free XP / level-up sounds (default OFF, user toggle).
- **Push notifications** — post-launch.

---

## NEXT ACTION

**G2M Week 1 — Method B orientation + shadow worker deployment** (see full plan in `docs/superpowers/specs/2026-06-21-kartalix-g2m-design.md` §9):

1. **Pre-reading (Sunday, ~3h):** `docs/method-b-design.md` (all 10 sections), `docs/method-b-model.svg`, then this file, then scan `docs/migrations/0014_method_b.sql`.
2. **Read `worker-story-agent.js` (~2h):** Find `correlateToTopic`, `rulesPreFilterDelta`, `detectDeltaLLM`, `synthesizePhase`. Note gaps vs `docs/method-b-design.md §9 build order.
3. **Apply migration + deploy** (~1h): `0014_method_b.sql` in Supabase → `npx wrangler deploy -c wrangler-story.toml` → `methodb:enabled=1`.
4. **Observe `/admin/pipeline` for 5 days.** Three signals to watch: (a) `confirmingSkip` rate in `/status` — should be >60% if the pre-filter is working; (b) methodb `€/day` vs. legacy; (c) `materialDelta / deltaChecks` ratio — if >50%, Haiku is too permissive and synthesis quality will suffer. Also watch for `conflict: true` in `phases.delta` rows — that's the contradiction flag added in this session.
5. **Write `docs/superpowers/specs/method-b-implementation-plan.md`** (~3h): Precise task list for Weeks 2-12 based on what you see. Must answer these open questions from the audit (AUDIT.md §7.3):
   - `detectDeltaLLM` now returns `new_track.conflict=true` for contradicting facts (Source A: €15M fee, Source B: €25M fee) — visible in `phases.delta`. Verify this fires correctly during observation week. Full editorial queue (holding conflicted stories for review) is post-G2M.
   - When a T1 source arrives *after* initial synthesis and triggers a new phase, does `synthesizePhase()` **supersede** the previous synthesis or **append** to it? Update path must exist, not just append.
   - Map Sprint I (Trust Architecture, SLICES.md) against Method B trust tiers — can Sprint I's `trust_tier` + `source_family` fields satisfy Method B's EVENT router needs?
6. **CI setup (~2h any day):** Survey `/admin/golden-fixtures`, create `.github/workflows/golden-fixtures.yml`, create `scripts/test-tier2.sh`.

**Done when:** Shadow worker live + `/admin/pipeline` showing methodb activity + `method-b-implementation-plan.md` exists.

Step 3 (Haiku judge in `correlateToTopic` + `branch_of`/`sequel_of` edges + parallel claim-tracks) — hold until shadow output observed and implementation plan written.

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
- **`worker-fetch-agent.js` refactor (864KB)** — do NOT refactor now. Natural exit: after Method B cutover, legacy fetch path becomes dead code; delete it and the file shrinks to ~200-300KB on its own. Until then: new features go in `src/*.js` modules (never add to the monolith); the `src/shared.js` DRY work is the only incremental extraction worth doing (see §7 above).

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
