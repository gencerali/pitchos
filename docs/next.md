# Next Actions

## Supadata API — Credits

- `SUPADATA_API_KEY` set on `pitchos-story-agent` via Cloudflare dashboard ✅
- Monthly credits exhausted — **resets 04.07**
- Until then: story agent falls back to title+summary extraction only (no transcript fetch)
- After 04.07: transcripts will flow automatically — no action needed

---

## MB-NEXT-1: Multi-Article Synthesis from Single YouTube Video

**Status:** Waiting — verify basic single-article YouTube synthesis works first (check after 04.07 when Supadata resets).

**What it does:** One interview (e.g. Özen transfer presser, Sergen on Kafa Sports) contains
multiple distinct newsworthy topics. Currently only one article is produced per video.

**Mechanism:**
- After transcript fetch, call `segmentTranscript()` (already in `publisher.js`)
  to split into 3-5 topic segments
- Synthesize one article per segment
- `generateMultiTopicVideoSynthesis()` already built for the Sergen/Kafa Sports case

**Gate:** Confirm Özen presser video → fact extraction → article is working end-to-end before enabling.

---

## MB-NEXT-2: Mystery Follow-Up Article ("Özen said 3 — but who?")

**What it does:** When an official states a count without naming subjects (e.g. "3 transfer
targets in final stage"), the mystery itself has reader value.

**Mechanism:**
1. Detect "mystery": fact has `numbers.other[].value = N` but `entities.players = []`
2. Query DB: pull all `story_type=transfer` facts for the same site in past 7 days where
   specific player names appear → these are known candidates from parallel fact items
3. New synthesis trigger type `mystery_followup` with speculation-framed prompt:
   "Özen 3 dedi — işte şu ana kadar görüşüldüğü bildirilen adaylar"
4. Ground strictly in existing fact rows only — no invented names

**Example data:** Ouattara, Nübel, Thorstvedt, Bueno all have separate transfer fact rows
that could populate this article without fabrication.

---

## Backlog

### Sound (iPhone)
- iPhone Chrome and Safari: no sound despite 4 fix attempts
- Needs real-device debugging with Safari Web Inspector (remote debug via Mac)

### B1.3 Streak Revival — Untested
- Needs a real broken streak (miss a day after ≥ 2-day streak) to trigger

### B3
- Shareable Result Card (canvas image after prediction resolves)
- Community Prediction Heatmap (score distribution overlay on prediction UI)
- Weekly Email Digest (summary email with XP, rank, highlights)

### B4
- Seasonal Events (e.g. playoff bonus XP windows, themed badges)
- Match Alerts (push notification opt-in via Web Push API)
