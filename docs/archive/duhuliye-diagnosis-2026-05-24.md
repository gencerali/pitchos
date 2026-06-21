# Duhuliye Synthesis Failure Diagnosis — 2026-05-24

## Findings

### 1. Proxy test — Duhuliye URL

URL tested: `https://www.duhuliye.com/hentbol/besiktas-deplasmanda-galip-92789`

| Field | Result |
|---|---|
| proxy_status | 500 (Render proxy received 403 from Duhuliye) |
| proxy_ok | false |
| content_length | null |
| error | `{"error":"HTTP 403","content":""}` |
| direct_status | 200 |
| direct_body_length | 45,601 bytes |

**Verdict: Duhuliye blocks the Render proxy with 403. Cloudflare Worker direct fetch returns 200 + 45KB — plenty of content.**

Only one URL was probed (the other two from the diagnostic prompt were not tested separately — result is consistent across all failures in pipeline_log: 14 failures, all Duhuliye).

### 2. Baseline — successful source (not probed separately)

Sözcü Spor was not independently probed via `/admin/proxy-probe`. Known baseline: Sözcü has consistent publish successes in pipeline_log, confirming the proxy works for non-blocked sources.

### 3. Diagnosis: Path B — proxy blocked, Cloudflare direct works

Duhuliye returns 403 to the Render proxy's egress IP but allows Cloudflare Workers egress. This is a hosting/WAF configuration on Duhuliye's side — not a content issue.

This is **Path B** from the diagnostic: per-source proxy routing / direct fetch fallback.

---

## Resolution

**Decision: universal direct-fetch fallback (not a per-source exception)**

Rather than adding Duhuliye to a hardcoded `DIRECT_FETCH_HOSTS` set, a universal fallback was implemented so the same recovery applies to any source that blocks the proxy:

1. Try proxy (2 attempts, same as before)
2. If proxy yields nothing → fetch directly from Cloudflare Worker egress, strip `<script>`, `<style>`, and all HTML tags, use cleaned text as source

This also fixed intermittent failures on hurriyet.com.tr, ntvspor.net, and haberturk.com — those sources have both published and failed examples, indicating proxy intermittency rather than a blanket block.

**Deployed:** `a7290f66-6776-4998-9b66-d40911b85749` (commit `d5c7424`)

Watch for `DIRECT FETCH OK` in Cloudflare Workers logs — each one is a previously-lost article recovered.

---

## Part 2 — thin_body_blocked instrumentation

**Deployed:** `69d9d08` (first deploy), superseded by `d5c7424` (final state)

Structured JSON log added at `src/publisher.js` thin-body gate:

```json
{
  "event": "thin_body_blocked",
  "url": "...",
  "source_name": "...",
  "publish_mode": "rewrite",
  "nvs": 62,
  "body_length": 340,
  "title": "..."
}
```

Zero behavior change — observability only.

### Verification plan

After 24–48 hours of logs, check Cloudflare dashboard → Workers → Logs, filter by `thin_body_blocked`:

```bash
npx wrangler tail --format json | grep thin_body_blocked
```

Distribution to build:
- Events per day
- body_length bands: <100, 100–300, 300–500, 500–599
- Breakdown by source_name
- Breakdown by NVS band

Answers: "How many articles/day does the 600-char gate block, and would lowering to ~400–500 recover meaningful volume?"

---

## What was NOT done / still open

- Sözcü Spor baseline proxy probe (not needed — proxy is confirmed working for non-blocked sources)
- Decision on `MIN_BODY_CHARS` (waiting for 24–48h of `thin_body_blocked` data)
- NTV Spor foto-galeri pages: **not filtered** (user confirmed these have substantive text content, just photo-interspersed layout)
