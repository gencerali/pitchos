# Kartalix Platform — Release Roadmap

**Active plan. One truth. Updated every release.**

---

## Release Model

| Track | Meaning |
|---|---|
| `v0.x` | Pre-launch iterations. Continuous deploy. No freeze required. |
| `v1.0` | **Public launch freeze.** Full test + backup before deploy. |
| `v1.x` | Post-launch features. Freeze per release. |

**Frozen release** = git tag + Cloudflare worker version noted + KV snapshot + Supabase backup. Procedure is in the [Freeze Procedure](#freeze-procedure) section.

---

## Current State: v0.8 (shipped 2026-05-13)

---

## Releases

### v1.0 — Public Launch *(planned, target: July 2026)*

**The milestone that matters.** Site is publicly promoted, security is hardened, and a clean rollback exists.

**Requires:**
- [ ] Sprint H complete (news pool always has 40+ articles)
- [ ] Slice 4.2 complete (security hardened — no trivially-forgeable admin auth)
- [ ] Slice 4 partial (Telegram ops channel — so you're not blind in production)
- [ ] Slice 3.7 complete (cost guard — hard cap before public traffic can spike spend)
- [ ] Legal sign-off re-confirmed (lawyer review after Sprint H ships)
- [ ] All freeze criteria below pass

**Freeze criteria for v1.0:**
- [ ] Homepage loads <2s on mobile (4G throttled)
- [ ] 40+ articles visible without manual intervention for 3 consecutive days
- [ ] Widget loads on kartalix.com, app.kartalix.com, www.kartalix.com — all three
- [ ] Kaydet (save) tested: beklemede → yayında promotes to KV within one cron tick
- [ ] Admin login: 5 wrong attempts → lockout
- [ ] Admin at /admin/cost shows current month spend is within cap
- [ ] Rewrite articles: at least 3 per day for 3 consecutive days (proxy + RSS fallback both exercised)
- [ ] git tag v1.0.0, Cloudflare version ID noted, KV export saved, Supabase backup downloaded

---

### v0.9 — News Pool & Publish Queue *(next up)*

**Goal:** Homepage consistently shows 40+ articles. Post-derby day produces ≥15 rewrites. Pending articles are one-click publishable.

**Scope — Sprint H:**
- [ ] **H1** Persistent rewrite queue (`rewrite:queue` KV) — NVS≥60 articles queued instead of dropped; retried each run; 48h TTL
- [ ] **H2** Pool grows to 200 slots with `rank_score = nvs × freshness_decay`; homepage shows top 20; "Daha fazla" loads next 20
- [ ] **H3** Quick-publish button in admin news list (one click, no edit form) — POST `/admin/content-publish?slug=X`
- [ ] **H3** Bulk promote: select N pending articles → publish all
- [ ] **H4** Topic pages: `/konu/transfer`, `/konu/mac`, `/konu/sakat` — filtered KV pool per category; homepage tabs
- [ ] **H5** Multi-source rewrite wired into backgroundWork: stories with ≥3 contributions in 6h trigger `synthesizeStory` (cap 2/run)

**Freeze criteria:**
- [ ] Homepage shows ≥40 articles on a quiet news day
- [ ] Post-match run produces ≥8 rewrite articles
- [ ] Admin quick-publish tested: beklemede article appears on homepage within 5 min
- [ ] Topic pages load with correct filtered articles

---

### v0.8 — Operational Fixes ✅ *shipped 2026-05-13*

Widget CORS wildcard, rewrite RSS fallback, Kaydet status fix, badge label cleanup, Sprint H spec.

| What | Detail |
|---|---|
| Widget CORS | All 5 widget endpoints → `*` wildcard + `Cache-Control: no-store`. Fixes app./www. subdomains. |
| Cron fix | Sunday cron `0 2 * * 0` → `0 2 * * 7` (Cloudflare rejects 0) |
| Rewrite RSS fallback | If proxy times out, use RSS summary (≥100 chars) as source — prevents Render cold-start silently killing rewrites |
| Rewrite cap | Raised 4 → 6 per run |
| Kaydet status | Admin Save now reads eStatus dropdown; backend applies status + updates KV feed |
| Badge labels | Consolidated: YZ, YZ+, Ş:xxx, Video, Manuel, Kaynak, RSS |

**Backup:** git commit `b8dd716` on `main`. Cloudflare worker version `0fbe6b4e`.

---

### v0.7 — Truth & Voice ✅ *shipped 2026-05-13*

Facts Firewall, Truth Layer, Story Foundation, Voice Agent Phase 2.

| What | Detail |
|---|---|
| Slice 1 | Facts Firewall — facts + fact_lineage tables; source text destruction |
| Slice 1.5 | Truth Layer — grounding context, verifyArticle, needs_review |
| Slice 2 | Story-Centric Foundation — 130 stories in DB, state machine, 46 stories with transitions |
| Slice 3.9 | Voice Agent Phase 2 — 13 Turkish rules seeded; weekly DNA extraction; voice_patterns KV; style injection into all prompts |
| Admin | /admin/tools page; /admin/archive-legacy; next match self-caching; Sunday 02:00 cron |

---

### v0.6 — Source Intelligence ✅ *shipped 2026-05-05*

Sprint E source expansion + Sprint F source intelligence layer + Sprint G sentiment judge.

| What | Detail |
|---|---|
| Sprint E | Fotospor, Transfermarkt, Google News Transfer feeds; hourly cron; keywordFilter hotfix |
| Sprint F | F1 independence gate (press-only can't reach confirmed); F2 YouTube into unified pipeline; F3 source_configs DB + admin UI |
| Sprint G | Rival-pov −25 NVS cap integrated into scoreArticles |

---

### v0.5 — Content Rewrite ✅ *shipped 2026-05-02*

YouTube embed, single-source rewrite, multi-source synthesis, H2H widget.

| What | Detail |
|---|---|
| Sprint C | 5 YouTube channels; match video templates (T-VID-HLT, T-VID-GOL, etc.) |
| Sprint D | synthesizeArticle — single-source rewrite via proxy + RSS fallback |
| Sprint D2 | synthesizeStory — true multi-source synthesis (≥3 contributions) |
| Sprint B+ | tr.json Turkish translation; H2H widget on T02 articles |

---

### v0.4 — Match Intelligence ✅ *shipped 2026-05-01*

All 12 match templates + Sprint A event flashes + Sprint B widgets.

| What | Detail |
|---|---|
| Slice 3 Phase 3 | 12 match templates (T01–T13, T-XG, T-REF); match watcher */5 cron |
| Sprint A | Event flash templates: T-RED, T-VAR, T-OG, T-PEN, T-HT; seen_event_ids dedup |
| Sprint B | Standings + fixtures + team widgets on homepage; fixture widget on match articles |

---

### v0.3 — Pipeline Reliability ✅ *shipped 2026-04-17*

KV ceiling, Supabase dedup, age penalty, 7-band NVS, story dedup.

---

### v0.2 — Content Quality ✅ *shipped 2026-04-06*

12 RSS sources, NVS scoring, hero carousel, Transfer Radar, Render proxy.

---

### v0.1 — Live Pipeline ✅ *shipped March 2026*

Cloudflare Worker live, Claude API connected, KV cache, cron trigger, Supabase logging.

---

## Post-Launch Backlog (v1.1+)

Ordered by value/dependency. Do not start until v1.0 ships.

| # | Release | Scope | Est. |
|---|---------|-------|------|
| v1.1 | Squad Intelligence | squad_members DB, dynamic keywords, auto-rebuild on squad change | 1–2 wks |
| v1.2 | Distribution | Distribute Agent, push notifications (NVS≥80), distribution_log | 1–2 wks |
| v1.3 | Visual Assets | Visual Asset Agent, IT6 templates, image pipeline | 2–3 wks |
| v1.4 | Editorial QA | Editorial QA Agent, guest submissions, Telegram author channel | 2–3 wks |
| v1.5 | Governance | CLO (FSEK rule engine), CFO full (per-agent cost attribution, weekly report) | 2 wks |
| v1.6 | Self-Learning | Engagement signals → scoring; source performance table; journalist accuracy tracker | 3 wks |
| v2.0 | Multi-team | Pitchos onboarding for Team 2; cross-team learning propagation | TBD |

**Blocked items (not in any release until unblocked):**
- Twitter/X auto-post — $100/mo X API Basic. Unblocks when ad revenue covers it.
- bjk.com.tr content — CAPTCHA-protected. Unblocks with ScrapingBee ($49/mo) or residential proxy.
- Fixed egress IP for widget API caching — needs a cheap VPS. Unblocks at ~333 page loads/day.

---

## Freeze Procedure

Run these steps for every frozen release (v1.0+):

### 1. Git tag
```bash
git tag v1.0.0
git push origin v1.0.0
```

### 2. Note Cloudflare Worker version
After `npx wrangler deploy`, the output includes:
```
Current Version ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```
Record this in the release row above.

To roll back to a previous worker version:
```bash
npx wrangler rollback [version-id]
```

### 3. KV snapshot
```bash
npx wrangler kv bulk get --binding=PITCHOS_CACHE > backups/kv-v1.0.0.json
```
Store the JSON file in `backups/` (gitignored — it contains article content).

### 4. Supabase backup
Supabase Dashboard → Project → Settings → Backups → Download latest.
File: `backups/supabase-v1.0.0.sql.gz`

### 5. Verify rollback path
- Cloudflare: `wrangler rollback [version-id]` restores the worker instantly
- KV: `wrangler kv bulk put --binding=PITCHOS_CACHE backups/kv-v1.0.0.json` restores article cache
- Supabase: restore via pg_restore to a fresh Supabase project (last resort)

---

## Deferred (v2 backlog)

Full list in [SLICES.md v2 BACKLOG section](SLICES.md#v2-backlog--do-not-touch-until-v1-ships).

Summary: live match blog, polls, Transfer Radar board, Fan Pulse dashboard, WhatsApp channel, multi-language, IT1 licensed photography, WebSub real-time push, subscription tier.
