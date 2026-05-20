# Sprint L — Pre-Development Analysis
## Self-Maintaining Pipeline + Extensible Alarm Framework

**Status**: Analysis phase — awaiting approval before code  
**Date**: 2026-05-15  
**Brief source**: `temp/kartalix_pipeline_and_alarms_brief.txt`

---

## Executive Summary

Both workstreams are valid and well-scoped. The main adjustments to the brief's starting hypothesis are:

- **Filter unification (A) should ship before the alarm framework (B)**, not after. It is smaller, standalone, and means the first alarms monitor a cleaner system.
- **Confidence bucket does not reduce Claude costs** — it is a signal quality improvement, not a volume reduction. The per-call count stays roughly the same; scoring accuracy improves.
- **State machine should collapse to 3 states** (`clear`, `firing`, `acknowledged`), not 5. Resolution type belongs in the event log, not the state.
- **Telegram bot is the right notification channel for v1.** Email is too slow for ops; Slack/Discord are out of scope.
- **Parallel-run period is essential and non-negotiable.** Skipping it risks silently degrading pipeline coverage.

Total estimated effort: **8–9 dev days** + 7 calendar days for parallel run.

---

## Part A — Pipeline Self-Maintenance

### A1. Consolidating BJK_KEYWORDS + BJK_REGEX into `passesEntityScreen()`

**Recommendation: Yes, consolidate. The two paths are inconsistent in ways that matter.**

Current state:

| | `BJK_KEYWORDS` (fetcher.js) | `BJK_REGEX` (processor.js) |
|---|---|---|
| Type | Array of strings, `includes()` match | Compiled regex |
| Text window | title + summary only | title + summary + full_text (first 600 chars) |
| Source of truth | `site.keyword_config` DB column, or hardcoded `utils.js` list | Always hardcoded in `processor.js` |
| Applies to | RSS feeds with `keywordFilter: true` | All articles, no opt-out |
| Covers | "beşiktaş" + full squad name list | "beşiktaş" + "siyah.beyaz" only — no player names |

**The inconsistency that matters most**: `BJK_REGEX` has `siyah.beyaz` but `BJK_KEYWORDS` does not. An article using "siyah-beyazlılar" without "beşiktaş" survives `processor.js` but gets dropped at `fetcher.js`. Since `fetcher.js` runs first, `processor.js` never sees it. The `BJK_REGEX` coverage of "siyah.beyaz" is effectively dead.

**Callers that need updating after consolidation:**

| File | Line area | What changes |
|---|---|---|
| `src/fetcher.js` | ~169 | Replace `keyword_config` lookup + includes-filter with `classifyRelevance()` |
| `src/processor.js` | ~3, ~20 | Remove `BJK_REGEX` export; replace regex test with `classifyRelevance()` |
| `src/utils.js` | ~15 | `BJK_KEYWORDS` export kept temporarily during parallel run, then removed |
| `worker-fetch-agent.js` | Any import of `BJK_KEYWORDS` or `BJK_REGEX` | Update imports |

**Behavioral differences to preserve explicitly:**

1. **Text window**: At fetch time, full_text may not yet be fetched. `classifyRelevance()` must work correctly on title+summary alone and produce the same HIGH/MEDIUM/NONE result when full_text is later available (or absent). Implement with an optional `fullText` parameter.
2. **Per-feed opt-out**: The `keywordFilter: false` flag on individual feeds must continue to skip the screen entirely. Dedicated BJK-only feeds (beIN, official) must never be filtered.
3. **The `keyword_config` DB column**: currently a complete replacement for `BJK_KEYWORDS`. After consolidation, this column becomes obsolete. Do not remove it during parallel run; mark it deprecated and ignore it once team_entities is live.

**New proposed hierarchy in `classifyRelevance(text, teamCode)`:**

```
1. TEAM_CORE_REGEX match → HIGH bucket   (beşiktaş, bjk, kartal, siyah.beyaz, kara kartal, vodafone park, tüpraş stadyumu)
2. Active entity match   → MEDIUM bucket (current squad, staff — from team_entities table)
3. No match             → NONE           → article dropped
```

HIGH and MEDIUM both proceed to NVS scoring. NONE is dropped before any Claude call.

---

### A2. `team_entities` Schema and API-Football Sync

**Schema validation: sound. Three additions recommended.**

The proposed schema handles the core case well. Additions:

**1. Add `confidence_weight float DEFAULT 1.0`**

Some surnames are common enough to cause false positives. "Silva" (e.g. Jota Silva) is highly ambiguous — hundreds of players named Silva across global football. "Onana" is rare. `confidence_weight` allows suppressing a name as an entity match trigger when needed (set to 0.0 to disable without deleting the row). The MEDIUM bucket decision in `classifyRelevance()` uses this as a filter: `WHERE confidence_weight > 0.5`.

**2. Add `exclude_contexts text[]`**

Edge case: if Cengiz Ünder is sold in August but news articles still mention him in the context of "former Beşiktaş player" for months, we still want those articles. The `active_until` date handles the entity match suppression, but an `exclude_contexts` array (`['former','eski','ex-']`) lets the matcher skip matches that appear alongside disqualifying context words. Low priority — implement in a later iteration.

**3. No changes needed to the UNIQUE constraint** — `(team_code, api_football_player_id)` is correct. Players can be in multiple squads over time; the combination with `active_until` handles re-joins.

**Edge case analysis:**

| Scenario | Handling |
|---|---|
| Player loaned FROM Beşiktaş | Not in API-Football squad response for BJK → `active_until` set to loan date. Correct. |
| Player loaned TO Beşiktaş | Appears in API-Football squad response → included. Correct. |
| Youth promotion | Youth players appear in squad response once promoted. Correctly included. |
| Transfer window lag | Max 6-day lag (weekly sync Sunday 03:00). A Tuesday signing generates Thursday news before next Sunday sync. **Mitigation**: admin UI escape hatch for manual entity add (source='manual'). Flag this in the alarm framework (ENTITY_SYNC_DELTA). |
| Dual-nationality names | API-Football returns the name registered with the federation. Turkish accented names (ö, ü, ğ, ş, ı) are handled by `ascii_surname`. Variants that differ significantly (e.g. nickname "Samba" for a player whose legal name is different) must be added to `nicknames[]` manually — API-Football won't have them. |
| Manager change mid-season | Manager upsert at weekly sync. The old manager's `active_until` is set. Articles during the gap (after firing, before sync) may miss — acceptable given rarity. |

**Sync cadence**: Weekly on Sunday 03:00 TRT is correct. Transfers happen Monday–Thursday primarily. Sunday sync captures the full week's moves before the following week's reporting. Do not go shorter than weekly — API-Football has rate limits and the benefit of daily sync is marginal.

**Delta alarm threshold**: the brief proposes `>20% change in active count` triggers ENTITY_SYNC_DELTA. Validate with historical data — squad turnover in a summer window can be 30–40% (new signings + departures). Set the threshold to `>40%` change to avoid false positives during summer transfer windows; keep `>20%` for mid-season checks.

---

### A3. Confidence Bucket Pre-Screen — Impact on NVS Volume

**The bucket design is correct. It does not reduce NVS call volume — it improves signal quality.**

Current vs proposed article counts per 6-hour window (from actual pipeline data):

| Stage | Current | With buckets |
|---|---|---|
| After keyword filter | ~399 | ~399 (same logic, different implementation) |
| After dedup | ~223 | ~223 (unchanged) |
| Sent to NVS scoring | ~223 | ~223 (HIGH + MEDIUM both proceed) |
| NVS calls | ~1 batch call | ~1 batch call |

**No cost change.** The pre-screen is pure JavaScript (regex + string matching). Zero additional Claude calls.

The bucket's value is not cost reduction — it is the MEDIUM flag enabling NVS to make better decisions on borderline articles (see A4).

**MEDIUM bucket concern — transfer roundup sites:**

Sites that publish "top transfer targets" lists mentioning dozens of player names across all clubs. Example: "Galatasaray, Fenerbahçe ve Beşiktaş'ın hedeflediği 10 oyuncu" — this would get HIGH (team name present). The trickier case: an international outlet that says "Cengiz Ünder linked to Marseille" — MEDIUM bucket (player name only), reaches NVS. NVS should correctly score this low (0–15) because the article is about Ünder potentially leaving, not about Beşiktaş. Passing the MEDIUM flag to NVS makes this explicit.

**Sources where MEDIUM bucket would be unusually high:**

- International transfer aggregators (Fanatik international, Turkish Football Fanatik)
- General sports roundups (TRT Haber, Hürriyet) — articles covering multi-club stories

These sources should already have `keywordFilter: true`. With MEDIUM bucket, their articles reach NVS but get flagged appropriately. No action needed other than monitoring the MEDIUM→published conversion rate for these sources in the By Source table.

---

### A4. Should NVS Receive the Bucket as Context?

**Recommendation: Yes, add a one-line relevance context field to the NVS prompt. Keep NVS logic otherwise untouched.**

The case for context:

A MEDIUM-bucket article ("Jean Onana linked to Premier League club" from an international outlet) looks identical to a HIGH-bucket article ("Jean Onana scores for Beşiktaş") from NVS's perspective unless it is told the difference. Without context, NVS might score the first article 40 (vague transfer rumour) when 10 would be more accurate (not about BJK's current play at all).

Proposed addition to NVS prompt input:

```
relevance_signal: HIGH (club name present) | MEDIUM (entity match only: ["onana"])
```

One line. NVS prompt interpretation: HIGH = article is directly about Beşiktaş; MEDIUM = article mentions a BJK-related person but may not be about the club — apply extra scrutiny to whether the club itself is the subject.

**What must NOT change in NVS:**
- Scoring rubric, thresholds, category assignment logic
- Output format
- No dependency on bucket in any publish decision — the bucket is an input hint, not a gate

**Store the bucket on the article record** (`relevance_bucket` column on `content_items`) for analytics. Over 30 days we should see: MEDIUM bucket articles scoring ≥55 ("did MEDIUM inclusion add value?"). If MEDIUM→published rate is <5%, the MEDIUM bucket is mostly noise and the threshold should be reconsidered.

---

### A5. Migration Path from `keyword_config`

**Recommended parallel-run strategy — non-negotiable:**

Skipping parallel run risks silently missing articles that the old keyword list caught. The team_entities sync may have coverage gaps (newly signed players not yet in API-Football, manually-added nicknames missing). A 7-day parallel run finds these gaps before cutover.

**Phase sequence:**

```
Day 0:   Ship classifyRelevance() alongside old paths
         Both run in parallel; old path drives publish decision
         New path logs its output (bucket, matched) per article to a temp column

Day 1–7: Monitor divergences:
           - Old PASS / New NONE → potential miss; review manually
           - Old FAIL / New PASS → potential new coverage; review manually
         Track: what % of old-pass articles does new also pass?
         Target: >95% coverage parity before cutover

Day 8:   If coverage parity ≥95%: cut over; new path drives publish decision
         Remove old BJK_KEYWORDS filter from fetcher.js
         Remove BJK_REGEX from processor.js
         Mark keyword_config DB column as deprecated (do not delete)

Day 30+: Remove keyword_config column from sites table in a later migration
```

**Coverage parity threshold of 95%** means the new system drops no more than 1 in 20 articles that the old system would have published. Given the team_entities list will closely mirror the current BJK_KEYWORDS player list (same squad), actual parity should be >98%.

---

## Part B — Alarm Framework

### B1. Alarms as Data vs Checks as Code

**Recommendation: alarms as data, checks as code. The brief's proposal is correct.**

**Rule out pure SQL-in-a-row** (storing arbitrary query strings in the DB):
- Security: editing a SQL string in an admin UI is effectively arbitrary code execution on the DB
- Debugging: a failing query string in a DB cell is invisible in git history, unsearchable in code review
- Testing: impossible to unit-test a string stored in a row

**The right split:**
- `alarm_definitions` table: what to check, when, with what params, how to notify — all data
- `checkRegistry` in code: the actual check logic — registered functions, parameterized, testable, version-controlled

This means:
- Adding a new alarm that uses an *existing* check function → insert a row, no deploy
- Adding a new *kind* of check → write a function, deploy, insert a row
- Tuning thresholds (`check_params` JSONB) → update a DB field, no deploy

This balance matches the stated goal of "extensible by adding rows, not by deploying code" for the 90% case (threshold tuning, new alarms using existing check types).

---

### B2. State Machine Design

**Recommendation: simplify to 3 states. `auto_resolved` / `manually_resolved` belong in events, not states.**

Proposed 5-state machine from the brief: `clear`, `firing`, `acknowledged`, `auto_resolved`, `manually_resolved`

Simplified 3-state machine:

```
         check fires
clear ──────────────→ firing
  ↑                      │ │
  │ auto-clear           │ │ acknowledge (suppress notifications)
  │ (check returns       ↓ │
  │  false + auto_clear  acknowledged
  │  enabled)            │
  │                      │ check still firing: stay acknowledged
  └──────────────────────┘
  ↑ manual clear from UI
  └──────── (any state → clear, logged as event type 'manually_cleared')
```

Resolution type (`auto` vs `manual`) lives in the `alarm_events` table as `event_type` ('auto_cleared' vs 'manually_cleared'). The state itself is just `clear`. This simplifies:
- State transition logic (3 cases, not 5)
- UI rendering (3 badge colors, not 5)
- Any query that asks "how many active alarms?" — `state IN ('firing', 'acknowledged')`

**Acknowledged behavior confirmed**: check keeps running while acknowledged. If the check returns `firing` again after manual clear → re-transitions to `firing`, re-notifies. This is correct "I fixed it, now verify" behavior.

**One edge case to handle explicitly**: acknowledged + check returns clear → transition to `clear`, write `auto_cleared` event. Do NOT notify on this transition (it resolved on its own, which is good news, but the user acknowledged it so they know it was transient). This is a no-op notification.

---

### B3. Notification Routing

**Recommendation: Telegram bot for P0/P1. In-app badge for all severities. Email as fallback.**

| Channel | P0 | P1 | P2 | Info |
|---|---|---|---|---|
| In-app badge on /admin/rapor | ✅ | ✅ | ✅ | ✅ |
| Telegram bot | ✅ | ✅ | — | — |
| Email (Resend free tier) | ✅ backup | — | — | — |

**Telegram bot setup**: one bot, one private chat ID (your personal Telegram or a dedicated ops channel). Sending = one HTTP POST to `https://api.telegram.org/bot{TOKEN}/sendMessage`. No external paid service. Free.

**Why not Supabase email for ops alerts**: Supabase's transactional email relay is designed for auth flows (signup confirmations, password resets), not for operational alerts. Delivery is reliable but slow (5–30s). For "zero articles published in 6 hours" at 2am, Telegram push notification on mobile beats email by 20 minutes.

**Resend free tier** (100 emails/day): use as backup for P0 only. P0 = pipeline completely stopped. Single email per alarm transition to `firing`; no re-notify unless state changes. 100/day limit is sufficient.

**In-app badge**: firing alarm count shown as a red badge on the /admin/rapor nav link. Poll every 30 seconds via a lightweight `/api/alarms/count` endpoint (returns `{ firing: N, acknowledged: M }`). No WebSocket needed.

---

### B4. History and Retention

**Recommendation: 90 days, delete (no archive). Storage is negligible.**

Storage math: 3 initial alarms × average 4 state transitions/day × 365 days × ~500 bytes/row = ~2.2MB/year. Even at 50 alarms in two years, that is ~37MB. Negligible for Supabase.

**Do not archive to cold storage for v1.** The investigability value of alarm history (pattern detection: "this fires every Monday morning after the weekly sync") is higher than the cost of keeping it warm. 90-day rolling delete is the right balance.

**Index matters more than retention**: `CREATE INDEX ON alarm_events (definition_id, occurred_at DESC)` ensures history queries are fast even at 90 days of data.

**What to do at 90 days**: a scheduled Supabase function (`pg_cron` or a CF cron) runs `DELETE FROM alarm_events WHERE occurred_at < NOW() - INTERVAL '90 days'`. One line. Ship it with the framework.

---

### B5. Multi-Project Scoping

**Recommendation: `project` text field is correct. No `projects` table in v1.**

A `projects` table would add:
- A foreign key join on every alarm query
- An extra admin UI for managing projects
- A migration when a new project is added

A text field adds:
- Nothing except a filter clause: `WHERE project = 'kartalix'`
- Zero migrations to add a new project

The brief's examples (`'kartalix'`, `'flexnet'`, `'opticoms_rfx'`) are good. The project strings should be short slugs defined by convention, not enforced by a table. A README comment listing valid project codes is sufficient governance for v1.

**When to add a `projects` table**: when different projects need different notification channels, different access control, or different retention policies. That is a v2 concern.

---

### B6. Failure Modes — Monitoring the Monitor

**The brief's heartbeat approach is correct. Add one external check for true independence.**

**Proposed layered self-monitoring:**

```
Layer 1: Alarm runner writes heartbeat (last_run_at) to system_heartbeat table every minute
Layer 2: Separate CF cron (every 5 min) checks if last_run_at is > 3 min stale
         If stale: direct Telegram message, bypassing alarm system entirely
Layer 3: CF Workers health endpoint GET /health/alarm-runner
         Returns 200 + {last_run_at, age_seconds} if fresh; 503 if stale
         Register with UptimeRobot (free, 5-min checks) as external watch
```

Layer 3 provides true independence from Cloudflare's own execution environment. If the entire CF account has an issue, UptimeRobot catches it.

**One additional failure mode to handle**: the alarm runner's check functions themselves may throw (network error querying Supabase, unexpected data shape). The runner must catch per-check errors and write an `alarm_events` row with `event_type = 'check_error'`. A `check_error` event does NOT transition state — it is logged for debugging only. If check errors persist (>3 consecutive), the alarm itself transitions to a special `check_failing` state and notifies. This prevents a broken check function from silently suppressing alarms.

---

## Part C — Sequencing and Effort

### C1. Phase Order

**Recommendation: invert the brief's proposed order. Filter unification first.**

**Brief's proposed order**: framework → filter unification → auto-entities → confidence bucket → first three alarms

**Recommended order**:

| Phase | What | Why this order |
|---|---|---|
| 1 | Filter unification (`src/relevance.js`, consolidate callers) | Fastest win, standalone, no new infra. The alarms will monitor a cleaner system. |
| 2 | Alarm framework: data model + migrations | Three tables, indexes, nothing blocking. |
| 3 | Alarm runner + Telegram notifications | Core engine. |
| 4 | First three pipeline-health alarms | Alarm framework immediately does something useful. |
| 5 | /admin/rapor alarm UI | Visibility into firing alarms. |
| 6 | `team_entities` table + API-Football sync | Depends on nothing above. Parallelizable with Phase 4–5 if bandwidth allows. |
| 7 | Confidence bucket integration into `classifyRelevance()` | Requires team_entities to be populated (Phase 6). |
| 8 | NVS prompt gets `relevance_bucket` context | Requires Phase 7. |
| 9 | 7-day parallel run | Old + new paths running simultaneously. |
| 10 | Cutover: remove `keyword_config` code path | After parity confirmed. |

Phases 6 and 4–5 can run in parallel if two developers are available. On a single-developer track, run sequentially in the order shown.

---

### C2. Effort Estimates

| Phase | Task | Effort |
|---|---|---|
| 1 | `src/relevance.js`: TEAM_CORE_REGEX, `classifyRelevance()`, update fetcher.js + processor.js callers | **1 day** |
| 2 | DB migrations: `alarm_definitions`, `alarm_states`, `alarm_events`, `system_heartbeat`, `confidence_weight` on team_entities | **0.5 days** |
| 3 | Alarm runner: CF cron, state machine transitions, event logging, Telegram POST, heartbeat write | **1 day** |
| 4 | First three check functions: `checkZeroArticles`, `checkDropRateSpike`, `checkNvsDrift` + DB rows | **0.5 days** |
| 5 | /admin/rapor alarm UI: active section, history section, definitions panel, ack + clear buttons | **1.5 days** |
| 6 | `team_entities` migration + API-Football sync cron + KV cache (entities:BJK) | **1 day** |
| 7 | Confidence bucket: `getActiveEntities()` integration into `classifyRelevance()`, MEDIUM flag logging, `relevance_bucket` column on content_items | **1 day** |
| 8 | NVS prompt update: add `relevance_signal` input field | **0.5 days** |
| 9 | Parallel run: monitoring, comparison tooling, coverage report | **7 days elapsed, ~0.5 days active dev** |
| 10 | Cutover: remove `keyword_config` path, cleanup | **0.5 days** |
| — | **Total active dev** | **~8.5 days** |
| — | **Total elapsed (with parallel run)** | **~3 weeks** |

**Risks that could push to 12 days:**
- API-Football squad endpoint returns unexpected data shapes for Turkish clubs (needs defensive parsing)
- `classifyRelevance()` parallel run reveals >5% coverage miss, requiring manual entity audit and fixes before cutover
- /admin/rapor alarm UI scope expands (inline threshold editing is medium complexity)

---

## Roadmap Placement

This workstream ships as **v0.98** between Sprint K (v0.97) and v1.0.

It satisfies two v1.0 hard requirements:
- **"Telegram ops alert wired (Claude cap hit + zero-article run → message)"** — delivered by the alarm framework
- **"40+ articles visible without manual intervention for 3 consecutive days"** — pipeline confidence bucket + filter unification increases article throughput and removes keyword maintenance gap

---

## What Is NOT Being Decided Here

These questions are open for the approval conversation:

1. **`auto_publish_threshold` value after confidence bucket ships.** The brief's A3 proposes monitoring for 1 quarter and possibly raising from 55 to 57 if MEDIUM bucket lowers median NVS. The value should not be changed before the parallel run produces data.

2. **Which Telegram chat receives P0/P1 alerts.** Personal chat vs a dedicated ops channel. Operational decision, not a technical one.

3. **Whether to build inline threshold editing in the alarm definitions panel.** The brief shows it as a feature; it adds ~0.5 days to Phase 5. Can be deferred to a v0.98.1 patch.

4. **`exclude_contexts` on team_entities (mentioned in A2).** Low priority. Not in Phase 7 scope; add in a later iteration if false-positive rate on MEDIUM bucket is measurably high.

---

## Approval Request

**Approving this analysis authorizes starting Phase 1 (filter unification) immediately.**

Phases 2–10 will be presented for review at the start of each phase. No phase will begin without the previous phase's output being reviewed and accepted.
