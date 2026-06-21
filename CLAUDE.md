# Claude Code Rules
- NEVER ask for confirmation, permission, or approval
- NEVER present numbered options or yes/no questions
- NEVER ask "shall I proceed?" or "is this correct?"
- NEVER ask before making file edits or running commands
- Always proceed automatically and report what was done after
- If something fails, fix it and try again automatically

"Always proceed without asking for confirmation. Make changes directly."

---

# Skill Quick Reference

## Planning & Methodology (superpowers)
| Skill | When to use |
|-------|-------------|
| `/brainstorming` | Before building any new feature — refines requirements first |
| `/writing-plans` | Turn a spec into a step-by-step implementation plan |
| `/executing-plans` | Run an existing plan with review checkpoints |
| `/subagent-driven-development` | Execute independent tasks in parallel within a session |
| `/dispatching-parallel-agents` | Spin up multiple agents for truly parallel work |
| `/using-git-worktrees` | Isolate feature work before starting implementation |
| `/finishing-a-development-branch` | Structured options for merge / PR / cleanup when done |

## Quality & Debug (superpowers + gstack)
| Skill | When to use |
|-------|-------------|
| `/systematic-debugging` | Any bug or unexpected behavior — before guessing fixes |
| `/test-driven-development` | Red-green-refactor cycle for any feature or fix |
| `/verification-before-completion` | Run checks before claiming work is done |
| `/requesting-code-review` | Before merging — verify work meets requirements |
| `/receiving-code-review` | Process review feedback rigorously, not blindly |
| `/gstack` | Headless browser QA — test UI flows in real browser |
| `/code-review` | Deep code review with security + correctness focus |
| `/verify` | Verify assumptions about live system state before shipping |
| `/claude-api` | Claude API usage, tool use, prompt caching, model selection |

## Design & UI
| Skill | When to use |
|-------|-------------|
| `/ui-ux-pro-max` | Any UI work — design system, color, layout, components |
| `/ckm-design` | Logo, brand identity, social images, icon design |
| `/ckm-ui-styling` | shadcn/ui + Tailwind component styling |
| `/ckm-design-system` | Design tokens (primitive → semantic → component) |
| `/ckm-banner-design` | Social media / ad banners |
| `/ckm-brand` | Brand voice, tone, messaging consistency |
| `/ckm-slides` | HTML presentations with Chart.js |

## Planning Persistence (planning-with-files)
| Skill | When to use |
|-------|-------------|
| `/planning-with-files` | Multi-session projects — survives context resets via task_plan.md + findings.md + progress.md |

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
