# Pool Wipeout Root Cause Analysis — 2026-05-21

**Investigation scope**: Why does `articles:BJK` (KV) reach 0 at night? Requested by `temp/8 wipe out invest.txt`.

---

## 1. KV keys used for the live pool

| Key | TTL | Purpose |
|---|---|---|
| `articles:BJK` | **7200s (2h)** | Live article pool — the single key the homepage reads |
| `kv:timeline:BJK` | 90 days | Per-slug first/last-seen audit trail |
| `pool_ts:BJK` | 3 days | Pool composition time-series snapshots (chart) |
| `churn:BJK:YYYY-MM-DD` | 16 days | Daily added/removed counts for KPI strip |

Only `articles:BJK` matters for pool availability. Its TTL is 2 hours.

**File:line**: `src/publisher.js:1095` — `env.PITCHOS_CACHE.put(key, value, { expirationTtl: 7200 })`

---

## 2. Code paths that WRITE to `articles:BJK`

`cacheToKV(env, siteCode, articles)` is the only write function. Call sites:

| Location | Trigger | Notes |
|---|---|---|
| `worker-fetch-agent.js:5353` | Normal cron (every 2h `0 */2 * * *`) | Main pipeline path. Merges new articles + existing KV |
| `worker-fetch-agent.js:4751` | Cron with 0 articles after preFilter | Emergency seed: pulls DB, writes if KV is empty |
| `worker-fetch-agent.js:4759` | Cron quiet run (0 articles, KV non-empty) | Re-ranks existing KV to apply decay |
| `worker-fetch-agent.js:1052` | Admin manual promote | Article promoted from DB into feed |
| `worker-fetch-agent.js:1284` | Lineup card generation | Template card merged into pool |
| `worker-fetch-agent.js:1595` | Hourly rewrite-queue drain | Drains pending rewrites into pool |
| `worker-fetch-agent.js:3294` | H5 synthesis | Synthesis output merged into pool |
| `worker-fetch-agent.js:3866` | Rabona daily digest | Rabona article merged into pool |
| `worker-fetch-agent.js:4164–4469` | Match watcher (every 5 min during matches) | Template cards (goals, FT, HT) merged |

**Conditions that do NOT write**: If `processSite` throws an uncaught exception before reaching line 5353, no write happens and the existing KV entry ages toward its 2h expiry.

---

## 3. Code paths that EVICT from the pool

All eviction happens inside `rankAndEvict` (`src/publisher.js:954`), which is called exclusively by `cacheToKV`. There is no separate delete path.

Three eviction mechanisms:

### A — Hard TTL (unconditional)
`HARD_TTL_BY_MODE` (`src/publisher.js:838`):
- `rss_summary`: evict after **2h**
- `copy_source`: evict after **12h**
- `manual`: evict after **168h**

`HARD_TTL_BY_TEMPLATE` (`src/publisher.js:829`):
- Live event cards (T10, T-HT, T-RED etc.): 3h
- Match result T11: 12h
- Lineup T09: 12h
- Match report T12/T13: 72h
- Match preview T01/T03: 36h

Hard-TTL articles get `_rank = -1` and are always dropped, regardless of `minPool`.

### B — Soft floor (score decay)
`HALF_LIFE_BY_MODE` (`src/publisher.js:821`):
- `rewrite`, `synthesis`, `original_synthesis`, `synthesis_generated`, `video_embed`: **24h** half-life
- `rss_summary`: **0.5h** half-life
- `copy_source`: **3h** half-life
- `manual`: **96h** half-life
- Any mode not in the map: **8h** half-life (default)
- Templates: per `HALF_LIFE_BY_TEMPLATE` (varies 3–24h)

Decay formula: `rank = nvs * exp(-ageHours / halfLife) * storyBoost`. Articles below `floor=5` are soft-evicted. **Since `minPool:20` was added**, if all survive above floor, good. If not, the highest-ranked sub-floor articles are rescued up to 20 total — but hard-TTL (`_rank=-1`) articles are never rescued.

### C — Overflow cap
Pool capped at 200 articles. Lowest-ranked articles above 200 are dropped with reason `overflow`. Rarely hits this in practice.

---

## 4. Cron schedule and empty-window risk

```
*/5 * * * *   — matchWatcher + alarmChecks (article pipeline only during live match)
0 */2 * * *   — main article pipeline: processSite → cacheToKV
0 4 * * *     — daily archival + source tests
0 3 * * 1     — weekly editorial notes redistill
0 2 * * 0     — weekly voice pattern extraction
```

The main pool refresh is **every 2 hours** (`0 */2 * * *`).

`articles:BJK` TTL is **7200s = exactly 2 hours**.

**Gap risk**: If the cron at e.g. 02:00 runs slightly late, or the `cacheToKV` write at the end of `processSite` fails (exception, timeout), the KV key expires before the next cron at 04:00. That is a **0-article window of up to 2h**.

---

## 5. Overnight drain — reconstructed timeline

```
~22:00  rss_summary articles fill pool (hardTtl=2h, published ~20:00)
~00:00  hardTtl expires → rankAndEvict evicts all rss_summary on next cron write
~00:00  Pool drops to only rewrites + videos (may be 8–15 articles)
~02:00  Cron runs. KV key not yet expired (still within 2h TTL window)
~02:00  preFilter yields 0 new articles (quiet night). "quiet run" path:
         → reads existing KV (8–15 articles), passes to cacheToKV
         → rankAndEvict re-ranks with decay, 2h-old rewrites still above floor
         → pool survives at 8–15
~02:00  KV TTL resets to 7200s from this write ← KEY POINT
~04:00  Cron runs again. If KV expired in between AND cron yields 0 new:
         → KV is null → "seed from DB" path fires
         → [BEFORE FIX] seed pulled rss_summary → rankAndEvict immediately evicts → pool=0
         → [AFTER FIX]  seed excludes rss_summary/copy_source → rewrites survive → pool=20+
```

Root cause was **at line 4735** (the emergency seed path), which used `GOOD_MODES_SEED` including `rss_summary`. Articles pulled from DB at night were ~3–6h old rss_summary articles, which `rankAndEvict`'s hardTtl=2h evicted immediately, leaving pool empty.

**File:line (old, bad)**: `worker-fetch-agent.js:4735` — the `GOOD_MODES_SEED` array included `rss_summary`  
**File:line (new, fixed)**: `worker-fetch-agent.js:5323-5325` — `seedModeExclude = ['rss_summary','copy_source']` with `not.in.()` filter

---

## 6. Rebuild from Supabase — is it automatic?

**Yes, automatic** — two paths:

**Path 1** (`worker-fetch-agent.js:4732`): triggered when `preFilter` returns 0 articles AND `articles:BJK` KV is null or empty. Seeds from DB using a whitelist of good modes.

**Path 2** (`worker-fetch-agent.js:5318`): triggered at the end of every `processSite` run when `latestKV.length < 10`. Seeds from DB using mode exclusion.

Both are automatic — no manual action needed. The bug was that the seeded articles were immediately evicted by `rankAndEvict`, making the automatic recovery invisible (it ran, but produced 0 survivors).

---

## 7. The minPool:20 floor — where is it?

`src/publisher.js:1021–1028`:

```javascript
if (minPool > 0 && survived.length < minPool) {
  const subFloor = scored
    .filter(a => a._rank > 0 && a._rank < floor)
    .sort((a, b) => b._rank - a._rank);
  const needed = Math.min(minPool - survived.length, subFloor.length);
  if (needed > 0) {
    survived.push(...subFloor.slice(0, needed));
    survived.sort((a, b) => b._rank - a._rank);
  }
}
```

`cacheToKV` always passes `minPool: 20` (`src/publisher.js:1046`):
```javascript
const { articles: ranked, evictedReasonMap } = rankAndEvict(articles, 200, { minPool: 20, ...opts });
```

Hard-TTL articles (`_rank === -1`) are excluded from the rescue pool — they are permanent evictions. Only `_rank > 0 && _rank < floor` articles are eligible for rescue.

---

## 8. Proposed proper fix — recommendation

The three fixes already applied address the root cause. For completeness, the four options evaluated:

### Option A — KV with no TTL, manually managed
Write `articles:BJK` with no `expirationTtl`. Pool persists until explicitly overwritten.

**Pro**: Eliminates the 2h expiry gap entirely. Pool never goes dark from TTL alone.  
**Con**: Stale articles never age out automatically if the cron stops writing (e.g. Claude API outage, worker exception). A deployment bug could serve the same 30-day-old article indefinitely.  
**Verdict**: Too risky. Stale-forever is worse than occasionally empty.

### Option B — KV with longer TTL than refill interval (with buffer)
Current: TTL=7200s, cron=every 2h. Change TTL to e.g. 10800s (3h) — 50% buffer over the cron interval.

**Pro**: Tolerates one cron failure or late run before KV expires.  
**Con**: Still fails after two consecutive missed writes (e.g., overnight Claude API outage). Does not fix the seed-quality bug (now fixed separately).  
**Verdict**: Cheap improvement but not sufficient alone. Could layer on top of current fixes.

### Option C — Supabase-backed with KV as cache (rebuild on miss) ✅ CURRENT APPROACH
Article serving reads KV. On KV miss, reads from Supabase directly. `cacheToKV` is called every cron cycle but is not the last line of defense.

**Pro**: KV expiry never equals dark site — Supabase is always authoritative. Cache miss is slow (adds ~300ms DB latency) but correct.  
**Con**: Requires `serveArticlePage` and homepage render to handle KV miss gracefully. Currently the homepage (`/`) and article pages (`/haber/*`) do have Supabase fallbacks.  
**Verdict**: **This is the correct architecture** and it's already partially in place. The gap was seed quality, not the architecture itself.

### Option D — Extend TTL to 4h (small improvement, no risk)
Change `expirationTtl: 7200` to `expirationTtl: 14400` (4h). Gives 2h of buffer over the 2h cron.

**Pro**: Tolerates one complete missed cron without expiry.  
**Con**: Doesn't address the seed quality issue (now fixed). Stale articles serve for up to 4h after a full cron failure.  
**Verdict**: Low-risk improvement worth doing. Doesn't conflict with any current fix.

---

## Summary — current state after fixes

| Root cause | Fix applied | Status |
|---|---|---|
| Seed includes rss_summary (hardTtl=2h, evicted immediately) | `seedModeExclude = ['rss_summary','copy_source']` | ✅ Deployed `9d046b3` |
| No floor prevents eviction to 0 | `minPool: 20` in `rankAndEvict` | ✅ Deployed `9d046b3` |
| Alarm fired too late (< 20 not ≤ 20) | Threshold changed to `<= 20` | ✅ Deployed `9d046b3` |
| KV TTL = cron interval (no buffer) | Not yet changed | ⚠️ Remaining risk |

**Recommended follow-up**: Change `expirationTtl: 7200` → `expirationTtl: 14400` at `src/publisher.js:1095`. Low-risk, one-line change, adds 2h buffer against a single missed cron write.
