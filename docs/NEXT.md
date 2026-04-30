# NEXT.md

**The single most underused founder tool. Read this every time you sit down.**

Update this at the END of every work session. Not the start — the end. Future-you walking in cold should know exactly what to do next without thinking.

---

## NEXT ACTION

Create `@kartalix-pm` Telegram channel, then begin PM agent scaffold:

1. Create `@kartalix-pm` Telegram channel — note the chat ID (needed to wire the bot)
2. Add `pm_sessions` migration to Supabase — columns: `id`, `created_at`, `type` (kickoff/close/drift/session/pause), `content` (text), `commitments` (jsonb), `slips` (jsonb)
3. Scaffold PM agent Cloudflare Worker — start with Monday 09:00 kickoff message only, wire to `@kartalix-pm`

---

## CONTEXT IF NEEDED

**Currently in flight**: Slice 0 (PM Agent)
**Last session**: 2026-04-28 — full audit, lawyer consultation processed, 48-hour legal compliance complete (IT3 blocked, enrich cron off, hot-news delay, source attribution). Render redeployed, Supabase cleanup SQL run.
**Blockers**: None. All legal pre-conditions met.

---

## RULES

- One next action. Not three. Not "various things."
- Concrete, not abstract. Bad: "work on Facts Firewall." Good: "Add migration for `fact_lineage` table in `migrations/0042_fact_lineage.sql`."
- If you finish a session without knowing the next action, the session wasn't really done. Take 2 minutes to figure it out before closing the laptop.
- The PM agent reads this and references it in Friday close messages.

---

*Last updated: 2026-04-28*
