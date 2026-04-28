# NEXT.md

**The single most underused founder tool. Read this every time you sit down.**

Update this at the END of every work session. Not the start — the end. Future-you walking in cold should know exactly what to do next without thinking.

---

## NEXT ACTION

Begin Slice 0 PM agent build. Specifically:

1. Date-stamp all `[DATE]` entries in `DECISIONS.md` and `SLICES.md` with `2026-04-28`
2. Book the Turkish IP lawyer consultation (highest external dependency — Slice 1 cannot ship without it)
3. Create `@kartalix-pm` Telegram channel and note the chat ID
4. Add `pm_sessions` migration to Supabase — columns: `id`, `created_at`, `type` (kickoff/close/drift/session), `content` (text), `commitments` (jsonb), `slips` (jsonb)
5. Then scaffold the PM Cloudflare Worker — start with the Monday kickoff message only

---

## CONTEXT IF NEEDED

**Currently in flight**: Slice 0 (PM Agent)
**Last session**: 2026-04-28 — full codebase audit completed. AUDIT.md written. Five architecture files read. All working rules set.
**Blockers**: Lawyer consultation must be booked before Slice 1 ships. Auto-enrich cron in pitchos-proxy needs a founder decision (see AUDIT.md §6.3).

---

## RULES

- One next action. Not three. Not "various things."
- Concrete, not abstract. Bad: "work on Facts Firewall." Good: "Add migration for `fact_lineage` table in `migrations/0042_fact_lineage.sql`."
- If you finish a session without knowing the next action, the session wasn't really done. Take 2 minutes to figure it out before closing the laptop.
- The PM agent reads this and references it in Friday close messages.

---

*Last updated: 2026-04-28*
