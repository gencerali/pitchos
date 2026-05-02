# NEXT.md

**The single most underused founder tool. Read this every time you sit down.**

Update this at the END of every work session. Not the start — the end. Future-you walking in cold should know exactly what to do next without thinking.

---

## NEXT ACTION

**NEXT**: Finish Sprint B remaining items, then Sprint C (YouTube embed).

**Sprint B remaining** (~2h):
1. Create `tr.json` Turkish widget translation file
2. Add `/widgets/tr.json` static endpoint to worker
3. H2H widget on T02 articles

**Sprint C — YouTube Embed** (follows Sprint B, ~4h):
1. Confirm real channel IDs for: Beşiktaş JK official, beIN SPORTS Türkiye, TRT Spor
2. Create `src/youtube.js` — `fetchYouTubeChannel()` + `qualifyYouTubeVideo()` (keyword rules)
3. Add `generateVideoEmbed()` to `src/publisher.js` — Haiku 1-sentence intro + iframe
4. Wire into `0 */2 * * *` cron (parallel to RSS intake block)
5. Add `/force-yt?channel_id=...` debug endpoint
6. Verify article render shows iframe correctly

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

*Last updated: 2026-05-01 (session 8, Sprint A complete)*
