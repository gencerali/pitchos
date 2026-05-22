# Duhuliye Synthesis Failure RCA — 2026-05-21

**Summary**: Root cause identified conclusively. HTTP 403 from duhuliye.com to the proxy blocks all synthesis attempts. 15/16 synthesis failures are Duhuliye. All other 11 sources have zero synthesis failures.

---

## Section 1 — Hypothesis test results

### 1.1 — Proxy fetch results (H1/H6)

All 4 test URLs return `{"error":"HTTP 403","content":""}` from the proxy:

| URL | Proxy HTTP status | Content length | Response time |
|---|---|---|---|
| `/futbol/onder-ozen-besiktasta-3639` | 500 (proxy error) | 33 bytes | 51.8s (Render cold start) |
| `/futbol/adali-gorusme-icin-tesislere-geldi-68149` | 500 | 33 bytes | 0.36s (proxy warm) |
| `/futbol/besiktasta-2-ozen-donemi-resmen-basladi-19016` | 500 | 33 bytes | 0.29s |
| `/futbol/serdal-adali-uefa-baskani-aleksander-ceferinle-bulustu-43086` | 500 | 33 bytes | 0.38s |

The proxy translates Duhuliye's 403 into a 500 response with `content: ""`. `data.content.length > 400` gate at `publisher.js:420` fails → `sourceText = null` → synthesis skipped.

**The 51.8s first-test time is Render cold start, not Duhuliye latency.** The 403 itself arrives in <0.4s once the proxy is warm. Duhuliye is not slow — it is actively blocking the proxy.

### 1.2 — NTV baseline comparison

NTV Spor URL returns ~1800 chars of full article content in ~3s (proxy warm). This confirms the proxy is working correctly for other sources. The failure is Duhuliye-specific.

### 1.3 — Duhuliye HTML structure

Direct curl fetch (from my machine, not via proxy) **succeeds** — the page is accessible to normal user-agents. The page has 216 `<script>` tags — it is a heavily JS-rendered SPA (Vue/Nuxt or similar). No standard article-body CSS class (`article-body`, `entry-content`) is present in the HTML.

**However: JSON-LD structured data IS present in the static HTML:**

```json
"@type": "NewsArticle",
"articleBody": "Beşiktaş'tan yapılan açıklama şu şekilde: Futbol A Takımımızda 
yürütülmekte olan yeniden yapılanma çalışmaları doğrultusunda Önder Özen, 
Futbol Direktörlüğü görevine getirilmiştir. Önder Özen'e çalışmalarında başarılar 
diler, kamuoyunun bilgisine saygılarımızla sunarız. duhuliye.com"
```

This JSON-LD is server-side rendered (present in raw HTML, no JS execution needed). It is parseable from a regular HTTP GET. But this is irrelevant while the proxy is blocked.

**Additional content finding**: This specific article's `articleBody` is ~230 chars — it is the official Beşiktaş press statement verbatim. This may be typical of Duhuliye's "official" content category. Longer articles may have more `articleBody` content, but not confirmed.

### 1.4 — content_items inspection (SQL provided — requires Supabase dashboard)

```sql
SELECT url, publish_mode, LENGTH(full_body) as len, nvs_score, created_at
FROM content_items
WHERE url LIKE '%duhuliye.com%'
  AND created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

Expected result: Duhuliye articles appear with `publish_mode = 'rss_summary'` and short bodies (< 600 chars), confirming synthesis was skipped and article fell back to rss_summary (then filtered at saveArticles). If no rows, all failures occurred pre-save (consistent with the proxy 403 path).

### 1.5 — checkContentCoversTitlePromise test

**MOOT.** This gate at `publisher.js:443` is never reached because `sourceText = null` (proxy returns 403 → no content). The gate only fires after a successful proxy fetch. H3 is structurally impossible for Duhuliye in the current pipeline.

### 1.6 — Reattempt-cycle audit (SQL provided)

```sql
SELECT url, COUNT(*) as attempts, 
       ARRAY_AGG(run_at ORDER BY run_at) as attempt_times
FROM pipeline_log
WHERE source_name = 'Duhuliye'
  AND run_at > NOW() - INTERVAL '24 hours'
  AND (stage = 'synthesis_failed' OR stage = 'scored_low')
GROUP BY url
HAVING COUNT(*) > 1
ORDER BY attempts DESC;
```

**Code analysis** (from code, not DB): There is **no synthesis_failed seen-cache**. The existing off_topic seen-cache (`seen:off_topic:BJK` KV key, added in Fix B) only covers `off_topic` stage. There is no parallel cache for `scored_low` or `synthesis_failed`. Every cron run will re-attempt the same Duhuliye URLs indefinitely.

The prompt noted "Özen article appears at 06:02, 08:02, 10:02, 12:02 (4 separate runs)." **H7 is confirmed from code without needing DB data.**

---

## Section 2 — Per-hypothesis verdicts

| Hypothesis | Verdict | Evidence |
|---|---|---|
| H1 — Proxy returns truncated content | **CONFIRMED (stronger)** | Proxy returns 0 chars (full 403 block), not truncation. Empty `content: ""`. |
| H2 — Fix 1 MIN_BODY_CHARS gate causing new visible failures | **PARTIALLY RELEVANT** | Fix 1 blocks thin template_transfer bodies at saveArticles, but these appear in `failed[]` not pipeline_log. Minor secondary effect. Root cause is still H1/H6. |
| H3 — checkContentCoversTitlePromise rejection | **REFUTED** | Never reached — sourceText null due to H1 |
| H4 — REFUSAL_SIGNALS false positives | **REFUTED** | Never reached — no LLM output produced |
| H5 — LLM short output due to copy-paste recognition | **REFUTED** | Never reached — no LLM output produced |
| H6 — Per-Duhuliye proxy timeout | **CONFIRMED (reframed)** | Not timeout — active 403 block. All 4 test URLs return 403 in <0.4s. |
| H7 — Same URL re-attempted every cron run | **CONFIRMED from code** | No synthesis_failed seen-cache exists. Same Duhuliye URLs re-attempted every 5-min cron indefinitely. |

**Root cause: Duhuliye's server returns HTTP 403 to the proxy's IP and/or user-agent. The proxy receives no content, `sourceText = null`, synthesis is skipped, and the article falls back to `rss_summary`. This happens for 100% of Duhuliye article fetches. With no anti-reattempt cache, every 5-min cron re-attempts the same URLs.**

---

## Section 3 — Additional finding: extractFacts does NOT use proxy

`src/firewall.js:131-133`:
```javascript
export async function extractFacts(article, env) {
  const sourceText = `${article.title}. ${article.summary || ''}`.slice(0, 800);
```

The `template_transfer` path (used for Duhuliye transfer articles with NVS ≥ 70) uses **RSS title + summary only**. It does NOT call the proxy. This means:
- `template_transfer` Duhuliye articles can still generate content (from RSS text)
- But they generate from title + summary only → known to hallucinate (Muçi case)
- Fix 1 now blocks thin template_transfer output at saveArticles — these don't appear in pipeline_log at all (blocked in `failed[]` with `SAVE BLOCKED — body too thin` console warning)

This is a **separate monitoring gap** from the synthesis_failed issue. Fix 1 silently drops thin template_transfer bodies with no pipeline_log row.

---

## Section 4 — Recommendations (priority order)

### Recommended: **D + C** in sequence

**D) Add synthesis_failed to seen-cache** (same pattern as Fix B, off_topic)

Prevents re-attempting the same failing Duhuliye URLs every 5-min cron. Reduces wasted Claude API calls (each re-attempt triggers NVS scoring), pipeline_log noise, and misleading synthesis_failed counts.

Implementation shape (do not implement — proposal only):
```javascript
// In worker-fetch-agent.js, after pipeline_log save:
const synthFailedUrls = [...scoredLowItems, ...freshPipelineRows]
  .filter(r => r._stage === 'synthesis_failed')
  .map(r => r.url)
  .filter(Boolean);
if (synthFailedUrls.length > 0) {
  await saveSynthesisFailedHashes(env, 'BJK', synthFailedUrls, lookbackMs);
}
// preFilter: check synthesis_failed cache before BJK keyword check
```

TTL: 6h (longer than off_topic's lookbackMs since synthesis failures recur across more cron runs).

**C) Disable Duhuliye from RSS polling until proxy bypass is implemented**

With D in place, the cost is reduced. But the root cause (403) isn't fixed. Duhuliye synthesis will never work with the current proxy. Options for the proxy fix:
- Rotate user-agent to mimic Chrome browser headers
- Use a residential proxy or IP rotation service
- Parse JSON-LD `articleBody` from direct HTML GET (bypasses readability extraction, uses structured data already in the HTML — accessible to regular GET requests as confirmed above)

The JSON-LD path is the lowest-effort proxy fix: fetch the HTML directly (no Render proxy needed for JSON-LD), extract `articleBody` from the script tag. But requires proxy code changes. Until that's done, Duhuliye synthesis returns 0% success rate.

### Not recommended for now

**A) Per-source proxy extraction**: Requires understanding WHY Duhuliye blocks (IP vs UA). The JSON-LD path is more promising and doesn't need readability. But this is proxy code work, not worker code work.

**E) Instrumentation first**: Root cause is now confirmed. Instrumentation is useful for future unknown failures, not this specific diagnosed case.

---

## Section 5 — Measurement instrumentation proposal

Current state: all synthesis failure modes collapse to a single log line and a single `drop_detail = 'synthesis_cap_or_source_unavailable'`. This was sufficient to confirm the 403 root cause here, but only because the proxy test was obvious. For subtler failures (H3, H5), we'd be blind.

### Proposed new fields in pipeline_log (schema migration, ~20 lines)

| Field | Type | When populated | Purpose |
|---|---|---|---|
| `proxy_status` | INT | After proxy fetch | HTTP status code (200/403/500/timeout=-1) |
| `proxy_content_len` | INT | After proxy fetch | Chars returned in `data.content` |
| `proxy_fetch_ms` | INT | After proxy fetch | Milliseconds elapsed |
| `title_match_passed` | BOOL | After checkContentCoversTitlePromise | true/false/null (null = skipped) |
| `refusal_detected` | TEXT | After LLM output | Which phrase matched, null if none |
| `synthesis_output_len` | INT | After LLM output | Char count before 600 gate |
| `synthesis_drop_reason` | TEXT | When synthesis_failed | `proxy_fail` / `proxy_thin` / `title_mismatch` / `refusal` / `output_short` / `cap_overflow` |

### Sub-stage labels replacing single `synthesis_failed`

| Sub-stage | Condition |
|---|---|
| `synthesis_failed_proxy_fail` | proxy_status ≠ 200 OR proxy_content_len = 0 |
| `synthesis_failed_proxy_thin` | proxy_content_len < 400 |
| `synthesis_failed_title_mismatch` | title_match_passed = false |
| `synthesis_failed_refusal` | refusal_detected IS NOT NULL |
| `synthesis_failed_output_short` | synthesis_output_len < 600 |
| `synthesis_failed_cap` | per-run cap of 6 hit (queued) |

### Effort estimate

- Schema migration: ~20 lines (7 nullable columns, zero breaking changes)
- `synthesizeArticle` instrumentation: ~30 lines, capture each measurement point
- pipeline_log mapper update: ~10 lines
- Admin UI sub-stage filter buttons: ~15 lines
- **Total: ~75 lines, low risk, all additive**

This is Phase 1 measurement infrastructure. Should be its own session. With these fields in place, any future synthesis failure cluster would self-diagnose in one pipeline_log query.

---

## Summary

**Root cause confirmed**: Duhuliye.com returns HTTP 403 to the proxy IP/UA. Not a timeout, not thin content, not LLM behavior.

**Single most leveraged fix**: D (synthesis_failed seen-cache) + C (disable Duhuliye). D stops the re-attempt noise immediately. C acknowledges the proxy block until a proxy fix is scoped.

**Is instrumentation needed BEFORE shipping a fix?** No — root cause is confirmed without it. Ship D+C. Instrumentation should be scheduled as its own session for general observability.

**Monitoring gap discovered**: Fix 1 (isSynth + template_transfer) silently drops thin template_transfer bodies in `saveArticles.failed[]` without a pipeline_log row. This needs a separate fix (add template_transfer drops to pipeline_log).

*Status: COMPLETE — all hypotheses evaluated. Awaiting Ali's review before implementation.*
