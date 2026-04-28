# NEXT.md

**The single most underused founder tool. Read this every time you sit down.**

Update this at the END of every work session. Not the start — the end. Future-you walking in cold should know exactly what to do next without thinking.

---

## NEXT ACTION

Two manual tasks, then resume build:

1. **Deploy pitchos-proxy to Render** — auto-enrich cron is now disabled in code, needs to be re-deployed to take effect on the live server
2. **Run `supabase-migration-legal-cleanup.sql`** in Supabase SQL editor — deletes stored P4 full text and IT3 images from content_items

Once those two are done: create `@kartalix-pm` Telegram channel, note the chat ID, and begin PM agent scaffold (`pm_sessions` table + Cloudflare Worker, Monday kickoff message first).

---

## CONTEXT IF NEEDED

**Currently in flight**: Slice 0 (PM Agent) — legal compliance work completed first
**Last session**: 2026-04-28 — lawyer feedback processed. IT3 images blocked, hot-news delay added, source attribution made mandatory, auto-enrich cron disabled, P4 full-text stripped from pipeline. Three new DECISIONS.md entries written.
**Blockers**: Lawyer consultation complete ✅. Render re-deploy and Supabase cleanup SQL must run before next fetch cycle.

---

## RULES

- One next action. Not three. Not "various things."
- Concrete, not abstract. Bad: "work on Facts Firewall." Good: "Add migration for `fact_lineage` table in `migrations/0042_fact_lineage.sql`."
- If you finish a session without knowing the next action, the session wasn't really done. Take 2 minutes to figure it out before closing the laptop.
- The PM agent reads this and references it in Friday close messages.

---

*Last updated: 2026-04-28*
