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

### MB-NEXT-3 — Unified Fact Extraction (`src/extractor.js`)

**Problem:** Three separate extractors (`extractAndScore`, `extractFacts`, `fetchYouTubeAndExtractFacts`) write inconsistently to the same `facts` table. P4 RSS rows have no `grounding_summary` or `key_quotes`. YouTube quotes land in `fact_payload.quotes` instead of `key_quotes`. Future sources (Twitter, Instagram, etc.) would each need their own ad-hoc path.

**Goal:** One canonical fact shape, one DB write path, all source types plugging into the same function.

#### Canonical fact schema (every source, every type)

```
story_type          string   transfer|injury|contract|match_result|squad|disciplinary|statement|other
entities            object   { players[], clubs[], competitions[] }
numbers             object   { transfer_fee, contract_years, other[] }
dates               object   { primary_date, other[] }
grounding_summary   string   Always present. 1-2 sentence paraphrase of the key claim.
                             Machine-readable, factual, never verbatim.
key_quotes          array    [{ text, speaker, role }] — empty [] if none.
                             Verbatim attributed quotes only.
source_type         string   'rss_full' | 'rss_summary' | 'yt_transcript' | 'yt_title'
                             | 'twitter' | 'instagram' | 'manual'
source_date         string   ISO date of original publication (item.published_at or item.created_at)
claim_confidence    string   high | medium | low
```

`grounding_summary` is the narrative bridge between sparse JSON and readable synthesis.
`source_type` lets synthesis weight credibility (transcript > full body > title+summary).
`source_date` lets synthesis reference timing and staleness.

#### Implementation plan

1. Create `src/extractor.js` — single `extractFacts(sourceInput, env)` where `sourceInput` = `{ text, sourceType, item }`.
   - One prompt template, adapted by `sourceType` (shorter for `rss_summary`, full for `yt_transcript`).
   - Single `parseAndValidate()` that enforces the canonical shape — fills `grounding_summary: ''` and `key_quotes: []` if model omits them.
   - Single `writeFactsRow(facts, item, env)` — one DB path, all columns set.

2. Retire the three existing extractors — replace callers in `firewall.js` and `worker-story-agent.js` with `extractFacts()` from `src/extractor.js`.

3. Migration: backfill `source_type` and `source_date` for existing rows where null.

#### Source type guide (current + future)

| Source | sourceType | text input |
|--------|-----------|-----------|
| RSS with full body (P1–P3) | `rss_full` | full body text, up to 2500 chars |
| RSS title+summary only (P4) | `rss_summary` | title + summary, up to 800 chars |
| YouTube with Supadata transcript | `yt_transcript` | title + transcript, up to 4000 chars |
| YouTube title only (Tier 2 skip) | `yt_title` | title only |
| Twitter/X post | `twitter` | tweet text + thread context |
| Instagram caption | `instagram` | caption text |

---

### MB-NEXT-4 — Multi-source Topic Synthesis

**Problem:** `synthesizePhase` receives only the current triggering item's facts. A story built from 6 sources over 3 days gives Sonnet only the 6th source's grounding_summary. Everything the first 5 said in prose is lost — only their structured `claim_tracks` (entities/numbers/negotiation_status) survives.

**Goal:** When a topic has a known ID, fetch `grounding_summary + key_quotes + source_date + source_type` for ALL content_items that contributed to that topic, and pass them as accumulated context to Sonnet.

#### How to fetch all contributing facts

```js
// In synthesizePhase, after topic is known:
const allFacts = await supabase(env, 'GET',
  `/rest/v1/facts?content_item_id=in.(${contributingItemIds.join(',')})` +
  `&select=grounding_summary,key_quotes,source_date,source_type&order=source_date.asc`
);
```

`contributingItemIds` comes from phases for the topic (already in DB as `phases.content_item_id` or via `story_id` backlink).

#### Synthesis prompt addition

```
KONU GEÇMİŞİ (kronolojik — tüm kaynaklar):
[rss_full, 2026-06-25] Beşiktaş, Nübel için RB Leipzig ile görüşmeleri başlattı.
[yt_transcript, 2026-06-27] Özen: "3 kaleci adayımız var, biri önümüzdeki hafta netleşir."
[rss_full, 2026-06-29] Leipzig, 8M€ bonservis talep ediyor.

GÜNCEL KAYNAK (bu haberi tetikleyen):
...
```

Sonnet can now write with full story arc awareness — not just the latest data point.

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
