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

#### Reality check (DB audit 2026-06-29)

| | Count | % |
|---|---|---|
| Total facts | 2523 | — |
| Has grounding_summary | 1163 | 46% |
| Has source_date | 1082 | 43% |
| Has extraction_tier | 1163 | 46% |
| Has fact_payload written | **0** | **0%** |

- `llm_full` rows (P1–P3 full body): 1163 — summary ✅, source_date mostly ✅
- `null` tier rows (P4 + legacy): 1360 — **zero summary, zero source_date** ❌
- `key_quotes` column **does not exist in DB** — all quote extraction silently lost since day 1
- `grounding_summary` stored in **English** — Turkish synthesis gets a language-mismatch input
- `source_url` only in `fact_lineage` — every synthesis needs a join to get it

**54% of facts are hollow. The project memory is half-empty.**

---

#### Canonical fact schema — every source, every type, always complete

```
─── CORE CLAIM ────────────────────────────────────────────────────────
story_type       text    transfer|injury|contract|match_result|squad|
                         disciplinary|statement|other
entities         jsonb   { players[], clubs[], competitions[] }
numbers          jsonb   { transfer_fee, contract_years, other[] }
dates            jsonb   { primary_date, other[] }
event_date       date    When the described event happened — may differ from
                         source_date (e.g. retrospective article today about
                         a January signing). Extracted by model from content.
claim_status     text    rumor | developing | confirmed | denied | completed | obsolete
                         Universal lifecycle (replaces transfer-only negotiation_status).
                         Injury: rumor→confirmed→completed. Contract: same. Match: confirmed.
                         Model sets it; corroboration and trust can promote it.
claim_confidence text    high | medium | low  — model's own confidence, BEFORE source ceiling.

─── NARRATIVE CONTEXT ─────────────────────────────────────────────────
grounding_summary text   Always present. 1–2 cümle Türkçe özet. Paraphrase,
                         never verbatim. The narrative bridge for synthesis.
key_quotes       jsonb   [{ text, speaker?, role? }] — verbatim Turkish quotes.
                         speaker and role are optional (may be unknown in transcript).
                         Empty [] if none — never null.

─── SOURCE PROVENANCE ─────────────────────────────────────────────────
source_type      text    rss_full | rss_summary | yt_transcript | yt_title |
                         twitter | instagram | api | manual
source_date      timestamptz  Publication date of the source (= source_published_at,
                              kept for back-compat). Set on every write — no more nulls.
source_url       text    Denormalized from fact_lineage. Enables synthesis/audit without join.
source_name      text    Publication name (Fotomaç, Sabah, kanal adı).

─── TRUST ─────────────────────────────────────────────────────────────
fact_trust       smallint  Computed [0–100]. See trust model below.
                           Replaces ad-hoc proxyNVS in story agent.

─── ALREADY PRESENT, KEEP ────────────────────────────────────────────
entity_fingerprint, corroboration_count, story_id, extraction_model, extraction_tier
```

---

#### Fact Trust Model — four layers, one score

Reuses the existing T1–T4 tier system as the base. Extends it with source-type ceilings, content richness bonuses, and corroboration.

```
Layer 1 — Source tier (existing, already in content_items.trust_score)
  T1 / official:          90
  T2 / broadcast:         70
  T3 / journalist/press:  50
  T4 / digital/aggregator:25

Layer 2 — Source type ceiling (new — caps model from over-trusting weak inputs)
  api:           100  (structured, verified)
  yt_transcript:  85  (rich, but editorialised)
  rss_full:       80
  instagram_official, twitter_official: 75  (account type from source metadata)
  rss_summary:    60
  twitter:        40
  yt_title:       35
  instagram:      35
  manual:         80

Layer 3 — Content richness bonus (what's actually in the fact)
  +10  numbers present (transfer_fee, contract_years, or other[])
  +10  specific date present (not just "yakında" — a real date)
  +10  key_quotes present (at least one verbatim quote)
  + 5  ≥2 named player entities
  + 5  model says claim_confidence = 'high'
  −10  model says claim_confidence = 'low'
  − 5  story_type = 'other' (couldn't be classified)

Layer 4 — Corroboration bonus (same entity_fingerprint, different source_name)
  +5 per corroborating fact, max +20 (4 sources)
  corroboration_count column already exists in DB (currently always 0)
  Incremented when a new content_item matches the same entity_fingerprint

Formula:
  base    = source_tier_score (Layer 1)
  ceiling = source_type_ceiling (Layer 2)
  bonus   = Σ(Layer 3) + corroboration_bonus (Layer 4)
  fact_trust = clamp(min(ceiling, base + bonus), 0, 100)

Examples:
  Fabrizio Romano tweet, "X Beşiktaş'ta" — no source tier config yet:
    base=50 (T3 default), ceiling=40 (twitter), numbers=0, quotes=0 → fact_trust=40
  Official club RSS, confirmed signing with fee + contract:
    base=90 (T1), ceiling=80, +10 fee, +10 date, +5 high confidence → min(80, 115) = 80
  Anonymous yt_title "3 Bomba Transfer!":
    base=25 (T4), ceiling=35, story_type=other −5 → fact_trust=20
  Same transfer corroborated by 3 sources:
    base=50, ceiling=60, +10 numbers, +15 corrob → fact_trust=60 → claim_status upgrades
```

**claim_status auto-promotion via trust:**
- fact_trust < 35 → force `rumor` (overrides model if it said 'confirmed')
- fact_trust 35–59 → `developing` if model says rumor/developing; `confirmed` only if model also says confirmed
- fact_trust ≥ 60 + model says 'confirmed' → `confirmed`
- `denied` and `completed` always model-set; trust doesn't override

**Where fact_trust is consumed:**
- Method B cooldown gate — replaces `proxyNVS` (same concept, now principled)
- MB-NEXT-4 synthesis context — higher trust facts surfaced first in topic history
- Future: claim_status upgrades when corroboration pushes fact_trust across threshold

---

#### Stress-test fixes incorporated

| Weakness found | Fix |
|---|---|
| No event_date | Added to schema — model extracts "olayın tarihi" separately from source_date |
| Confidence ceiling per source_type | Layer 2 hard ceiling in fact_trust formula |
| YouTube multi-claim (single claim only) | Extractor always returns `claims[]`; single-claim is claims[0] |
| API sources shouldn't hit LLM | `parseStructuredFact()` bypass path for source_type='api' |
| Denial direction wrong | Prompt explicitly asks: "Bu iddia mı, red mi, yoksa spekülasyon mu?" |
| Relative date unresolved | source_date injected into prompt: "Kaynak tarihi: {date}. Göreceli tarihleri buna göre çevir." |
| speaker optional in key_quotes | speaker and role are optional fields |
| 1360 hollow rows | Backfill task: re-extract from content_items where full_text available |

---

#### DB migration

```sql
ALTER TABLE facts
  ADD COLUMN key_quotes    jsonb DEFAULT '[]',
  ADD COLUMN source_type   text,
  ADD COLUMN source_url    text,
  ADD COLUMN source_name   text,
  ADD COLUMN claim_status  text,
  ADD COLUMN event_date    date,
  ADD COLUMN fact_trust    smallint DEFAULT 0;
-- source_published_at already exists → keep, just make it reliable
-- corroboration_count already exists → wire up increment logic
-- negotiation_status: keep for transfer backward compat, but claim_status is primary
```

---

#### Implementation steps

1. ✅ **DB migration** — applied (`mb_next3_unified_fact_schema`)
2. ✅ **`src/extractor.js`** — created. Turkish prompt, multi-claim, trust model, dryRun mode
3. ✅ **Replace existing extractors** — firewall.js + story agent wired to new extractor
4. ✅ **Replace proxyNVS in story agent** with `fact.fact_trust`
5. ✅ **Circular import** — `normalizeStoryType` inlined in extractor.js, no cross-import

#### Open bugs & follow-ups (post-implementation review)

| # | Issue | Impact | Fix |
|---|---|---|---|
| **MB-N3-1** | Trust base always 50 in story agent — `trust_score` int not mapped to tier string before `computeFactTrust` | Medium — all story-agent facts under-trusted | Add `trust_tier` mapping in story agent (1 line) |
| **MB-N3-2** | `normalizeStoryType` duplicated in `firewall.js` + `extractor.js` | Low — divergence risk if story types added | Move to `utils.js`, both import from there |
| **MB-N3-3** | Corroboration increment not wired — `corroboration_count` always 0, Layer 4 trust never fires | High — trust model incomplete | Increment on delta detection 'corroboration' signal |
| **MB-N3-4** | ✅ Phase 1 (SQL) + Phase 2 (inline MCP): all 74 facts with full_body now have Turkish grounding_summary, entity_fingerprint, correct fact_trust, negotiation_status. | — | Done |
| **MB-N3-5** | ✅ Upsert guard in `writeFactRow` — checks `content_item_id` + `entity_fingerprint` (or `story_type`) before insert; PATCHes if exists. Also fixed `extraction_tier` to only write `llm_full`/`llm_light` (constraint values). | — | Done |
| **MB-N3-5b** | ✅ DB migration `mb_n3_5_fix_fact_constraints`: expanded `story_type` check to `transfer\|match\|injury\|contract\|disciplinary\|institutional\|squad\|other`; relaxed `extraction_tier` to allow NULL. | — | Done |
| **MB-N3-6** | ✅ Added `&content_type=not.in.(kartalix_generated,analysis)` to DB fetch in `worker-story-agent.js`. Our own output no longer recycled through extractor. | — | Done |

---

#### Source type guide

| sourceType | extraction_tier | Trust ceiling | Text input |
|-----------|----------------|:---:|-----------|
| `rss_full` | `llm_full` | 80 | body ≤2500 chars |
| `rss_summary` | `llm_summary` | 60 | title + summary ≤800 |
| `yt_transcript` | `llm_transcript` | 85 | title + transcript ≤4000 |
| `yt_title` | `llm_title` | 35 | title only |
| `twitter` | `llm_summary` | 40 | tweet ≤500 chars |
| `instagram` | `llm_summary` | 35 | caption ≤300 chars |
| `api` | — | 100 | structured JSON (no LLM) |
| `manual` | — | 80 | admin free text |

---

### MB-NEXT-5 — Synthesis Redesign

Closes 14 gaps vs. the legacy `synthesizeArticle` / `synthesizeFromFacts` pipeline. Implement roughly in this order.

#### A — Grounding context (highest payoff)
Add `buildGroundingContext(env, site)` call inside `synthesizePhase` before the Sonnet call.
Prepend its `DOĞRULANMIŞ VERİLER` block to the prompt (standings, form, next match, relegation/European gaps).
Cache result per site per run (4h TTL) to cap API-Football calls.
**Cost:** 2–3 API-Football calls per synthesis unless cached. With TTL cache, ~3 calls per cron tick total.
**Coverage:** Hard structural context only (position, form, stakes). NOT fan mood or player pressure — that is Sprint K / item D2 below.

#### B — Dedicated title generation
After body synthesis, call `generateKartalixTitle(body, item.title, env, stats)` from `publisher.js`.
Remove the in-prompt `BAŞLIK:` instruction entirely — title and body generation separate like legacy.
No extra token cost beyond the existing Haiku budget.

#### C — Post-generation verification
Run `verifyArticle` (or a trimmed variant) against grounding block + structured facts after synthesis.
On fail: set `needs_review: true` in KV shape rather than blocking publish.
**Cost:** ~1 extra Haiku call per article.

#### D — Entity-scoped cross-fact context (situational awareness bridge)
After topic is known, query recent facts for the **focus entity** across all topics (last 14 days):
```js
const entityFacts = await supabase(env, 'GET',
  `/rest/v1/facts?entities->>'players'=ilike.*${focusEntity}*` +
  `&select=grounding_summary,key_quotes,source_date,story_type&order=source_date.desc&limit=5`
);
```
Inject as `OYUNCU/KULÜP BAĞLAMI` block in prompt. Gives: transfer links, pressure notes, manager quotes about this player — without Sprint K.
This is the bridge to "player hasn't scored in 10 games / looking for another team" situational awareness.

#### E — Competing tracks as Turkish narrative
Replace `JSON.stringify(allTracks)` with a formatter that outputs 1–2 Turkish sentences per competing club
(e.g., "Galatasaray da aynı oyuncuyla ilgileniyor, ancak resmi teklif yapılmadı.").
Zero extra API calls.

#### F — Guard expansion
Merge DECISION_SIGNALS with the ~8 applicable legacy REFUSAL_SIGNALS (model-deflection patterns,
not proxy/scrape-specific ones). One-line array extension.

#### G — Word count and story-type prompt deltas
Raise floor to "120–250 kelime" (default).
Add light inline `story_type` conditionals in prompt — structural only, never editorial content
(editorial tone rules stay in KV `editorial:notes` only, never hardcoded here):
- `transfer`: if fee or contract_years in numbers, include them; if not, don't speculate
- `injury`: emphasize recovery timeline field; frame around return date if known
- `institutional`: emphasize decision-maker name + announced outcome

#### H — toShadowKVShape fixes
1. `source`: use `item.source_name` from the content_items row (outlet name, not `'Method B'`)
2. `category`: add `EN_TO_TR_CATEGORY` map: `{transfer:'Transfer', injury:'Sakatlık', match:'Maç', squad:'Kadro', institutional:'Kulüp', contract:'Sözleşme', other:'Haber'}`
3. `image_url`: use `item.image_url` from the row (already captured by most RSS feeds) instead of `''`
4. `full_body`: pipe through `articleBodyToHtml()` before storing (matches legacy stored format)

#### I — fact_trust zero-value bug (one-liner)
Change `f?.fact_trust > 0` to `typeof f?.fact_trust === 'number'` so a legitimate `fact_trust: 0`
isn't silently re-derived via `computeFactTrust`.

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
