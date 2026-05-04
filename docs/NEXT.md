# NEXT.md

**The single most underused founder tool. Read this every time you sit down.**

Update this at the END of every work session. Not the start — the end. Future-you walking in cold should know exactly what to do next without thinking.

---

## NEXT ACTION

**NEXT**: Sprint F — F1 source independence gate (~2h). Start with `story-matcher.js`: add trust tier check to prevent press-only cite chains reaching "confirmed" state.

**Sprint E — Source Expansion** ✅ DONE (2026-05-04):
1. ✅ Scorer updated: national team + multi-sport BJK scoring bands added
2. ✅ Synthesis prompt: national team / other-sport context injection
3. ✅ Step 1: Fanatik/Milliyet/Sporx/Ajansspor covered by existing Google News BJK feed
4. ✅ Step 2: Transfermarkt already live in feed list
5. ✅ Step 3: RSS cron moved to hourly (was 2-hourly)
6. ❌ Step 4: Twitter blocked — X API free tier has no search; Nitter dead; $100/month Basic needed. Parked until revenue.

**Sprint F — Source Intelligence Layer** (planned, starts after Sprint E):
- F1: Source independence gate — press-only cite chains can't reach "confirmed" (~2h)
- F2: YouTube into unified pipeline — story matching + nvs_hint scoring (~6h)
- F3: Lightweight source config — `source_configs` Supabase table + `/admin/sources` edit UI (~7h)
- Full scope and rationale: SLICES.md Sprint F section

**Sprint D — Original News Synthesis** ✅ DONE (2026-05-02)
- Raw RSS/P4 articles removed from KV frontend feed — only templates + original synthesis appear
- `generateOriginalNews(sources, site, env)` in publisher.js: multi-source, no attribution, 300–400 word Kartalix voice
- Synthesis loop in backgroundWork: top P4 stories (NVS≥55), cap 3/run, skip match_result/squad
- Dedup key: `synth:{hash}:{date}` in KV — prevents same story being re-synthesized same day
- Multi-source context: collects related P4 articles via titleSimilarity(>0.25) for richer Claude input
- `/force-synthesis?publish=1` debug endpoint added (tests with top recent Supabase P4 articles)

**Sprint C — YouTube Embed** ✅ DONE (2026-05-02)
- 5 channels live: Beşiktaş JK, beIN SPORTS TR, A Spor, Rabona Digital, TRT Spor
- Keyword qualification + archive season filter working
- 3 videos published on first run (Sergen Yalçın basın toplantısı, Josef/Guedes alumni return, BJK 2-1 Eyüpspor full match)
- Match-specific templates live: T-VID-HLT, T-VID-GOL, T-VID-BP, T-VID-INT, T-VID-REF (Süper Lig only)
- `classifyMatchVideo` routes to match templates; falls back to generic T-VID outside Süper Lig context
- `/force-yt` now shows `match_type` per video and uses match templates when `?publish=1`

**Backlog (done)**:
- Sprint A ✅ — T-HT, T-RED, T-VAR, T-OG, T-PEN deployed (d6bb2e0d)
- PR #1 — close (SoccerData evaluation, stay on API-Football Pro)

---

## CONTEXT IF NEEDED

**Currently in flight**: Slice 3 complete (Phase 1 + Phase 2 + Phase 3)
**Session 7 status (2026-05-01)**:
- API key rotated ✅
- Editorial feedback system: article comments → distill → editorial:notes → injected into all generation
- Reference article paste: admin panel, style learning from other channels, feeds redistill
- Weekly redistill cron (Monday 03:00) — consolidates and deduplicates rules
- Reactions restored to Supabase with idempotency fix; admin news list fixed
- Template set COMPLETE (9 of 9): T01, T02, T03, T07, T10, T11, T12, T13, T-XG
  - Pre-match: T03 Form Guide (72h), T02 H2H (72h), T07 Injury Report (48h), T01 Preview (48h)
  - Live: T10 Goal Flash
  - Post-match: T11 Result Flash, T13 Man of the Match, T12 Match Report + xG, T-XG Delta (|goals−xG| > 1.2)
- Injury API fix: fixture-scoped query, client-side dedup, no Kartalix articles in RSS context

**Provider decision**: API-Football Pro confirmed ✅ — close PR #1
**Open PRs**: #1 slices/track-a-stats-pipeline (close), #2 slices/track-b-v2-backlog (merge after retrospective)
**Slice 3 Phase 3 remaining templates**: T02 H2H History, T05 Lineup Announcement, T07 Injury/Suspension, T13 Man of the Match, T12 Match Report (with xG), T-xG Delta, T-SUB Suspension Watch, T-GK Goalkeeper Spotlight, T-FRM Formation Change, T-REF Referee Profile
**Key finding**: Shot x/y coordinates absent from API-Football — shot map visuals parked to v2
**Key finding**: xG is in every fixture response — T-xG Delta article is zero-cost to add
**Editorial system KV keys**: editorial:notes (active rules), editorial:raw_feedback (unprocessed comments), editorial:references (pasted example articles)

---

## RULES

- One next action. Not three. Not "various things."
- Concrete, not abstract. Bad: "work on Facts Firewall." Good: "Add migration for `fact_lineage` table in `migrations/0042_fact_lineage.sql`."
- If you finish a session without knowing the next action, the session wasn't really done. Take 2 minutes to figure it out before closing the laptop.
- The PM agent reads this and references it in Friday close messages.

---

**API migration + T-REF — DONE (session 7)**:
- T05: RSS injury extraction → `getInjuries(env, fixture_id)` (same API as T07)
- T09: RSS keyword scan + Haiku extraction → `getFixtureLineup(fixtureId, env)` (API-Football `/fixtures/lineups`)
- T08b: stays RSS — API has no probable lineups
- `getFixtureLineup` added to api-football.js — returns null if lineup not yet submitted
- `referee` field added to nextMatch builder from API data
- T-REF Referee Profile: new template, API-driven, fires 24–48h pre-match, computes BJK W/D/L record under that referee from recent fixtures
- `/force-tref?referee=Name` debug endpoint added

**Slice 3 Phase 2 (story type classification) — DONE**:
- `classifyStoryType()` in firewall.js: Haiku call → transfer/injury/disciplinary/contract/match_result/squad/institutional/other
- Per-type schemas: transfer (existing), injury/disciplinary, contract, generic
- `extractFactsForStory()` replaces `extractFacts` in story intake — two-step: classify then extract
- match_result + squad filtered from story system (`SKIP_STORY_TYPES`) — handled by templates
- story-matcher: judge prompt includes pre-classified type hint; createStory uses it as fallback

*Last updated: 2026-05-04 (session 10 — Sprint F scoped; Rabona digest + non-BJK filter + Supadata live)*
