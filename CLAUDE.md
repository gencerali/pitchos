# Claude Code Rules
- NEVER ask for confirmation, permission, or approval
- NEVER present numbered options or yes/no questions
- NEVER ask "shall I proceed?" or "is this correct?"
- NEVER ask before making file edits or running commands
- Always proceed automatically and report what was done after
- If something fails, fix it and try again automatically

"Always proceed without asking for confirmation. Make changes directly."

---

# Gamification Roadmap — Status

## Done

### B1.1 Badge Progress Visibility
- Locked milestone badges show count/threshold + purple progress bar
- Data from `badge_progress` in `/api/me`
- `BADGE_PROGRESS_MAP` (21 badge IDs) in `profil.html`

### B1.2 Prediction Accuracy Stat
- Profile Tahminler tab: accuracy summary (total, exact%, outcome%)
- Liderlik "Tahmin" tab: accuracy leaderboard (min 5 predictions)
- `/api/leaderboard/accuracy` endpoint

### B1.3 Streak Revival Modal
- Broken streak (prev ≥ 2) triggers modal 1.2s after check-in
- 100 XP cost, 7-day cooldown, negative XP ledger row
- `/api/xp/streak-revival` endpoint

### Phase 7 — Sound Design
- Sound toggle in profile settings (`PATCH /api/profile`)
- XP coin: A5→C#6→E6 ascending sparkle (triangle wave)
- Level-up fanfare: C-E-G staccato + sustained C6 + C7 shimmer
- `/api/profile` endpoint

### B2.1 Daily Quest Banner
- 7 quest sets rotating by day-of-week, 3 quests per day
- Progress computed from `xp_events` (no extra writes)
- `/api/quests` endpoint
- Banner injected by `gamification.js` into `.kxQuestBanner` elements
- Shown on `tribun.html` and `profil.html`

### B2.2 Weekly Leagues
- Absolute XP thresholds: Bronz(0) / Gümüş(100) / Altın(300) / Platin(700) / Elmas(1500)
- Weekly window = Monday 00:00 UTC
- `/api/league` endpoint
- Shown in quest banner card on profile + tribün

### B2.3 PWA
- `manifest.json` with name, theme, start_url
- Manifest link + Apple mobile web app meta tags on all HTML pages

---

# Method B (pitchos-story-agent) — Status

## Done

### MB-1 Shadow Worker Setup
- `worker-story-agent.js` + `wrangler-story.toml`, `*/5 * * * *` cron
- GitHub Actions auto-deploy on push to `claude/methodb-startup-7y5cu3`
- `methodb:enabled` KV flag gates the pipeline; shadow pool at `articles:{site}:methodb`

### MB-2 Core Pipeline
- Cursor-based processing of `content_items` with extracted facts
- Topic correlation → delta detection (Haiku) → Sonnet synthesis
- Stable slug (`mb-` prefix), shadow pool upsert (latest state per topic+entity)
- `synthesizedThisRun` Set + `normEnt()` Turkish normalization for within-run dedup
- Fan-out only for 2+ genuinely competing clubs

### MB-3 Editorial Quality
- Fan-facing tone, 60–160 word target, no analyst/disclaimer language
- DECISION_SIGNALS rejection filter (catches chain-of-thought leaking into body)
- NVS-based cooldown: low-trust accretive updates gated to 1 article per topic per 3h;
  high-trust (numbers/dates/key story types) and match events bypass gate entirely

### MB-4 YouTube Transcript Pipeline
- Story agent detects `content_type='youtube_embed'` items with no facts
- Reuses legacy-filtered video list (main worker ingests from `YOUTUBE_CHANNELS`, story agent reads same `content_items` rows)
- Two-tier decision per video based on CONTENT TYPE, not channel:
  - **Tier 1 (Supadata transcript):** press conferences (`basın toplantısı`, `maç sonu açıkl*`), named exec/coach + verbatim quote in title, Günayer/Rabona analysis
  - **Tier 2 (title+summary only):** named exec without quote, squad/attendance headlines
  - **Skip:** training montages, highlights, journalist takes ("aktardı" panels)
- Extracts facts + verbatim quotes; saves to `facts` table (no re-extraction on next run)
- Quotes passed to Sonnet synthesis prompt (`alıntılar`) for direct quotation in articles
- Budget: `YT_TRANSCRIPT_CAP=2` per run, `SUPADATA_MONTHLY_CAP=80` (KV counter)
- **Action needed:** `npx wrangler secret put SUPADATA_API_KEY -c wrangler-story.toml`

---

## Backlog (Method B)

### MB-NEXT-1: Multi-Article Synthesis from Single YouTube Video
- **Context:** One interview (e.g. Özen transfer presser, Sergen on Kafa Sports) contains
  multiple distinct newsworthy topics. Currently only one article is produced per video.
- **Mechanism:** After transcript fetch, call `segmentTranscript()` (already in `publisher.js`)
  to split into 3-5 topic segments, then synthesize one article per segment.
- **Precedent:** `generateMultiTopicVideoSynthesis()` built for Sergen/Kafa Sports case.
- **Gate:** Verify basic single-article YouTube synthesis works correctly before enabling.

### MB-NEXT-2: Mystery Follow-Up Article ("Özen said 3 — but who?")
- **Context:** When an official states a count without naming the subjects (e.g. "3 transfer
  targets in final stage") the mystery itself has reader value.
- **Mechanism:**
  1. Detect "mystery": fact has `numbers.other[].value = N` but `entities.players = []`
  2. Query DB: pull all `story_type=transfer` facts for the same site in past 7 days where
     specific player names appear → these are known candidates from parallel fact items
  3. New synthesis trigger type `mystery_followup` with speculation-framed prompt:
     "Özen 3 dedi — işte şu ana kadar görüşüldüğü bildirilen adaylar"
  4. Ground strictly in existing fact rows only — no invented names
- **Today's data:** Ouattara, Nübel, Thorstvedt, Bueno all have separate transfer fact rows
  that could populate this article without fabrication.

---

## Backlog

### Sound (iPhone)
- iPhone Chrome and Safari: no sound despite 4 fix attempts
- Root causes fixed on desktop; iOS gesture/autoplay policy still blocking
- Needs real-device debugging with Safari Web Inspector (remote debug via Mac)
- Current implementation: `_initAudioCtx()` on any touch, `_unlockAudio()` when sound enabled, tone fns do internal `resume().then(play)` 

### B1.3 Streak Revival — Untested
- Needs a real broken streak (miss a day after ≥ 2-day streak) to trigger

### B3
- Shareable Result Card (canvas image after prediction resolves)
- Community Prediction Heatmap (score distribution overlay on prediction UI)
- Weekly Email Digest (summary email with XP, rank, highlights)

### B4
- Seasonal Events (e.g. playoff bonus XP windows, themed badges)
- Match Alerts (push notification opt-in via Web Push API)
