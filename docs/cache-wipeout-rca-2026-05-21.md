# Pool Wipeout Root Cause Analysis — 2026-05-21

## Symptom

Article pool (`articles:BJK` KV key) reached 0 across 6+ consecutive cron runs overnight. Report page showed:

> "Article pool has 0 articles (< 20) for 6 consecutive cron runs"

Pool had also gone to 0 on a previous night (at least one prior occurrence). Manual cache reload restored content.

---

## Root Cause: Three Compounding Failures

### Failure 1 — Short-TTL articles dominate the seed

**What happened:** When `articles:BJK` KV is empty or below 10 articles, `cacheToKV` falls back to seeding from Supabase (SELECT recent published articles). The seed query had no filter on `publish_mode`, so it pulled `rss_summary` articles.

**Why that's fatal:** `rss_summary` articles have `hardTtl = 2h` and `halfLife = 0.5h` in `rankAndEvict`. At night, any `rss_summary` article older than 2 hours is unconditionally evicted. So a seed of 30 articles — mostly `rss_summary` articles published 3–6 hours earlier — results in `rankAndEvict` evicting nearly all of them immediately after the seed is written.

**Timeline:**
```
23:00 — Normal cron, pool = 40 articles (mix of rewrites + videos)
01:00 — rss_summary hardTtls expire; rankAndEvict evicts them
01:05 — Pool = 8 (only rewrites + videos survive)
01:10 — KV TTL (7200s) expires on the articles:BJK key itself
01:15 — Next cron: KV miss → seed from DB → pulls 30 articles (80% rss_summary)
01:15 — rankAndEvict immediately evicts them → pool = 5 (worst case: 0)
01:20 — next cron: same pattern repeats
```

### Failure 2 — No minimum pool floor

**What happened:** `rankAndEvict` had no lower bound. If all articles score below `floor=5` (the eviction threshold), the function returns an empty array. Even a handful of high-quality rewrites could be evicted if their `_rank` decayed below 5 overnight.

**Why `_rank` decays to 0 at night:** The `halfLife` decay formula applies age penalties. A 24h-old rewrite at `halfLife=24h` has `_rank = baseScore * 0.5`. At 48h it's `0.25`. Below the floor=5 threshold, it's evicted regardless of quality.

### Failure 3 — Alarm threshold was `< 20` not `<= 20`

**What happened:** Pool at exactly 20 (the intended minimum) did not fire the alarm. First alarm triggered only after pool fell to 19 or lower. This delayed detection by 1–2 cron cycles.

---

## Fixes Applied (deployed 2026-05-20, commit `9d046b3`)

### Fix 1 — Seed exclusion

`cacheToKV` seed-from-DB query now excludes short-lived modes:

```javascript
const seedModeExclude = ['rss_summary', 'copy_source'];
// ...&publish_mode=not.in.(rss_summary,copy_source)&...
```

Only rewrites, synthesis, templates, and video embeds seed the pool. These have halfLife ≥ 24h and no hardTtl, so they survive overnight.

### Fix 2 — `minPool: 20` floor in `rankAndEvict`

`rankAndEvict` now accepts a `minPool` option. After normal eviction, if `survived.length < minPool`, the function rescues the highest-ranked sub-floor articles to hit the minimum:

```javascript
if (minPool > 0 && survived.length < minPool) {
  const subFloor = scored.filter(a => a._rank > 0 && a._rank < floor)
    .sort((a, b) => b._rank - a._rank);
  const needed = Math.min(minPool - survived.length, subFloor.length);
  if (needed > 0) survived.push(...subFloor.slice(0, needed));
}
```

`cacheToKV` always passes `minPool: 20`.

### Fix 3 — Alarm at `<= 20`

Heartbeat alarm threshold changed from `poolSize < 20` to `poolSize <= 20`. Message updated to `(≤ 20 — at minimum floor)`. A pool at exactly 20 is already at the rescue floor — an alarm at that point gives 1 cron cycle of lead time before it could go lower.

---

## Observability

Pool composition snapshots are now written to `pool_ts:BJK` (KV, 576 entries, 3-day TTL) on every `cacheToKV` call. The `/admin` report page shows a stacked area chart of pool composition over time, making overnight drains visible retroactively.

---

## Remaining Risks

1. **If seed DB is genuinely empty** (< 10 articles across all non-rss_summary modes), `minPool=20` cannot rescue to 20 — it can only rescue what exists. This scenario would require publishing new content to DB before the pool recovers.

2. **KV TTL on `articles:BJK`** is 7200s (2h). If a cron run fails to write (network error, exception), the KV key expires and the next run hits the seed path again. The seed exclusion fix prevents the worst-case but a 2h gap is still possible in a cron failure scenario.

3. **Long-term pool decay:** If no new rewrites or synthesis articles publish for 3+ days (e.g., Claude API outage), the pool ages down and `halfLife` decay pushes all articles below floor=5. `minPool=20` rescues them but serves stale content. No automated alert for this case yet.

---

## Related

- `docs/DECISIONS.md` — 2026-05-20 pool drought fix entry
- `src/publisher.js` — `rankAndEvict` minPool implementation (~line 1060)
- `worker-fetch-agent.js` — pool-timeseries endpoint, heartbeat alarm
