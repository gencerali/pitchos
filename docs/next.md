# Next Actions

## Pending: Set SUPADATA_API_KEY on story worker

The story agent falls back to title+summary extraction only until this secret is set.
No CLI needed — do it from Cloudflare dashboard on your phone:

1. Open **dash.cloudflare.com** → Workers & Pages → **pitchos-story-agent**
2. Settings → Variables → **Environment Variables** → Edit variables
3. Add → Name: `SUPADATA_API_KEY` → Value: (your key from supadata.ai dashboard) → **Encrypt** → Save

That's it. No deploy needed — secrets take effect on the next cron run.

Your Supadata key is at: **app.supadata.ai** → API Keys

---

## MB-NEXT-1: Multi-Article Synthesis from Single YouTube Video

**Status:** Waiting — verify basic single-article YouTube synthesis works first.

**What it does:** One interview (e.g. Özen transfer presser, Sergen on Kafa Sports) contains
multiple distinct newsworthy topics. Currently only one article is produced per video.

**Mechanism:**
- After transcript fetch, call `segmentTranscript()` (already in `publisher.js`)
  to split into 3-5 topic segments
- Synthesize one article per segment
- `generateMultiTopicVideoSynthesis()` already built for the Sergen/Kafa Sports case

**Gate:** Confirm Özen presser video → fact extraction → article is working end-to-end first.

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

**Today's data:** Ouattara, Nübel, Thorstvedt, Bueno all have separate transfer fact rows
that could populate this article without fabrication.
