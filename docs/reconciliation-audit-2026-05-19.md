# Reconciliation Audit — Claimed vs Actual Code
**Date:** 2026-05-19  
**Trigger:** Fix B claimed "shipped or in progress" in multiple session summaries; code-level check found it was never implemented.

---

## Item 1 — Fix A: preFilter uses BJK_KEYWORDS
**Status: SHIPPED**

- `src/processor.js:29` calls `bjkMatch(haystack)` — NOT `BJK_REGEX.test(...)`
- `src/processor.js:1` imports `bjkMatch` from `utils.js`
- `src/utils.js:112-116` defines `bjkMatch()` using `keywords.some()`

---

## Item 2 — Fix B: off_topic seen cache
**Status: NOT SHIPPED** (confirmed)

- `getOffTopicHashes` — NOT FOUND anywhere
- `saveOffTopicHashes` — NOT FOUND anywhere
- KV key `seen:off_topic:` — NOT FOUND anywhere
- `src/processor.js:350-355` has `getSeenHashes`/`saveSeenHashes` for the general URL-dedup cache (`seen:${siteCode}`), but this is unrelated
- preFilter at `src/processor.js:9` calls `bjkMatch()` with no off_topic caching layer

---

## Item 3 — NTV Spor bjk_filter=true
**Status: CANNOT VERIFY — requires live Supabase query**

```sql
SELECT name, bjk_filter FROM source_configs WHERE name ILIKE '%NTV%';
```

Run against production DB to confirm.

---

## Item 4 — Global Media source disabled/removed
**Status: CANNOT VERIFY — requires live Supabase query**

```sql
SELECT name, source_type, active FROM source_configs WHERE name ILIKE '%global%media%';
```

Run against production DB to confirm.

---

## Item 5 — article.trust → article.trust_tier field rename
**Status: PARTIAL**

Both `.trust` (old) and `.trust_tier` (new) coexist everywhere via fallback pattern:

- `src/processor.js:18,31,39,52,68` — `a.trust_tier || a.trust` (read)
- `src/processor.js:243` — `a.trust_tier || a.trust`
- `src/fetcher.js:164` — writes `trust_tier: feed.trust` (mapping old→new at ingest)
- `src/fetcher.js:220` — `feed.trust || feed.trust_tier`
- `src/publisher.js:124` — `article.trust_tier || article.trust` in `decidePublishMode()`
- `src/publisher.js:469` — `article.trust_tier === 'official'` ✓
- `src/publisher.js:738` — `tierToTrustScore(a.trust_tier || a.trust)`

The rename happened structurally (new field written at ingest, read by downstream) but the old `.trust` fallback was never removed. DB rows from before the rename still rely on the fallback.

---

## Item 6 — Rewrite quality fix (transient fact extraction)
**Status: SHIPPED**

All four pieces present:
- `src/publisher.js:372-395` — `extractFactsFromSource()` defined ✓
- `src/publisher.js:449-454` — called inside `synthesizeArticle()` within `Promise.all()` ✓
- `src/publisher.js:461-463` — targetWords tiers: `'300-400'` (7+ facts), `'200-300'` (4-6), `'150-200'` (0-3) ✓
- `src/publisher.js:466` — `KAYNAKTAN DOĞRULANAN BİLGİLER` block injected into prompt ✓

---

## Item 7 — AdSense compliance fixes
**Status: SHIPPED (8/8)**

1. `shouldShowAds` function — `worker-fetch-agent.js:5885-5890` ✓
2. `ADSENSE_SCRIPT` constant — `worker-fetch-agent.js:5883` ✓
3. `functions/[[catchall]].js` exists ✓
4. `_routes.json` at repo root exists ✓
5. `renderStaticPage` — no unconditional ADSENSE_SCRIPT injection ✓
6. `renderArticleHTML` — `worker-fetch-agent.js:6567` uses `shouldShowAds()` gate ✓
7. `index.html` head — no static `<script async src="...adsbygoogle...">` ✓
8. `index.html:1603-1609` — dynamic injection gated on `articles.length >= 8 && document.querySelector('#newsGrid .card')` ✓

---

## Item 8 — BJK_KEYWORDS expansion
**Status: PARTIAL**

- `src/utils.js:25-106` — 6-tier structure present (club identity, current squad, management, recent former players, legends, recent former management) ✓
- `bjkMatchDetail` function — `src/utils.js:120-127` ✓
- "prekazi" — NOT in list ✓
- **Entry count: ~63, not ~160.** The expansion happened (was ~45 before) but fell well short of the target. Either the full list was never finalized or a partial version shipped.

---

## Item 9 — pipeline_log visibility columns
**Status: SHIPPED**

- Schema ALTER TABLE — `worker-fetch-agent.js:3396-3398` adds `trust_tier TEXT`, `source_body_len INTEGER`, `drop_detail TEXT` ✓
- Insert populates all three — `worker-fetch-agent.js:5406` ✓
- SELECT includes all three — `worker-fetch-agent.js:2242` ✓
- CSV export includes all three — `worker-fetch-agent.js:8747` ✓

---

## Item 10 — Visual badges P1.2 and source attribution P1.3
**Status: SHIPPED**

- `worker-fetch-agent.js:6439-6459` — `BADGE_MAP` with Maç Önü, Maç Günü, Gol, Sonuç, Analiz, Transfer, Haber ✓
- `worker-fetch-agent.js:6573` — renders `<div class="cat-tag ${badgeClass}">${escHtml(badgeLabel)}</div>` ✓
- `worker-fetch-agent.js:6462-6473` — `attrHtml` with three attribution variants (external source link, rewrite credit, multi-source synthesis) ✓
- `worker-fetch-agent.js:6649` — `${attrHtml}` rendered into article HTML ✓

---

## Summary

| # | Item | Status |
|---|------|--------|
| 1 | Fix A: preFilter BJK_KEYWORDS | SHIPPED |
| 2 | Fix B: off_topic seen cache | NOT SHIPPED |
| 3 | NTV Spor bjk_filter=true | CANNOT VERIFY (DB) |
| 4 | Global Media source disabled | CANNOT VERIFY (DB) |
| 5 | article.trust → trust_tier rename | PARTIAL |
| 6 | Rewrite quality fix (fact extraction) | SHIPPED |
| 7 | AdSense compliance (8 checks) | SHIPPED |
| 8 | BJK_KEYWORDS expansion | PARTIAL |
| 9 | pipeline_log visibility columns | SHIPPED |
| 10 | Visual badges & source attribution | SHIPPED |

---

## Claimed done but NOT in code

- **Fix B (off_topic seen cache)** — definitively not shipped. No functions, no KV key pattern, no wrapping logic anywhere.

## Done but with gaps worth noting

- **Item 5 (trust_tier rename)** — structurally migrated at ingest boundary but `.trust` fallbacks remain throughout. Fine as compatibility shim if all DB rows are already migrated; a problem if any code path writes `.trust` directly on new objects.
- **Item 8 (BJK_KEYWORDS expansion)** — expanded and tiered, but ~63 entries vs. target ~160. Either the second batch was never written or a trimmed version shipped.
- **Items 3 & 4** — status genuinely unknown without a DB query. Should be verified directly before closing.

## Correctly tracked

Items 1, 6, 7, 9, 10 — all substantive requirements present in code with specific line references.

---

## Format improvement proposal (for Ali's review — no changes made)

Add a **`verified-by`** field to each shipped entry in NEXT.md/DECISIONS.md:

```
### Fix B — off_topic seen cache
status: shipped
shipped-in: <commit hash or deploy version>
verified-by: grep seen:off_topic worker-fetch-agent.js → line XXXX
```

The `verified-by` line must point to a specific grep result, line number, or curl output — not a prose statement like "added in this session." A claim with no evidence line is treated as `status: pending-verification`, not `status: shipped`. This one field would have caught the Fix B drift at the moment the entry was written.
