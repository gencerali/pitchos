# NEXT.md

**The single most underused founder tool. Read this every time you sit down.**

Update this at the END of every work session. Not the start — the end. Future-you walking in cold should know exactly what to do next without thinking.

---

## NEXT ACTION

**NEXT** (Sprint 1 rescoped around **Method B** — see `docs/method-b-design.md`):
1. **Deploy & observe** — `npx wrangler deploy -c wrangler-story.toml` + secrets, apply `0014_method_b.sql`, set KV `methodb:enabled=1`, then watch `/admin/pipeline` for a few days. Tune the rules pre-filter, delta prompt, and synthesis voice against real output. ← this task
2. Step 3 — Haiku judge in `correlateToTopic` + `branch_of`/`sequel_of` edges (derbi→skandal, hoca krizi) + parallel claim-tracks (rakip-kulüp transfers). *(hold until shadow output observed.)*

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
- **Cutover seam** — `getServedArticles` blue/green resolver (per-site `pipeline:active` pointer, defaults legacy, cold-start fallback) wired into the `/cache` serving path; `/admin/pipeline/flip` endpoint + flip buttons on the compare page. Instantly reversible, safe-by-default. 72/72 tests green.
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
