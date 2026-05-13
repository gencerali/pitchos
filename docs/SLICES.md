# SLICES.md — Kartalix v1 Build Tracker

**How to use this file**: Read the top section every time you sit down to work. Update statuses when you finish anything material. The PM agent reads this to surface drift.

**Statuses**: `not-started` · `in-progress` · `blocked` · `done`

---

## CURRENTLY IN FLIGHT

**Slice 0 — Build Scaffold + PM Agent**
Started: 2026-04-28
Estimated: 1–2 weeks
Status: `in-progress`

---

## v0 — BUILD SCAFFOLD (do first, before any slice)

**Goal**: ship the PM agent and the four tracking files before starting Slice 1.

- [x] Four tracking files in `docs/` (SLICES, DECISIONS, NEXT, AUDIT, BUILD-DISCIPLINE)
- [x] Turkish IP lawyer consultation completed — feedback received, architecture adjusted
- [x] 48-hour legal compliance actions done (IT3 block, enrich cron disabled, hot-news delay, source attribution)
- [ ] Telegram channel `@kartalix-pm` created
- [ ] PM agent Cloudflare Worker scaffold
- [ ] Monday kickoff message wired
- [ ] Friday close message wired
- [ ] End-of-session logger wired
- [ ] Drift detector daily cron wired
- [ ] Pause command implemented

**Done when**: Monday morning, you receive a kickoff message in Telegram with your committed deliverables for the week.

---

## SLICE 1 — Facts Extraction Firewall

**Why first**: legal core. Every other piece depends on this being real. Without it, you're shipping copyright violations.

**Estimated**: 2–4 weeks (could stretch to 6 if evenings only)

**Deliverables**:
- [x] Fact schema for Transfer story type (start narrow)
- [x] Firewall extraction logic
- [x] Source text destruction post-extraction (with audit log)
- [x] `facts` and `fact_lineage` tables migration — `0002_facts_firewall.sql` run 2026-05-09
- [x] Wire firewall between Readability output and Produce Agent (transfer path: extractFacts → writeTransfer; all types: extractFactsForStory)
- [x] Golden fixture: `firewall_destroys_source_text` — verified 2026-05-09 via /test-firewall: facts extracted, article generated from facts only, source_text_length logged, no source text stored
- [ ] Golden fixture: `rashica_transfer_5_contribs` — 5 contributions about same player → one story
- [ ] Golden fixture: `fotomac_403` — 403 source handled gracefully
- [ ] Lawyer consultation outcome reviewed and architecture adjusted if needed ✅ done 2026-04-28
- [ ] Hot News delay (15 min for P4) — implemented 2026-04-28, golden fixture still needed
- [ ] Source attribution mandatory on all derived articles — implemented 2026-04-28
- [x] Remove Cloudflare Access gate from `/haber/*` — never had one; site public since pictures removed + no copied content

**Done when**: a P4 article goes through the pipeline and the published Kartalix article is provably non-derivative. You can show this to a lawyer. Article pages are publicly accessible.

**Blockers**:
- ~~Turkish IP lawyer consultation pending~~ ✅ resolved 2026-04-28

---

## SLICE 1.5 — Truth Layer: Factual Grounding + Verifier Gate

**Why after Facts Firewall**: Slice 1 ensures articles are non-derivative (legal). Slice 1.5 ensures they're factually accurate (editorial). These are distinct concerns: you can write a fully original article that is still wrong ("BJK kritik virajda" when league data shows 4th place on 45 points is not a crisis). The truth layer makes generation fact-consistent by default.

**The problem**: Claude synthesizes articles from RSS source text. If a source frames a story misleadingly, Claude inherits and amplifies that framing. If sources disagree on a score or date, Claude picks one arbitrarily. No mechanism prevents the system from writing articles that contradict verified API-Football data.

**Phase 1 — Factual Grounding** ✅ DONE (2026-05-08)

_Inject verified API-Football stats into every synthesis prompt before generation. Claude cannot contradict data it can see._

- [x] `buildGroundingContext(env)` in publisher.js — fetches last 5 results + current Süper Lig standings, returns `DOĞRULANMIŞ VERİLER` block in Turkish
- [x] Injected into `synthesizeArticle()` (single-source inline synthesis) and `generateOriginalNews()` (multi-source batch synthesis)
- [x] Graceful fallback: returns `''` if API-Football is unavailable; generation continues without grounding
- [x] Both synthesis functions fetch grounding in parallel with editorial notes — no added latency

**Phase 2 — Interpretation Guard** ✅ DONE (2026-05-09)

_Editorial notes rule that governs crisis/disaster framing. Uses existing system, no new code._

- [x] Add to editorial notes via `/admin/editorial`: interpretation guard rule added
- [x] Run `/admin/editorial/distill` to activate immediately

**Phase 3 — Verifier Gate** ✅ DONE (2026-05-09)

_Post-generation Haiku call extracts factual claims → cross-checks against structured data → flags mismatches. Prevents wrong scores, standings, and dates in published articles._

- [x] `verifyArticle(body, groundingCtx, env)` in publisher.js — Haiku call, ~300 tokens, extracts verifiable claims from body and cross-checks each against grounding data
- [x] Returns `{ passed: bool, issues: string[] }` — `issues` lists specific discrepancies
- [x] If `!passed`: regenerate once; if still failing, publish with `needs_review: true` flag
- [x] `verification_result JSONB` column on `content_items` — migration `0003_verifier_gate.sql` written; **run in Supabase SQL Editor**
- [x] Admin report: surface `needs_review: true` articles with ⚠️ badge
- [ ] `fact_issues` Supabase table — deferred to Slice 7 (audit trail, not blocking)

**Grounding enhancements** (also 2026-05-09):
- [x] `buildGroundingContext()` fully multi-tenant: reads `site.team_id/league_id/season`, falls back to BJK legacy path
- [x] `getLeagueContext(teamId, leagueId, season, env, opponentId)` in api-football.js — standings, recent fixtures, European spots, rival tracking, opponent motivation — cached 1h KV
- [x] `league_european_spots` Supabase table: maps finishing position → competition + entry round + start month + extra qualifying games (migration `0005_league_european_spots.sql` written; **run in Supabase SQL Editor**)
- [x] Competition labels in grounding: `(outcome/SL)` or `(outcome/Kupa)` to prevent false verification failures on Cup vs League results
- [x] Grounding tone fixed: data is context, not script — prompt instructs Claude to weave data naturally, not echo it

**DB migrations** ✅ ALL RUN (2026-05-09):
- [x] `0003_verifier_gate.sql` — `needs_review` + `verification_result` on `content_items`
- [x] `0004_sites_team_league.sql` — `team_id/league_id/season` on `sites`; BJK row set
- [x] `0005_league_european_spots.sql` — table exists with prior seed data (unique constraint confirmed)

**Done when**: 100 synthesis articles generated with grounding active, zero instances of published articles contradicting API-Football standings or recent results.

---

## SLICE 2 — Story-Centric Foundation ✅ DONE (2026-05-10)

**Why second**: replaces article-centric thinking with story-centric data model. Slices 3+ depend on this.

**Estimated**: 2–3 weeks

**Deliverables**:
- [x] `stories`, `story_contributions`, `story_state_transitions` tables — live, 130 stories in DB
- [x] Story matching algorithm (entity overlap + Claude judge)
- [x] Story state machine (emerging → developing → confirmed → active → resolved → archived → debunked)
- [x] Generation triggers tied to state transitions — confirmed → active fires synthesis
- [x] Sub-story lineage (parent_story_id field on stories table)
- [x] Confidence scoring math — source independence gate, quality tier multiplier, OFFICIAL_INITIAL_DELTA=60
- [x] Golden fixture: `story_matching_entity_overlap` — PASS: top story has 46 contributions (Sergen Yalçın)
- [x] Golden fixture: `story_state_transitions` — PASS: 46 stories with logged transitions (emerging→developing→confirmed→active)
- [x] Golden fixture: `confidence_scoring` — PASS: 42 active stories, top at conf:100

**Verified 2026-05-10**: `/admin/golden-fixtures` endpoint returns `all_pass: true` against live production data. 130 stories, 42 active, 46 stories with state transitions logged.

---

## SLICE 3 — Story Type Narrow Set

**Why third**: ships the 3-type taxonomy (Match-extended, Transfer, Injury). Generation triggers, templates, and HITL all branch from type.

**Estimated**: 3–4 weeks

**Deliverables**:

**Phase 0 — Synthesis generation (prerequisite, fixes 1-sentence stubs)**
- [x] Synthesis generation in Produce Agent: fetch full source text at generation time, pass ephemerally to Claude Sonnet, write 300–500 word original Kartalix article (2026-04-29)
- [x] Article body: original prose in Kartalix voice, no "according to X" language
- [x] Source text discarded immediately after generation (never written to DB or KV)

**Phase 1 — Structured match data (stats API)**
- [x] `src/api-football.js` wrapper — getNextFixture, getLiveFixture, getFixture, getH2H, getStandings, getBJKStanding, getFixturePlayers (2026-04-29)
- [x] `getNextFixture()` replaces hardcoded NEXT_MATCH config in template pipeline (2026-04-29)
- [x] Verified: BJK team ID = 549, Süper Lig ID = 203 (2026-04-29)
- ~~[ ] `API_FOOTBALL_KEY` wired as Workers secret~~ — superseded by Track A (2026-04-30)
- ~~[x] Upgraded API-Football to Starter plan~~ — superseded by Track A (2026-04-30)

**Track A — Stats provider procurement results (2026-04-30)**

API-Football Pro ($19/mo) verified against all five NFRs. SoccerData not yet verified.

| NFR | Requirement | API-Football Pro | Status |
|-----|-------------|-----------------|--------|
| NFR1 | Request capacity | 7,500/day (locked NFR was 25,000 for SoccerData) | ⚠️ see note |
| NFR2 | Süper Lig coverage | Confirmed — ID 203, all 12 coverage flags true | ✅ |
| NFR3 | Player ratings | Confirmed — ratings in every fixture player record | ✅ |
| NFR4 | Weather endpoint | Absent — use Open-Meteo (free, no auth, Workers-compatible) | ⚠️ workaround |
| NFR5 | Injury/suspension data | Confirmed — injuries flag true for Süper Lig 2025 | ✅ |

NFR1 note: 7,500/day is 25× estimated peak production volume (~300 calls/day on match days). The 25,000 figure was locked to SoccerData's plan, not to an actual business need. Recommend revising NFR1 to ≥2,000/day and accepting API-Football Pro as the provider. **User decision required before PR #1 can merge or be closed.**

NFR4 note: Open-Meteo (`api.open-meteo.com`) is free, no key, covers any lat/long, works in Cloudflare Workers. One additional fetch call per T01 Preview. Venue coords map already planned as fallback.

- [x] **Provider decision**: stay on API-Football Pro ✅ (2026-05-10)
- [x] `API_FOOTBALL_KEY` rotated and re-wired as Workers secret ✅ (2026-05-10)
- [x] Open-Meteo weather in T01 Match Preview — already implemented via `getMatchWeather()` ✅
- [ ] Venue coords map: add lat/long for BJK home ground + common away grounds

**Phase 2 — Story type classification + match lifecycle**
- [x] Type classification in Qualify Agent: `classifyStoryType()` in firewall.js — Haiku call, 80 tokens (2026-05-01)
- [x] Per-type fact schemas: Transfer, Injury, Disciplinary, Contract, Generic (2026-05-01)
- [x] `extractFactsForStory()` — two-step (classify → schema-appropriate extract) (2026-05-01)
- [x] match_result + squad filtered from story system via `SKIP_STORY_TYPES` (2026-05-01)
- [x] Story-matcher judge includes pre-classified type hint (2026-05-01)
- [ ] **Story type normalization** *(discovered 2026-05-10)*: production DB has 35+ free-form types leaking from Claude (`transfer_interest`, `player_transfer`, `player_replacement_transfer`, `institutional_statement`, etc.). Fix: update `classifyStoryType()` prompt to enforce the controlled set (transfer, injury, disciplinary, contract, institutional, other) and map any non-standard judge output to the nearest controlled type before DB write. Optionally: one-off SQL UPDATE to normalize existing rows.
- [ ] Intelligent match lifecycle (signal-driven open/close, no fixed window) — deferred
- [ ] Match story phase detection (pre/live/post) stored on story entity — deferred
- [ ] Sub-story spawning for non-routine match events — deferred

**Phase 3 — Match templates** ✅ COMPLETE

_Template set revised 2026-04-30 after API-Football Pro coverage verification. All 12 templates shipped 2026-05-01._

Core pre-match (all API-driven):
- [x] T01 Match Preview (fixture + H2H + standings + weather) (2026-04-30)
- [x] T02 H2H History (2026-05-01)
- [x] T03 Form Guide (2026-05-01)
- [x] T05 Match Day Card (API injuries, not RSS) (2026-05-01)
- [x] T07 Injury & Suspension Report (fixture-scoped API) (2026-05-01)
- [x] T09 Confirmed Lineup (API `/fixtures/lineups`, returns null until submitted) (2026-05-01)
- [x] T-REF Referee Profile (API last-10 fixtures, 24–48h window) (2026-05-01)

Live + post-match:
- [x] T10 Goal Flash (live, BJK goal detected from score delta + events API) (2026-04-30)
- [x] T11 Result Flash (FT detection) (2026-04-30)
- [x] T12 Match Report (xG + stats + ratings) (2026-05-01)
- [x] T13 Man of the Match (player ratings from API) (2026-05-01)
- [x] T-XG xG Delta (fires when |goals − xG| > 1.2) (2026-05-01)

Infrastructure:
- [x] Match Watcher: `*/5 * * * *` cron, active 3h before to 2h after kickoff (2026-05-01)
- [x] `/watcher` debug endpoint (2026-05-01)
- [x] `/admin/kv-remove` — remove test/stale articles from production KV by template_id or slug (2026-05-01)
- [x] Force endpoints: `/force-t09`, `/force-tref`, `/force-txgdelta` (2026-05-01)

Parked — data gap confirmed:
- ~~Shot map visual~~ — x/y coordinates absent at all levels; StatsBomb required; v2
- ~~Per-player shot breakdown~~ — shots.total null per player; not viable
- T08 Press Conference Quotes — RSS-only pipeline (no structured data source)

**Phase 3.5 — In-match event flash templates (Sprint A)** ✅ DONE (2026-05-13)

_All events available from single endpoint: `/fixtures/events?fixture={id}`. Watcher already polls this for goals. Extend to other event types._

- [x] T-RED Red Card Flash — `type:"Card", detail:"Red Card"` or `"Yellow Red Card"`
- [x] T-VAR VAR Decision Flash — `type:"Var"`
- [x] T-OG Own Goal Alert — `type:"Goal", detail:"Own Goal"` — handled by `generateGoalFlash` (already OG-aware); watcher routes by `ev.team.id !== 549`
- [x] T-PEN Missed Penalty — `type:"Goal", detail:"Missed Penalty"`
- [x] T-HT Halftime Report — `liveFixture.status === 'HT'`, `ht_published` flag in `match:BJK:live`
- [x] `fetchAllEvents` — single call to `/fixtures/events?fixture={id}` (no team/type filter), reused for all Sprint A checks
- [x] `seen_event_ids` persisted in `match:BJK:live` KV — prevents duplicate flashes across watcher ticks

**Phase 3.6 — Widgets (Sprint B)** ✅ DONE (2026-05-13)

_Zero backend changes. Pure frontend embeds via api-sports.io widget JS. Host a Turkish `tr.json` translation file._

Widgets available:
1. `fixture` — live match score + events + stats + lineups (best for match articles)
2. `standings` — league table (always-on in sidebar/home)
3. `h2h` — head-to-head history (embed on T02 articles)
4. `league` — schedule by round + standings (good for season overview page)
5. `team` — squad + stats (good for About Beşiktaş page)
6. `game` — expandable match card (lightweight inline embed)

Recommended widgets for Kartalix (priority order):
1. **`standings`** — sidebar/home page, always relevant, shows BJK table position in real time
2. **`fixture`** — inject into match-day article pages (T01, T05, T09, T10, T11, T12), shows live score
3. **`h2h`** — auto-inject on T02 H2H articles
4. **`game`** — lightweight match card in RSS feed / article previews

Turkish localization:
- Host `tr.json` at `https://app.kartalix.com/widgets/tr.json`
- Use `data-custom-lang="..."` attribute on all widgets
- Override keys for: match statuses, player positions, tab labels, time labels

Deliverables:
- [x] Standings widget on home page sidebar (permanent) (2026-05-01)
- [x] Fixtures (games) widget on home page sidebar (permanent) (2026-05-01)
- [x] Team stats widget on home page sidebar (permanent) (2026-05-01)
- [x] Fixture (game) widget auto-injected on match-day article pages (2026-05-01)
- [x] `/widgets/config` endpoint — serves API key with CORS restricted to app.kartalix.com (2026-05-01)
- [x] Widget key = same as API_FOOTBALL_KEY — confirmed by api-sports docs (2026-05-01)
- [x] `tr.json` Turkish translation file + `/widgets/tr.json` endpoint (2026-05-13)
- [x] H2H widget on T02 articles (2026-05-13)

**Sprint C — YouTube Embed (embed-only quick win)** ← AFTER SPRINT B

_Zero new infrastructure. YouTube Atom feed is free, public, no auth. Embed is an iframe — no content reproduction. 1-sentence intro written from video title only — no captions, no firewall._

Qualification — title keyword matching, no Claude:
- Include: özet, highlights, basın toplantısı, röportaj, açıklama, maç sonu
- Exclude: #shorts, standalone "Shorts"
- BJK official channel: all videos qualify (official source, all content relevant)

Three channels (placeholder IDs — Ali to confirm):
- Beşiktaş JK official (`UCxxxxx`)
- beIN SPORTS Türkiye (`UCxxxxx`)
- TRT Spor (`UCxxxxx`)

Deliverables:
- [x] YouTube channel config: 5 channels hardcoded in src/youtube.js (2026-05-02)
- [x] `fetchYouTubeChannel(channel, since)` in src/youtube.js — Atom XML parse (2026-05-02)
- [x] `qualifyYouTubeVideo(video)` — keyword rules + archive season filter (2026-05-02)
- [x] `generateVideoEmbed(video, site, env)` in publisher.js — Haiku intro + iframe (2026-05-02)
- [x] Wire into `0 */2 * * *` cron via processYouTubeVideos() in backgroundWork (2026-05-02)
- [x] Dedup via Supabase original_url (`https://youtube.com/watch?v={videoId}`) (2026-05-02)
- [x] Article render: `<p>` intro + iframe passes through buildBodyHtml HTML path (2026-05-02)
- [x] `/force-yt` debug endpoint — dry-run default, `?publish=1` to embed, `?channel_id=` to target (2026-05-02)

Out of scope for Sprint C (addressed in Slice 1 extension):
- Caption fetch
- Facts Firewall for video content
- Treatment Classifier
- Produce Agent treatment branching

**Full YouTube pipeline plan** (Steps 1–9, including captions + firewall + produce branching): logged in DECISIONS.md 2026-05-02 entry. Planned for after Slice 1 ships.

**Sprint D — Single-Source Rewrite** ✅ DONE (2026-05-02) · _renamed 2026-05-12_

_Note: this was originally called "synthesis" but renamed to "rewrite" (publish_mode: 'rewrite') to accurately reflect what it does — reads one source, rewrites it in Kartalix voice. True synthesis (multi-source, independent angle) is a future sprint below._

- [x] `synthesizeArticle()` in publisher.js — fetch one source via proxy, Claude rewrites in Kartalix voice (300–350 words)
- [x] Proxy wake-up: GET /health with 35s timeout before article fetch — handles Render free-tier cold start
- [x] Skip if source fetch fails — stays rss_summary, not published (2026-05-12)
- [x] `generateOriginalNews(sources, site, env)` — multi-source context bundling (titleSimilarity>0.25), publish_mode: 'original_synthesis'
- [x] `/force-synthesis` debug endpoint

**Sprint D2 — True Multi-Source Synthesis** ✅ DONE (2026-05-13)

_The real editorial product. Gather 3–5 independent sources covering the same story, write an original Kartalix take from an independent angle that cannot be attributed to any single source._

**Deliverables:**
- [x] `synthesizeStory(story, siteId, env)` in story-matcher.js — confirmed story + ≥3 contributions, fetches full text of top 5 sources via Readability proxy, Claude Sonnet writes from independent angle
- [x] Synthesis prompt instructs Claude to find an angle none of the sources used
- [x] Fires automatically when active/confirmed story gets 3rd+ contribution (async, non-blocking)
- [x] publish_mode: `synthesis` (distinct from `synthesis_generated` single-source)
- [x] Dedup: one synthesis per story per day (KV key: `synth:{story_id}:{date}`)
- [x] `/force-story-synthesis?story_id=` debug endpoint

**Sprint E — Source Expansion** ✅ DONE (2026-05-13)

_Goal: more volume, more reliable, broader coverage (national team, other sports, breaking transfers)._

- [x] Step 1: Fanatik/Milliyet/Sporx/Ajansspor — no working direct RSS found; covered by Google News BJK feed
- [x] Fotospor `sondakika` feed added (`keywordFilter: true`)
- [x] Google News Transfer search feed added (`keywordFilter: true`)
- [x] Step 2: Transfermarkt TR added (trust: journalist, proxy, keywordFilter: true)
- [x] Step 3: RSS cron moved to hourly `0 */1 * * *`
- [x] NTV Spor + TRT Haber: added `keywordFilter: true` (broad football feeds — prevents non-BJK articles reaching scoring)
- [x] **Feed quality hotfix** (2026-05-13): proxy path was missing date cutoff entirely; undated articles now use URL date extraction → treat-as-now fallback; Google News Transfer was `keywordFilter: false` (fixed); one-time flood cleared via Supabase URL dedup

❌ Step 4: Twitter blocked — X API Basic $100/month, over budget until revenue

**bjk.com.tr content access** ❌ BLOCKED — backlog item:
- bjk.com.tr is fully CAPTCHA-protected (Cloudflare). Blocks datacenter IPs, headless browsers (rss.app), Jina.ai, Google webcache, archive.today — everything.
- KEY FINDING (2026-05-10): @Besiktas tweets that contain 🔗 embed the direct bjk.com.tr URL in the RSS description HTML (e.g. `https://bjk.com.tr/tr/haber/94315`). URL extraction is now implemented in the fetcher — URLs are stored, content fetch fails silently.
- Next angle to try: ScrapingBee with `render_js=true` ($49/month), or Bright Data residential proxy ($500/month). Only worth it when ad revenue covers cost.
- Workaround: synthesize from tweet title only for official announcements. Twitter @Besiktas posts the same content as bjk.com.tr within minutes.

**Step 4 — Twitter** ❌ BLOCKED:
- X API free tier: search not included (CreditsDepleted 402 confirmed 2026-05-04)
- X API Basic: $100/month — over budget until ad revenue
- Nitter RSS: all public instances dead as of 2024 (X killed guest auth tokens)
- twitterwebviewer.com: browser-only, blocks automated access
- Bearer token stored as Worker secret, fetchTwitterSources() implemented but disabled
- Revisit when monthly ad revenue covers $100/month cost
- Accounts to wire when ready: @Besiktas, @superlig, @tvbjk (official/FACT),
  @Muratozen1903, @firatgunayer, @kartalanalizcom, @HaberKartali, @zaferalgoz,
  @sercan_dikme, @SportsDigitale, @kartalistahaber, @forzabesiktas, @sporx,
  @beINSPORTS_TR, @Ozyakup

---

**Sprint G — Sentiment Judge** ✅ DONE (already integrated, confirmed 2026-05-13)

`rival_pov` field with −25 NVS cap is integrated directly into the main `scoreArticles` Haiku call in processor.js — not a separate call. The single-prompt approach handles rival-POV detection as part of NVS scoring. No separate `sentimentJudge` function needed.

---

**Sprint F — Source Intelligence Layer** ← AFTER SPRINT E

_Goal: fix the dual-pipeline architecture. All sources through one truth system. Source rules without a code deploy._

_Architectural basis: external review confirmed the root bug — YouTube and RSS operate under different truth definitions. This sprint closes that gap. Five agreed points from the review are implemented here; three (entity extraction, Evidence Events rewrite, dynamic source trust) are deferred to Slice 8 as they require runtime data._

**F1 — Source independence gate** (~2h): ✅ DONE 2026-05-05
- [x] `story-matcher.js`: quality gate — `confirmed` requires at least one `broadcast` or `official` contribution
- [x] Press/aggregator-only chains cap at `developing`
- [x] `QUALITY_TIERS` flag persisted in `entities._quality_source` JSONB

**F2 — YouTube into unified pipeline** (~6h): ✅ DONE 2026-05-05
- [x] `videoToArticle()` normalizes video → article shape with `trust_tier`, `nvs_hint`, `treatment`
- [x] `processYouTubeVideos` calls `extractFactsForStory` + `matchOrCreateStory` per qualifying video (cap 3/run)
- [x] `writeArticles` has `treatment: 'embed'` branch (scaffolding for full pipeline unification)
- [x] `scoreArticles` nvs_hint bypass — no Claude call for preset-score sources
- [x] Archive windows fixed: `ARCHIVE_DAYS_BY_TYPE` keyed to story_type (transfer=15d, injury=7d, disciplinary=5d, contract=30d)

**F2.5 — Match story as pipeline container** (~6h): ✅ DONE 2026-05-05
_Decision (2026-05-05): match stories should live in the story system with time-based state transitions, not confidence-based. Templates contribute to match stories; press articles, videos, and transcripts about the same fixture all attach to the same story object. Single pipeline for all source types._
- [ ] `createMatchStory(fixture, siteId, env)` — proactive creation from fixture API at T-14 days; `story_type: 'match'`, `fixture_id`, `match_date`
- [ ] Match story state machine: `scheduled → pre_match (T-3d) → live (kickoff) → post_match (FT) → archived (T+2d)` — driven by time, not confidence
- [ ] `matchOrCreateStory` bypass for `story_type: 'match'` — contributions never call `nextState`; state advances via time-cron only
- [ ] Templates set `story_id` on output `content_items` (they know `fixture_id`, look up the match story)
- [ ] Press/video articles about a match get entity-matched to the open match story (BJK + opponent club overlap)
- [ ] New cron (daily): advance match story states based on `match_date`

**F3 — Lightweight source config** (~7h): ✅ DONE 2026-05-05
- [x] `source_configs` Supabase table — migration at `docs/migrations/0001_source_configs.sql`
- [x] `fetchSourceConfigs`, `configsToRSSFeeds`, `configsToYTChannels` in `fetcher.js`
- [x] Worker reads from DB at cron start; falls back to hardcoded if table empty
- [x] `POST /admin/sources/seed` — one-time idempotent seed from hardcoded arrays
- [x] `GET/PATCH/DELETE /admin/sources` — JSON CRUD API
- [x] `/admin/sources/ui` — table view with inline edit (active, trust_tier, treatment, nvs_hint, bjk_filter, notes)
- **Activation steps**: run SQL migration → POST /admin/sources/seed → verify at /admin/sources/ui

**Done when**: a YouTube video about a Beşiktaş match appears in story contributions. A press-only rumour wave cannot reach "confirmed." You can deactivate a source from `/admin/sources` without a deploy.

**Phase 3.6.1 — Widget API call caching (backlog)**

_Widget calls go direct from browser to `v3.football.api-sports.io` and count toward the 7,500/day quota. Each home page load burns ~3 calls (standings + fixtures + team). At scale this needs a server-side cache layer._

- [ ] Proxy needs a **fixed egress IP** (e.g. a cheap VPS) added to the API IP allowlist — Cloudflare Workers use rotating IPs so can't be added directly
- [ ] Worker calls the fixed-IP VPS proxy, VPS forwards to api-sports with the key, caches response, returns with CORS headers
- [ ] Widget `data-url-football` on config widget pointed at proxy URL
- [ ] KV TTLs: standings 1h, fixtures 5min, team stats 24h

**Constraint discovered**: api-sports domain allowlisting is browser-only (validates `Origin` header from actual browsers). Worker-side proxy calls without a real browser Origin get IP-blocked even when forwarding the header. Proxy requires a static IP on the allowlist.

**Why now is too early**: current traffic is low, quota is 7,500/day. Revisit when daily widget calls exceed ~1,000 (≈333 page loads/day).

**Phase 4 — Golden fixtures**
- [ ] Golden fixture: `match_lifecycle_signal_driven`
- [ ] Golden fixture: `juventus_false_positive` (siyah-beyaz case)
- [ ] Golden fixture: `transfer_state_progression`

**Done when**: each of the three types runs end-to-end with appropriate templates and triggers.

---

**Sprint H — Template Audit + Match Widget Guard**

_Two related problems discovered 2026-05-10: (1) no visibility into which templates fired for a given match and whether the output was quality; (2) match statistics widget is injecting into too many article types (transfer news, injury reports, etc.) where match stats are irrelevant or misleading._

**H1 — Template audit endpoint** (~3h):
- [ ] `GET /admin/template-audit?date=YYYY-MM-DD` — for a given match date, returns which templates fired (T01–T13, T-XG, T-REF, T-HT, T-RED, T-VAR, T-OG, T-PEN) and which did not
- [ ] For each fired template: show slug, word count, first 200 chars of body, nvs_score
- [ ] For each missing template: show why it likely didn't fire (no fixture found, flag already set, API returned null, etc.) — pull from fetch_logs error_message
- [ ] Admin UI tab "Match Audit" in report page — date picker, fires the endpoint, renders grid of 12 template slots (green = fired, red = missed, yellow = fired but short body <150 words)
- [ ] Word-count threshold alert: flag templates with body < 150 words as likely stubs

**H2 — Match widget placement guard** (~2h):
- [ ] Currently `renderArticleHTML` injects the fixture widget on any article where `slug` contains a date and `template_id` is set — too broad
- [ ] Restrict widget injection to match-day template IDs only: `['T01','T02','T03','T05','T07','T08b','T09','T10','T11','T12','T13','T-XG','T-HT','T-RED','T-VAR','T-OG','T-PEN','T-REF','T-VID-HLT','T-VID-GOL']`
- [ ] Synthesis-generated articles (`is_kartalix_content: true`, no `template_id`): never inject match widget
- [ ] Transfer/injury story articles from story system (`content_type: 'kartalix_generated'`, `story_type` not 'match'): never inject match widget
- [ ] Add `widget_eligible: bool` to KV article shape — set true only for match templates; `renderArticleHTML` reads this flag

**Done when**: template audit shows which slots fired and which missed for any match date; fixture widget no longer appears on transfer/institutional news articles.

---

## SLICE 3.9 — Voice Agent

**Why before operational control**: content quality affects every article published from this point. Legal (Slice 1) is the floor; voice is the ceiling. A fast, complete, legally-clean feed that sounds robotic loses to a human journalist. This is the gap that determines whether Kartalix feels like a real media organization or an aggregator with a skin.

**Estimated**: 1–2 weeks

**The problem**: Claude generations follow predictable patterns — certain phrase structures, over-formal register, no cultural texture. Turkish sports journalism has specific idioms, emotional vocabulary, sentence rhythm, and a fan-POV register that readers recognize immediately. Currently none of this is in the system.

**What already exists**: `editorial:references` KV store + weekly redistill cron. Seeding it with 15–20 high-quality Turkish sports articles covers ~60% of the gap immediately. The Voice Agent covers the remaining 40% through continuous learning.

**Phase 1 — Seed (1–2 hours, do immediately)**:
- [ ] Paste 15–20 well-written Turkish sports articles into `/admin/editorial` as reference articles — Fotomaç match reports, NTV Spor injury news, beIN Sports editorial pieces, Rabona Digital analysis
- [ ] Add explicit cultural vocabulary to editorial notes: BJK-specific idioms ("Kartallar", "Siyah-Beyazlılar", "Çarşı ruhu"), emotional register ("şampiyonluk hasreti", "gurur", "hayal kırıklığı"), headline patterns
- [ ] Add anti-patterns to editorial notes: forbid AI tells ("It is worth noting", "Certainly", "Furthermore", clinical passive constructions)
- [ ] Run `/admin/editorial/distill` to extract and activate rules immediately

**Phase 2 — Voice Agent cron** ✅ DONE (2026-05-13):
- [x] Weekly cron (Sunday 02:00) added — `runVoicePatternExtraction(env)` in worker cron handler
- [x] `extractStyleDNA` via Haiku: sentence rhythm, idiom usage, emotional vocabulary — NOT content
- [x] Phase 1 seed: 13 Turkish voice rules added to editorial:notes via `seedVoiceRules()` — activate with POST /admin/seed-voice
- [x] `editorial:voice_patterns` KV key: growing library (30-pattern cap, weighted by NVS score)
- [x] `getEditorialNotes` updated: injects 3 weighted-random style examples into all generation prompts
- [x] Style examples weighted by NVS score + rotated randomly per generation to prevent pattern lock-in
- [x] /admin/tools page: "Ses Tarzı Kütüphanesi" card with manual trigger + view buttons
- First run: wait until ≥3 synthesis articles in DB, then POST /admin/run-voice-patterns

**Phase 3 — Engagement feedback (wires into Slice 8)**:
- [ ] Track which articles get more shares/time-on-page
- [ ] High-engagement articles → their style examples get higher weight in `voice_patterns`
- [ ] Low-engagement patterns decay over time
- [ ] Result: system learns what resonates with BJK fans without manual curation

**Done when**: a senior Turkish sports journalist reads three Kartalix articles without immediately identifying them as AI-generated.

---

## SLICE 4 — Operational Control (HITL + Telegram)

**Why fourth**: gets you out of the loop on routine, in the loop on sensitive. Without this, you're either drowning in alerts or missing critical issues.

**Estimated**: 2 weeks

**Deliverables**:
- [ ] Single `@kartalix_bot` setup
- [ ] Three operational channels: `@kartalix-ops`, `@kartalix-alerts`, `@kartalix-decisions`
- [ ] Inline keyboard buttons everywhere
- [ ] HITL Gate C only (financial, disciplinary, injury severity, P5-only transfers)
- [ ] Auto-hold on 60min SLA timeout
- [ ] Quiet hours (23:00–07:00 Europe/Istanbul)
- [ ] Daily digest at 09:00
- [ ] Held stories surface in morning digest

**Done when**: you go a week without manually checking the system, and it just works.

---

## SLICE 4.2 — Security Hardening

**Why here**: Kartalix is a live public website generating original content and handling admin operations. As traffic grows so does attack surface — a single compromised admin cookie or unprotected endpoint is a full takeover. This slice must ship before Slice 5+ because distribution (push notifications, social posting) dramatically raises the blast radius of any breach.

**Estimated**: 1 week

**Threat model for Kartalix**:
- Admin panel takeover (cookie theft, brute-force, session fixation)
- Content injection (XSS in article body, admin input)
- API abuse (unbounded scraping of `/cache`, `/haber/*`, `/admin/*`)
- Supabase key exposure (service key in logs, error responses)
- Dependency compromise (npm packages, CDN scripts)
- Cloudflare misconfiguration (wrong route order, public admin routes)

**Phase 1 — Admin auth hardening** (~3h):
- [ ] Replace static `kx-editor=1` cookie with signed JWT or HMAC token — current cookie is trivially forgeable; anyone who knows the value has full admin access
- [ ] Add `HttpOnly; Secure; SameSite=Strict` flags to all auth cookies
- [ ] Admin login rate-limit: max 5 attempts per IP per 10 minutes (KV-based counter), lockout with exponential backoff
- [ ] Session expiry: admin cookies expire after 8 hours of inactivity
- [ ] `/admin/*` routes: reject any request without valid auth before reaching any handler (currently some routes skip auth checks)

**Phase 2 — HTTP security headers** (~2h):
- [ ] `Content-Security-Policy`: restrict script sources to `self` + known CDNs (Google Analytics, AdSense, api-sports widgets, YouTube iframes) — block inline scripts except nonces
- [ ] `X-Frame-Options: DENY` — prevent clickjacking on admin panel
- [ ] `X-Content-Type-Options: nosniff`
- [ ] `Referrer-Policy: strict-origin-when-cross-origin`
- [ ] `Permissions-Policy`: disable camera, microphone, geolocation
- [ ] Apply to all worker responses via a shared `secureHeaders()` helper

**Phase 3 — Rate limiting + API abuse prevention** (~3h):
- [ ] Public endpoints (`/cache`, `/haber/*`, `/rss`, `/sitemap.xml`): max 60 req/min per IP using Cloudflare rate limiting rules (WAF) — configure in Cloudflare dashboard, zero code change
- [ ] Admin endpoints (`/admin/*`): max 20 req/min per IP
- [ ] `/admin/notes`, `/admin/redistill`, `/force-*` endpoints: POST-only + auth check (some currently accept GET)
- [ ] Error responses: never return raw error messages or stack traces to clients — log internally, return generic `{"error":"internal"}` with request ID
- [ ] Supabase service key: audit all `console.log` and error paths to ensure key never appears in Worker logs or responses

**Phase 4 — Content security** (~2h):
- [ ] Article body sanitization: `sanitizeBodyHtml()` already exists — verify it strips `<script>`, `onclick`, `javascript:` hrefs, and `<iframe src>` not from whitelist (YouTube, api-sports)
- [ ] Admin input (notes, reference articles, source configs): strip any HTML before storing to KV/Supabase — treat all admin input as untrusted text
- [ ] Subresource Integrity (SRI): add `integrity` hash to any third-party `<script>` tags loaded from CDN (Google Analytics, AdSense loader)

**Phase 5 — Secrets audit** (~1h):
- [ ] Rotate `API_FOOTBALL_KEY` (exposed in session 4 logs) — `npx wrangler secret put API_FOOTBALL_KEY`
- [ ] Audit `wrangler.toml` vars section: move any sensitive values to secrets (currently `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY` should all be secrets, not vars)
- [ ] Add `.dev.vars` to `.gitignore` if not already present
- [ ] Review Cloudflare Worker logs: purge any logs containing key values

**Golden fixtures**:
- [ ] `admin_auth_forgery_blocked` — crafted fake cookie returns 401 on all admin routes
- [ ] `rate_limit_triggers` — 61st request in 1 minute returns 429
- [ ] `xss_stripped` — article body with `<script>alert(1)</script>` stored and rendered as escaped text, not executed

**Done when**: OWASP Top 10 items A01 (Broken Access Control), A02 (Cryptographic Failures), A03 (Injection), A05 (Security Misconfiguration), A07 (Identification/Auth Failures) are all addressed. A penetration tester reviewing the admin panel finds no trivial entry points.

---

## SLICE 4.5 — Squad Intelligence

**Why before Slice 6 (multi-team)**: `BJK_KEYWORDS` is hardcoded in utils.js. Adding Team 2 means manually updating a JS file and redeploying. Squad Intelligence makes keywords a data concern, not a code concern.

**Estimated**: 1–2 weeks

**Deliverables**:
- [ ] `squad_members` Supabase table: `id, site_id, name, name_variations (JSONB), role (player/coach/staff/president), status (current/departed_1y/departed_2y/target/rumored), position, nationality, shirt_number, joined_at, departed_at`
- [ ] Seed BJK squad from current `BJK_KEYWORDS` hardcoded list
- [ ] `buildKeywordConfig(siteId, env)` — reads `squad_members`, auto-generates keyword list with name variations and transliterations (Haiku call, weekly)
- [ ] Worker reads `keyword_config` from Supabase at cron start instead of `BJK_KEYWORDS` constant — falls back to hardcoded if table empty
- [ ] Transfer window mode: `status = target/rumored` players added to keyword list automatically during May–Aug and Jan–Feb
- [ ] `departed_2y` players dropped from active keywords automatically
- [ ] Supabase trigger or weekly cron: when player row changes status, rebuild keyword_config for that site
- [ ] Admin UI: squad list at `/admin/squad` — add/edit/remove players, update status, "Regenerate keywords" button
- [ ] Golden fixture: `squad_keywords_auto_rebuild`

**Done when**: adding a new player to the squad table causes their name to appear in the keyword filter on the next cron run, with no code change.

---

## SLICE 5 — Visual Asset Agent (IT2 + IT6)

**Why fifth**: every published article needs a defensible image. Without this, the platform looks unfinished. With it, the brand starts to feel real.

**Estimated**: 2–3 weeks

**Deliverables**:
- [ ] Visual Asset Agent
- [ ] IT6 templates: match result card, transfer status card, generic story card
- [ ] IT2 caching for BJK official media
- [ ] IT2 social embeds (iframe pattern)
- [ ] IT3 explicit block at firewall
- [ ] IT5 limited use (abstract only, no real people)
- [ ] `images` and `image_templates` tables
- [ ] Golden fixture: `visual_tier_selection`
- [ ] Golden fixture: `it3_blocked`

**Done when**: 100 articles published, 100 images attached, 0 copyright concerns.

**Deferred to v2**: IT1 (AA subscription)

---

## SLICE 5.5 — Distribute Agent

**Why before authors**: distribution architecture needs to exist before content scales. Currently all published content reaches only one channel (KV → web). Growth requires multi-channel without rewriting the publish path.

**Estimated**: 1–2 weeks

**Architecture**: all published `content_items` pass through a `distribute(article, site, env)` function that fans out to enabled channels based on NVS tier. Channels are config-driven per site — no hardcoding.

**Channel rules by NVS**:
```
NVS ≥ 80 → web + RSS + social post + push notification
NVS ≥ 60 → web + RSS + social post
NVS ≥ 40 → web + RSS
NVS < 40  → web only
```

**Deliverables**:
- [ ] `distribute(article, site, env)` function in publisher.js — replaces direct KV write, fans out to channels
- [ ] **Web + RSS**: already done, wire through distribute function
- [ ] **Push notifications** (NVS ≥ 80): Web Push API, zero cost, service worker on fan site — breaking news, goal flashes, confirmed transfers
- [ ] `push_subscriptions` Supabase table: endpoint, keys, site_id, created_at
- [ ] `/subscribe-push` endpoint on fan site for service worker registration
- [ ] `distribution_log` Supabase table: article_id, channel, status, sent_at — full audit trail
- [ ] Channel toggles per site in Supabase `sites` table: `distribution_config JSONB`
- [ ] **Twitter/X**: stub only — wire when API revenue covers $100/month. Config: list of accounts from DECISIONS.md
- [ ] **Newsletter**: stub — weekly digest, wire in Slice 9
- [ ] Golden fixture: `distribute_nvs_80_all_channels`

**Blocked**: Twitter ($100/mo X API Basic) — stub exists, activate when ad revenue covers it

**Done when**: a goal flash publishes to web AND sends a push notification to subscribed fans within 30 seconds, with no manual action.

---

## SLICE 6 — Editorial QA + Author Flow

**Why sixth**: enables guest authors with two-stage approval. Lower priority than legal/visual core, but unlocks editorial scaling.

**Estimated**: 2–3 weeks

**Deliverables**:
- [ ] Editorial QA Agent
- [ ] `authors` and `guest_submissions` tables
- [ ] `@kartalix-editorial-author` Telegram channel
- [ ] Two-stage approval: QA → author review → author approve → publisher (you) review
- [ ] "Request changes" loop
- [ ] Author identity via invite-token
- [ ] Plagiarism overlap detection (P4 source comparison)
- [ ] Sensitive content flagging
- [ ] Image rights check on guest submissions

**Done when**: you publish your first guest article via Telegram approval.

---

## SLICE 3.7 — Cost Guard (lightweight, do before Sprint A)

**Why now**: before adding more Claude calls (Sprint A event flash templates, widgets), we need a hard safety net. A runaway cron or a new template looping unexpectedly should not silently burn $50. This is the minimum viable CFO — no Telegram, no per-agent attribution, just a spend accumulator and a kill switch.

**Estimated**: 2–3 hours

**How it works**:
- Every `callClaude` call already returns `usage.input_tokens` + `usage.output_tokens` + model name
- `addUsagePhase` already accumulates these into `stats` per cron run
- `logFetch` already writes them to `fetch_logs` in Supabase
- Missing piece: a **running monthly total in KV** that every Claude call checks against a cap

**Deliverables**:
- [ ] KV key `cost:YYYY-MM` — running USD total for current month, updated after every cron run
- [ ] Hard cap check at start of `runAllSites` and `matchWatcher` — if monthly spend > `MONTHLY_CLAUDE_CAP` (default $8), skip all Claude calls and log `COST GUARD: monthly cap reached`
- [ ] `addCost(env, usd)` helper in utils.js — atomic KV increment (read → add → write)
- [ ] `/admin/cost` endpoint — show current month spend, daily breakdown from fetch_logs, and cap status
- [ ] Cap configurable via Workers env var `MONTHLY_CLAUDE_CAP` (set in wrangler.toml vars, override via Cloudflare dashboard)
- [ ] Warning log at 80% of cap: `COST GUARD: 80% of monthly cap used ($X of $Y)`

**Done when**: you can set a $10 Claude budget and trust the system will stop before exceeding it.

**Full CFO** (per-agent attribution, Telegram alerts, weekly reports) stays in Slice 7.

---

## SLICE 7 — Governance Layer (CLO + CFO)

**Why seventh**: top-down oversight. Less urgent than core pipeline, but critical for sustainable operation.

**Estimated**: 2 weeks

**Deliverables**:
- [ ] CLO synchronous mode: FSEK rule engine, image-rights checker, quote-length checker, IT3-leak detector
- [ ] CFO full mode: per-agent and per-source cost attribution, Telegram weekly reports
- [ ] CFO prerequisite: thread cost tracking through synthesis, template generators, YT pipeline — currently only fetch+score phase is tracked via `addCost`; Sonnet synthesis/template calls (~90% of spend) are invisible to the admin report (discovered 2026-05-09, gap ~9x vs Anthropic console)
- [ ] Per-`site_id` legal profiles
- [ ] Weekly cost + legal report to `@kartalix-ops`
- [ ] Golden fixture: `clo_blocks_quote_overflow`
- [ ] Golden fixture: `cfo_alerts_on_spike`

**Done when**: you have a weekly view of legal posture and unit economics.

**Deferred to v2**: async LLM audit modes for both

---

## SLICE 8 — Self-Learning Loops

**Why last**: the system gets sharper without manual tuning. Lowest urgency because the system can run without it; highest leverage long-term.

**Estimated**: 3 weeks

**Deliverables**:
- [ ] `agent_signals`, `agent_learnings` tables
- [ ] `engagement_events` table: clicks, time-on-page, shares per article
- [ ] Pageview/click tracking per article (lightweight, no third-party)
- [ ] Engage → Qualify (relevance threshold tuning)
- [ ] Engage → Produce (template priority weights)
- [ ] Distribute → Intake (source trust adjustment)
- [ ] Trust score modes (auto / locked / hybrid with bands)
- [ ] Human-override learning signals (highest weight)
- [ ] Type-aware learning (per story type baselines)
- [ ] **Source Performance table**: persistent `source_performance` — articles_contributed, articles_published, avg_nvs, avg_engagement, false_positive_rate, updated weekly; auto-downgrades trust tier on persistently bad sources
- [ ] Voice Agent Phase 3: high-engagement articles reinforce their style patterns in `voice_patterns`; low-engagement patterns decay
- [ ] Weekly Learn Agent cron: pattern extraction from engagement signals, writes to `agent_learnings`
- [ ] Journalist accuracy tracker: transfer rumors tagged with journalist source; confirmed/denied 90 days later; accuracy % per journalist feeds into trust score

**Done when**: a known-bad source's trust score drops over time without you touching it. A high-engagement writing style gets reinforced without you touching the prompts.

---

## Sprint H — News Pool & Publish Queue

**Why this matters**: The current pipeline has a hard synthesis cap (6/run) and a single 100-slot KV list. During high-volume news days (post-derby, transfer window), high-NVS articles get skipped and fall off the radar. The site never has more than ~20 fresh articles visible at once. This sprint replaces the cap with a persistent synthesis queue and grows the visible pool to 50–60 articles.

**Status**: `not-started`
**Estimated**: 2–3 sessions

---

### H1 — Persistent Synthesis Queue (~3h)

**Problem**: `results.filter(r => r.publish_mode === 'rewrite').length < 6` is a per-run in-memory cap. Articles that miss the cap aren't saved to Supabase dedup, so they _may_ get retried next run — but only if still in the RSS feed. Articles from smaller feeds that expire within 2h are silently lost.

**Solution**: `synthesis:queue` KV key — a JSON array of `{ url, title, nvs, source, published_at, rss_summary }` entries. Each hourly run:
1. Any NVS≥60 article that would get `rss_summary` mode is appended to the queue (deduped by URL)
2. Worker processes the top N from the queue (sorted by NVS desc) — N sized to fit worker CPU budget (~8–10)
3. Successfully synthesized articles are removed from the queue; failures are retried next run
4. Queue entries expire after 48h automatically (KV TTL)

Cap removed from `writeArticles`. Queue bounded at 200 entries max.

---

### H2 — Pool Size: 20 → 60 articles (~2h)

**Problem**: `mergeAndDedupe([...newKVItems, ...latestKV], 100)` caps the KV pool at 100 items but the homepage only shows ~20. Articles 21–100 are never seen. The pool doesn't distinguish "featured" from "available."

**Solution**:
- Grow `articles:BJK` pool to 200 slots (KV stores JSON; 200 short articles ~= 150KB, well within KV 25MB limit)
- Introduce a `rank_score = nvs × freshness_decay` where `freshness_decay = e^(-age_hours / 36)` — NVS 75 article is still top-ranked at 12h; by 48h it's dropped to 30% weight
- Homepage renders top 20 by rank_score; "Daha fazla" button loads next 20 from the same pool
- Admin can pin articles (`is_pinned: true`) which forces `rank_score = 999` regardless of age

---

### H3 — Manual Publish: Beklemede → Yayında (~1h) ✅ PARTIAL (2026-05-13)

**Problem**: Admin editors see pending articles but have no one-click path to promote them. "Kaydet" button was wired to content fields only — status dropdown was disconnected.

**Done (2026-05-13)**:
- `saveArticle()` now reads `eStatus` dropdown and sends `status` field to `/admin/content-save`
- Backend PATCH includes `status` field
- KV promoted immediately on publish: pending article fetched from Supabase and prepended to `articles:BJK` feed

**Remaining**:
- [ ] Quick-publish button directly in the admin news list (one click, no edit form needed) — POST `/admin/content-publish?slug=X`
- [ ] Bulk promote: select N pending articles → publish all

---

### H4 — Topic / Category Pages (~2h)

**Problem**: All articles live at `/` in a single chronological feed. A user interested only in transfer news has no way to filter. SEO suffers — no structured topic URLs.

**Solution**:
- `/konu/transfer`, `/konu/sakat`, `/konu/mac-sonuclari`, `/konu/kurumsal` — worker serves filtered KV pool per category
- Navigation tabs on homepage (Tümü | Transfer | Maç | Sakat | Diğer)
- No new DB schema needed — `category` field already on every article; filtering is client-side from the KV pool
- `sitemap.xml` extended to include category pages

---

### H5 — Multi-Source Synthesis Upgrade (~2h)

**Problem**: Standard `synthesizeArticle` reads 1 source. For major news (derby reaction, big transfer), multiple sources are writing on the same story at the same time — averaging their perspectives produces a richer article than any single source.

**Solution**:
- After story matching runs, if a story has ≥3 confirmed contributions within 6h of each other: trigger `synthesizeStory` (already implemented in Sprint D2, but only callable via `/force-story-synthesis`)
- Wire `synthesizeStory` into backgroundWork: after story matching loop, collect stories that became `developing` or `confirmed` this run, fire synthesis for each (cap 2/run)
- Result: a Kartalix original that synthesizes 3–5 independent sources — demonstrably non-derivative, better editorial quality

---

**Done when**: homepage consistently shows 40+ articles; post-derby day produces ≥15 synthesis articles without manual intervention; pending articles can be one-click published from admin list.

---

## v2 BACKLOG — DO NOT TOUCH UNTIL v1 SHIPS

**This is the "no" list.** When new ideas arrive during v1, they go here, not into v1 scope.

**Content & Quality**
- Full 3-judgment Qualify Agent (separate Relevance + Value + Sentiment as parallel Haiku calls) — current single-prompt NVS is working; tripling call count for marginal gain. Revisit when false-positive rate exceeds 10%
- Fan comments as learning signal — analyze comment themes weekly (Haiku), extract topics fans care about, player names mentioned → keyword updates. Too early without traffic
- Opinion/analysis pieces — weekly Kartalix Analiz: squad gaps, transfer targets, tactical piece (Sprint 10 per legacy roadmap)
- Story evolution UI: rumor → reported → confirmed → signed visual timeline

**Distribution & Reach**
- Twitter/X auto-post — wire when monthly ad revenue covers $100/month X API Basic. Account list in DECISIONS.md
- Email newsletter weekly digest — Slice 9
- Kartalix Pro subscription tier (Transfer Radar Pro, €3.99/mo) — Slice 9
- Push notification polish: quiet hours, per-topic subscriptions, opt-out management
- WhatsApp channel — zero cost, high Turkish engagement, post NVS ≥ 80 articles

**Engagement Features**
- Live match blog (T10) real-time updates — currently fires per event but no long-lived updating article; needs WebSocket or SSE on fan site
- Polls on match days — auto-generated from match context, Engage Agent v2
- Transfer Radar board — confidence scoring (source trust × mention frequency × specificity), visual rumor tracker
- Fan Pulse dashboard — daily sentiment from article mix (injury rate, transfer activity, NVS avg)
- Related articles widget — by category + player name, client-side from KV

**Multi-team & Scale**
- Pitchos onboarding for Team 2 — Galatasaray or Fenerbahçe (larger audience), all config in Supabase sites table
- Cross-team learning propagation — global learnings (team_id=NULL) apply to all teams on onboard
- Pitchos onboarding admin UI — add team without SQL
- Web admin dashboard — replace current worker-served admin with proper React app

**Legal & Infrastructure**
- IT1 licensed photography (AP/AA subscription integration)
- Async LLM audit modes for CLO/CFO
- IT5 AI-generated images — abstract only, no real people
- QIA (Quality Intelligence Agent) full-site scanner
- Fixed egress IP proxy for api-sports widget caching (see Phase 3.6.1)
- WebSub real-time push for breaking news — RSS push instead of pull

**International**
- Multi-language content (English, Italian, German)
- First non-Turkish team (Bundesliga or Premier League)
- Country-specific legal templates
- Journalist partnership program (paid verified accounts)

**Revenue**
- AdSense integration (apply after Sprint 4, 6-week approval clock)
- White-label platform offering to club media teams
- Subscription bundle — all teams €9.99/month

---

## SLICES SUMMARY TABLE

| # | Slice | Estimate | Status |
|---|-------|----------|--------|
| 0 | Build Scaffold + PM | 1–2 wks | in-progress (Telegram/PM agent pending) |
| 1 | Facts Firewall | 2–4 wks | done (2026-05-09) — two minor golden fixtures deferred |
| 1.5 | Truth Layer (Grounding + Verifier Gate) | 2–3 h Phase 1 done; Phase 3 ~8h | ✅ all phases done (2026-05-09) — 3 DB migrations pending run in Supabase |
| 2 | Story-Centric Foundation | 2–3 wks | in-progress (story matcher live; DB tables pending) |
| 3 | Story Types Narrow Set | 3–4 wks | in-progress (all templates done; source expansion Sprint E current) |
| 3.7 | Cost Guard | 2–3 h | done |
| 3.9 | Voice Agent | 1–2 wks | not-started — Phase 1 (seed editorial references) can start immediately |
| 4 | Operational Control (HITL + Telegram) | 2 wks | not-started |
| 4.5 | Squad Intelligence | 1–2 wks | not-started |
| 5 | Visual Asset Agent | 2–3 wks | not-started |
| 5.5 | Distribute Agent | 1–2 wks | not-started |
| 6 | Editorial QA + Authors | 2–3 wks | not-started |
| 7 | Governance Layer (CLO + CFO) | 2 wks | not-started |
| 8 | Self-Learning Loops | 3 wks | not-started |

**Agents live or planned**:
| Agent | Slice | Status |
|---|---|---|
| Fetch Agent (intake + qualify + produce + distribute) | live | worker-fetch-agent.js |
| Proxy Agent (bypass 403 feeds) | live | pitchos-proxy |
| PM Agent (Telegram Monday/Friday) | 0 | scaffold built, not wired |
| Sentiment Judge (rival-pov detection) | 3 Sprint G | not-started |
| Voice Agent (style learning) | 3.9 | not-started |
| CLO (legal compliance) | 7 | not-started |
| CFO (cost attribution) | 7 | not-started |
| Learn Agent (self-improving loops) | 8 | not-started |

**What's live and working (as of 2026-05-04)**:
- Full template set: T01–T13, T-XG, T-REF, T-HT, T-RED, T-VAR, T-OG, T-PEN (18 templates)
- YouTube embed pipeline: 5 channels, match-specific templates, BJK relevance filter active
- Non-BJK video filter: broadcast channels (A Spor, TRT Spor) require Beşiktaş in title
- Rabona Digital digest: Fırat Günayer daily analysis via Supadata transcript → original article
- Transcript pipeline: Supadata API (free tier, 100 req/month) → pitchos-proxy → worker
- transcript_qualify restricted to Rabona Digital only (fits free tier)
- Original news synthesis: multi-source, no attribution, national team + multi-sport aware
- Editorial feedback system: comments → distill → rules → injected into all generation
- API-Football Pro: all match data (fixtures, lineups, injuries, events, stats, standings)
- Story matching: facts extraction + story clustering (Supabase)
- Cost guard: monthly cap KV accumulator

**Total v1 estimate**: 19–26 weeks of focused work.
**Realistic calendar with COO duties**: 6–9 months.

---

*Last updated: 2026-05-09 (session 13 — Slice 1.5 Phase 3 Verifier Gate done; multi-tenant league context + getLeagueContext + league_european_spots table; 3 DB migrations written, pending Supabase run)*
