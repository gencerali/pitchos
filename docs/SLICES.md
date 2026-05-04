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
- [ ] Fact schema for Transfer story type (start narrow)
- [ ] Firewall extraction logic
- [ ] Source text destruction post-extraction (with audit log)
- [ ] `facts` and `fact_lineage` tables migration
- [ ] Wire firewall between Readability output and Produce Agent
- [ ] Golden fixture: `rashica_transfer_5_contribs`
- [ ] Golden fixture: `fotomac_403`
- [ ] Golden fixture: `firewall_destroys_source_text` (legal core test)
- [ ] Lawyer consultation outcome reviewed and architecture adjusted if needed ✅ done 2026-04-28
- [ ] Hot News delay (15 min for P4) — implemented 2026-04-28, golden fixture still needed
- [ ] Source attribution mandatory on all derived articles — implemented 2026-04-28
- [ ] Remove Cloudflare Access gate from `/haber/*` (open article pages to public when firewall ships)

**Done when**: a P4 article goes through the pipeline and the published Kartalix article is provably non-derivative. You can show this to a lawyer. Article pages are publicly accessible.

**Blockers**:
- ~~Turkish IP lawyer consultation pending~~ ✅ resolved 2026-04-28

---

## SLICE 2 — Story-Centric Foundation

**Why second**: replaces article-centric thinking with story-centric data model. Slices 3+ depend on this.

**Estimated**: 2–3 weeks

**Deliverables**:
- [ ] `stories`, `story_contributions`, `story_state_transitions` tables
- [ ] Story matching algorithm (entity overlap + event type + temporal + semantic)
- [ ] Story state machine (emerging → developing → confirmed → active → resolved → archived → debunked)
- [ ] Generation triggers tied to state transitions
- [ ] Sub-story lineage (parent_story_id, ancestry_path)
- [ ] Confidence scoring math
- [ ] Golden fixture: `story_matching_entity_overlap`
- [ ] Golden fixture: `story_state_transitions`
- [ ] Golden fixture: `confidence_scoring`

**Done when**: 5 contributions about Rashica produce one Kartalix article that evolves, not five articles.

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

- [ ] **Provider decision**: stay on API-Football Pro (close PR #1) OR proceed with SoccerData verification
- [ ] `API_FOOTBALL_KEY` wired as Workers secret (`npx wrangler secret put API_FOOTBALL_KEY`) — rotate key first (exposed in session 4)
- [ ] Add Open-Meteo call to T01 Match Preview for weather context
- [ ] Venue coords map: add lat/long for BJK home ground + common away grounds

**Phase 2 — Story type classification + match lifecycle**
- [x] Type classification in Qualify Agent: `classifyStoryType()` in firewall.js — Haiku call, 80 tokens (2026-05-01)
- [x] Per-type fact schemas: Transfer, Injury, Disciplinary, Contract, Generic (2026-05-01)
- [x] `extractFactsForStory()` — two-step (classify → schema-appropriate extract) (2026-05-01)
- [x] match_result + squad filtered from story system via `SKIP_STORY_TYPES` (2026-05-01)
- [x] Story-matcher judge includes pre-classified type hint (2026-05-01)
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

**Phase 3.5 — In-match event flash templates (Sprint A)** ← NEXT SPRINT

_All events available from single endpoint: `/fixtures/events?fixture={id}`. Watcher already polls this for goals. Extend to other event types._

- [ ] T-RED Red Card Flash — `type:"Card", detail:"Red Card"` or `"Second Yellow Card"` — high fan engagement, tactical context ("10 kişi kaldı")
- [ ] T-VAR VAR Decision Flash — `type:"Var"` — highest controversy events, fans demand instant reaction
- [ ] T-OG Own Goal Alert — `type:"Goal", detail:"Own Goal"` — distinct from goal flash (opponent own goal = good news)
- [ ] T-PEN Missed Penalty — `type:"Chance Missed"` on a penalty minute — emotional flash
- [ ] T-HT Halftime Report — status `"HT"` detected, mini first-half summary (stats from `/fixtures/statistics`)

Implementation notes:
- Extend `match:BJK:live` KV state to include `last_event_hash` — fingerprint of all events seen so far
- On each watcher tick, compare event list hash vs stored; if changed, classify new events and fire appropriate template
- All event types polled with ONE additional API call to `/fixtures/events` per tick (already done for goals via `fetchGoalEvents`)

**Phase 3.6 — Widgets (Sprint B)** ← AFTER SPRINT A

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
- [ ] `tr.json` Turkish translation file + `/widgets/tr.json` endpoint
- [ ] H2H widget on T02 articles

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

**Sprint D — Original News Synthesis** ✅ DONE (2026-05-02)

_Architectural decision: RSS/P4 sources are inputs only. All published content is original Claude-generated Kartalix articles. No referenced news._

- [x] Raw RSS/P4 articles removed from KV frontend feed — only templates + original synthesis visible
- [x] `generateOriginalNews(sources, site, env)` in publisher.js — multi-source, 300–400 word, no attribution
- [x] Synthesis loop in backgroundWork: NVS≥55, cap 5/run, skip match_result/squad (template-handled)
- [x] Dedup key `synth:{hash}:{date}` in KV — same story not re-synthesized same day
- [x] Multi-source: related articles (titleSimilarity>0.25) bundled for richer Claude context
- [x] National team + multi-sport scoring updated: World Cup, Olympics, BJK handball/basketball/volleyball all scored and synthesised
- [x] Synthesis prompt: context-aware national team (spotlight BJK players) + other-sport framing
- [x] `/force-synthesis` debug endpoint — dry-run + `?publish=1`, shows total_recent/already_covered/new_candidates

**Sprint E — Source Expansion** ← CURRENT SPRINT

_Goal: more volume, more reliable, broader coverage (national team, other sports, breaking transfers)._

**Step 1 — Disabled RSS feeds** (~1h):
- [ ] Find working URLs for Fanatik, Milliyet Spor, Sporx, Ajansspor (currently commented out)
- [ ] Add to RSS_FEEDS in src/fetcher.js, test with `/run`
- [ ] Expected gain: +30–50 articles/day

**Step 2 — Transfermarkt RSS** (~30min):
- [ ] Add `https://www.transfermarkt.com.tr/besiktas-jk/ticker/verein/114/format/atom` to RSS_FEEDS
- [ ] Trust tier: `journalist`, P4: false (Transfermarkt is authoritative for transfers)
- [ ] Expected gain: high-signal transfer rumours 24-48h before Turkish press

**Step 3 — Cron separation** (~2h):
- [ ] RSS intake: move to `0 */1 * * *` (hourly) — RSS feeds don't update faster than this
- [ ] Live match watcher: stays on `*/5 * * * *` but skips RSS fetch+score entirely
- [ ] Expected gain: 6× reduction in Claude scoring cost (288 → 48 scoring calls/day)

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

**Sprint F — Source Intelligence Layer** ← AFTER SPRINT E

_Goal: fix the dual-pipeline architecture. All sources through one truth system. Source rules without a code deploy._

_Architectural basis: external review confirmed the root bug — YouTube and RSS operate under different truth definitions. This sprint closes that gap. Five agreed points from the review are implemented here; three (entity extraction, Evidence Events rewrite, dynamic source trust) are deferred to Slice 8 as they require runtime data._

**F1 — Source independence gate** (~2h):
- [ ] `story-matcher.js`: before allowing `confirmed` state transition, require at least one `broadcast` or `official` tier contribution
- [ ] Press/aggregator-only contributions cap story state at `developing` regardless of confidence score
- [ ] Fixes: "5 tabloids reprinting one leak = confirmed story" — cite-chain inflation
- [ ] Zero Claude calls, pure logic

**F2 — YouTube into unified pipeline** (~6h):
- [ ] Normalize qualifying YouTube videos to article shape with `nvs_hint` + `treatment` fields
- [ ] Route through `storyMatcher` before writing — BJK özet video now contributes to active match story
- [ ] `writeArticles` branches on `treatment`: `embed` → `generateVideoEmbed`, `synthesize` → `generateRabonaDigest`
- [ ] `nvs_hint` respected in `scoreArticles` — skip Claude scoring when hint is set (zero cost for embeds)
- [ ] nvs_hint values: BJK official = 88, broadcast özet = 78, Rabona = 74
- [ ] Fixes: YouTube floating disconnected from story system; no truth evaluation in embed path

**F3 — Lightweight source config** (~7h):
- [ ] New Supabase table: `source_configs` (id, name, url, source_type, trust_tier, treatment, bjk_filter, keywords[], exclude_keywords[], is_active, notes)
- [ ] `treatment` values: `embed` | `synthesize` | `signal_only` (score + story match, no article published)
- [ ] Worker reads `source_configs` from Supabase at cron start — replaces hardcoded RSS_FEEDS + YOUTUBE_CHANNELS arrays
- [ ] `/admin/sources` endpoint: table view + per-source edit (active toggle, treatment, trust_tier, notes)
- [ ] Gives operational control without code deploys
- [ ] Note: full web admin dashboard stays in v2 backlog. This is the minimal viable ops layer.

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
>>>>>>> Stashed changes
- [ ] Golden fixture: `match_lifecycle_signal_driven`
- [ ] Golden fixture: `juventus_false_positive` (siyah-beyaz case)
- [ ] Golden fixture: `transfer_state_progression`

**Done when**: each of the three types runs end-to-end with appropriate templates and triggers.

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
- [ ] Engage → Qualify (relevance threshold tuning)
- [ ] Engage → Produce (template priority weights)
- [ ] Distribute → Intake (source trust adjustment)
- [ ] Trust score modes (auto / locked / hybrid with bands)
- [ ] Human-override learning signals (highest weight)
- [ ] Type-aware learning (per story type baselines)

**Done when**: a known-bad source's trust score drops over time without you touching it.

---

## v2 BACKLOG — DO NOT TOUCH UNTIL v1 SHIPS

**This is the "no" list.** When new ideas arrive during v1, they go here, not into v1 scope.

- IT1 licensed photography (AA subscription integration)
- Async LLM audit modes for CLO/CFO
- Source addition admin UI (currently Supabase dashboard manual)
- Story type expansion: Disciplinary, Financial, Management, Commentary, Editorial
- Cultural/fan story type
- Infrastructure/stadium/academy/women's team coverage
- AI-generated images (IT5) per-story integration
- QIA (Quality Intelligence Agent) full-site scanner
- Pitchos onboarding for second club (Juventus)
- Pitchos onboarding admin UI
- Web-based author submission form
- Web admin dashboard
- Multi-language content (English, Italian)

---

## SLICES SUMMARY TABLE

| # | Slice | Estimate | Status |
|---|-------|----------|--------|
| 0 | Build Scaffold + PM | 1–2 wks | in-progress (Telegram/PM agent pending) |
| 1 | Facts Firewall | 2–4 wks | in-progress (firewall + story matching live; golden fixtures pending) |
| 2 | Story-Centric Foundation | 2–3 wks | in-progress (story matcher live; DB tables pending) |
| 3 | Story Types Narrow Set | 3–4 wks | in-progress (all templates done; source expansion Sprint E current) |
| 4 | Operational Control | 2 wks | not-started |
| 5 | Visual Asset Agent | 2–3 wks | not-started |
| 6 | Editorial QA + Authors | 2–3 wks | not-started |
| 7 | Governance Layer | 2 wks | not-started |
| 8 | Self-Learning Loops | 3 wks | not-started |

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

*Last updated: 2026-05-04 (session 10 — Sprint F planned; architectural dual-pipeline gap identified and scoped)*
