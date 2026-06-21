# Kartalix — Open Items Inventory (2026-05-19)

Produced by Claude Code from prompt `3.kartalix_open_items_inventory_prompt.txt`.  
**Do NOT modify NEXT.md / ROADMAP.md / DECISIONS.md from this file.** Ali reviews and approves placements separately.

---

## Status of "already in-flight" items

| Item | Claimed status | Verified status |
|---|---|---|
| preFilter BJK_KEYWORDS replacement (Fix A) | shipped | ✅ CONFIRMED SHIPPED — deployed this session, version `edb6b718` |
| off_topic seen cache (Fix B) | shipped or in progress | ⚠️ UNCERTAIN — session summary says "awaiting Fix A verification." Status unclear. Confirm before marking done. |
| NTV Spor `bjk_filter=true` | shipped | ✅ CONFIRMED — pipeline diagnostic showed this was the fix direction; listed as done in session notes |
| Global Media source disabled/removed | shipped | ✅ CONFIRMED — confirmed by session notes |
| `article.trust` → `article.trust_tier` field rename | shipped | ✅ CONFIRMED — pipeline diagnostic confirmed fix; central mapper now uses `trust_tier \|\| trust \|\| null` |
| Rewrite quality fix (transient fact extraction) | shipped 2026-05-17 | ✅ CONFIRMED — DECISIONS.md and NEXT.md entries present |
| AdSense compliance structural fix | shipped 2026-05-18 | ✅ CONFIRMED — ROADMAP shows all compliance work submitted |

**Critical clarification needed**: Fix B (off_topic seen cache) — before any further work, confirm whether it was deployed in a session that wasn't fully summarised. Check wrangler version history or `git log`.

---

## Awaiting action items

### AdSense "Request Review" click

**Status: DONE.** NEXT.md and ROADMAP.md both confirm "AdSense review submitted 2026-05-18." The click already happened. Remove from active tracking.

**Residual action**: Check AdSense console in 7–14 days from 2026-05-18 (i.e., 2026-05-25 to 2026-06-01). No code work until Google responds.

**Placement recommendation**: No NEXT.md entry needed — a calendar reminder is more appropriate than a development task. Current NEXT.md already says "Check console in 7–14 days for outcome."

---

### DECISIONS.md backfill

**Status: Open.** Three entries added on 2026-05-17. Approximately 8–11 more entries from the list in the prompt remain unwritten.

**Placement recommendation: NEXT.md**, as a bounded writing session (est. 30–45 min). Place after pipeline_log visibility enhancement completes and Fix B is confirmed. This is low technical risk and high audit value — a one-session effort.

**Priority relative to other NEXT.md items**: 3rd (after About page work and top-20 article review).

---

## Open and clearly defined — placement recommendations

### Item 1 — Title dedup trust-aware refactor

**Proposed placement**: ROADMAP.md under v0.96 prerequisites. **Confirmed correct.**

**Status**: Open, not started. The pipeline diagnostic confirmed the root cause (alphabetical-first feed wins, trust not consulted). Fix A (BJK_KEYWORDS in preFilter) is now deployed; the dedup issue is independent.

**Scheduling note**: 48h observation of Fix A cron runs is appropriate before starting this. The pipeline_log visibility enhancement (`drop_detail` populating winner URL for `title_dedup` rows) is a prerequisite for *verifying* this fix once deployed. Both should be bundled in the same session.

**Re-categorization**: No. ROADMAP placement is correct.

---

### Item 2 — pipeline_log visibility columns

**Status: IN PROGRESS.** Schema migration pending (Supabase SQL editor — awaiting Ali to run the 3 ALTER TABLE statements). Code changes not yet written. Placement in ROADMAP under "current work" is already implicit.

**Placement recommendation**: Keep in ROADMAP as active current work. Once migration runs and code ships, add DECISIONS.md entry per the enhancement prompt's spec.

---

### Item 3 — Duhuliye special handling

**Status**: Open. Awaiting Duhuliye audit findings (the audit in `docs/duhuliye-and-keywords-audit-2026-05-19.md` being written in the same session).

**Critical note**: The 42% off_topic rate cited in the audit prompt may be stale. The pipeline diagnostic (May 15 data, pre-Fix A) showed only 4% off_topic for Duhuliye (7/177 rows, all confirmed false positives caused by BJK_REGEX/BJK_KEYWORDS gap). **Fix A (BJK_KEYWORDS in preFilter) should have eliminated these false positives entirely.** The rate should be re-measured after Fix A runs for 2–3 cron cycles.

**Placement recommendation**: ROADMAP.md, but deferred until post-Fix-A rate measurement confirms there is still a problem. If Fix A reduces Duhuliye off_topic to ~0%, this item closes without additional code changes. **Do not implement a Duhuliye override until the post-Fix-A rate is confirmed.**

---

### Item 4 — BJK_KEYWORDS / squad auto-sync from API-Football

**Status**: Open. Not started.

**Placement conflict**: This prompt places it at v0.97 (before summer transfer window, 6 weeks away). ROADMAP.md places it at v1.1 (post-launch) under "Squad Intelligence."

**Flag: placement conflict needs Ali's decision.** The summer transfer window argument is legitimate — if the window opens before v1.0 ships (plausible given v1.0 target is July 2026), a player signed in late June would not be in BJK_KEYWORDS and all early coverage of that player would be rejected as off_topic.

**Recommendation options**:
- **Option A**: Move to v0.98 or v0.99 as a minimal version (API-Football weekly squad pull → KV cache → filter reads from KV instead of hardcoded list). Low-risk, no DB migration needed.
- **Option B**: Keep at v1.1 but add a manual keyword-update process for the window period (just edit `utils.js`). Acceptable if someone monitors the squad during the window.

The audit document (`docs/duhuliye-and-keywords-audit-2026-05-19.md`) covers API-Football squad data availability in detail.

---

### Item 5 — About page refinements + byline + Author page

**Status**: Open. ROADMAP P0.3 (unchecked):
> `[ ] **P0.3** Add consistent byline on every article: "Kartalix Editorial · Ali [Surname]" or equivalent; add visible publication date`

**Placement recommendation: NEXT.md** (high priority). This is AdSense P0 — a reviewer will check the About page. The code part (byline injection in `renderArticleHTML`) is small; the time bottleneck is Ali writing the copy.

**Sub-items:**
- Byline on every article: code change in `renderArticleHTML` — small (~5 lines)
- Inline contact email on About page: copy only
- Correction policy paragraph: copy only
- `/yazar/ali` Author page: new route in worker + HTML template (~30 lines code + Ali copy)
- Resolve "biz/editörlerimiz" plural: copy fix on About page

**Priority relative to other NEXT.md items**: 1st — AdSense P0 risk. Google reviewer will look for bylines.

---

### Item 6 — Visual distinction badges for article types

**Status: ALREADY DONE.** ROADMAP.md P1.2 is checked:
> `[x] **P1.2** Content-type visual badges live on all articles (Maç Önü · Maç Günü · Canlı · Sonuç · Analiz · Transfer · Haber)`

**Placement recommendation: Remove from open items entirely.**

---

### Item 7 — Source attribution per article

**Status: ALREADY DONE.** ROADMAP.md P1.3 is checked:
> `[x] **P1.3** Source attribution visible on every article (credit + link to original)`

**Placement recommendation: Remove from open items entirely.**

---

### Item 8 — Read top 20 articles critically, improve weakest 5

**Status**: Open. ROADMAP P1.1 (unchecked):
> `[ ] **P1.1** Read top 20 published articles critically; improve weakest 5 for substance and depth`

**Placement recommendation: NEXT.md** (2nd priority after About page work). This is the single highest-leverage AdSense action that doesn't require code. A reviewer will sample-read articles; the worst 20% matters more than the average.

**Note**: This task cannot be delegated to Claude Code — requires Ali's editorial judgment. It is a 2–3 hour reading + selective rewriting task.

---

## Open but parked / deferred — confirmations

All items 9–20 are correctly placed already. Confirmations:

| # | Item | Current placement | Correct? |
|---|---|---|---|
| 9 | Sprint J — Maç Özetleri | ROADMAP v0.96 | ✅ |
| 10 | Sprint K — Situational Awareness | ROADMAP v0.97 | ✅ |
| 11 | Sprint L — Pipeline self-maintenance + Alarms | ROADMAP v0.98 | ✅ |
| 12 | Worker file split (4 phases) | ROADMAP parallel workstream | ✅ |
| 13 | Cockpit page (/admin/cockpit) | ROADMAP after Worker Split Phase 2 | ✅ |
| 14 | KPI strip on /admin/report | ROADMAP after Worker Split Phase 1 | ✅ |
| 15 | Path B — Six content shapes / strangler rebuild | ROADMAP post-v1.0 | ✅ |
| 16 | Fact buffer for short inputs | ROADMAP v0.99 or post-v1.0 | ✅ |
| 17 | Persistent facts architecture | ROADMAP deferred backlog | ✅ |
| 18 | Narrative arcs | ROADMAP post-v1.0 | ✅ |
| 19 | External task orchestration via Render | ROADMAP architectural pattern reference | ✅ |
| 20 | Pitchos platform / multi-tenant | ROADMAP v2.0+ | ✅ |

**Item 9 re-flag**: Sprint J (Maç Özetleri / Match Highlights) is PARKED per NEXT.md but the ROADMAP marks it as v0.96, after Sprint I (trust layer). Sprint I is now shipped (v0.95). The prerequisite gap was Sprint I being incomplete — that's resolved. The remaining Sprint J prerequisite is `NEXT_MATCH` hardcoded constant removal (line 26-45 of worker). Sprint J could now resume whenever AdSense and pipeline stabilization work settles.

---

## DECISIONS.md backfill candidates — assessment

From the prompt's list of ~11 backfill candidates, these are the highest priority to document (decisions that are non-obvious and affect current work):

| Decision | Priority | Why urgent |
|---|---|---|
| "rss_summary mode articles are net negative" | High | Affects scoring threshold decisions; currently being applied but not documented |
| "Strangler over big-bang rebuild" | Medium | Worker split is planned — context helps future contributors |
| "AI disclosure is positive E-E-A-T signal in 2026" | Medium | AdSense context |
| "Match stories and news stories are conceptually different" | Medium | Sprint J will reopen this question |
| "Trust signals vs hot signals are separate axes" | Low | Documented in pipeline diagnostic |
| "Generation-time fact extraction is transient, not persistent" | Low | Already in DECISIONS.md 2026-05-18 |
| "Pages catch-all Function with explicit _routes.json for unknown URL handling" | Low | In DECISIONS.md 2026-05-18 already |
| "External task orchestration via Render, not workflow tools" | Low | ROADMAP note already |
| "Telegram over email for alarms" | Low | Sprint L design doc already specifies this |
| "Alarms-as-data, checks-as-code" | Low | Already in DECISIONS.md 2026-05-17 |
| "Static folder files duplicating worker routes are permanent compliance risk" | Medium | May recur as pages grow |

---

## Recommended NEXT.md order for new items

Current NEXT.md next action is "Resume Sprint J (DB cleanup → seed sources → Match Highlights)." Based on this review, the correct ordering after current pipeline_log work completes:

1. **Immediately active**: pipeline_log visibility enhancement (in progress this session)
2. **After pipeline_log ships**: About page + byline (P0.3) — AdSense P0 item, Ali writing required
3. **Parallel**: Read top 20 articles critically (P1.1) — Ali reading, no code
4. **After 48h observation of Fix A**: Title dedup trust-aware refactor
5. **DB cleanup + seed sources** (currently in NEXT.md) — prerequisites for Sprint J
6. **Sprint J** — can resume after items 2–5 and AdSense observation window
7. **DECISIONS.md backfill** — one focused 30-min session any time

**Items to remove from NEXT.md / close out:**
- AdSense "Request Review" — already done
- Items 6 and 7 (badges, source attribution) — already done

---

*Output only. No NEXT.md / ROADMAP.md / DECISIONS.md modified. Ali reviews and approves placements separately.*
