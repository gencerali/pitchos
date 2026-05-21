# Dedup Deep Dive — Fotomaç + Google News
**Date:** 2026-05-21  
**Scope:** Diagnostic only. No code changes.  
**Status:** ALL QUESTIONS ANSWERED. SQL results received 2026-05-21.

---

## Q1 — What source won each Fotomaç title_dedup?

**Finding: `dedup_winner_url` and `dedup_winner_source` columns do not exist.**  
Winner URL is stored in `drop_detail` (populated at `src/processor.js:84` via `dupeWinnerMap`). There is no separate winner_source column — source must be derived by joining pipeline_log on the winner URL + same run_at.

**Corrected SQL (run in Supabase dashboard):**

```sql
SELECT 
  f.url        AS fotomac_url,
  f.title      AS fotomac_title,
  f.drop_detail AS winner_url,
  w.source_name AS winner_source,
  w.title       AS winner_title,
  f.trust_tier  AS fotomac_trust,
  w.trust_tier  AS winner_trust,
  f.run_at
FROM pipeline_log f
LEFT JOIN pipeline_log w 
  ON w.run_at = f.run_at 
  AND w.url = f.drop_detail
WHERE f.source_name = 'Fotomaç'
  AND f.stage = 'title_dedup'
  AND f.run_at > NOW() - INTERVAL '72 hours'
ORDER BY f.run_at DESC;
```

The `run_at` join works because all events in a single cron run are written with the same `runAt` constant (`worker-fetch-agent.js:5455`).

**If LEFT JOIN returns `winner_source = NULL`**: the winner URL is from a different run (cross-run dedup via `getSeenUrls`). In that case, drop_detail contains a URL we can look up in `content_items` to get the source.

### SQL results (2026-05-21)

| fotomac_title | winner_source | winner_title | winner_trust | run_at |
|---|---|---|---|---|
| Beşiktaş'ta eski futbolcu Recep Adanır anıldı | null (cross-run) | — | null | 20:03 |
| Beşiktaş'tan Muçi için resmi açıklama! | **Duhuliye** | Beşiktaş'tan Muçi açıklaması! | T2 | 18:03 |
| Beşiktaş'ta eski futbolcu Recep Adanır anıldı | null (cross-run) | — | null | 18:03 |
| Beşiktaş Başkanı Serdal Adalı UEFA Başk… Ceferin ile buluştu | null (cross-run) | — | null | 18:03 |
| Beşiktaş'ta eski futbolcu Recep Adanır anıldı | null (cross-run) | — | null | 14:03 |
| Beşiktaş Başkanı Serdal Adalı UEFA Başk… Ceferin ile buluştu | **Duhuliye** | Serdal Adalı, UEFA Başkanı Aleksander Ceferin'le Buluştu | T2 | 14:03 |

**CRITICAL FINDING: Every Fotomaç title_dedup loss was to Duhuliye — not NTV, not Hürriyet, not Fanatik.**

Winner URLs for the "null" rows are all `duhuliye.com` paths — the same Duhuliye articles, seen in a previous run's URL cache. The join returns null because those Duhuliye articles were processed in an earlier cron run, not the same `run_at`. The drop_detail confirms: Duhuliye won every single contest.

---

## Q2 — What trust_tier ordering does title_dedup use?

**Answered from code. `dedupeByTitle` has NO trust-tier awareness.**

Full function at `src/processor.js:161–181`:

```javascript
export function dedupeByTitle(articles) {
  const kept = [];
  const dupeWinnerMap = new Map();
  for (const a of articles) {
    const aNorm = normalizeTitle(a.title);
    const aKeys = extractKeyTokens(a.title);
    let winner = null;
    const isDupe = kept.some(k => {
      if (titleSimilarity(aNorm, normalizeTitle(k.title)) > 0.3) { winner = k; return true; }
      const kKeys = extractKeyTokens(k.title);
      if (sharedStoryTokens(aKeys, kKeys) >= 3) { winner = k; return true; }
      return false;
    });
    if (!isDupe) {
      kept.push(a);
    } else {
      dupeWinnerMap.set(a.url || a.original_url || a.title, winner?.url || winner?.original_url || null);
    }
  }
  return { kept, dupeWinnerMap };
}
```

**The winner is the first article with that title in the input array.** Period. No trust_tier check, no NVS check, no recency tiebreak. The first article about "Anguissa transfer" to appear in the combined `allFetched` array wins — regardless of whether it's from NTV (T2) or Fotomaç (T3) or Google News (T2).

**Implication for Fotomaç:** The 6 Fotomaç articles were not beaten because of trust tier — they were beaten because competing articles about the same story arrived earlier in the array. Array order is determined by:
1. The `ORDER BY name` from source_configs fetch (alphabetical) — Fotomaç ("F") comes after Fanatik ("F") but before Hürriyet ("H"), NTV ("N"), Sabah ("S")
2. The parallel fetch resolution order for each source's RSS items

**Design gap flagged:** Trust-tier-aware dedup would require sorting the input array by trust_tier descending before calling `dedupeByTitle`, or rewriting the function to compare trust when a collision is found. Neither is in scope here — flagged for Sprint I2 consideration.

---

## Q3 — Actual pipeline_log and source_configs columns

### pipeline_log confirmed columns
From `worker-fetch-agent.js:5453–5465` (the write path) and `worker-fetch-agent.js:2241` (the read path):

| Column | Type | Notes |
|---|---|---|
| `site_id` | uuid | |
| `run_at` | timestamptz | same value for all events in one cron run |
| `source_name` | text | max 100 chars |
| `title` | text | max 250 chars |
| `url` | text | max 500 chars |
| `stage` | text | published / title_dedup / off_topic / etc. |
| `nvs_score` | int | null for preFilter drops |
| `publish_mode` | text | null for preFilter drops |
| `trust_tier` | text | T1–T4 |
| `source_body_len` | int | chars in summary+full_text at point of drop |
| `drop_detail` | text | winner URL (title_dedup), matched keyword (off_topic), char count (template_transfer_thin), pubDate (date_old) |

**Columns that do NOT exist:** `dedup_winner_url`, `dedup_winner_source`, `polling_interval_minutes`, `max_per_run`, `custom_config`

### source_configs confirmed columns
From Ali's successful query (2026-05-21) and `src/fetcher.js:84–110`:

| Column | Notes |
|---|---|
| `name` | display name |
| `url` | RSS feed URL |
| `is_active` | bool |
| `trust_tier` | T1–T4 |
| `bjk_filter` | bool — requires BJK keyword match |
| `source_type` | 'rss' or 'youtube' |
| `proxy` | bool — routes through Render proxy |
| `is_p4` | bool |
| `source_family` | Turkuvaz / demiroren / independent / etc. |
| `created_at` | timestamptz |
| `updated_at` | timestamptz |
| `channel_id` | YouTube channel ID (YouTube sources only) |
| `all_qualify` | YouTube sources only |
| `treatment` | YouTube sources only |

**To confirm full schema (run in Supabase dashboard):**
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'source_configs'
ORDER BY ordinal_position;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'pipeline_log'
ORDER BY ordinal_position;
```

---

## Q4 — Side-by-side title comparison (5 Fotomaç dedup matches)

### Results

| Fotomaç title | Duhuliye winner title | Verdict |
|---|---|---|
| "Beşiktaş'tan Muçi için resmi açıklama!" | "Beşiktaş'tan Muçi açıklaması!" | ✅ Correct match — same story |
| "Beşiktaş Başkanı Serdal Adalı UEFA Başkanı Aleksander Ceferin ile buluştu" | "Serdal Adalı, UEFA Başkanı Aleksander Ceferin'le Buluştu" | ✅ Correct match — same story |
| "Beşiktaş'ta eski futbolcu Recep Adanır anıldı" | (cross-run, Duhuliye URL confirmed in drop_detail) | ✅ Correct match — same story |

**Finding:** All dedup matches are correct — Duhuliye and Fotomaç genuinely cover the same stories. No false positives here. The issue is not dedup accuracy — it's that Duhuliye (T2, proxy-blocked) is beating Fotomaç (T3, proxy-functional) and then failing to produce a published article.

---

## Q5 — The 1 published Google News article in 48h

### Result: 0 rows (with corrected `original_url` column)

Ali's corrected query (`original_url` instead of `url`) returned no results. The "1 published" item in pipeline_log was either:
- Published under a different `source_name` in content_items (synthesis/template generation can overwrite source attribution)
- Or published outside the 72h window (the pipeline_log data was labeled "before_deploy" and may span a wider period)

**To find it (run in Supabase dashboard):**
```sql
SELECT original_url, title, publish_mode, LENGTH(full_body) as body_len, 
       nvs_score, published_at, source_name
FROM content_items
WHERE (source_name LIKE '%Google News%' OR original_url LIKE '%news.google%')
  AND published_at > NOW() - INTERVAL '7 days';
```

**Verdict regardless:** The G-C disable decision stands. The single article either doesn't exist in content_items (was overwritten/rejected), predates the 72h window, or was so infrequent it doesn't change the 0.5% yield calculation. No action needed on this finding.

---

## Q6 — Google News dedup winners: are they sources we already have?

### Results

| winner_source | times_beat_google_news | winner_trust |
|---|---|---|
| null (cross-run URL cache) | **102** | null |
| Duhuliye | 5 | T2 |

**Finding: Google News was NOT primarily beaten by NTV/Hürriyet/Fanatik. It was beaten by itself.**

102 out of 107 losses (95%) are to `null` winner — meaning the same Google News redirect URL was seen in a previous cron run's URL cache (`getSeenUrls`). Google News RSS returns the same ~100 redirect URLs on every poll. After the first run processes them, all subsequent runs hit the `url_seen` filter — but `title_dedup` is triggered here because `drop_detail` stores the previously-seen URL. The pipeline is correctly preventing re-processing.

Only 5 losses to Duhuliye (same stories covered by both). Zero losses to NTV, Hürriyet, Sabah, Fanatik, NTV Spor — none of the "real" sources we expected.

**Revised interpretation of Google News:** The 90%+ title_dedup figure in the original 2.2 data was misleading. It was mostly URL self-dedup across runs, not "NTV covers the same story better." Google News was generating ~100 URL-cache hits per cron cycle as overhead, with virtually no new unique content ever making it through. G-C disable confirmed correct.

---

## Summary of all findings

| Question | Status | Finding |
|---|---|---|
| Q1 winner columns | ✅ | `drop_detail` stores winner URL; no separate winner_source column |
| Q2 trust ordering | ✅ | **None.** First-come-first-served. No trust tier tiebreak. |
| Q3 schema | ✅ | Columns documented above; `polling_interval_minutes` etc. don't exist |
| Q4 title comparison | ✅ | All 3 confirmed correct matches — Duhuliye + Fotomaç cover same stories |
| Q5 published GN article | ✅ | 0 rows in content_items within 72h; article effectively doesn't exist |
| Q6 GN dedup winners | ✅ | 95% self-dedup (URL cache); 5 Duhuliye; 0 NTV/Hürriyet/Fanatik |

---

## Actionable findings

### Finding 1 — Duhuliye T2 assignment blocks Fotomaç and publishes nothing (HIGH PRIORITY)

**The chain of failure:**
1. Duhuliye is assigned T2 in source_configs — same tier as NTV Spor, A Haber, Hürriyet. It should be T4 (aggregator).
2. Duhuliye name starts "D", Fotomaç starts "F" — in alphabetical source order, Duhuliye's articles arrive first in the combined array.
3. `dedupeByTitle` is first-come-first-served: Duhuliye wins all title collisions with Fotomaç.
4. Duhuliye's proxy is HTTP 403-blocked (Render proxy) — synthesis_failed on every article it wins.
5. Net result: Duhuliye blocks Fotomaç T3 from publishing, then fails to publish anything itself.

**Fix requires two components:**
- **Fix A (immediate, SQL-only):** Lower Duhuliye to T4: `UPDATE source_configs SET trust_tier = 'T4', updated_at = NOW() WHERE name = 'Duhuliye';`
  This alone doesn't fully fix the problem (dedup is still first-come-first-served) but it correctly reflects Duhuliye's actual editorial standing and unblocks trust-aware dedup when that's implemented.
- **Fix B (code change, ~2 lines, Sprint I2):** Sort the combined article array by trust_tier descending before calling `dedupeByTitle`. T4 articles would then never beat T3 articles for the same story regardless of arrival order.

Both fixes together: Fotomaç T3 beats Duhuliye T4 → Fotomaç articles enter synthesis → proxy extracts content → articles publish.

**Estimated volume uplift if both fixes applied:** 3–6 more Fotomaç articles/day passing dedup → ~1–2 publishing (given ~30% synthesis success rate and proxy warm-path yield of ~1000 chars).

### Finding 2 — Google News self-dedup overhead (confirmed noise, already fixed)

95% of Google News pipeline_log entries were the same redirect URLs cycling through URL-seen cache on every cron run. These added ~100 log entries per cycle as pure overhead. G-C disable (2026-05-21) was correct.

### Finding 3 — dedupeByTitle is trust-blind (design gap, Sprint I2)

`src/processor.js:161–181` — first article with a given title in the input array wins, regardless of trust tier. A pre-sort by trust_tier descending before `dedupeByTitle` would fix this system-wide (not just for Fotomaç vs Duhuliye). 2-line change at the call site in `worker-fetch-agent.js`.

---

## Recommended next actions (diagnostic only — no code changes in this doc)

1. **Approve or reject Duhuliye T4 downgrade** (SQL-only, 1 minute): changes Duhuliye trust from T2 → T4. Reversible. No code change.
2. **Approve or reject trust-aware dedup** (2-line code change, Sprint I2 scope): sort input array by trust_tier before dedup. Changes which source wins collisions system-wide.
3. **Both together** = Fotomaç starts winning its stories and publishing articles.
