# Cost Ceiling (Module 1.6) — build tracker

Adds **daily** spend tracking, a **daily cap**, and a **month-end trajectory** projection on top
of the existing monthly cap (`addCost`/`checkCostCap`, `cost:YYYY-MM`, `cost:cap`). Built
step-by-step with per-step approval; observe-only by default, enforcement flag-gated.

## Operator GUI requirements (locked 2026-06-06)
- On `/admin/financials` → **"Maliyet"** tab: a **cost-over-time graph** with **time-interval
  scrolling and/or filters** (day / week / month range).
- **Warnings** (trajectory on pace to exceed cap, daily overage) shown on that page.
- **Alarms** go into the **existing alarms section below the reports** — not a new location.

## Steps
1. ✅ **Daily spend tracking** — `addCost` also increments `cost:day:YYYY-MM-DD` (TTL ~35d).
   Backend only; no GUI/user impact. Tests: `src/__tests__/cost.test.js`.
2. ✅ **Trajectory compute** — pure `costTrajectory(env, now?)` projects month-end from
   **max(month-to-date avg, trailing-7-day avg)** so a recent spike isn't masked by a cheap
   early month. Returns `{monthSpend, todaySpend, cap, dayOfMonth, daysInMonth, avgPerDayMTD,
   avg7d, projMTD, proj7d, projectedMonthEnd, projectionBasis, pctOfCap, projectedPctOfCap,
   onTrack}`. No side effects, no callers acting on it yet. Tests in `cost.test.js`.
3. ✅ **Daily cap + soft alarm (observe-only)** — pure `costAlarmConditions(traj, override)`
   (daily cap default `cap/daysInMonth`; trajectory alarm at >100% projected). Detected in
   `runAlarmChecks` (sets `alarm_first_seen.cost_trajectory`/`cost_daily` + detail), rendered
   in `/admin/alarms` (the alarms section). Blocks nothing. Tests in `cost.test.js`.
4. ✅ **Enforcement (flag-gated, default OFF)** — `checkCostCap` also blocks AI calls on daily
   overage **only** when KV `cost:daily_enforce = "1"`; returns `reason: 'monthly'|'daily'`.
   Default OFF = zero behavior change. Tests in `cost.test.js`.
5a. ✅ **Durable daily archive (2-yr retention)** — `cost:daily_archive` KV doc; `archiveDailyCost`
   rolls live `cost:day:*` into it in the 04:00 cron and prunes >730 days. Pure `rollupDailyCost`
   (merge live-over-archive + prune). History fills forward; past stays monthly. Tests in `cost.test.js`.
5b. ✅ **GUI** — daily-spend bar chart (Chart.js, reused) + **7/14/30/90/365/730** filters +
   trajectory **warning banner** on the Maliyet tab; route serves `daily` (archive+live) +
   `trajectory`. Alarms already in the alarms section (Step 3). **Supervised: eyeball on deploy.**

---

## 1.6 COMPLETE ✅ — how to operate
- **See it:** `/admin/financials` → "Claude Maliyeti" tab — daily chart + range filters + on/off-track banner. Alarms: `/admin/alarms`.
- **Tune the daily cap:** `wrangler kv key put --namespace-id=dedaea653ed542cca25e6cc2551dd1c3 cost:daily_cap 0.60` (default = monthly cap / days-in-month).
- **Arm daily enforcement (default OFF):** `… cost:daily_enforce 1` (blocks AI calls past the daily cap, like the monthly cap). Disarm: set `0`.
- **Verify after deploy (supervised):** open the Maliyet tab → chart renders, filters switch ranges, banner shows; check `/admin/alarms` shows cost_trajectory when projected > cap.

## KV keys
- `cost:YYYY-MM` — monthly spend (existing)
- `cost:day:YYYY-MM-DD` — daily spend (Step 1, TTL ~35d)
- `cost:cap` — monthly cap override (existing)
- `cost:daily_cap` — daily cap override (Step 3)
- `cost:daily_enforce` — `"1"` to enable daily blocking (Step 4)
