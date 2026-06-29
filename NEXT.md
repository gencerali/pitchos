# What's Next

**One file. All tracks. Updated every session.**

---

## Blocked / Waiting

| Item | Waiting on | ETA |
|------|-----------|-----|
| Supadata transcripts | Credits reset | 04.07 — then automatic |
| AdSense approval | Google review | Unknown — check dashboard |
| v1.0 ship | Sprints K + L + security hardening | July 2026 target |

---

## Method B (pitchos-story-agent)

### Done
- [x] MB-1 Shadow worker — cron, CI deploy, `methodb:enabled` KV gate
- [x] MB-2 Core pipeline — topic correlation → delta detection → Sonnet synthesis
- [x] MB-3 Editorial quality — NVS cooldown, DECISION_SIGNALS filter, fan-facing tone
- [x] MB-4 YouTube transcript pipeline — Supadata Tier 1 / title+summary Tier 2, quotes preserved
- [x] SUPADATA_API_KEY set in Cloudflare dashboard

### Next (after 04.07)
- [ ] **MB-NEXT-1** Verify single-article YouTube synthesis works end-to-end (check admin pipeline after first few runs with transcripts)
- [ ] **MB-NEXT-1b** Multi-article from single video — `segmentTranscript()` + `generateMultiTopicVideoSynthesis()` (already in `publisher.js`). Gate: MB-NEXT-1 verified first.
- [ ] **MB-NEXT-2** Mystery follow-up article — detect count-without-names in facts, cross-query transfer facts, synthesize speculation grounded only in DB. Trigger: `mystery_followup`.

---

## Gamification

### Done
- [x] Phases 1–6 (XP engine, streaks, leaderboard, tribün, profile, schema)
- [x] Phase 7 Sound (toggle, XP coin sparkle, level-up fanfare)
- [x] B1.1 Badge progress bars (locked badges show count/threshold + progress bar)
- [x] B1.2 Prediction accuracy stat (profile + accuracy leaderboard tab)
- [x] B1.3 Streak revival modal (100 XP cost, 7-day cooldown)
- [x] B2.1 Daily quest banner (7 quest sets, 3/day, tribün + profile)
- [x] B2.2 Weekly leagues (Bronz/Gümüş/Altın/Platin/Elmas, Monday reset)
- [x] B2.3 PWA (manifest.json, Apple meta tags)

### Open
- [ ] **3.7** Haiku toxicity check on comments — needs `ANTHROPIC_API_KEY` in Cloudflare Pages env
- [ ] **8** Bot seeding — 1500 synthetic users (`profiles.is_bot` col ready) — pre-launch blocker
- [ ] **B3.1** Shareable result card — dynamic OG image after match result
- [ ] **B3.2** Community prediction reveal — score heatmap after lock
- [ ] **B3.3** Weekly email digest — Monday recap via Resend
- [ ] **B4.1** Seasonal events — double XP weekends, derby badges
- [ ] **B4.3** Match alerts — WhatsApp/Telegram opt-in
- [ ] **Sound (iPhone)** — Chrome + Safari still silent; needs Safari Web Inspector remote debug on real device

### Phase 7 (Poll Automation — future)
- [ ] 7.A AI poll generator (Haiku, weekly from trending topics)
- [ ] 7.B Poll scheduling engine
- [ ] 7.C Sentiment-driven polls
- [ ] 7.D Poll analytics dashboard

---

## Pipeline / v1.0

### v1.0 Freeze Criteria (open items)
- [ ] `/run`, `/force-*` endpoints require auth (no unauthenticated triggers)
- [ ] `ADMIN_PIN` secret set — no hardcoded fallback
- [ ] Homepage loads <2s on mobile (4G throttled)
- [ ] 40+ articles visible without manual intervention for 3 consecutive days
- [ ] Telegram ops alert wired (Claude cap hit + zero-article run)
- [ ] At least one synthesis article contains situational context block
- [ ] `git tag v1.0.0` + Cloudflare version + KV export + Supabase backup

### Sprint K — Situational Awareness Engine (v0.97)
- [ ] K4 `sites.editorial_context` schema + admin form + BJK seed data *(do first)*
- [ ] K1 Layer 1: remaining fixtures, cache invalidation after result flash
- [ ] K2 Mathematical locks + rival threat index + GD tiebreaker
- [ ] K3 European qualification tree
- [ ] K5 `src/situation.js` glue + synthesis integration *(needs Worker Split Ph1 first)*

### Sprint L — Alarm Framework (v0.98)
- [ ] L1 `src/relevance.js` — unify filter paths, retire `BJK_KEYWORDS`
- [ ] L2 `team_entities` table + API-Football weekly sync
- [ ] L5–L10 Alarm DB schema, runner, Telegram bot, `/admin/rapor` UI

### Worker Split (prerequisite for Sprint K5 + Cockpit)
- [ ] Phase 1: extract `renderAdminReportPage` → `routes/admin-report.js`
- [ ] Phase 2: extract `/force-*` endpoints → `routes/force-triggers.js`
- [ ] Phase 3: extract `processSite`, `matchWatcher` → `domain/`

---

## Post-Launch (v1.1+)

- [ ] Squad Intelligence — `squad_members` DB, dynamic keywords
- [ ] Distribution Agent — push notifications (NVS≥80)
- [ ] Visual Assets — image pipeline *(blocked: lawyer consult re Wikimedia + AI images)*
- [ ] Editorial QA Agent
- [ ] Multi-tenant (v2.0) — after Beşiktaş site proven

---

## Tech Debt (fix opportunistically)

- [ ] `normalizeTitle` / `KEY_TOKEN_RE` — Turkish Unicode boundary bug (v1.1)
- [ ] `fetchBeIN` stub — delete or implement
- [ ] Unify SPA + server-rendered article templates (SEO gap)
