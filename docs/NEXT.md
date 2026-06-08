# NEXT.md

**The single most underused founder tool. Read this every time you sit down.**

Update this at the END of every work session. Not the start — the end. Future-you walking in cold should know exactly what to do next without thinking.

---

## NEXT ACTION

**NEXT**:
1. Sprint 1 Task 1.1 — Docs reconciliation (ROADMAP.md, NEXT.md, DECISIONS.md). ← this task
2. Sprint 1 Task 1.2 — Per-source-per-content-type NVS+lifetime config extension in `SCORING_CONFIG_DEFAULTS`
3. Sprint 1 Task 1.3 — Reorder pipeline so scoring runs AFTER fact extraction (currently scores on RSS metadata only)

---

## OPEN TODOs — branch `claude/pipeline-didnt-run-HiGSZ` (added 2026-06-08)

Outstanding follow-ups from the pipeline/cost/YouTube fixes on this branch. These are committed to code but NOT yet live or need manual steps:

- [ ] **DEPLOY the branch** (`npm run deploy`). Everything below lives in the deployed Worker, not the repo — none of it is live until deploy: quiet-period 06:30→06:00 fix, Sunday cron `0 2 * * 7` fix, prompt-cache fix (random voice patterns moved out of cached prefix), `SYNTHESIS_CAP_PER_RUN` 18→12, YouTube shared-keyword relevance check + per-run YT synthesis cap + official-first ordering.
- [ ] **Flip Rabona `all_qualify` → false in the DB** via `/admin/sources` (the `all_qualify` checkbox). Runtime reads the flag from `source_configs` (DB) via `configsToYTChannels`; the hardcoded default in `src/youtube.js` is only the seed/fallback. Until the DB row is flipped, Rabona videos still bypass the keyword check.
- [ ] **Clean up the 2 off-topic published articles** (set `status` off `published` + evict from KV pool `articles:BJK`):
  - `2026-06-08-yuzmeden-kurege-genc-paralimpik-sampiyon-yigit-dogukan-bozkurtun-ilham`
  - `2026-06-08-fenerbahcede-aziz-yildirim-donemi-yeniden-basliyor-kongre-guvenli-lima`
- [ ] **Verify caching after deploy**: check `usage.cache_read_input_tokens` > 0 on synthesis calls (admin `/financials`). If still 0, the cached prefix is under Sonnet's 2048-token minimum — either consolidate stable text into the prefix or drop `cache_control` to stop paying write premiums.
- [ ] **Homepage video rail bug** (in progress): "Video Öne Çıkanlar" 7-slot list pulls curated `rail_fallback_video_slugs` (unutulmazlar) instead of the 7 most-recent videos, because the main pool is capped at 3 videos (`rankAndEvict` MAX_VIDEOS) so `buildVideoRail`'s recency pass has nothing left and falls through to the curated fallback. Fix = supply recent videos to the rail without a per-request DB hit.

---

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
