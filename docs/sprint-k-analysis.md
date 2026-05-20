# Sprint K — Situational Awareness Engine: Pre-Development Analysis

**Date**: 2026-05-14 (session 22)
**Brief**: `C:\Git\pitchos\temp\kartalix_situational_awareness_brief.txt`
**Status**: Analysis complete, awaiting review before implementation begins.

---

## Codebase finding first

A significant portion of what the brief proposes already exists. Reading `getLeagueContext()` in `api-football.js` and `buildGroundingContext()` in `publisher.js`:

**Already implemented:**
- Current standings for all teams (position, points, played, GD)
- Gap-to-cutoff calculations with `possible: bool` flag (`maxPointsPossible >= cutoffPts`)
- Recent form (last 5 results, league-only filtered)
- Rival identification (teams within ~6 points at adjacent meaningful positions)
- Rival's **next** fixture with opponent and date
- European spot mapping from `league_european_spots` Supabase table (position → competition + entry round + start month)
- Opponent motivation context for match-day templates
- Season notes via `season:notes:${teamId}` KV key (raw string)
- 1h KV cache per team+league+season

The gaps are: cup cascade logic, mathematical guarantees (vs. just `possible`), seeding bands, drop-down rules, and a structured Layer 3 schema replacing the primitive KV string.

---

## A1. Validate the three-layer split

**The split is correct.** The cut points are clean:
- Layer 1 = API-sourced objective facts. Wrong if API is wrong, not if logic is wrong.
- Layer 2 = derivable by pure function from facts. Wrong if the encoding of rules is wrong.
- Layer 3 = editorial judgment. Wrong if a human is wrong or goes stale.

**Where Layer 2 derivation is unreliable and needs Layer 3 override:**

1. **Cup winner cascade** — when Trabzonspor wins the cup but is already in EL via 2nd-place league finish, the cup slot cascades. The cascade recipient depends on who is 4th, 5th, etc. and whether they're already qualified. The TFF rules are in Turkish and occasionally ambiguous at edge cases. Layer 3 needs an `european_path_override` field so an admin can hard-code the correct outcome the moment TFF officially confirms it, bypassing derivation.

2. **Seeding bands** — whether BJK is seeded in a given qualifying round depends on UEFA's coefficient table, finalized in June for the following season. Mid-season the coefficient rank is provisional. Layer 2 encodes the expected band; Layer 3 override handles the confirmed band once UEFA publishes.

3. **Mathematical locks with head-to-head tiebreakers** — `maxPointsPossible >= cutoffPts` is the right first-pass formula. But when teams finish level on points, Turkish Süper Lig uses season-specific H2H as tiebreaker. Layer 2 can flag "H2H tiebreaker risk" but cannot reliably predict the outcome from partial-season data. Layer 3 `concerns` field covers narrative handling.

**Layer 1.5 gaps (facts we should cache but don't yet):**
- BJK's full remaining fixture list (not just next one)
- Rivals' remaining fixtures (currently only their next one)
- Cup competition status (TFF bracket not in API-Football) — manual KV key `cup:status:${teamId}`
- Turkey's UEFA coefficient band for 2025-26 (changes annually) — hardcode in `EUROPEAN_RULES` constant

---

## A2. Claim mapping (ZTK article from session 22)

| Claim | Layer | Notes |
|---|---|---|
| "Trabzonspor kazanırsa → Avrupa Ligi 2. Eleme" | L2 | TFF cup allocation rule encoded in `EUROPEAN_RULES` |
| "Konyaspor/Gençlerbirliği kazanırsa → Konferans Ligi 2. Eleme" | L2 | Same rule engine, other branch |
| "Play-Off'a kalırsa seribaşı avantajını eline geçirecek" | L2 | UEFA seeding bands encoded in `EUROPEAN_RULES.seeding` |
| "Bu turlarda elenmesi durumunda UECL'den devam" | L2 | Drop-down rule in `EUROPEAN_RULES.dropDown` |
| "Braga, Olympiakos, Celtic, Rangers..." as likely opponents | L1.5 | UEFA access list for EL pot 3/4 — not in API-Football; encode manually in `EUROPEAN_RULES` as indicative |
| "Atalanta, Ajax, Freiburg, Marsilya..." as UECL playoff opponents | L1.5 | Same |
| "seribaşı olmayan tarafta yer alabilir" | L2 | Derived from Turkey's coefficient rank in UECL seeding table |
| "en avantajlı senaryo... ezeli rakibi Trabzonspor'un kazanması" | L3 | Editorial judgment — rivalry framing, narrative preference |

**Result: L3 is ~12% of claims. The hypothesis holds.**

---

## A3. European qualification rule encoding — feasibility

**Stable enough to encode.** UEFA access list changes are annual (published July/August), well-publicized, and incremental.

**Edge cases that catch most engineers:**

1. **Double-qualified team** — a team that finishes 2nd (EL) also wins the cup (also EL). Rule: take the better competition; cup slot cascades to next eligible unqualified team by league position. Cascade can chain. Must iterate the full table.

2. **Cup winner below qualification zone** — if cup winner finishes 15th, the cup slot is additional (doesn't cascade). Simple branch.

3. **Country coefficient changes slot count** — Turkey has been near the boundary for CL champion entry. For 2025-26: assume same 5-slot allocation as 2024-25, verify when UEFA publishes access list.

4. **Drop-down rules** — EL qualifying team eliminated enters UECL at a specific round (depends on which qualifying round eliminated). Small lookup table.

**Recommendation: hardcode 2025-26 rules, update annually.** Annual maintenance: ~30 minutes. Add `last_verified` date to `EUROPEAN_RULES` as a reminder.

**Effort for K3**: 2 days (rule encoding 3–4h, cascade + edge cases 1d, unit tests 4h).

---

## A4. League position math — derived signals

All buildable from data already in `getLeagueContext()`, with two additions (full remaining fixtures for BJK and rivals).

| Signal | Input | Formula | Output |
|---|---|---|---|
| Mathematical lock top-N | Full table + each team's remaining games | For team at N+1: `maxPossible = points + remaining×3`. If `bjk_points > maxPossible` → locked. | `{ locked_top4, locked_top3, locked_top2, champion }: bool` |
| Mathematical elimination | Same | `bjk_maxPossible = bjk_points + bjk_remaining×3`. If cutoff team's `points > bjk_maxPossible` → eliminated. | `{ cannot_reach_top3, etc. }: bool` |
| Best/worst case rank | Current points, remaining count, full table | Best: `+remaining×3`. Worst: `+0`. Rank range: iterate table. | `{ best_pts, worst_pts, best_rank, worst_rank }` |
| Fixture difficulty | Remaining fixtures + opponent current rank | `difficulty = (totalTeams - opponentRank) / totalTeams` | `remaining_fixtures: [{ opponent, date, difficulty, home }]` |
| Rival threat index | Rival's remaining fixtures | `threatIndex = avg(opponentDifficulty)` — low avg = high threat (easy games ahead) | `rivals: [{ ..., threatIndex }]` |
| GD tiebreaker risk | Standings gap | If `gap_to_rival ≤ 2`: flag `gd_tiebreaker_risk = true` | `{ gd_tiebreaker_risk: bool, at_risk_with: [team] }` |
| Weighted form | Last 5 results, opponent rank at time | `formScore = Σ(result_points × opponentWeight)` | `{ weighted_form: float, raw_form: 'GGBMG' }` |
| H2H tiebreaker projection | Season H2H for tied-points rivals only | Sum season H2H pts. Compare to rival's. | `h2h_advantage: { team: 'ahead'|'behind'|'even' }` |

**Already in `getLeagueContext()`**: `gaps.possible`, form last-5, rival next fixture, opponent rank.

**Need to add**: `locked_top_N`, `best_rank/worst_rank`, full remaining fixture list (BJK + rivals), `threatIndex`, GD tiebreaker risk flag. H2H projection: implement only when `gd_tiebreaker_risk = true`.

---

## A5. Editorial context schema — minimum viable

```json
{
  "manager": "Giovanni van Bronckhorst",
  "manager_stated_goal": "Top-3 garanti, Avrupa'nın en iyi kulvarına ulaşmak",
  "narrative_arc": "Erken sezon çalkantısından sonra yeniden yapılanma; tutarlı bir çıkışla sezonu kapatma",
  "transfer_posture": "Hücum hattına ciddi takviye planlanıyor; Ghezzal ve Rosier gidebilir",
  "key_editorial_dates": [
    { "date": "2025-05-18", "event": "ZTK Kupası Finali", "impact": "Avrupa kulvarı kesinleşiyor" },
    { "date": "2025-07-01", "event": "Transfer penceresi açılıyor" }
  ],
  "concerns": ["Orta sahada derinlik eksikliği", "Kanat ihtiyacı", "Genç kadro deneyimsizliği"],
  "european_path_override": "",
  "last_edited": "2026-05-14"
}
```

**Notes:**
- `season_closed` removed — derivable from Layer 2 (`locked_top_N` tells you when the league is decided).
- `key_editorial_dates`: match dates are Layer 1; transfer windows are Layer 2 constants. Keep only genuinely editorial dates (cup finals, contract deadlines) where the significance is the editorial judgment, not the date itself.
- `transfer_posture` should be injected into prompts flagged as soft/speculative, not stated as fact.
- `european_path_override`: empty string = use Layer 2 derivation. Non-empty = bypass derivation entirely.
- `last_edited` timestamp so admin knows when it was last reviewed.

**Where it lives**: `sites.editorial_context JSONB`. Matches existing per-team config pattern. One migration: `ALTER TABLE sites ADD COLUMN editorial_context JSONB DEFAULT '{}'`.

---

## A6. LLM-curation cron (Layer 3.5)

**Recommendation: yes-later — implement after K1–K5 have been running stably for 4–6 weeks.**

Don't build this before you know what well-formed Layer 3 looks like for a full season. Let a human fill it for 2 months, observe what changes and why, then write the cron prompt based on observed update patterns.

**When built:**
- Weekly cron (Wednesday 03:00)
- Source: last 14 days of Kartalix `content_items` (most reliable — already in DB, already BJK-filtered)
- Prompt must enumerate fields and explicitly forbid anything derivable from standings/fixtures/results — blocks Layer 1/2 data creeping into Layer 3
- Output: strict JSON schema validation before admin review
- Admin sees diff view, field-by-field accept/reject
- Each proposed change sourced to specific article slugs in our DB

---

## A7. Cache and freshness strategy

**Layer 1**: `league-context:${leagueId}:${season}:${teamId}` at 1h TTL already correct. **One gap**: after `generateResultFlash()` fires, standings cache isn't invalidated — next article within the hour sees pre-match standings. Fix: `env.PITCHOS_CACHE.delete('league-context:...')` at end of `generateResultFlash()`. 2-line change in K5.

**Layer 2**: Do NOT cache. `deriveSituation()` is a pure function over already-cached Layer 1 data, execution time < 2ms. Caching adds complexity with minimal benefit.

**Layer 3**: No TTL. Changes only on admin save. Direct Supabase read is fine. Add KV write-through cache at `editorial:context:${teamCode}` if it becomes a hot path at scale.

**After a match ends** (end-to-end):
1. `generateResultFlash()` fires → invalidates `league-context:*`
2. Next article generation calls `buildSituationContext()`
3. `liveFacts()` cache miss → fresh API-Football standings → fresh Layer 2
4. Article reflects new standings correctly

---

## A8. Multi-team scaling

Function signatures designed multi-tenant from day 1:

```js
export async function buildSituationContext(teamCode, season, env)
export async function liveFacts(teamCode, season, env)
export function deriveSituation(facts, rules = EUROPEAN_RULES)
export async function editorialContext(teamCode, env)
function formatForPrompt(facts, situation, editorial, lang = 'tr')
```

`EUROPEAN_RULES` keyed by season + country:
```js
const EUROPEAN_RULES = {
  '2024-25': {
    'TR': { league: { 1: {...}, 2: {...}, 3: {...}, 4: {...} }, cupWinner: {...}, dropDown: {...} },
  },
  '2025-26': { 'TR': { /* update July 2025 when UEFA publishes access list */ } },
}
```

Adding Galatasaray: same functions, `teamCode = 'GS'`, same Turkish rules, different `sites.editorial_context`. Zero refactor.

Adding a German team: add `'DE'` key to `EUROPEAN_RULES`, same function signatures. Mathematical derivations are league-agnostic.

---

## A9. Failure modes and graceful degradation

| Failure | Behavior |
|---|---|
| API-Football down | `liveFacts()` returns stale KV data. If KV also empty: returns `null`. `buildSituationContext()` returns Layer 3 editorial only. Article generation continues. |
| Layer 3 missing for new team | `editorialContext()` returns `{}`. Layer 2 paragraph still renders. Admin sees banner: "Editöryal bağlam girilmemiş." |
| UEFA changes a rule mid-season | Admin sets `european_path_override` to correct value. Layer 2 bypassed for that field. Admin banner: "Override aktif — lütfen EUROPEAN_RULES sabitini güncelleyiniz." |
| Derivation produces wrong rank | `computeMathLocks()` returns incorrect `locked_top4 = true` due to a bug | Caught by Layer 2 drift monitoring (see A10). `european_path_override` available as emergency fix. |

Per-article manual override: not in v1. If an article's context is wrong, fix the source data. Exception: skip situational context injection for `publish_mode = 'rss_summary'` (copy-only content that isn't synthesized).

---

## A10. Test strategy

**Unit tests (`test/european-rules.test.js`):**

| Scenario | Input | Expected |
|---|---|---|
| Trabzonspor wins ZTK, 2nd in league (already in EL via league) | `bjkPos: 3, cupWinner: { trabzon, leaguePos: 2 }` | `bjk: UEL Q2, cascade: true` |
| Konyaspor wins ZTK (14th in league) | `bjkPos: 3, cupWinner: { konya, leaguePos: 14 }` | `bjk: UECL Q2` |
| BJK wins ZTK while 3rd in league (hypothetical) | `bjkPos: 3, bjkCupWinner: true` | `bjk: UEL Q2, note: best comp wins` |
| Cup winner already in CL (league champion wins cup) | `bjkPos: 3, cupWinner: { champTeam, leaguePos: 1 }` | `cascade: 2 levels, bjk outcome depends on chain` |
| Mathematical lock top-4, 2 games left | `bjkPoints: 65, 5thPlacePoints: 53, 5thRemaining: 2` | `locked_top4: true` |
| Mathematical elimination from top-3 | `bjkPoints: 58, 3rdPlacePoints: 67, bjkRemaining: 2` | `cannot_reach_top3: true` |

**Frozen snapshot validation**: After 2024-25 season ends (June 2025), create `test/fixtures/bjk_2024_25_final.json` with final standings + ZTK result. Expected output: `{ competition, round, seeded }`. Verify against actual UEFA pot placement (August 2025). Run as regression test when updating `EUROPEAN_RULES` for 2025-26.

**Layer 2 drift monitoring**: after each hourly cron, recompute `deriveSituation()` and compare key fields to the previous run. Log to admin dashboard when `european_path`, `locked_positions`, or `worst_case_rank` changes. Passive smoke test + change alert in one.

---

## Function signatures and module boundaries

**New file: `src/situation.js`** (~300 lines)

```js
// Public API
export async function buildSituationContext(teamCode, season, env) → string

// Internal layers
async function liveFacts(teamCode, season, env)
// → { standings, teamRow, rivals, rivalRemainingFixtures,
//     bjkRemainingFixtures, cupStatus, form, nextFixture, fetchedAt }

function deriveSituation(facts, rules = EUROPEAN_RULES)
// → { mathLocks, europeanScenarios, rivalAnalysis, fixtureRating }

async function editorialContext(teamCode, env)
// → { manager, manager_stated_goal, narrative_arc, transfer_posture,
//     key_editorial_dates, concerns, european_path_override, last_edited }

function formatForPrompt(facts, situation, editorial) → string

// Pure functions (unit-testable)
export function computeMathLocks(table, teamRow)
export function computeEuropeanPath(facts, rules)
export function resolveCupCascade(table, cupWinnerId, rules)
export function computeRivalAnalysis(table, teamRow, rivalFixtures)

// Constants
const EUROPEAN_RULES = { /* keyed by season + country code */ }
```

**Integration points in existing files:**
- `publisher.js`: `synthesizeArticle()`, `generateOriginalNews()` — call `buildSituationContext()` in parallel with `buildGroundingContext()`, prepend as separate block
- `publisher.js` template generators: `generateMatchPreview()`, `generateMatchReport()`, `generateFormGuide()` benefit most from situational narrative
- Worker: `buildSituationContext` imported alongside `buildGroundingContext`

---

## Data model additions

```sql
-- migration 0008_sites_editorial_context.sql
ALTER TABLE sites ADD COLUMN IF NOT EXISTS editorial_context JSONB DEFAULT '{}';

-- New KV keys (no schema change needed)
-- cup:status:{teamId}          manual: { finalist1, finalist2, winner, date }
-- situation:derived:{teamCode} optional Layer 2 cache, 1h TTL
```

No new Supabase tables for v1. `league_european_spots` table already exists for the position→competition mapping.

---

## Effort estimate

| Phase | Task | Days |
|---|---|---|
| K1 | Layer 1 audit + gap-fill (remaining fixtures, cache invalidation) | 1 |
| K2 | Layer 2: math locks + rival threat + GD flag | 1 |
| K3 | Layer 2: European qualification tree (rules + cascade + drop-down + tests) | 2 |
| K4 | Layer 3: schema, migration, admin form, seed BJK context | 1.5 |
| K5 | Glue: `src/situation.js`, `formatForPrompt()`, integration into publisher.js | 1.5 |
| **Total K1–K5** | | **7 days** |
| K6 | Layer 3.5: LLM curation cron (deferred 4–6 weeks) | +3 days |

---

## Risks and unknowns

1. **Turkey 2025-26 UEFA coefficient** — finalized after 2024-25 European competitions end (May-June 2025). Slot count might change by 1. `european_path_override` handles this until `EUROPEAN_RULES` is updated.

2. **TFF cup allocation edge cases** — verify the cascade rule against a real historical case before K3 ships (e.g. 2023-24: who won the cup, what was their league position, which team received the cascaded slot?).

3. **API-Football remaining fixtures endpoint** — confirm `v3/fixtures?team=549&league=203&season=2024&status=NS` returns clean data. Quota impact: 1 extra call per cron run (amortized by 1h KV cache).

4. **Prompt length** — situational context + grounding context together could push synthesis prompt to 2,000+ tokens. Monitor whether adding the situational paragraph degrades article quality. May need a "100-word max" format variant for lower-NVS articles.

---

## Recommended implementation order

1. **K4 first** — Layer 3 schema + admin form + BJK seed data. Half a day. Immediately useful. Shows visible progress.
2. **K1** — Layer 1 gap-fill. Informs exactly what data is available for K2/K3.
3. **K2** — Mathematical locks. Simpler, builds framework confidence before the hard part.
4. **K3** — European qualification tree. Do K2 first so the structure is proven.
5. **K5** — Glue + integration. Last, after all layers individually tested.
6. **K6** — Deferred 4–6 weeks after K5 is in production.
