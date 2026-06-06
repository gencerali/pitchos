# Source Health (Module 1.1)

Per-source pass-rate / dead-feed monitoring over `pipeline_log` (7-day retention). Observe-only
by default; auto-disable is flag-gated.

## What it does
- **`src/source-health.js` `computeSourceHealth(rows, knownSources, opts)`** (pure, tested) →
  per source: `fetched`, `published`, `passRate`, `drops{stage}`, `zeroDays`, `lastRunAt`, `status`.
  - `status`: **dead** (≥3 consecutive zero-fetch days), **noisy** (≥20 fetched, <10% pass),
    **idle** (0 fetched, <3 zero-days), **healthy**.
- **`runSourceHealth(env)`** (daily 04:00 cron) → stores `source_health:report:{code}`, a compact
  `source_health:alarms`, and (only if `source_health:auto_disable='1'`) sets `is_active=false`
  on feeds dead ≥3 days.

## Where to look
- **Report (JSON):** `GET /admin/source-health` (per site).
- **Alarms:** dead/noisy feeds appear in `/admin/alarms` (the section below reports).

## Operate
- **Arm auto-disable (default OFF):** `wrangler kv key put --namespace-id=dedaea653ed542cca25e6cc2551dd1c3 source_health:auto_disable 1`. Disarm: `0`.
- A feed auto-disabled here can be re-enabled by setting its `source_configs.is_active=true`.

## Notes / overlap
- Complements the existing `source_disappeared` + `source_test_fail` alarms (presence/fetch),
  adding **quality** (pass-rate, drop breakdown, noisy detection) + **auto-disable**.
- Window is 7 days (pipeline_log retention); `zeroDays` therefore caps at 7.
- An optional HTML report page on `/admin` is a later **supervised** GUI step (JSON endpoint exists now).
