# Kartalix News Pipeline — How an Article Becomes (or Doesn't Become) News

**Audience**: Product, editorial, engineering  
**As of**: v0.95 (May 2026)

---

## Overview

The pipeline runs automatically every hour. It pulls raw RSS articles from all configured sources, filters them down through five stages, scores each one with AI, and places qualifying articles into a live ranked pool. Articles in the pool decay over time and are replaced by newer, higher-value content. The visitor always sees a freshly ranked, time-decayed pool — never a static list.

---

## Stage 1 — Fetch

**Trigger**: Cron, every hour on the hour.

All RSS feeds configured in the site's `feed_config` are fetched in parallel. Each feed has:
- A **trust tier** (T1–T4): affects how articles are ranked later, not whether they are fetched.
- A **keywordFilter flag**: controls whether the keyword filter (Stage 2) applies to this feed.

Per-feed stats are recorded: raw article count, after-date count, after-keyword count. These appear in the admin By Source table.

**Hard limit**: `fetchRSSArticles` returns at most 100 articles total across all RSS feeds per run.

---

## Stage 2 — Keyword Filter (per-feed)

Applied only to feeds where `keywordFilter: true`. Dedicated Beşiktaş feeds (e.g. official club feed, beIN) bypass this step — all their content is presumed relevant.

**Match rule**: article title + summary must contain at least one keyword from `site.keyword_config.keywords`. If not set in the DB, the hardcoded `BJK_KEYWORDS` list is used as fallback.

**Current keyword list covers**:
- Core team identifiers: `beşiktaş`, `besiktas`, `bjk`, `kartal`
- Full squad: every player's full name, common short form, and unaccented ASCII variant (e.g. `orkun kökçü`, `orkun kokcu`, `orkun`)
- Coaching staff: `sergen yalçın`, `mustafa hekimoğlu`, `serdal adalı`

**Known gap**: alternative club nicknames (`siyah-beyazlılar`, `kara kartal`, `vodafone park`) are not in `keyword_config` — only in the separate `BJK_REGEX` used later. An article using only those terms on a filtered feed would be dropped here. Turkish sports media almost always writes "Beşiktaş" in headlines, so the practical miss rate is low, but it exists.

**Important**: `site.keyword_config.keywords` completely replaces the hardcoded list — it does not extend it. If the DB value is missing the four core team-name keywords, articles about Beşiktaş that don't mention a player name will be dropped.

---

## Stage 3 — Pre-filter

Applied to all articles after keyword filtering, regardless of feed type.

Three checks, all must pass:
1. **Age**: article must be published within the last **72 hours**. Older articles are dropped.
2. **BJK relevance regex**: title + summary + full text (first 600 chars) must match `/beşiktaş|besiktas|bjk|kartal|siyah.beyaz/i`. This is broader than the keyword list — it also catches `siyah.beyaz`.
3. **Minimum length**: summary must be at least 50 characters. Single-sentence wire alerts are dropped.

---

## Stage 4 — Deduplication

Three sequential dedup checks. An article failing any one is dropped from this run.

| Step | What it removes | Typical drop |
|------|----------------|--------------|
| **Hash dedup** | Articles with identical content hash to another article in the current batch | ~2 |
| **Title dedup** | Articles with near-identical titles to another article in the current batch (same story, multiple sources) | ~95 |
| **URL dedup** | Articles whose URL already exists in the database — meaning they were scored in a previous run | ~79 per 6-hour window |

**URL dedup is not a loss**: articles dropped here were already processed and stored in a previous run. They are correctly skipped, not discarded. The admin funnel now shows this step explicitly as "After URL dedup — N already scored."

After dedup, the surviving articles are the only truly new content to process.

---

## Stage 5 — NVS Scoring (Claude AI)

Each surviving article is sent to Claude for **News Value Scoring (NVS)**, a 0–100 scale specific to Beşiktaş editorial relevance.

Claude assigns:
- **NVS score** (0–100): overall news value
- **Category**: Transfer, Match, Injury, Club, etc.
- **Content type**: rss_article, video, social, etc.
- **Notes**: brief reasoning for the score
- **Golden score**: optional editorial flag for exceptional content

After scoring, a **story dedup** is applied: if two articles cover the same story, only the highest-NVS article advances. Up to **100 articles** proceed after story dedup per run.

---

## Stage 6 — Publish Decision

**Binary threshold** (no grey zone as of v0.95):

| NVS | Decision |
|-----|----------|
| ≥ `auto_publish_threshold` (currently **55**) | Published immediately |
| < 55 | Discarded — not saved |

Two overrides:
- `template_official` articles (official @Besiktas tweets rendered as templates) always publish regardless of NVS.
- `hot_news_hold` articles are held back regardless of NVS (match-day breaking news, waiting for confirmation).

Published articles are saved to the `content_items` table (status = `published`) and written to the live KV pool.

---

## Stage 7 — Article Writing

For published articles, the pipeline decides the **publish mode** based on NVS:

| Condition | Mode | What happens |
|-----------|------|--------------|
| NVS ≥ 60 | `rewrite` | Claude rewrites the article with editorial polish, Beşiktaş framing, and proper structure |
| NVS 55–59 | `rss_summary` | Article summary is published as-is — **not placed in the live KV pool**, only in the DB |
| Any NVS, synthesis-eligible | `synthesis` | A new article is generated from multiple sources (see Stage 8) |

Only `rewrite`, `synthesis`, template-generated, and `youtube_embed` articles appear in the live visitor pool. `rss_summary` articles are stored in the DB for audit but are not shown to visitors.

---

## Stage 8 — Synthesis Gate (H5 Stories)

The synthesis engine runs separately, triggered by the same cron. It monitors `stories` in the DB and generates original AI-written articles when enough source coverage exists.

**Gate conditions — all four must be met**:
1. ≥ 3 contributing articles linked to the story
2. ≥ 2 of those contributions published within the last **6 hours** (story is actively developing)
3. Highest NVS among contributions ≥ **60**
4. ≥ 2 **distinct source families** among contributions (e.g. Turkuvaz = A Haber + A Spor + Sabah count as **one** family)

**Kartalix exclusion**: our own previously synthesized articles are excluded from the family count. This prevents circular synthesis where our own output triggers new synthesis of itself.

If the gate passes, Claude synthesizes a new original article from all contributing sources. The synthesized article enters the KV pool with an 8–12h half-life.

---

## Stage 9 — KV Live Pool and Decay

The live pool is stored in Cloudflare KV (`articles:BJK`). It is re-ranked on every cron run, even runs that produce no new articles.

### Ranking formula

```
rank = NVS × exp(−ageHours / halfLife) × storyBoost × trustMultiplier
```

**Half-life by article type**:

| Type | Half-life | Hard TTL |
|------|-----------|----------|
| Live match events (goal, red card, VAR, HT) | 0.5h | 3h |
| Match result | 4h | 12h |
| Lineup | Pinned until kickoff +2h, then 4h decay | — |
| Rewrite / synthesis | 8h | — |
| Original synthesis | 12h | — |
| Video embed | 12h | — |
| Manual (editorial) | 96h | — |
| Transfer round-up (T07) | 36h | — |
| Standings / form guide (T12, T13) | 24h | 72h |

**Story boost**: `1.0 + (contributions_in_last_6h × 0.05)`, capped at **1.4×**. A story covered by 8+ sources in 6h gets a 40% rank boost.

**Trust multiplier**: `trust_score / 50`, clamped between 0.2× and 2.0×. A T1 source (score 100) gets a 2× multiplier; a T4 source (score 25) gets a 0.5× multiplier. Same NVS article from T1 ranks 4× higher than from T4.

**Hard TTL**: articles older than their hard TTL cap are evicted unconditionally (rank = −1), regardless of NVS.

**Floor**: articles with a rank score below **5** are evicted. This means an article with NVS 70, rewrite mode, ages out in approximately 11 hours (when decay reduces score below 5).

**Pool limit**: maximum 200 articles in the pool. After ranking and eviction, the pool is sorted descending by rank and the top 200 are kept.

### Quiet-run handling

If no new articles pass the pre-filter in a given run:
- The existing KV pool is re-ranked in place (decay applied, no new content added).
- If the KV pool is empty (e.g. after a cold start), the DB is seeded: the last 300 published articles are loaded and ranked into KV.

---

## What the visitor sees

The visitor-facing API returns the KV pool sorted by current rank score. Articles at the top are the most valuable, freshest, best-sourced content. Over time, without new input:
- A rewrite at NVS 70 will fall below rank 5 in ~11 hours and be evicted.
- A synthesis at NVS 80 will last ~13 hours before eviction.
- A manual editorial article at NVS 80 will last ~4 days.
- A live goal notification (T10, NVS 100) will be gone within 3 hours regardless.

This means the live pool is self-cleaning. Old content does not accumulate — it is always replaced by newer, higher-value articles as they enter the pipeline.

---

## Current pipeline throughput (typical 6-hour window)

| Stage | Count | Notes |
|-------|-------|-------|
| Raw fetched | ~500 | Across all RSS sources |
| After keyword filter | ~399 | −101 non-BJK |
| After hash dedup | ~397 | −2 exact content duplicates |
| After title dedup | ~302 | −95 same story, different sources |
| After URL dedup | ~223 | −79 already scored in previous runs |
| After NVS scoring | ~223 | 1 Claude batch call |
| Published (NVS ≥ 55) | ~12 | ~5.4% of scored |
| Placed in KV pool | ~8–10 | Excluding rss_summary mode |

**Root constraint**: the publish threshold of 55 means ~95% of scored articles are discarded. Lowering `auto_publish_threshold` in the `sites` table is a no-deploy change that immediately increases throughput.

---

## Key configuration (sites table)

| Column | Current value | Effect |
|--------|--------------|--------|
| `auto_publish_threshold` | 55 | Single quality gate. Lower = more articles. |
| `feed_config` | JSON array of feeds | Which sources are active |
| `keyword_config` | JSON keyword list | Override for keyword filter (replaces, not extends, hardcoded list) |
| `max_pool_size` | (site setting) | Max articles in live pool |
