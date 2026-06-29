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

#### Reality check (from DB audit, 2025-06-29)

| | Count | % |
|---|---|---|
| Total facts rows | 2523 | — |
| Has grounding_summary | 1163 | 46% |
| Has source_date | 1082 | 43% |
| Has extraction_tier | 1163 | 46% |
| Has fact_payload | **0** | **0%** |

- `extraction_tier = 'llm_full'` (P1–P3 full body): 1163 rows — have summary, mostly have source_date ✅
- `extraction_tier = null` (P4 title-only + legacy): 1360 rows — **zero summary, zero source_date** ❌
- `key_quotes` **column does not exist** in the DB — all quote extraction silently dropped since day 1
- `grounding_summary` is stored in **English** — wrong language for Turkish synthesis
- `source_url` lives only in `fact_lineage` — requires a join every time synthesis needs it

**54% of all facts are hollow.** Synthesis and delta detection have been running on incomplete data.

---

#### Canonical fact schema — every source, every type, always complete

```
Core claim
  story_type        text      transfer|injury|contract|match_result|squad|disciplinary|statement|other
  entities          jsonb     { players[], clubs[], competitions[] }
  numbers           jsonb     { transfer_fee, contract_years, other[] }
  dates             jsonb     { primary_date, other[] }
  claim_confidence  text      high | medium | low
  claim_status      text      rumor | developing | confirmed | denied | completed | obsolete
                              (replaces transfer-only negotiation_status; generalizes to all story types)

Narrative context — currently broken, most important gap
  grounding_summary text      Always present. 1–2 sentence Türkçe özet of the key claim.
                              Paraphrase only — never verbatim. Machine-readable.
  key_quotes        jsonb     [{ text, speaker, role }] — empty [] if none.
                              Verbatim attributed quotes only, in original Turkish.

Source provenance — for synthesis, audit, and future analytics
  source_type       text      rss_full | rss_summary | yt_transcript | yt_title |
                              twitter | instagram | manual
                              Tells synthesis how much to weight the grounding_summary.
                              (transcript > rss_full > rss_summary > yt_title)
  source_date       timestamptz  When the source article was published (item.published_at).
                                 Already in DB as source_published_at but unreliable — must
                                 be set on every write.
  source_url        text      Denormalized from fact_lineage for synthesis queries.
                              fact_lineage keeps the legal audit trail; this is convenience.
  source_name       text      Publication name (Fotomaç, Sabah, YouTube channel).
                              Denormalized same reason.

Already present, keep
  entity_fingerprint  text    For delta detection
  corroboration_count int     Already exists (default 0)
  story_id            uuid    Link to legacy stories table
  extraction_model    text    Which model extracted
  extraction_tier     text    llm_full | llm_summary | llm_transcript | llm_title
```

**On `claim_status`:** `negotiation_status` only works for transfers. `claim_status` is a universal lifecycle that works for all story types:
- injury: rumor → confirmed → completed (player returns)
- contract: rumor → developing → confirmed → completed (signed)
- disciplinary: rumor → confirmed → completed (ban served)

This enables MB-NEXT-4 to sort facts chronologically by claim lifecycle, not just date.

**On `source_type` vs `extraction_tier`:** `source_type` is about WHERE the content came from (rss, youtube, twitter). `extraction_tier` is about HOW MUCH text we had (full body vs title only). Both matter — keep both, but make source_type mandatory from now on.

**On `grounding_summary` language:** Currently stored in English. Must be Turkish. The prompt needs to say explicitly: "Türkçe yaz". This is critical — synthesis prompts are in Turkish, an English summary creates a language mismatch Sonnet has to bridge.

---

#### DB migration needed

```sql
ALTER TABLE facts
  ADD COLUMN key_quotes      jsonb DEFAULT '[]',
  ADD COLUMN source_type     text,
  ADD COLUMN source_url      text,
  ADD COLUMN source_name     text,
  ADD COLUMN claim_status    text;
-- source_date: already exists as source_published_at — keep that column name, just make it reliable
-- extraction_tier: already exists — extend allowed values
```

---

#### Implementation plan

**Step 1 — DB migration** (new columns above)

**Step 2 — `src/extractor.js`** — single unified function:
```js
extractFacts({ text, sourceType, item, env })
// → persists canonical row, returns { ...facts, id }
```
- One prompt template, adapted by sourceType (longer/richer for yt_transcript, compact for rss_summary)
- Always produces: grounding_summary (Turkish), key_quotes, claim_status
- Single `writeFactRow()` that sets ALL columns — no nulls by accident
- Writes source_url + source_name directly (no separate lineage call needed for those fields)
- `fact_lineage` still written for legal audit (destruction_confirmed_at, text_length)

**Step 3 — Replace existing extractors**
- `extractAndScore()` in `firewall.js` → calls `extractFacts()`, keeps multi-claim loop
- `extractFacts()` in `firewall.js` (P4 lightweight) → calls `extractFacts()` with `sourceType: 'rss_summary'`
- `fetchYouTubeAndExtractFacts()` in `worker-story-agent.js` → calls `extractFacts()` with `sourceType: 'yt_transcript'` or `'yt_title'`

**Step 4 — Fix the story-agent select query**
The current query selects `key_quotes` which doesn't exist in DB yet (causes silent failure). After migration it will work correctly.

---

#### Source type guide — current + future

| Source | sourceType | extraction_tier | text input |
|--------|-----------|----------------|-----------|
| RSS full body (P1–P3) | `rss_full` | `llm_full` | body up to 2500 chars |
| RSS title+summary (P4) | `rss_summary` | `llm_summary` | title + summary ≤800 chars |
| YouTube + Supadata transcript | `yt_transcript` | `llm_transcript` | title + transcript ≤4000 chars |
| YouTube title only | `yt_title` | `llm_title` | title only |
| Twitter/X | `twitter` | `llm_summary` | tweet + thread ≤500 chars |
| Instagram | `instagram` | `llm_summary` | caption ≤300 chars |
| Manual admin entry | `manual` | — | free text |

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
