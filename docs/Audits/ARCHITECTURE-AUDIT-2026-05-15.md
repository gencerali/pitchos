# Architecture Audit Report — Kartalix / PitchOS

## 1. Context

- **Audited at**: 2026-05-15
- **Auditor**: Claude Code (claude-sonnet-4-6) — requested by founder
- **Codebase state**: v0.8 shipped 2026-05-13; Sprint I (Trust Layer) is the next planned work

**Roadmap items considered:**
- Sprint I — Trust Layer (I1 source tiers, I2 independence hardening, I3 journalist tracking, I4 feedback loop)
- Sprint J — Maç Özetleri / Match Highlights
- Sprint K — Situational Awareness Engine (3-layer: live facts, derived signals, editorial context)
- v1.0 public launch — July 2026 freeze criteria
- v1.1 — PM Agent
- v1.2 — Distributed Pipeline (second worker, queue)
- v1.4 — Second team (Galatasaray or equivalent)

**Architectural decisions respected:**
- Story-centric architecture (facts → stories → synthesis)
- Facts Firewall as legal core (source text destroyed after extraction)
- Multi-tenant JSONB config per site row
- Signal-driven match lifecycle (match watcher, state machine)
- API-Football Pro as the canonical data provider
- Three story types: transfer, match-centric, institutional

**Assumptions made:**
- `pitchos-proxy` auto-enrich cron was NOT disabled (the April 2026 AUDIT.md flagged it as needing a founder decision; NEXT.md has no record of it being disabled)
- Sprint I DB migrations (trust_tier, source_family, trust_score) have NOT been run in Supabase (NEXT.md confirms this is the next action)
- Migration 0008 (`sites.editorial_context`) has not been run; the file does not exist in `docs/migrations/`
- `ADMIN_PIN` secret is set correctly in Wrangler — but the fallback `kartalix2026` in code is a risk if not

---

## 2. Executive Summary

The core pipeline is architecturally sound: multi-tenant from the start, a clean `src/` module boundary for domain logic, and a working Facts Firewall that protects the legal posture. The roadmap through v1.0 is achievable in the July timeframe — the feature design is correct and the data model is extensible.

The primary risk is concentration: a single 8,655-line worker file now contains every HTTP handler, every HTML template, every admin tool, and every business logic hook. This is not a stylistic concern — it is making each Sprint more expensive than the last, and it will make Sprint K's `src/situation.js` integration harder than it needs to be. The second risk is a security gap that must be closed before public launch: the `force-*` and `/run` endpoints are completely unauthenticated and publicly routable.

**Top 3 things that matter most for the next 90 days:**
1. Lock down the unauthenticated pipeline trigger endpoints before v1.0 (finance and content-integrity risk, not just a style issue)
2. Run the Sprint I database migrations so trust tier can actually be wired into ranking
3. Begin extracting the HTML rendering layer from the worker to keep Sprint K's ~300 new lines manageable

---

## 3. Strengths to Preserve

- **`src/` module separation is working.** `publisher.js`, `processor.js`, `fetcher.js`, `utils.js`, `story-matcher.js`, `firewall.js`, `api-football.js` have clean export surfaces. The worker imports from them; they don't import from the worker. This boundary is the foundation for all future extraction work — protect it.

- **`buildGroundingContext()` is architecturally correct.** Grounding context flows into every synthesis prompt, drawn from a cached API source with graceful fallback. Sprint K's `src/situation.js` should extend this pattern, not replace it. If you refactor it, keep the 1h KV cache + graceful-null fallback pattern.

- **`rankAndEvict()` is a single ranked truth.** All 35 KV write paths now go through `cacheToKV()` → `rankAndEvict()`. The decay formula is centralized. Future Sprint I trust_multiplier wires in here in one place, nowhere else. Preserve this consolidation.

- **`getActiveSites()` makes multi-tenancy free.** Every pipeline loop iterates over active site rows. Adding Galatasaray (v1.4) is a Supabase INSERT plus a NEXT_MATCH row — it is zero code if `NEXT_MATCH` gets moved out of the worker (see P1 findings). Do not introduce per-tenant `if` branches in the worker.

- **Cost cap enforcement is in `utils.js`, not scattered.** `checkCostCap()` is called before every AI operation. $8 cap is extremely low for the feature set, but the pattern of checking before spending is correct. When the cap increases, you change one env var, not 20 call sites.

- **Facts Firewall legal core is in place.** `facts` + `fact_lineage` tables, `extractFactsForStory()` gating, `SKIP_STORY_TYPES` filter — the structural protection is real. The open question (full_body pre-firewall remediation) is a data cleanup task, not an architecture problem.

- **The build discipline system (four files + PM agent design) is well-thought-out.** `DECISIONS.md`, `SLICES.md`, `NEXT.md`, `BUILD-DISCIPLINE.md` form a coherent tracking system. The fact that you have 17 decision records from the first two weeks shows the practice is working.

---

## 4. P0 — Stop Everything

---

### P0-1: Unauthenticated pipeline trigger endpoints are publicly accessible

**Title:** `/run`, `/force-cache`, and all `/force-*` routes require no authentication

**Description:** Every endpoint under the `force-*` and `run-*` wrangler route patterns (`kartalix.com/force-*`, `kartalix.com/run-*`) is publicly routable and performs no auth check. These endpoints trigger the full fetch-score-write pipeline, fire Claude API calls (spending against the $8/month cap), and some (`/force-synthesis?publish=1`, `/force-t01`, `/force-t02`, etc.) publish articles directly to the live site. Any person who reads the public JS on kartalix.com can discover these routes. A single script hitting `/force-synthesis?publish=1` in a loop can drain the monthly Claude budget in under 10 minutes and flood the site with garbage.

**Why this priority:** This is a direct financial and content-integrity risk, live in production today. It is also explicitly listed in the v1.0 freeze checklist ("security hardening, JWT auth, rate limiting, CSP") — but the freeze is in July. The risk is active now.

**Recommended fix:** Add the same `kx-editor=1` cookie check (or a separate `kx-ops` cookie with a different PIN) to all `force-*` and `/run` handlers before the URL dispatch block. Long-term, move to a signed token in the cookie. As an immediate stopgap: move the auth check to a shared `function requireAuth(request)` helper, and call it at the top of each force-handler. This is a 2-hour change.

**Estimated effort:** S (< 1 day — add auth guard to ~25 route handlers)

**Files / areas involved:** `worker-fetch-agent.js` lines 161–1580 (all force-* and /run handlers)

---

### P0-2: Default admin PIN is hardcoded in source code with known value

**Title:** `ADMIN_PIN || 'kartalix2026'` default gives admin access if the secret is unset

**Description:** Line 2116 of `worker-fetch-agent.js`: `const adminPin = env.ADMIN_PIN || 'kartalix2026'`. If the `ADMIN_PIN` Wrangler secret is ever not set — new deployment environment, team member running locally, secret accidentally deleted — the entire admin UI is accessible with a widely-shared default PIN. This PIN is now documented in this audit report and was committed to the codebase.

**Why this priority:** A hardcoded credential fallback is a category of vulnerability that appears in OWASP Top 10. The risk is not theoretical — it is the state the system reaches if secrets are misconfigured.

**Recommended fix:** Remove the fallback entirely. Change line 2116 to `if (!env.ADMIN_PIN) return Response.json({ error: 'Server misconfigured' }, { status: 500 })`. Document `ADMIN_PIN` in a `.env.example` or deployment checklist. Verify the secret is set via `wrangler secret list` after any deployment.

**Estimated effort:** S (< 1 hour)

**Files / areas involved:** `worker-fetch-agent.js` line 2116

---

## 5. P1 — Fix Before Next Roadmap Item

---

### P1-1: Forgeable session cookie blocks Sprint I admin tooling

**Title:** `kx-editor=1` cookie has no secret, no HttpOnly flag, and no Secure flag

**Description:** Admin authentication is a static cookie value `kx-editor=1`. Any user can open browser DevTools, type `document.cookie = 'kx-editor=1'`, and gain full admin access. The cookie has no HMAC signature or session secret. It also lacks the `HttpOnly` flag (JavaScript on the page can read and exfiltrate it) and the `Secure` flag (though in practice kartalix.com is HTTPS, so this is lower risk). Sprint I adds journalist trust tracking and source tier management to the admin — these are higher-value attack targets than the current admin state.

**Why this priority:** Sprint I ships source tier controls that directly affect what gets published. A forgeable admin session means an attacker could demote trusted sources to T4, corrupting the ranking signal permanently.

**Recommended fix:** Replace `kx-editor=1` with a server-generated session token: on successful PIN entry, generate `crypto.randomUUID()`, store it in KV (`admin:session:{token}` with 7-day TTL), set the cookie to that token. On each admin check, verify the token against KV. This eliminates forgeability. Add `HttpOnly; Secure; SameSite=Lax` flags to the Set-Cookie header. This is a full-day change but straightforward.

**Estimated effort:** M (1–2 days)

**Files / areas involved:** `worker-fetch-agent.js` lines 2049–2137 (all auth checks + login handler)

---

### P1-2: Sprint I database migrations not run — trust tier cannot be wired

**Title:** Trust tier columns (trust_tier T1-T4, source_family, trust_score) do not exist in Supabase

**Description:** `NEXT.md` lists Sprint I1 as the next action: `ALTER TABLE source_configs ADD COLUMN trust_tier TEXT`, `ALTER TABLE source_configs ADD COLUMN source_family TEXT`, `ALTER TABLE content_items ADD COLUMN trust_score INT DEFAULT 50`. None of these exist in the live schema. Until they do, the `trust_multiplier = trust_score/50` cannot be wired into `rankAndEvict()`, and Sprint I1 cannot complete. This is a dependency on a 10-minute SQL run, not a code problem.

**Why this priority:** Sprint I is the next sprint. Nothing in I1 can ship code-side until the schema exists. The trust gate is also a v1.0 launch freeze criterion.

**Recommended fix:** Run the three `ALTER TABLE` statements from `NEXT.md` in the Supabase SQL editor. Then seed the 17+ existing sources in `/admin/sources/ui`. These are non-destructive column additions (`IF NOT EXISTS`, nullable or with defaults) — zero downtime risk.

**Estimated effort:** S (10 minutes to run migrations; 1–2 hours to seed sources)

**Files / areas involved:** Supabase SQL editor — `ALTER TABLE source_configs`, `ALTER TABLE content_items`

---

### P1-3: `NEXT_MATCH` hardcoded in worker and points to a past match

**Title:** `NEXT_MATCH` constant (worker line 26) is stale and every match cycle requires a code deploy

**Description:** The `NEXT_MATCH` object is hardcoded at line 26 with `date: '2026-05-01'` and `opponent: 'Gaziantep FK'` — a match that was played 14 days ago. Template generators T01 (preview), T02 (H2H), T03 (form guide), T07 (injury), T08 (lineup), T09 (confirmed lineup) all depend on `fixture_id: 1394714` from this object. If `match:BJK:next` KV is populated correctly, it overrides this — but the hardcoded fallback silently provides stale fixture data when KV is empty (on cold deploy, KV expiry, etc.). Sprint J (match highlights) adds new template generators that consume fixture events — stale fixture_id there would silently produce wrong content.

**Why this priority:** Sprint J depends entirely on correct fixture routing. A stale fixture_id silently passes all code paths, produces wrong match data, and publishes it. This is a content integrity risk, not just a technical debt item.

**Recommended fix:** Remove the `NEXT_MATCH` constant entirely. Make all template generators read from `match:BJK:next` KV first, then call `getNextFixture()` directly as fallback (with KV write-back), and return a soft error (no article generated, not a hard failure) if both fail. The `match:BJK:next` KV key was added in session 14 — make it the only source of truth.

**Estimated effort:** M (1–2 days — touch all template generators that reference NEXT_MATCH)

**Files / areas involved:** `worker-fetch-agent.js` lines 26–45 (NEXT_MATCH constant) + all T01–T09 template call sites

---

### P1-4: Migration 0008 missing — Sprint K Layer 3 admin form is blocked

**Title:** `sites.editorial_context JSONB` migration file does not exist in `docs/migrations/`

**Description:** `docs/sprint-k-analysis.md` specifies `migration 0008_sites_editorial_context.sql`: `ALTER TABLE sites ADD COLUMN IF NOT EXISTS editorial_context JSONB DEFAULT '{}'`. This file does not exist in `docs/migrations/`. The migration numbering skips from 0007 to 0009. Sprint K task K4 (Layer 3 schema + admin form + BJK seed data) is identified as the first thing to implement in Sprint K — it cannot start until this migration runs. The column likely does not exist in Supabase either, meaning `src/situation.js`'s `editorialContext()` function will fail on its first query.

**Why this priority:** K4 is listed as "half a day" and the recommended first task of Sprint K. If the migration is missing, K4 silently produces no editorial context, and the entire Sprint K output (situational awareness injection) degrades to Layer 1 + Layer 2 only — with no error visible.

**Recommended fix:** Create `docs/migrations/0008_sites_editorial_context.sql` with the ALTER TABLE statement. Run it in Supabase before Sprint K begins. Add the seed record for BJK via `/admin/sources` or a separate admin form.

**Estimated effort:** S (30 minutes to create file and run migration)

**Files / areas involved:** `docs/migrations/` (new file), Supabase SQL editor

---

### P1-5: `worker-fetch-agent.js` at 8,655 lines is a growth blocker

**Title:** The main worker is a God File — every Sprint adds hundreds of lines to an already-unmaintainable file

**Description:** The worker is 8,655 lines and contains: 25+ force-* route handlers (each 30–80 lines), inline HTML rendering for admin UI (est. 3,000+ lines of template strings), inline article page renderer, RSS feed renderer, sitemap renderer, PIN login page, admin dashboard, QA fixtures page, and the cron orchestration logic. `checkH5SynthGate()` is defined here instead of in `story-matcher.js`. Sprint I will add trust tier seeding UI; Sprint K will add a Layer 3 editorial form and `buildSituationContext()` integration. At current growth rate (~500 lines/sprint), the worker reaches 12,000 lines before v1.0. Finding the right insertion point for new code takes increasingly more time and the risk of accidentally breaking an unrelated route increases.

**Why this priority:** This is a P1 (not P2) because Sprint I and Sprint K both add new admin UI and new route handlers to this file. The problem is not just accumulation — it is that the file is already so large that adding Sprint K's 300-line `src/situation.js` integration correctly requires navigating 8,655 lines to find 5 call sites.

**Recommended fix:** Extract in two targeted passes, not a full rewrite. Pass 1 (before Sprint I, M effort): move all HTML rendering functions (`renderAdminPage`, `renderArticleHTML`, `renderPinPage`, `renderTopicPage`, `serveRSSFeed`, `serveSitemap`) into a `src/renderer.js` file. This alone removes ~3,000 lines. Pass 2 (before Sprint K, M effort): move `checkH5SynthGate()` into `story-matcher.js`; extract all force-* handlers into a `src/debug-routes.js` module. The worker itself should contain only: route dispatch, cron handler, `processSite()`, `backgroundWork()`, `runAllSites()`.

**Estimated effort:** L (Pass 1: 2–3 days; Pass 2: 2–3 days — mechanical moves, low logic risk)

**Files / areas involved:** `worker-fetch-agent.js` → `src/renderer.js`, `src/debug-routes.js`

---

## 6. P2 — Schedule This Quarter

---

### P2-1: No error tracking — production failures disappear silently

**Title:** All errors are `console.error()` only — no external error tracker, no alerting

**Description:** Every error in the pipeline (Claude API failure, Supabase write failure, proxy timeout, template generation crash) is logged to `console.error()`. These are visible in the Cloudflare dashboard only if you actively look. There is no alert when the Claude cap is hit, no Telegram notification when a cron run produces 0 articles, no Sentry or similar for unhandled exceptions. The `pipeline:failures` KV key captures some failures but has no notification path. NEXT.md session 21 added the KV timeline for article lifecycle — but that is observability of content, not of system health.

**Why this priority:** Sprint I journalist tracking and Sprint K situational awareness both add new failure modes (trust scoring failures, Layer 2 derivation errors, Layer 3 missing context). Without error tracking, regressions in these new features are discovered by noticing the site looks wrong — not by an alert.

**Recommended fix:** Route the Claude cost cap warning to Telegram (the PM agent channel already exists). Add a lightweight error reporter that writes to a Supabase `pipeline_errors` table (or the existing `fetch_logs` table with an error severity level) on each failed cron run. At minimum: send a Telegram message when `articles_processed === 0` on a non-off-season cron run. Full Sentry integration is v2 scope.

**Estimated effort:** M (1–2 days)

**Files / areas involved:** `src/utils.js` (callClaude error path), `worker-fetch-agent.js` (cron handler), Supabase `fetch_logs` or new table

---

### P2-2: `seenUrls` query grows unboundedly — will degrade by v1.0

**Title:** `getSeenUrls()` fetches 10,000 rows on every pipeline run with no index on the query columns

**Description:** `processor.js` line 265: `SELECT original_url FROM content_items WHERE site_id=... ORDER BY created_at DESC LIMIT 10000`. There is no explicit index on `(site_id, created_at)` in the migration files — Supabase may have created a default index, but it is not in the codebase. At current growth (est. 50–100 new rows/day), `content_items` will have ~15,000–25,000 rows by v1.0 launch. The query will return 10,000 rows on every hourly cron — that is 10,000 rows × 24 runs = 240,000 row-reads per day from a table with no explicit index.

**Why this priority:** This will become a performance issue before v1.0. PostgREST row reads are counted toward Supabase egress and response time. At 25K rows the 10K query still runs, but at 100K+ rows (post-launch growth) it becomes a meaningful latency addition to every cron run.

**Recommended fix:** Add a migration: `CREATE INDEX IF NOT EXISTS content_items_site_created ON content_items (site_id, created_at DESC)`. Then consider whether the `getSeenUrls` window needs to be 10,000 — a 30-day window (`created_at >= now() - interval '30 days'`) is likely sufficient and self-bounded.

**Estimated effort:** S (1–2 hours — migration + query update)

**Files / areas involved:** `src/processor.js` line 265, `docs/migrations/` (new migration 0012)

---

### P2-3: Editorial notes and feedback stored in KV — data loss risk

**Title:** `editorial:notes`, `editorial:raw_feedback`, `editorial:references` are in KV (volatile) not Supabase

**Description:** All editorial notes (the rules that shape every Claude generation), raw feedback from the editor, and reference articles are stored in Cloudflare KV. KV is reliable for caching, but it is not a database — there is no backup, no audit trail, and a KV namespace reset or accidental delete would silently wipe all editorial configuration. These values directly affect the quality of every synthesized article. A single `env.PITCHOS_CACHE.delete('editorial:notes')` call — whether accidental or intentional — removes all editorial rules with no recovery path.

**Why this priority:** Sprint I journalist tracking adds more editor-configured data. Sprint K Layer 3 editorial context is added to `sites.editorial_context` in Supabase (correctly), but the existing editorial notes stay in KV. As the editorial system grows, the durability gap increases.

**Recommended fix:** Migrate `editorial:notes` to a Supabase table (`editorial_rules`: id, site_id, scope, text, active, created_at). Keep KV as a read-through cache (5-min TTL, warm-on-read from Supabase). The migration can be additive: read from Supabase, fall back to KV during migration period. `editorial:raw_feedback` can stay in KV (it is processed and discarded); `editorial:references` could stay in KV (50-item cap, low value).

**Estimated effort:** M (2–3 days — new Supabase table + migration + updated read/write functions in utils.js)

**Files / areas involved:** `src/utils.js` (getEditorialNotes, saveEditorialNote, etc.), new Supabase migration

---

### P2-4: Monthly cost cap is tracked in KV — concurrent write race condition

**Title:** `addCost()` does a read-modify-write on KV with no locking — concurrent cron ticks can undercount spend

**Description:** `utils.js` lines 291–295: `addCost()` reads the current cost from KV, adds the new spend, and writes it back. If two cron ticks (e.g., the 5-minute cron and the hourly cron) fire simultaneously and both read before either writes, one of the increments is lost. At $8/month cap with an inaccurate counter, the system could exceed the intended cap. With 5 cron schedules in wrangler.toml, simultaneous firing is possible.

**Why this priority:** The cost cap is a financial safety mechanism. If it undercounts, you could receive an unexpectedly large Anthropic invoice. With current spend levels this is low-magnitude, but Sprint I and Sprint K each add more Claude calls per run.

**Recommended fix:** Write cost tracking to Supabase `api_costs_daily` table (which already exists per AUDIT.md) using a Supabase `UPSERT` with atomic increment (`cost_usd = cost_usd + $1`). KV is not appropriate for financial counters that need consistency. Alternatively, use Cloudflare Durable Objects for atomic KV if you want to stay in Workers.

**Estimated effort:** M (1–2 days — Supabase atomic upsert + update all addCost call sites)

**Files / areas involved:** `src/utils.js` addCost/checkCostCap, `api_costs_daily` Supabase table

---

### P2-5: `pitchos-proxy` auto-enrich cron status unknown — potential Facts Firewall bypass

**Title:** The Render.com auto-enrich cron was identified as a Slice 1 violation in April 2026 but its current status is unconfirmed

**Description:** `AUDIT.md` (April 2026) identified the `pitchos-proxy/index.js` auto-enrich cron (lines 101–135) as a critical violation: it runs every 10 minutes, fetches Readability full text for all cached articles including P4 sources, and pushes that content back to KV. This bypasses the Facts Firewall entirely. The AUDIT.md flagged it for a founder decision (disable now vs. at Slice 1 time). The NEXT.md session log does not record this being disabled. It is possible this cron is still running today on Render.com.

**Why this priority:** If it is still running, it is pushing P4 source text into KV on a 10-minute cycle, which directly undermines the Facts Firewall's legal protection. It needs to be confirmed disabled or the risk is ongoing.

**Recommended fix:** Check the Render.com dashboard for the `pitchos-proxy` worker. If the cron is still active, disable it immediately. Confirm by checking `pitchos-proxy/index.js` line 101–135 for the `/auto-enrich` cron handler and whether it is still deployed.

**Estimated effort:** S (30 minutes to verify + disable if still active)

**Files / areas involved:** `pitchos-proxy/index.js` lines 101–135, Render.com dashboard

---

## 7. P3 — Track, Decide Later

- **Test coverage is ~3.5%** (516 test lines / 14,563 source lines). Core pipeline functions — `preFilter()`, `rankAndEvict()`, `saveArticles()`, `scoreArticles()` — have zero test coverage. This makes Sprint I trust_multiplier regression undetectable. Schedule unit tests for `rankAndEvict()` before Sprint I ships.

- **`seenHashes` window is 50 items** (`processor.js` line 273: `slice(-50)`). This KV hash cache is too small to provide meaningful dedup — its only value is preventing duplicate processing within the same cron run. The real dedup is `getSeenUrls()` (10,000 rows). Consider removing seenHashes entirely and relying on seenUrls + the slug unique index.

- **`ALLOWED_ORIGINS` is hardcoded** in the worker (line 47). Adding `app.kartalix.com` as an additional domain required a code change. Move to `sites.allowed_origins TEXT[]` or a JSONB config field so domain changes don't require deploys.

- **`COST` rates in `utils.js` are labeled 'costEur'** but the comment on line 289 says "USD pricing despite the 'costEur' variable name". The variable naming is actively misleading. Rename to `costUsd` across all stat objects.

- **`BJK_KEYWORDS` (utils.js) and `BJK_REGEX` (processor.js) are two separate keyword lists** for the same conceptual filter. One is an array used for source config filtering; the other is a regex used in pre-filter. They are not synchronized. If a new player is added to `BJK_KEYWORDS`, the regex doesn't pick them up and vice versa. Consolidate into one source of truth.

- **`NEXT_MATCH.cup: null`** — the cup fixture slot in `NEXT_MATCH` is always null. Cup competition support is planned (Sprint K Layer 1.5 gap). Track this as a data model gap before Sprint K ships.

- **Migration 0008 file is missing** from `docs/migrations/`. Either the `sites.editorial_context` migration was run manually via the Supabase dashboard (undocumented), or it was never run. Verify and create the file if missing.

- **`worker-fetch-agent.js` has 12 TODO/FIXME/HACK comments** — most are innocuous sprint notes. None appear to be critical code paths.

- **`kv:timeline:BJK` has no multi-tenant key** — it uses the hardcoded site code `BJK`. `cacheToKV()` accepts `siteCode` parameter but the timeline key should match. Verify the timeline key uses the `siteCode` parameter, not a hardcoded string, before v1.4 (second team).

---

## 8. Roadmap Impact Matrix

| Finding | Sprint I (Trust Layer) | Sprint J (Match Highlights) | Sprint K (Situational Awareness) | v1.0 Launch | v1.4 (2nd Team) |
|---|---|---|---|---|---|
| **P0-1** Unauth force-* routes | Low impact | Low impact | Low impact | **BLOCKS** (freeze criterion) | — |
| **P0-2** Hardcoded default PIN | Low impact | Low impact | Low impact | **BLOCKS** (security hardening criterion) | — |
| **P1-1** Forgeable session cookie | Sprint I admin adds source tier controls — forgeable auth = attacker can corrupt trust tiers | — | Sprint K Layer 3 admin is editable by anyone with DevTools | **BLOCKS** (security criterion) | — |
| **P1-2** Sprint I migrations not run | **BLOCKS I1 completely** — trust_multiplier cannot be wired until columns exist | — | — | BLOCKS (trust gate freeze criterion) | — |
| **P1-3** Stale NEXT_MATCH | — | **BLOCKS** — Sprint J uses fixture_id for event fetch; stale ID produces wrong content | Affects match-day situational framing | Risk | Breaks per-team fixture routing |
| **P1-4** Missing migration 0008 | — | — | **BLOCKS K4** — Layer 3 admin form cannot ship without the column | — | — |
| **P1-5** God File (8,655 lines) | Makes Sprint I harder — finding trust_multiplier insertion in 8,655 lines | Makes Sprint J harder | Makes Sprint K ~300-line integration harder to verify | — | Severely harder to add 2nd team routes |
| **P2-1** No error tracking | Sprint I trust scoring errors invisible | Sprint J match event failures invisible | Sprint K derivation failures invisible | Risk at launch | — |
| **P2-2** getSeenUrls unbounded | — | — | — | Performance risk at launch traffic | Worse at 2× article volume |
| **P2-3** Editorial notes in KV | Sprint I adds more editor data in KV | — | Sprint K Layer 3 is correctly in Supabase, but existing rules still in KV | Durability risk | — |

---

## 9. Recommended Sequencing

**Immediate (before writing any Sprint I code):**

1. **P0-2** — Remove the hardcoded PIN fallback. 30 minutes. No risk.
2. **P1-2** — Run the Sprint I DB migrations in Supabase SQL editor. 10 minutes. Non-destructive.
3. **P1-4** — Create `docs/migrations/0008_sites_editorial_context.sql` and run it. 30 minutes.
4. **P2-5** — Verify Render.com auto-enrich cron is disabled. 30 minutes.

**During Sprint I:**

5. **P0-1** — Add auth guard to all `force-*` and `/run` handlers. This is a Sprint I prerequisite because Sprint I adds new admin tooling that the same auth system protects. Do it as Sprint I's first commit, not its last.
6. **P1-1** — Upgrade session cookie to server-generated token. Bundle with P0-1 — you're touching the auth system anyway.

**Before Sprint J (match highlights):**

7. **P1-3** — Remove `NEXT_MATCH` hardcoded constant, make all template generators read from `match:BJK:next` KV. Sprint J's entire feature depends on correct fixture routing. Fix this in Sprint J's first task.

**Before Sprint K:**

8. **P1-5 Pass 1** — Extract HTML renderers into `src/renderer.js`. Do this as Sprint J's final task or Sprint K's first task. The worker needs to be under 6,000 lines before Sprint K's 300-line `src/situation.js` integration.

**This quarter (alongside v1.0 prep):**

9. **P2-1** — Wire Claude cap hit + zero-article-run alerts to Telegram. One cron hook.
10. **P2-2** — Add `content_items_site_created` index migration.
11. **P2-3** — Migrate `editorial:notes` to Supabase.
12. **P2-4** — Move cost tracking to `api_costs_daily` Supabase table with atomic upsert.

**After v1.0 ships:**

13. **P1-5 Pass 2** — Extract force-* handlers into `src/debug-routes.js`. Lower urgency once the HTML rendering is out.
14. P3 items as backlog.

---

## 10. Unknowns and Things I Could Not Audit

1. **`pitchos-proxy/index.js` current deployed state** — I can read the source file but cannot verify whether the auto-enrich cron is actually disabled in the live Render.com deployment. This needs a dashboard check.

2. **Supabase `content_items.full_body` pre-firewall data** — The AUDIT.md (April 2026) flagged that many rows in `content_items.full_body` contain P4 source text from before the Facts Firewall shipped. I cannot query the live database to know how many rows this affects or whether the Turkish IP lawyer consultation has clarified the remediation path. This is still an open legal question.

3. **Sprint I migration status** — `NEXT.md` says these migrations are next. I cannot confirm whether they have been partially run (e.g., trust_tier column added but trust_score not). Run `SELECT column_name FROM information_schema.columns WHERE table_name = 'source_configs'` and `content_items` in Supabase to verify.

4. **`sites.editorial_context` column existence** — Migration 0008 file is missing. The column may or may not exist in Supabase. Run `SELECT column_name FROM information_schema.columns WHERE table_name = 'sites'` to confirm.

5. **`kv:timeline:BJK` multi-tenant safety** — The KV timeline key appears to use a hardcoded `BJK` string in some paths. I reviewed `cacheToKV()` only at the signature level; I could not verify all call sites produce tenant-scoped keys. Worth a grep before v1.4.

6. **`MONTHLY_CLAUDE_CAP = "8"` USD is extremely low** — Sprint I adds per-source trust scoring calls; Sprint K adds `buildSituationContext()` calls per synthesis prompt. The current cap of $8/month may need to increase. I could not model the exact new cost without running the pipeline, but the cap should be reviewed before Sprint I's first cron run.

7. **`story_contributions`, `stories`, `story_state_transitions` table schemas** — These tables were created via the Supabase dashboard (not via migration files in `docs/migrations/`). Their exact schema, indexes, and constraints are not verifiable from the codebase alone. They are load-bearing for Sprint H5, I2, and K. A migration file for each should be created to make the schema reproducible.

8. **Google AdSense approval status** — The site was submitted in May 2026. AdSense rejection based on content concerns (copyright, news aggregation) could affect the monetization assumption that underlies the v1.3 roadmap item. Not an architecture issue, but a launch risk worth tracking.

---

*Audit completed: 2026-05-15. No code was changed. All findings are observations and recommendations only.*
