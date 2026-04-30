# API-Football Coverage Verification — Süper Lig / BJK

Date: 2026-04-30
Plan: Pro ($19/mo, 7,500 req/day)

---

## Subscription status

- Plan: Pro
- Active: true
- Expiry: 2026-05-30
- Requests used at start of verification: 0
- Daily limit: 7,500

---

## Süper Lig identifiers

- league.id: **203**
- league.name: **Süper Lig** (no sponsor prefix in 2025–26 season — previously "Trendyol Süper Lig")
- current season: **2025** (2025-08-08 → 2026-05-17)

Note: the league name returned by `/leagues` is the string to use in article copy. Do not hardcode "Trendyol Süper Lig" — the sponsor prefix is dropped this season.

---

## Coverage flags (Süper Lig, season 2025)

All flags verified from live `/leagues?country=Turkey&current=true` response:

| Flag | Value |
|------|-------|
| fixtures.events | **true** |
| fixtures.lineups | **true** |
| fixtures.statistics_fixtures | **true** |
| fixtures.statistics_players | **true** |
| standings | **true** |
| players | **true** |
| top_scorers | **true** |
| top_assists | **true** |
| top_cards | **true** |
| injuries | **true** |
| predictions | **true** |
| odds | **true** |

All 12 flags true. Full coverage for current season.

---

## Beşiktaş identifiers

- team.id: **549**
- team.name: Beşiktaş
- team.code: BES
- team.founded: 1903
- venue.id: 20423
- venue.name: Tüpraş Stadyumu
- venue.city: İstanbul
- venue.capacity: 43,500
- venue.surface: grass

---

## Test fixture

- fixture.id: **1394705**
- date: 2026-04-27T17:00:00+00:00
- match: Beşiktaş 0–0 Fatih Karagümrük (home)
- round: Regular Season - 31
- referee: B. Kolak
- venue: Besiktas Park (Tüpraş Stadyumu)

Golden file: `docs/procurement/fixtures/golden-bjk-1394705.json`
Raw API response, unredacted. Used as the normalisation fixture for Track A slice work.

---

## Event-level depth assessment

### Events
- Total events in fixture: **13** (5 cards, 8 substitutions)
- No goal events — expected for a 0–0 result
- Event types returned: `Card`, `subst` (goal events confirmed present in API schema when goals occur)
- No shot events in the events array — shots are not tracked as individual timeline events

### Shot coordinates
**ABSENT.** API-Football does not return x/y shot coordinates at any level. The `shots` object in player statistics contains only `{total: null, on: null}` (per-player, not populated even when the team took 20 shots in this match). Fixture-level statistics return team totals (Shots on Goal, Total Shots, Shots insidebox/outsidebox) but with no positional data.

Shot maps via mplsoccer are **not viable from API-Football alone.** A second vendor (StatsBomb Open Data for historical, or a live positional data provider) would be required for shot location data.

### Lineups
**Fully populated:**
- Formation strings present: 4-1-4-1 (BJK), 4-4-2 (opponent)
- Each player has: id, name, number, pos (G/D/M/F), grid ("row:col" string, e.g. "1:1")
- 11 starters + 10 substitutes per team

### Per-player statistics
**Ratings present and populated:**
- Sample: Devis Vásquez (GK) → rating 7.9 / 90 min
- Sample: Taylan Bulut (outfield) → rating 7.3 / 90 min, 46 passes, 2 key passes, 90% accuracy, 1 tackle, 2 dribble attempts

**Populated for outfield players:** passes (total, key, accuracy %), tackles (total, blocks), dribbles (attempts, success), duels (total, won), fouls (drawn, committed)

**Not populated:** shots per player (total and on-target both null even for players who likely took shots — team had 20 shots total). Per-player shot attribution is absent.

### Fixture-level statistics (BJK)
| Stat | Value |
|------|-------|
| Shots on Goal | 7 |
| Shots off Goal | 8 |
| Total Shots | 20 |
| Shots insidebox | 13 |
| Shots outsidebox | 7 |
| Ball Possession | 70% |
| Total passes | 687 |
| Passes accurate | 615 |
| Passes % | 90% |
| Corner Kicks | 5 |
| Fouls | 12 |
| Yellow Cards | 2 |
| Red Cards | None |
| Goalkeeper Saves | 3 |
| expected_goals (xG) | 2.02 |
| goals_prevented | 1.48 |

xG is present at fixture level — usable in T12 Match Report copy.

---

## Quota consumed by this check

| Step | Endpoint | Requests |
|------|----------|----------|
| Step 2 | /status | 1 |
| Step 3/4 | /leagues?country=Turkey&current=true | 1 |
| Step 5 | /teams?league=203&season=2025 | 2 (one retry due to encoding issue) |
| Step 6 | /fixtures?team=549&season=2025&status=FT&last=1 | 1 |
| Step 7 | /fixtures?id=1394705 | 1 |
| Step 9 | /status | 1 |
| **Total** | | **6 of 7,500** |

At 6 requests per full verification run, the daily limit is effectively unlimited for verification purposes. Production polling budget is addressed in Track A slice planning.

---

## Implications for Track A slice

- **Player ratings ARE returned** → T13 Man of the Match article can use vendor rating directly, no custom model needed in v1. Ratings appear to be populated for all players who played.

- **Shot coordinates ARE NOT present** → mplsoccer shot maps are not viable from API-Football alone. Do not plan visual shot-map templates (T-series) that require positional data in v1. If shot maps are wanted, scope a second data source in v2.

- **Per-player shots NOT attributed** → "top shooter" player stat is unavailable per-player. Use fixture-level total shots for team context in match reports. Do not attempt per-player shot leaderboard in T12/T13.

- **Lineups fully supported with formation + grid positions** → T05 Lineup Announcement is fully viable. Formation string and positional grid available for layout rendering.

- **xG present at fixture level** → Include xG context in T11 Result Flash and T12 Match Report. BJK had 2.02 xG in a 0–0 — this is editorially meaningful.

- **All 12 coverage flags true for Süper Lig 2025** → No coverage gaps. Injuries, standings, player stats all available. No need for a second source to fill API-Football holes.

---

## Open questions / risks

- **League name changes by season:** The sponsor prefix ("Trendyol") was present in 2024–25 but absent in the 2025–26 API response. Code must read `league.name` dynamically, not hardcode any string. This should be a note in the `normalizeFixture` function in `src/api-football.js`.

- **Per-player shots are null even when team has shots:** Unknown whether this is a general API-Football limitation for Süper Lig or specific to this fixture. Worth checking one more fixture with goals before T13 is built, to confirm whether ratings and shot data populate correctly in a high-action game.

- **Key rotation:** The API key used in this verification (`4e3...`) was shared in plain text in chat. Rotate it before Track A slice work begins. New key goes into Cloudflare Workers secret `API_FOOTBALL_KEY` via `npx wrangler secret put API_FOOTBALL_KEY`.
