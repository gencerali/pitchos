# Synthesis Failure RCA — 2026-05-21

**Trigger**: 16 of 19 NVS≥50 articles failed synthesis in last 24h (84% failure rate). Cost $3.90, below cap. Fix 3 now deployed — `synthesis_failed` is a distinct stage going forward.

---

## Q4 — synthesizeArticle code audit (from src/publisher.js:397)

### Source fetching

- **Proxy**: `https://pitchos-proxy.onrender.com` — Render **free tier** (cold start 10–30s)
- **Warm-up**: one `/health` call before the loop if any article has nvs≥50 (`publisher.js:557-562`). If warm-up took >5s (cold start detected), adds 3s grace period.
- **Fetch loop**: 2 attempts, 15s `AbortSignal.timeout` per attempt, 4s delay between. `publisher.js:413-428`
- **Min content gate**: `data.content.length > 400` — if proxy returns <400 chars, `sourceText` stays null → synthesis skipped. `publisher.js:420`
- **Truncation**: `data.content.slice(0, 10000)` — source capped at 10,000 chars passed to LLM. `publisher.js:421`
- **No RSS fallback**: if proxy fails, synthesis is skipped entirely. No fallback to RSS summary. `publisher.js:437-440`

### Failure gates (each returns `{ body: null }`)

1. `sourceText === null` → proxy fetch failed OR content < 400 chars → **synthesis skipped**. `publisher.js:437`
2. `checkContentCoversTitlePromise` returns false → Haiku call, EVET/HAYIR gate. `publisher.js:443-447`
3. `REFUSAL_SIGNALS` match in LLM output → 18 Turkish/English phrases detected. `publisher.js:499-522`
4. `body.length <= 600` → checked in `writeArticles` at `publisher.js:611` — body not null but too short → stays rss_summary silently (no console.log for this path)

### Per-run cap

- Max 6 rewrites per cron run. `publisher.js:607`. Overflow enqueued to KV `rewrite:queue:BJK` for hourly drain.
- **Cap was NOT the bottleneck in the 16-failure event**: only 3 succeeded, so cap of 6 was not hit. Remaining 13+ failures had other causes.

### LLM call

- `max_tokens: 1000` (`publisher.js:493` — `callClaude(env, MODEL_GENERATE, prompt, false, 1000)`)
- Turkish at 150–400 target words ≈ 200–550 tokens. 1000 limit is generous. **Token truncation is not the failure mode.**
- `targetWords` based on fact bullet count: <4 bullets → 150-200 words; 4-6 → 200-300; 7+ → 300-400.

### drop_detail limitation (Fix 3)

Fix 3 sets `drop_detail = 'synthesis_cap_or_source_unavailable'` for **all** synthesis_failed rows, regardless of actual failure reason. This is a single label covering 4 distinct failure modes. It distinguishes synthesis_failed from scored_low but does not sub-classify the failure reason. See "Proposed logging improvement" below.

---

## Q3 — Is discarded synthesis output logged anywhere?

**No.** When `synthesizeArticle` returns `{ body: null }`, the caller at `publisher.js:621-623` logs to console only:
```
SYNTHESIS SKIPPED [nvs]: "title" — no source, stays rss_summary
```

No KV write. No DB write. Cloudflare logs are ephemeral (not queryable after ~1h without a tail session). The discarded LLM output (when it exists but is refused/too short) is also not captured.

**Proposed improvement** (do not implement yet — part of "Investigate template_transfer prompt" task):

Add to `synthesizeArticle` before returning `{ body: null }` after LLM call:

```javascript
// Store last failed synthesis sample for RCA visibility (truncated, best-effort)
if (body && body.length > 0) {
  env.PITCHOS_CACHE.put(
    `synth:failed:${srcUrl.slice(-60)}`,
    JSON.stringify({ title: article.title, body: body.slice(0, 500), reason: 'thin_or_refused', ts: new Date().toISOString() }),
    { expirationTtl: 86400 }
  ).catch(() => {});
}
```

---

## Q1/Q2/Q5 — Run these in Supabase SQL editor

Note: Fix 3 was deployed at `a7b84e0e` (2026-05-21 ~12:18 UTC). `synthesis_failed` stage does not exist in pipeline_log before that timestamp. Use the reinterpretation query below for historical data.

### Q1 — synthesis_failed breakdown (historical reinterpretation, last 24h)

```sql
SELECT 
  url,
  source_name,
  nvs_score,
  source_body_len,
  drop_detail,
  LEFT(title, 60) AS title_60,
  run_at
FROM pipeline_log
WHERE site_id = '2b5cfe49-b69a-4143-8323-ca29fff6502e'
  AND run_at > NOW() - INTERVAL '24 hours'
  AND (
    stage = 'synthesis_failed'
    OR (stage = 'scored_low' AND nvs_score >= 50)
  )
ORDER BY run_at DESC;
```

**What to look for**: `source_body_len` distribution. If many rows have `source_body_len < 600`, RSS feed is providing thin summaries. This does NOT mean the proxy also returned thin content — `source_body_len` tracks RSS summary length, not proxy-fetched content. But thin RSS bodies correlate with thin proxy results.

### Q2 — Source body fetch quality by source

```sql
SELECT 
  source_name,
  COUNT(*) AS total,
  ROUND(AVG(source_body_len)) AS avg_rss_len,
  COUNT(*) FILTER (WHERE source_body_len < 600) AS thin_rss_count,
  COUNT(*) FILTER (WHERE source_body_len >= 600) AS full_rss_count,
  COUNT(*) FILTER (WHERE nvs_score >= 50 AND (stage = 'scored_low' OR stage = 'synthesis_failed')) AS synth_failed_count
FROM pipeline_log
WHERE site_id = '2b5cfe49-b69a-4143-8323-ca29fff6502e'
  AND run_at > NOW() - INTERVAL '24 hours'
  AND source_body_len IS NOT NULL
GROUP BY source_name
ORDER BY synth_failed_count DESC, total DESC;
```

### Q3 — Published rewrite body lengths (the 3 that succeeded)

```sql
SELECT 
  title,
  source_name,
  LENGTH(full_body) AS body_len,
  nvs_score,
  published_at
FROM content_items
WHERE site_id = '2b5cfe49-b69a-4143-8323-ca29fff6502e'
  AND publish_mode = 'rewrite'
  AND published_at > NOW() - INTERVAL '24 hours'
ORDER BY published_at DESC;
```

### Q5 — Failure pattern: by source

```sql
SELECT 
  source_name,
  COUNT(*) AS synth_failed,
  ROUND(AVG(nvs_score)) AS avg_nvs,
  ROUND(AVG(source_body_len)) AS avg_rss_len
FROM pipeline_log
WHERE site_id = '2b5cfe49-b69a-4143-8323-ca29fff6502e'
  AND run_at > NOW() - INTERVAL '24 hours'
  AND (
    stage = 'synthesis_failed'
    OR (stage = 'scored_low' AND nvs_score >= 50)
  )
GROUP BY source_name
ORDER BY synth_failed DESC;
```

**If 10+ failures from one source** → source-specific fetch problem (paywall, redirect, thin content).  
**If spread across 5+ sources** → proxy pipeline problem (cold start, timeout, Render outage).

---

## Primary hypothesis (pre-data)

The Render free tier proxy is the most likely culprit. Evidence:

1. Render free tier hibernates after 15min inactivity. Cold start = 10–30s.
2. The warm-up call (`/health`) has a 35s timeout. If Render is hibernated, warm-up succeeds — but only after 10–30s. The code then adds a 3s grace period.
3. But warm-up only warms the `/health` handler. The `/article` endpoint may still be slow on first request.
4. Each `/article` fetch has 15s timeout. If Render is still booting when the first real fetch arrives, it times out.
5. After 2 failed attempts (30s total), `sourceText = null` → synthesis skipped.
6. With 16/19 failures and no source-specific concentration, a proxy-wide issue (cold start or Render outage window) explains the pattern better than per-source problems.

**Alternative hypothesis**: `checkContentCoversTitlePromise` is rejecting articles where the fetched source genuinely doesn't match the RSS title (different story, paywalled intro, etc.). This would show up as spread failures too. Cannot distinguish from proxy failure without per-attempt logging.

---

## What's missing to close this RCA

1. **DB query results** (Q1/Q2/Q5) — run the SQL above in Supabase dashboard
2. **Cloudflare log tail during a cron run** — `npx wrangler tail --format pretty | grep "SYNTHESIS\|PROXY"` — shows real-time pass/fail with reasons
3. **Render status during the failure window** — check Render dashboard logs for 2026-05-20 18:00–22:00 UTC for downtime or slow responses

---

*Status: PARTIAL — Q4/Q3 complete from code. Q1/Q2/Q5 require DB queries above.*
