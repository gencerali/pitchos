# Seasonal maintenance checklist

Most date/season logic is **self-updating** (derived from the clock) — but a few values are
hardcoded because they must match the data provider exactly. Review these **once a year, ~August**
before the new season starts.

## You'll be reminded automatically
When the hardcoded `SEASON` falls behind the calendar, a **`season_stale` alarm** appears on
**`/admin/alarms`** (minor severity) telling you exactly what to change. So you don't have to
remember the date — the system nags you. (Logic: `seasonConfigStale()` in `src/api-football.js`.)

## What to update each new season (~August)
1. **`src/api-football.js` → `const SEASON`** — bump to the new season's start year
   (e.g. `2025` → `2026` for 2026/27). This is the main one; the alarm watches it.
   - Then deploy the worker (push to `main` → the Deploy Worker Action runs).
2. **Verify IDs are still correct** (rarely change):
   - `BJK_ID` (team), `SUPERLIG` (league) in `src/api-football.js`.
   - Confirm the new-season fixtures are live on the provider before relying on standings/next-match.

## What you do NOT need to touch (self-updating)
- **Archive-video filter** (`src/youtube.js`): drops match highlights whose season tag is older
  than the current season, and stale highlight uploads — current season is derived from the clock
  (`currentSeasonStartYear`). No hardcoded year.
- General "this season / current week" display logic that reads live fixtures.

## If you change the sports-data provider
- The only API-coupled spot for video freshness is the (future) `getSeasonWeek` adapter — see the
  note in `src/youtube.js`. The pure `qualifyYouTubeVideo` freshness/season-tag logic is
  provider-independent (uses the video's own YouTube upload date + title).
- `SEASON` + the IDs above move to whatever the new provider uses; update `seasonConfigStale()` if
  the season numbering differs.
