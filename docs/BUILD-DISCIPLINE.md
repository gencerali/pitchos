# Kartalix Build Discipline

Four files. One Telegram bot. One weekly review. That's the whole system for not losing track during the 6–9 month build.

## The Four Files

| File | Purpose | Update cadence | Read cadence |
|------|---------|----------------|--------------|
| `architecture/pitchos-v1.tsx` | What we're building (system design) | Only on deliberate design change | Weekly review |
| `SLICES.md` | What's in flight, what's next | When you finish anything material | Every work session |
| `DECISIONS.md` | Why we chose what we chose | Append when making architecture-level decisions | When confused or onboarding someone |
| `NEXT.md` | The single very next concrete action | End of every work session | Start of every work session |

## The PM Agent (`@kartalix-pm` Telegram channel)

Four automated conversations per week, plus on-demand session logging.

### Monday 09:00 — Kickoff
Bot summarizes what you did last week, lists what's committed for this week (set last Friday), shows blockers. You reply with this week's commitments.

### Friday 17:00 — Close
Bot lists what shipped vs what slipped. Asks why if anything moved. Updates slice progress percentages.

### Daily — Drift detector (silent unless triggered)
Watches for: 5+ days without a session, slice in progress beyond estimate × 1.5, starting new slice without finishing current, committed deliverables not progressing.

### On-demand — Session logger
You message "done for now." Bot prompts: what shipped? what's next? any decisions? any blockers? Your replies update the four files.

### Monthly — Strategic review
First Monday of the month: completed slices count, time elapsed vs estimate, three honest questions, brief acknowledgment of progress.

## Scope Discipline

When you message the PM with a new idea, it asks one question: does this belong in current slice, future slice, or v2 backlog? Default answer is v2. The PM is allowed to push back.

## Pause Command

Send "PM, pause for [N] weeks." Bot acknowledges, sets return date, stops messaging until then. Resume with "PM, back."

Life happens. The system doesn't shame you for it.

## What This Is Not

- Not a journal you maintain manually
- Not a Notion or Jira or Linear (one tool, one bot)
- Not motivational platitudes
- Not a substitute for human collaboration on hard problems

## The Rule That Matters Most

**No new architecture conversations until v1 ships.** The architecture artifact is sufficient. New ideas during v1 go to the v2 backlog in SLICES.md and you don't think about them again.

If you find yourself in a long design conversation with Claude during v1, that's a signal. The PM agent watches for this pattern and surfaces it.

---

## Setup Checklist

- [ ] Drop the four files into `docs/` in the Kartalix repo
- [ ] Date-stamp the existing entries with today's date
- [ ] Add the architecture artifact to the repo as `docs/architecture/pitchos-v1.tsx`
- [ ] Book the Turkish IP lawyer consultation
- [ ] Build PM agent scaffold (Slice 0) — Cloudflare Worker, Supabase tables, Telegram channel
- [ ] First Monday kickoff arrives → you're operational

Once that checklist is done, the system runs itself for accountability and you focus on building.

---

*This document is the meta-architecture: the architecture for how the architecture gets shipped.*
