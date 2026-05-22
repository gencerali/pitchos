# Duhuliye Special Handling + Keyword Sync Investigation (2026-05-19)

Produced by Claude Code from prompt `1.kartalix_duhuliye_keywords_audit_prompt.txt`.  
**Diagnose only. No code changes.** Ali reviews before any action.

---

## Task 1 — Duhuliye off_topic rate verification

### Data discrepancy — two conflicting figures

The audit prompt states a 42% off_topic rate (21/50 articles in last 5 runs). The pipeline diagnostic (`docs/pipeline-diagnostic-2026-05-19.md`) from May 15 data shows 4% off_topic (7/177 Duhuliye articles, 7-hour window, 11 cron runs).

**The two figures are from different populations at different times:**

- The **pipeline diagnostic** (4%) is from 2026-05-15 data, a period dominated by NTV Spor (109 rows) which inflated the total pipeline volume. Duhuliye's absolute count was 177 rows in a ~7h window.
- The **42% figure** likely comes from a different export with a smaller Duhuliye-specific sample (50 articles, 5 runs), possibly from a period when the NTV volume was lower or the window was shorter.

**More importantly**: Both figures are pre-Fix-A. Fix A (replacing `BJK_REGEX` with `BJK_KEYWORDS` in preFilter) was deployed in this session. **The current rate is unknown and should be the actual reference point.** All analysis below is based on the pre-Fix-A data.

### Classification of 7 confirmed off_topic Duhuliye articles (May 15 data)

From `docs/pipeline-diagnostic-2026-05-19.md` — the diagnostic already identified all 7:

| # | Title | Classification | Keyword that should match |
|---|---|---|---|
| 1 | Sergen Yalçın: ''Kazanarak ligi tamamlamak istiyoruz..'' | **BJK direct** — coach quote | "sergen yalçın" / "sergen" |
| 2 | ''Konyaspor maçında bizim için her şey bitmişti..'' | **BJK direct** — anonymous quote clearly in BJK context | No clear single keyword; context-dependent |
| 3 | Sergen Yalçın kalacak mı? Kendisi açıkladı! | **BJK direct** — coach continuity article | "sergen yalçın" / "sergen" |
| 4 | Orkun Kökçü rekor peşinde! | **BJK direct** — BJK player article | "orkun kökçü" / "orkun" |
| 5–7 | (Sergen Yalçın quote article — 4 runs, same URL) | **BJK direct** — repeated re-entry of same article | "sergen yalçın" / "sergen" |

**Category counts:**
- BJK direct: **7 of 7** (100%)
- BJK indirect: 0
- Non-BJK league: 0
- Non-BJK other: 0

**All 7 Duhuliye off_topic articles were false positives.** The root cause was the BJK_REGEX/BJK_KEYWORDS split: the preFilter used `BJK_REGEX = /beşiktaş|besiktas|bjk|kartal|siyah.beyaz/i` (4 club name variants) while the fetch-time filter used `BJK_KEYWORDS` (45 entries including coach and player names). An article titled "Sergen Yalçın: '...'" passes the fetch-time filter (matches "sergen yalçın") but fails preFilter (no club name in title/short summary).

**Fix A resolves all 7 cases.** After Fix A, preFilter uses `BJK_KEYWORDS` like the fetch-time filter. "sergen yalçın", "orkun kökçü", and all other player/coach names now match at both stages.

### Post-Fix-A expectation

Duhuliye off_topic rate should fall to near 0% for normal BJK-related articles. The only remaining off_topic cases would be:

1. Articles where Duhuliye publishes genuinely non-BJK content (general Turkish football context pieces, league-wide analysis with no BJK player/name in title+first 600 chars+summary). The diagnostic found none in the May 15 sample, consistent with Duhuliye being BJK-only.
2. Articles where the title is so generic (e.g., anonymous quotes with no names at all) that no keyword matches. Example: article #2 above — "Konyaspor maçında bizim için her şey bitmişti..." — has no player name, no club name variant. This is a structural gap, not a keyword gap.

**Recommended verification**: After Fix A has run for 3+ cron cycles, re-export pipeline_log and count Duhuliye off_topic rows. If rate is < 5%, no further action needed. If rate remains elevated, re-examine article bodies for the anonymous-quote pattern.

---

## Task 2 — Current BJK_KEYWORDS content audit

### Full BJK_KEYWORDS array (src/utils.js lines 15–45)

```javascript
export const BJK_KEYWORDS = [
  // Club name variants (4 entries)
  'beşiktaş','besiktas','bjk','kartal',
  // Goalkeepers
  'ersin destanoğlu','ersin destanoglu','ersin',
  'devis vasquez','vasquez',
  // Defenders
  'amir murillo','murillo',
  'emmanuel agbadou','agbadou',
  'tiago djalo','djalo',
  'felix uduokhai','uduokhai',
  'emirhan topçu','emirhan topcu','emirhan',
  'rıdvan yılmaz','ridvan yilmaz','rıdvan',
  'taylan bulut','taylan',
  'gökhan sazdağı','gokhan sazdagi',
  // Midfielders
  'orkun kökçü','orkun kokcu','orkun',
  'wilfred ndidi','ndidi',
  'kristjan asllani','asllani',
  'salih uçan','salih ucan',
  'kartal kayra yılmaz','kartal kayra',
  // Forwards
  'milot rashica','rashica',
  'junior olaitan','olaitan',
  'tammy abraham','abraham',
  'vaclav cerny','cerny',
  'el bilal touré','el bilal toure','el bilal',
  'hyeon-gyu oh','hyeon gyu oh','hyeon-gyu','oh hyeon',
  'jota silva','jota',
  'cengiz ünder','cengiz under','cengiz',
  'mustafa hekimoğlu','hekimoğlu','hekimoglu',
  // Coach + management
  'sergen yalçın','sergen yalcin','sergen',
  'serdal adalı','serdal adali','serdal',
  // Other player
  'mert günok','mert gunok',
  'jean onana','onana',
];
```

**Total**: 45 keyword strings covering ~26 unique players/staff + 4 club variants.

### Cross-reference against known 2025–26 BJK squad

**Note**: This cross-reference uses knowledge from training data (≤August 2025). Post-window signings are not reflected. A live API-Football call would be authoritative.

**Players in BJK_KEYWORDS with confirmed BJK status (2025–26)**:
- Ersin Destanoğlu ✅ (starting GK)
- Devis Vásquez ✅ (2nd GK)
- Amir Murillo ✅ (RB)
- Emmanuel Agbadou ✅ (CB)
- Tiago Djaló ✅ (CB, on loan from Juventus)
- Félix Uduokhai ✅ (CB)
- Emirhan Topçu ✅ (LB)
- Rıdvan Yılmaz ✅ (LB/MF — on loan from Rangers or returned)
- Taylan Bulut ✅ (utility)
- Gökhan Sazdağı ✅ (utility)
- Orkun Kökçü ✅ (CM, captain)
- Wilfred Ndidi ✅ (DM)
- Kristjan Asllani ✅ (CM, on loan from Inter)
- Salih Uçan ✅ (MF)
- Kartal Kayra Yılmaz ✅ (youth/utility)
- Milot Rashica ✅ (W)
- Júnior Olaitan ✅ (W)
- Tammy Abraham ✅ (ST, on loan from Roma)
- Václav Černý ✅ (W)
- El Bilal Touré ✅ (ST)
- Hyeon-gyu Oh ✅ (ST, on loan from Celtic)
- Jota Silva ✅ (W, on loan from Benfica)
- Cengiz Ünder ✅ (W)
- Mustafa Hekimoğlu ✅ (youth striker)
- Sergen Yalçın ✅ (head coach)
- Serdal Adalı ✅ (sporting director / club management)
- Mert Günok ✅ (GK — may be at another club; verify)
- Jean Onana ✅ (DM — may have departed; verify)

**Players NOT in BJK_KEYWORDS (likely missing)**:

| Player | Role | Status | Priority to add |
|---|---|---|---|
| Semih Kılıçsoy | ST | Confirmed BJK player (mentioned in session context) | **HIGH** |
| Gabriel Paulista | CB | May be on squad (verify with API) | Medium |
| Al-Musrati | DM | Portuguese DM who joined BJK (verify) | Medium |
| Any summer 2025 signing | Various | Unknown — list was last updated before summer window | High (window opens ~6 wks) |

**Players in BJK_KEYWORDS who may have departed**:

| Player | Risk | Note |
|---|---|---|
| Mert Günok | Medium | Long-term BJK GK, may have left; verify |
| Jean Onana | Medium | Contracted to Inter, loan may have ended; verify |
| Tiago Djaló | Low | On loan from Juventus — still at BJK but loan-in |

The risk of stale entries is low for now — former players are still news subjects (transfer follow-ups, comparisons). However, searching for "onana" would hit Jean Onana in general (there is also André Onana at Manchester United), creating potential false negatives on non-BJK stories mentioning Onana. Same risk applies to single-name entries like 'jota' (there are other players named Jota), 'cerny', 'vasquez', 'abrahar'. These are accepted tradeoffs — specificity vs. recall.

### Last modification date of BJK_KEYWORDS

From `git log src/utils.js`:

```
1bf572c  Session 14: KV next-match cache, admin tools, voice patterns cron, feed hotfix
4c7ccde  Add BJK_KEYWORDS squad filter for journalist/international feeds
```

The commit `4c7ccde` ("Add BJK_KEYWORDS squad filter for journalist/international feeds") is the first introduction. No subsequent commits to `utils.js` added to the keyword list — it has been **manually maintained at zero updates** since initial creation. Session 14 (approximately 2026-05-13) touched `utils.js` for other reasons but did not update the keyword list.

**Process**: Manual edit by Ali in initial session. No automated sync. Never updated since creation.

---

## Task 3 — API-Football data availability

### Squad endpoint

**Endpoint**: `GET /players/squads?team={teamId}`  
`teamId` for Beşiktaş: `549` (hardcoded in `src/api-football.js` as `BJK_ID`)

**Currently in codebase**: NO. `src/api-football.js` has no squad endpoint function. Existing player-related endpoints are fixture-scoped: `getFixtureLineup()` (pre-match starting XI for a specific fixture) and `getFixturePlayers()` (post-match player ratings for a specific fixture). Neither returns the full registered squad.

**Response shape** (from API-Football v3 documentation):
```json
{
  "response": [{
    "team": { "id": 549, "name": "Beşiktaş JK", "logo": "..." },
    "players": [{
      "id": 12345,
      "name": "Ersin Destanoğlu",
      "age": 24,
      "number": 1,
      "position": "Goalkeeper",
      "photo": "..."
    }]
  }]
}
```

### Loan status in squad endpoint

**Not available reliably.** The `/players/squads` response does NOT include a loan flag. It returns all players registered with the team regardless of loan status. Players loaned OUT (BJK player playing elsewhere) do NOT appear in the squad response — they appear only in the receiving club's squad. Players loaned IN (e.g., Tiago Djaló from Juventus) appear in BJK's squad response.

To detect loan status explicitly: would require calling `/transfers?player={playerId}` and checking `transfer.type == "Loan"` with `transfer.teams.in.id == 549`. This is a secondary call per player — expensive and overkill for keyword maintenance.

**Practical approach**: Include all players returned by `/players/squads?team=549`. Players loaned OUT will be absent from the response automatically (they won't appear in BJK's squad). Players loaned IN will be present and correctly included. This matches the "current squad at BJK" definition without needing explicit loan status.

### Coach data

**Available.** Two paths:
1. `GET /coachs?team={teamId}` — returns current head coach with name, nationality, career history
2. `getFixtureLineup(fixtureId, env)` already returns `lineup.coach.name` (currently used in match templates)

For keyword sync purposes, path 1 is cleaner: one call, always current coach name.

### Rate-limit implications

- `/players/squads`: 1 API request per call
- `/coachs?team=549`: 1 API request per call
- Current plan (Pro): ~300–500 requests/day based on wrangler config
- Weekly sync would use 2 requests once per week → negligible impact
- Even daily sync: 2 requests/day out of 300–500 budget = well within limits

---

## Task 4 — Existing squad sync logic

### Search results

Searching `worker-fetch-agent.js` and all source files for `squad`, `players`, `roster`, `lineup`:

- **`/players/squads`**: Not present anywhere in the codebase
- **`squad_members`**: Referenced only in the ROADMAP roadmap admin releases page (v1.1 planned feature description). No SQL migrations, no queries, no JS code.
- **`getFixtureLineup()`**: EXISTS — in `src/api-football.js`, returns starting XI for a specific fixture. Used in T08c/T05 template generation. This is fixture-scoped, not season-squad-scoped.
- **`getFixturePlayers()`**: EXISTS — returns player ratings for a completed fixture. Post-match only.

**Conclusion**: No existing squad sync logic. The `squad_members` table is documented in the releases roadmap page as a v1.1 planned feature ("Squad Intelligence") but has no code, no migrations, and no KV keys.

### Effort estimate for minimal squad sync

A minimal implementation that pulls squad weekly and writes to KV (no DB table):

```
src/api-football.js: add getSquad() function (~15 lines)
worker-fetch-agent.js: add weekly cron call for syncSquad() (~20 lines)
src/utils.js: add getEffectiveBjkKeywords(env) function that merges
  static base keywords + dynamic player names from KV (~20 lines)
processor.js + fetcher.js: update bjkMatch call sites to pass env (~5 lines each)
```

Estimated 1–2 hours for the minimal version. Does not require a new DB table — KV is sufficient for a flat list of keyword strings. The full `squad_members` table design (with loan status, position, name_variations) would add another 2–3 days but is not needed for the filtering use case.

---

## Task 5 — Proposed integration shape

### 1. Static base keywords (manually maintained)

Suggest keeping this set permanently in `utils.js` regardless of squad sync:

```
Club name variants: 'beşiktaş', 'besiktas', 'bjk', 'kartal'
Stadium: 'vodafone park' (currently absent — add)
Ultras: 'çarşı' (currently absent — consider adding)
Abbreviations: 'bjk' (already present)
```

These never churn. A new coach name would be the only manual addition needed if the club name variants stay stable.

**Rationale**: Even if dynamic sync fails (API down, key expired), these 6–8 entries are enough to catch virtually all on-topic news. The pipeline degrades gracefully without player-name keywords — it just loses precision on player-specific articles.

### 2. Dynamic player/coach keywords (weekly sync from API-Football)

Implementation shape:
- `getSquad(env)` in `src/api-football.js` calls `/players/squads?team=549`
- Returns array of player objects: `[{id, name, position}]`
- `syncBjkKeywords(env)` in `worker-fetch-agent.js`:
  - Fetches squad + coach
  - Normalises each name: full name + transliterations (é→e, ğ→g, etc.) + last name alone
  - Writes `keywords:bjk` KV key: `JSON.stringify({ updated_at, keywords: [...] })`
  - TTL: 7 days (sync runs Sunday, TTL ensures stale keywords are never used >7 days after the last successful sync)
- `getEffectiveBjkKeywords(env)` in `src/utils.js`:
  - Reads `keywords:bjk` KV
  - Falls back to hardcoded `BJK_KEYWORDS` if KV is empty/expired
  - Returns merged array: static base + dynamic player names

This ensures the pipeline never breaks due to API failure — hardcoded list is always the fallback.

### 3. Loan handling — include or exclude?

**Recommendation: include BOTH loaned-in and loaned-out players**, for different durations:

| Player type | Include in keywords | Duration |
|---|---|---|
| Permanent squad | Yes | Until departure confirmed |
| Loaned IN (at BJK) | Yes | Duration of loan |
| Loaned OUT (BJK player at another club) | Yes, but with 90-day post-departure window | Transfer news continues for months |

**Argument for including loaned-out**: A player loaned out on July 1 generates news all through the following season (loan updates, return rumors, performance tracking). Removing them immediately means all such articles are off_topic. The 90-day window covers the peak news cycle.

**Argument against**: Loaned-out players may no longer be BJK news subjects if the loan becomes permanent or they return to a third club. Single-name entries (like "jota") can hit other players.

**Practical resolution**: The `/players/squads` endpoint naturally includes loaned-IN players (they register with BJK). For loaned-OUT players, the old entry stays in the keyword list as long as it was in the last API response within 90 days — implement via a "last_seen_in_squad" timestamp per player in the KV cache.

### 4. Departed-but-recent-news handling

**Recommendation: 90-day retention after departure**, regardless of whether articles say "former Beşiktaş."

Transfer news about a departed player typically peaks in the first 2–4 weeks and tapers off over 3 months. A player who left in the summer is still generating Kartalix-relevant news through October. After that, the news is no longer primarily about BJK — it's about their new club.

One exception: if a departed player's name is very common (e.g., "Abraham" — Tammy Abraham has multiple homonyms in football), the keyword can create false hits for unrelated players. These should be evaluated case by case. For most BJK player names (Turkish or unusual foreign names), false hit risk is low.

### 5. Duhuliye-specific handling options

After Fix A (BJK_KEYWORDS in preFilter), the off_topic rate for Duhuliye should fall to near 0%. The question of a Duhuliye override is therefore **likely moot**.

If the post-Fix-A rate still shows false positives (specifically the anonymous-quote articles where no name appears in title or short summary), three options:

**Option A — Source override: skip off_topic check for Duhuliye entirely**
- Pro: Matches Duhuliye's BJK-only mandate. Eliminates all Duhuliye false positives.
- Con: If Duhuliye ever publishes a non-BJK article (league-wide piece, general football), it flows through unchecked. Duhuliye's current editorial scope makes this low risk.
- Implementation: 1 line in preFilter: `if (article.source_name === 'Duhuliye') return true`

**Option B — Soft threshold: lower off_topic requirement for Duhuliye (1-keyword match)**
- Not applicable. The current check already requires 1-keyword match (any single keyword triggers pass). The issue isn't threshold — it's keyword coverage. This option doesn't help.

**Option C — No override: accept remaining off_topic rate**
- Pro: Simplest. No code change.
- Con: Anonymous-quote articles with no names (pattern: `''Konyaspor maçında bizim için...''`) will continue to be rejected. This is a small fraction of Duhuliye's output.
- If the post-Fix-A rate is < 5%, Option C is probably the right call.

**Recommendation: Option C for now.** Measure post-Fix-A Duhuliye off_topic rate after 3 cron cycles. If < 5%, accept it. If > 5%, implement Option A — it's a 1-line change with clear reasoning.

The anonymous-quote pattern (no player or coach name in title) could also be addressed by extending `BJK_KEYWORDS` with Duhuliye-specific signals like `'yönetim'`, `'teknik direktör'`, `'hoca'` — but these are too generic and would cause false passes on non-BJK articles from other sources.

---

## Summary — findings and open questions

| Item | Finding | Action required |
|---|---|---|
| Duhuliye pre-Fix-A off_topic rate | 4% (May 15 data, 7/177) — all false positives, all caused by BJK_REGEX gap | No separate fix needed — Fix A resolves these |
| Duhuliye post-Fix-A rate | Unknown — measure after Fix A runs 3+ cron cycles | Re-export pipeline_log in 24–48h |
| Semih Kılıçsoy | Confirmed BJK player (mentioned in session context) — NOT in BJK_KEYWORDS | **Add immediately**: `'semih kılıçsoy','semih kilicsoy','semih'` |
| Other missing players | Unknown — requires live API-Football call to verify full squad | No action until squad sync is implemented |
| BJK_KEYWORDS last updated | Never since initial creation (commit 4c7ccde) | Squad auto-sync would solve this structurally |
| Loan status in API-Football | Not in squad endpoint; derivable from /transfers but expensive | Exclude-by-absence approach is sufficient |
| API-Football squad endpoint | `/players/squads?team=549` — not yet in codebase; trivial to add | 1–2h effort for minimal KV-backed implementation |
| Duhuliye override | Likely unnecessary after Fix A; verify rate first | Option C (no override) recommended until post-Fix-A data available |
| Post-transfer-window risk | Summer window opens in ~6 weeks; new signings will be missing | Schedule squad sync implementation before window opens (see open-items doc Item 4) |

---

*Stop here. Awaiting Ali's review.*
