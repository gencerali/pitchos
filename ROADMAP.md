# Kartalix — Product Roadmap
Last updated: April 7, 2026

---

## Vision

Kartalix is a world-class fan-first intelligent media platform.
Not an aggregator. Not a rewriter.
The definitive digital home for every football club's fans — powered by autonomous agents, self-learning editorial intelligence, and zero compromise on content quality.

**North star:** A fan opens Kartalix and finds every piece of news about their team — faster, better framed, and more trustworthy than any other source. No rival celebrations. No clickbait. No filler. Just signal.

---

## Live Infrastructure

- kartalix.com — domain purchased, DNS pointed to Cloudflare
- Cloudflare Pages — fan site hosting (free)
- Cloudflare Workers — pipeline orchestrator (pitchos-fetch-agent)
- Cloudflare KV — article cache (PITCHOS_CACHE)
- Supabase — database (pitchos project)
- Render.com — RSS proxy + Readability extraction (pitchos-proxy)
- GitHub — code repository (pitchos + pitchos-proxy)

---

## Platform Decisions (locked April 6, 2026)

### Decision 1 — Content Model
- Full original source content fetched via Readability and displayed with attribution
- Attribution: source name only (e.g. "Kaynak: Fotomaç") — never a raw URL
- Zero RSS summaries in published articles — always full content or structured template
- AI writes ONLY structured templates (Match Day, Post-Match, Transfer, Injury, Official)
- Templates are fact/data-based, expanding gradually in Kartalix style
- No free-form Sonnet rewriting of source articles

### Decision 2 — Template Strategy
- Templates built one at a time, starting with Match Day
- Extract structured facts only: who, what, when, where, score — never invented
- Always cite per fact: "Kaynak: [source name]"
- Kartalix voice: short sentences, data first, no clickbait, no exclamation marks

### Decision 3 — Multi-Team Scalable Architecture
- No hardcoded team logic in worker code ever
- All team config in Supabase sites table as JSONB:
  - feed_config: RSS feeds per team
  - keyword_config: player/staff keywords per team
  - scoring_config: NVS thresholds and publish rules
  - fetch_config: cron schedule and token budget (Sprint 6)
- squad_members table: player roster per team (Sprint 3)
- templates table: template definitions per team (Sprint 5)
- agent_learnings table: learned patterns per team + global (Sprint 5)
- Worker reads ALL config from Supabase at runtime
- Adding second team = INSERT one row in sites table only

### Decision 4 — Content Extraction
- Readability (Mozilla, self-hosted on Render.com) for all article content
- No Jina, no rss2json, no third-party dependency for content
- RSS proxy also on Render.com for blocked feeds (Fotomaç, A Spor)
- Both services owned infrastructure — no rate limits, no vendor risk

### Decision 5 — Agent Architecture
- Event-driven pipeline, not monolithic request-response
- 6 specialized agents, each with single responsibility
- All agents read team config from Supabase — no team-specific code
- Agents learn over time via agent_learnings table
- Global learnings apply to all teams; team-specific learnings isolated
- Human review required for low-confidence learnings (< 0.85)

---

## Kartalix as a Media Organization

### Role Mapping (automated vs human)

```
INTAKE         → Intake Agent (fully automated)
QUALIFY        → Qualify Agent (fully automated + learning)
PRODUCE        → Produce Agent (templates automated, Readability automated)
POLISH         → Inline (string processing, zero cost)
PUBLISH        → Distribute Agent (fully automated)
ENGAGE         → Engage Agent (semi-automated)
LEARN          → Learn Agent (weekly automated + human review)
EDITORIAL      → Human (analysis, opinion, edge case review)
```

### What makes Kartalix world-class

- **Fastest**: Match result published in 30 seconds from final whistle (Sprint 5)
- **Most trusted**: Every article shows source trust tier and golden score
- **Most complete**: Every angle on a story in one place
- **Most personal**: Fan-team POV always. Rival celebrations never lead.
- **Most engaging**: Live blogs, polls, Transfer Radar, Fan Pulse
- **Self-improving**: Agents get smarter every week from engagement signals

---

## Agent Architecture

### AGENT 1 — INTAKE
**Responsibility:** Find and fetch raw content
**Input:** site config (feeds, keywords, schedule)
**Output:** raw_articles rows in Supabase
**Tasks:**
- Poll RSS feeds per schedule
- Route blocked feeds through Render proxy
- Deduplicate across sources (hash + title similarity)
- Store raw content with source metadata
**Self-learning:**
- Tracks feed quality over time (source_performance table)
- Adjusts fetch frequency per feed based on article quality
- Flags consistently failing feeds for console review
**Runs on:** Cloudflare Worker (cron)
**Cost:** Zero (no Claude calls)

### AGENT 2 — QUALIFY
**Responsibility:** Editorial judgment — three parallel sub-agents
**Input:** raw_article (title + summary)
**Output:** qualified_article with NVS, golden_score, category, sentiment

**2A — Relevance Judge**
"Is the fan team the PRIMARY subject?"
- Checks if team/player appears as subject, not passing mention
- Flags false positives: "siyah-beyaz" without player name, rival articles mentioning BJK in passing
- Output: relevant (bool) + confidence + reason
- Learns: false positive patterns per source

**2B — Sentiment Judge**
"How does this feel for fans?"
- Detects rival celebration framing
- Detects demoralizing headlines (rival win lead, opponent celebrating)
- Suggests fan-centric reframe if needed
- Output: sentiment + rival_pov (bool) + fan_angle
- Learns: demoralizing phrase patterns per team

**2C — Value Judge**
"How much will fans care?"
- Considers: content type, source trust, recency, player importance
- Categories: Match/Transfer/Injury/Squad/Club/European/Other
- Output: nvs_score + golden_score + category + content_type
- Learns: which story types drive engagement per team

**NVS formula:**
```
nvs = value_score
    - (rival_pov ? 30 : 0)
    - (relevant ? 0 : 50)
    + (sentiment_bonus)
    + (source_trust_bonus)
```

**Self-learning:** Stores all verdicts. Weekly review updates agent_learnings.
**Runs on:** Cloudflare Worker
**Claude calls:** 3 × Haiku per article batch
**Cost:** ~€0.001 per article

### AGENT 3 — PRODUCE
**Responsibility:** Content creation and enrichment
**Input:** qualified_article (NVS >= threshold)
**Output:** publishable content with full_body

**Decision tree:**
```
IF category = Match AND is_today          → Match Day template
IF category = Match AND is_past           → Post-Match template
IF category = Transfer AND nvs >= 70      → Transfer card template
IF category = Injury                      → Injury template
IF source_trust = official                → Official Statement template
ELSE                                      → Readability extraction
```

**Template filling (Haiku):**
- Extracts structured facts from Readability content
- Fills template slots (score, players, time, TV channel, venue)
- Never invents facts — only uses verified source content
- Cites source per fact

**Readability path (self-hosted, Render.com):**
- Mozilla Readability algorithm (same as Firefox Reader Mode)
- Handles all Turkish news sites
- No rate limits, no third-party dependency
- Returns clean article text, no ads, no navigation

**Self-learning:** Tracks template effectiveness per category
**Runs on:** Render.com (async job, no 30s timeout limit)
**Claude calls:** 1 × Haiku per template article only
**Cost:** ~€0.001 per template, zero for Readability articles

### AGENT 4 — DISTRIBUTE
**Responsibility:** Multi-channel publishing
**Input:** published_article
**Output:** live on all relevant channels

**Channel rules by NVS:**
```
NVS >= 80 → all channels + push notification
NVS >= 60 → website + RSS + social post
NVS >= 40 → website + RSS only
NVS < 40  → website only
```

**Channels (by sprint):**
- Sprint 3: Website KV + Supabase
- Sprint 4: RSS feed + Google News sitemap
- Sprint 5: Twitter auto-post + newsletter
- Sprint 6: Push notifications + mobile app

**Self-learning:** Best posting times per channel per team
**Runs on:** Cloudflare Worker (triggered)
**Cost:** Zero (no Claude calls)

### AGENT 5 — ENGAGE
**Responsibility:** Fan interaction layer
**Input:** published_article + real-time events
**Output:** enriched fan experience

**Features:**
- Fan Pulse: sentiment from article mix (injury rate, transfer activity, NVS avg)
- Transfer Radar: confidence scoring (source trust × mention frequency × specificity)
- Match day live blog: minute-by-minute (Sprint 5)
- Polls: auto-generated from match context (Sprint 5)
- Related articles: by category and player

**Self-learning:** Which engagement features fans actually use
**Runs on:** Cloudflare Worker (event-driven)
**Cost:** Minimal

### AGENT 6 — LEARN
**Responsibility:** System-wide continuous improvement
**Input:** engagement signals (clicks, time-on-page, shares, poll responses)
**Output:** updated agent_learnings in Supabase

**Weekly cycle:**
1. Review last week's published articles → high click = positive example, low click = negative
2. Review filtered articles → check if any wrongly blocked
3. Extract patterns from examples
4. Update source_performance rankings
5. Write new learnings to agent_learnings
6. Flag low-confidence learnings for human review
7. Propagate global learnings to all teams

**Learning types:**
- false_positive: "X phrase does not indicate BJK relevance"
- false_negative: "Y pattern was wrongly filtered — should publish"
- source_quality: "Z source consistently scores high engagement"
- timing: "Injury articles published within 1h of match get 2× clicks"
- sentiment: "Rival-celebration framing reduces engagement 40%"

**Cross-team propagation:**
- team_id = NULL → applies to all teams (global)
- team_id = BJK → BJK only (specific)
- Onboarding new team inherits all global learnings immediately

**Runs on:** Render.com cron (weekly)
**Claude calls:** Sonnet for pattern analysis
**Cost:** ~€0.50/week

---

## Human-in-the-Loop Learning (Sprint 5-6)

### Idea 1 — Admin Feedback per Article
Console shows each published article with:
- Full scoring breakdown: relevance verdict, sentiment verdict, NVS score, golden score, nvs_notes
- Why it was published: which rules triggered
- Admin feedback buttons: 
  👍 Correct decision  
  👎 Should not have published
  ⬆️ Should have scored higher
  ⬇️ Should have scored lower
  + Free text comment field

Admin feedback writes directly to agent_learnings table:
- agent_name: 'qualify_agent'
- learning_type: 'admin_feedback'
- pattern_text: the feedback text
- example_title: article title
- verdict: admin verdict
- confidence: 1.0 (human = highest confidence)
- team_id: NULL if global, site_id if team-specific

At next scoring run, Qualify Agent reads recent admin learnings
and injects them into the prompt as examples:
"Recent editorial feedback:
- Article 'X' was scored too high — rival celebration framing
- Article 'Y' was correctly identified as injury news
Apply these learnings to similar articles."

This creates a direct human → agent feedback loop.
Admin spends 5 minutes reviewing after each match day.
Agent gets smarter every week from real editorial judgment.

### Idea 2 — Fan Comments as Learning Signal
Reader comments contain valuable signal about what fans care about.

Learn Agent (weekly) analyzes comments:
- High comment count + positive tone → article topic fans love
- Negative comments about article quality → adjust scoring
- Specific player names mentioned frequently → update squad keywords
- Transfer rumors in comments that appear in news later → journalist accuracy

Comment analysis prompt (Haiku, weekly):
"Analyze these comments and extract:
1. Topics fans are passionate about
2. Content quality complaints
3. Player/transfer names mentioned
4. General sentiment about the site"

Output written to agent_learnings as:
- learning_type: 'fan_signal'
- team_id: site specific
- Examples: 'Fans want more Orkun Kökçü coverage'
             'Fans complain about rival celebration articles'
             'Transfer rumor X mentioned in comments 3 days before confirmed'

### Idea 3 — Cross-Team Learning Propagation
Learnings are tagged global (team_id=NULL) or team-specific.

Global learnings (apply to all teams):
- "Rival celebration articles → max NVS 25" 
- "Injury news with player name → minimum NVS 60"
- "Source trust hierarchy rules"

Team-specific learnings:
- "BJK fans care more about European competition"
- "GS fans respond more to transfer news than match analysis"
- "FB fans highly engaged with derby content specifically"

When Team 2 onboards:
→ Inherits ALL global learnings immediately
→ Starts building team-specific learnings from day 1
→ Gets smarter faster than Team 1 did

### Learning Flywheel (target state Sprint 7):

### Console UI for Learning (Sprint 6):
- Article review queue: scored articles with full scoring breakdown
- One-click feedback per article
- Learning entries list: view/edit/delete learnings
- Confidence scores per learning
- Learning performance: which learnings improved scoring most
- Global vs team-specific toggle
- Fan signal dashboard: top comment themes this week

### Implementation Timeline:
Sprint 5: agent_learnings table + basic admin feedback endpoint
Sprint 6: Console review UI + learning injection into prompts
Sprint 7: Fan comment analysis + cross-team propagation
Sprint 8: Learning performance tracking + auto-confidence scoring

---

## Supabase Schema (additions for agent architecture)

```sql
-- Agent memory and learnings
agent_learnings:
  id, agent_name, team_id (null=global),
  learning_type, pattern_text, example_title,
  verdict, confidence (0-1.0),
  times_applied, times_correct,
  approved_by_human (bool),
  created_at, last_applied_at

-- Source intelligence
source_performance:
  source_name, team_id,
  articles_contributed, articles_published,
  avg_nvs, avg_engagement,
  false_positive_rate,
  best_content_types,
  updated_at

-- Article lifecycle tracking
raw_articles:        intake output
qualified_articles:  qualify output
published_articles:  produce output
distribution_log:    distribute output
engagement_events:   clicks, time-on-page, polls
```

---

## Content Philosophy

### Fan Content Priorities (drives NVS scoring)

**Tier 1 — Always show (NVS 70+):**
- Match results: score, goals, stats, key moments
- Confirmed injuries with timeline and return date
- Official club announcements and statements
- Confirmed transfers (official or journalist tier)
- Press conference direct quotes (coach and players)

**Tier 2 — Show if space (NVS 40-69):**
- Pre-match analysis and expected lineups
- Credible transfer rumors (journalist trust tier)
- League table context directly involving BJK
- Youth team results and academy news
- Other branch results (basketball, volleyball) when significant

**Tier 3 — Deprioritize (NVS 20-39):**
- General Süper Lig news mentioning BJK in passing
- Transfer speculation without named journalist source
- Repeated angles on same story

**Never show (NVS < 20):**
- Rival celebrations against BJK as lead story
- General league news with no BJK relevance
- Duplicate of already-published story
- "Siyah-beyaz" keyword without BJK player or club name

### Golden Score System (visible to readers)
- ⚡⚡⚡⚡⚡ Official confirmation, match result, club statement
- ⚡⚡⚡⚡   Press conference quote, credible transfer (journalist tier)
- ⚡⚡⚡     Squad news, lineup, pre-match analysis
- ⚡⚡       General club news, youth team
- ⚡         Transfer rumors, speculation
- 👁️👁️👁️   Credible journalist rumor with detail
- 👁️👁️     Press rumor, unverified claim
- 👁️        Pure speculation, no source

### Source Trust Tiers (internal, drives scoring)
- 🔵 Resmi: bjk.com.tr, @Besiktas official accounts
- 🟢 Birincil: beIN Sports, NTV Spor, TRT Haber, A Spor
- 🟡 Basın: Fotomaç, A Haber, Hürriyet, Habertürk, Sabah
- 🟠 Gazeteci: Fırat Günayer, Fabrizio Romano
- 🔴 Sosyal: Unknown Twitter, forums (excluded by default)

### Sport Priority
- Football: always show
- Basketball: always show when in EuroCup/BSL season
- Volleyball/Handball/Other: major results only (final, championship)

---

## Match Day Automation (Sprint 5 target)

```
T-60min  Pre-match card auto-published:
         Lineups (from bjk.com.tr), injuries, suspensions,
         H2H stats, TV channel, weather, referee

T+0      Kickoff auto-tweet: "⚽ Maç başladı! #BJK"

T+45     Half-time report auto-published:
         Score, goals, cards, possession stats

T+90+    Full-time result auto-published in 30 seconds:
         Score, scorers, assists, cards, ratings

T+10min  Manager quotes published (from press feed)
         Fan reaction poll launched

T+2h     Full post-match analysis:
         All source articles via Readability
         Best quotes highlighted
         Next match preview
```

All automated. Zero human input required on match days.

---

## Squad Intelligence System

Dynamic database of players, coaches, staff per team.

**Used for:**
1. Keyword filtering on international/journalist feeds
2. Transfer Radar confidence scoring
3. Player Pulse cards (per-player sentiment)
4. Journalist accuracy tracking

**Supabase table: squad_members**
- id, site_id, name, name_variations (JSONB)
- role: player | coach | staff | president
- status: current | departed_1y | departed_2y | target | rumored
- position: GK | DEF | MID | FWD | coach | director
- nationality, age, market_value_eur
- joined_at, departed_at, shirt_number
- social_handles (JSONB)

**Keyword filter logic:**
- current + departed_1y: always monitored
- departed_2y: only if mentioned with team keyword
- targets/rumored: active during transfer windows
- Auto-generate name_variations for non-Latin names

**Active BJK_KEYWORDS (April 2026):**
beşiktaş, besiktas, bjk, kartal,
ersin destanoğlu, devis vasquez, amir murillo, emmanuel agbadou,
tiago djalo, felix uduokhai, emirhan topçu, rıdvan yılmaz,
taylan bulut, gökhan sazdağı, orkun kökçü, wilfred ndidi,
kristjan asllani, salih uçan, kartal kayra yılmaz,
milot rashica, junior olaitan, tammy abraham, vaclav cerny,
el bilal touré, hyeon-gyu oh, jota silva, cengiz ünder,
mustafa hekimoğlu, sergen yalçın, serdal adalı,
mert günok, jean onana
(Sprint 6: auto-built from squad_members table)

**Current BJK Squad (seed data — April 2026):**
Kaleciler: Ersin Destanoğlu, Devis Vasquez
Defans: Amir Murillo, Emmanuel Agbadou, Tiago Djalo, Felix Uduokhai, Emirhan Topçu, Rıdvan Yılmaz, Taylan Bulut, Yasin Özcan, Gökhan Sazdağı
Orta Saha: Orkun Kökçü, Wilfred Ndidi, Kristjan Asllani, Salih Uçan, Kartal Kayra Yılmaz, Milot Rashica, Junior Olaitan
Forvet: Tammy Abraham, Vaclav Cerny, El Bilal Touré, Hyeon-gyu Oh, Jota Silva, Cengiz Ünder, Mustafa Hekimoğlu
Teknik Direktör: Sergen Yalçın
Başkan: Serdal Adalı
Departed (monitor 1yr): Mert Günok (→ Fenerbahçe), Jean Onana (→ Genoa loan)

---

## Revenue Model

- **AdSense:** all tiers, apply Sprint 3 (site must be live)
- **Transfer Radar Pro:** early access + confidence history €3.99/month (Sprint 9)
- **Club newsletter:** weekly digest €2.99/month per team (Sprint 9)
- **White-label:** sell platform to club media teams (Sprint 10+)
- **Subscription bundle:** all teams €9.99/month (Sprint 10)

**Revenue targets:**
```
Sprint 3-4: €0 (building)
Sprint 5-6: €50-200/month (AdSense, early subs)
Sprint 7-8: €500-2000/month (5+ teams, subscriptions)
Sprint 9-10: €5000+/month (platform scale)
```

---

## Homepage Architecture

- Ticker: breaking news NVS > 75, auto-scrolling
- Hero Carousel: top 8 articles by NVS, 320px height, real images
- Son Dakika grid: articles 9-30, 3-column
- Transfer Radar: live rumor board with Golden Score + confidence
- Fan Pulse: daily sentiment derived from article mix
- Diğer Sporlar: basketball/volleyball when significant
- Video Öne Çıkanlar: key video clips
- Footer: about, privacy, source attribution, RSS

---

## Sprint Status

### ✅ Sprint 0 — Foundation (COMPLETE)
- Console HTML shell
- Supabase schema (10 tables)
- Beşiktaş fan site first version
- GitHub repo, Cloudflare Pages, Wrangler CLI, Claude Code

### ✅ Sprint 1 — Live Pipeline (COMPLETE)
- Cloudflare Worker fetch agent live
- Claude API connected
- NVS scoring (fact vs rumor classification)
- KV cache → fan site reads live news
- Cron trigger, Supabase logging, dev.bat shortcuts

### ✅ Sprint 2 — Content Quality (COMPLETE — April 6, 2026)
- 12 RSS sources configured (team-specific + general with BJK filter)
- Render.com proxy for blocked feeds (Fotomaç, A Spor via rss2json → Readability)
- Readability content extraction (Mozilla, self-hosted)
- Supabase content_items insert fixed
- Golden Score + NVS scoring working (Haiku, batch 10, 2000 tokens)
- Hero carousel + article grid + modal
- Real images via og:image extraction
- Deduplication (hash + title similarity)
- Report dashboard (report.html, password: kartalix2026)
- Full funnel tracking in fetch_logs
- kartalix.com domain → Cloudflare DNS (propagating)
- Kartalix branding, red accent, Barlow Condensed font
- Transfer Radar, Fan Pulse live from real article data
- Code split: src/fetcher.js, src/processor.js, src/publisher.js, src/utils.js

### 📋 Sprint 3 — Agent Foundation + Content Quality

**Priority 1 — Qualify Agent v1 (most important)**
Replace current single-prompt scoring with 3-judgment system:
- 2A Relevance: Is BJK the primary subject? (not passing mention)
- 2B Sentiment: Fan-friendly framing? Rival celebration?
- 2C Value: NVS score with explicit fan priority rules
- Create agent_learnings table in Supabase
- Manual learning entry for first false positives caught

**Priority 2 — Produce Agent v1 (Readability pipeline)**
- Move Readability enrichment to Render.com async job
- Render fetches all published articles after Worker completes
- Updates Supabase full_body + KV cache
- No Worker timeout risk
- All articles get full content (not just top 3)

**Priority 3 — Match Day template**
- Auto-detect match day from bjk.com.tr
- Extract: opponent, time (Istanbul), venue, TV channel, expected lineup, injuries
- Publish structured match card at T-60min

**Priority 4 — Move config to Supabase**
- feed_config JSONB: RSS feeds per team (remove from worker code)
- keyword_config JSONB: BJK_KEYWORDS per team
- scoring_config JSONB: NVS thresholds per team
- Worker reads all config at runtime
- Second team = INSERT one sites row only

**Priority 5 — Squad members seed**
- Seed squad_members table with full BJK April 2026 roster
- source_performance table created and populated

**Priority 6 — Legal + Monetization**
- GDPR/KVKK cookie banner
- Privacy policy page
- Source attribution on every article
- AdSense application (after kartalix.com live)
- Google Search Console + Google News submission
- Sitemap.xml auto-generated

**Known issues carrying from Sprint 2:**
- NTV Spor Atom titles still empty in some cases
- A Haber only 3 recent articles (feed has old content)
- Rival content (FB celebrations) still appearing as top stories → fixed by Qualify Agent

### 📋 Sprint 4 — Distribution + SEO
- NewsArticle structured data per article
- Meta tags + Open Graph per article
- RSS feed for kartalix.com/rss
- Auto-tweet high NVS articles (@kartalix)
- WhatsApp share buttons
- Article URLs with SEO-friendly slugs
- Distribute Agent v1: rules-based channel routing

### 📋 Sprint 5 — Learning Engine + Match Automation
- Pageview/click tracking per article (engagement_events table)
- Learn Agent v1: weekly Supabase review, pattern extraction
- Source engagement dashboard (source_performance updates)
- Journalist accuracy tracker (rumor confirmed/failed)
- Match day live blog (score API integration)
- Full match day automation: pre-match → kickoff → half-time → full-time → analysis
- Post-Match template
- Squad auto-update via Transfermarkt RSS
- Transfer prediction history dashboard

### 📋 Sprint 6 — Console + Multi-Team Config
- Console: source management UI per team
- Console: fetch schedule configuration per team
- Console: squad management (add/edit/remove players)
- Console: agent learnings review and approval UI
- Console: scoring threshold configuration
- fetch_config JSONB column in sites table
- Qualify Agent v2: 3 sub-agents running in parallel
- Learn Agent v2: automatic cross-team propagation
- Team 2 onboarding (Galatasaray or Fenerbahçe)

### 📋 Sprint 7 — Scale to 5 Teams
- 3 more Turkish teams from console
- Revenue dashboard cross-team
- Social account discovery engine
- Global vs team-specific learning split refined
- Onboarding playbook documented

### 📋 Sprint 8 — International Expansion
- First non-Turkish team (Bundesliga or Premier League)
- Multi-language Qualify Agent prompts
- Country-specific legal templates
- International AdSense rates benchmarking
- Distribute Agent v2: per-country channels

### 📋 Sprint 9 — Engagement + Subscriptions
- Comment system with Qualify Agent moderation
- Fan Memory (personal accounts, saved articles)
- Push notifications NVS > 80
- Email newsletter weekly digest
- Kartalix Pro subscription tier (Transfer Radar Pro)
- Polls on match days (Engage Agent v2)

### 📋 Sprint 10 — Full Autonomy
- Dedicated journalist agent reviewing every article before publish
- Story evolution tracking: rumor → reported → confirmed → signed
- Weekly Kartalix Analiz: squad gaps, transfer targets, tactical piece
- Platform revenue positive
- White-label offering to club media teams
- 50 teams target

---

## Key Decisions Made

- Content model: full source text via Readability, not RSS summaries or rewrites
- Content extraction: self-hosted Mozilla Readability on Render.com (no vendor dependency)
- RSS proxy: Render.com for blocked feeds (Fotomaç, A Spor)
- Agent architecture: 6 specialized agents, event-driven, config-driven, learning-enabled
- Scoring: 3-judgment system (relevance + sentiment + value) not single prompt
- Learning: behavioral analytics + agent_learnings table, not LLM retraining
- Multi-team: all config in Supabase, zero hardcoded team logic in worker
- Templates: fact-extracted, structured, Kartalix voice — no free-form AI rewriting
- Golden Score: public, NVS: internal only
- Infrastructure: Cloudflare + Supabase + Render.com free tiers
- No external AI tools: Claude does all intelligence
- Domain cost only: €8/year (kartalix.com at Strato)

---

## Open Questions

- Kartalix Pro pricing and feature set (decide Sprint 9)
- Whether to show article read count publicly
- YouTube transcript extraction for video content (Sprint 5 consideration)
- WebSub real-time push for breaking news (Sprint 4 consideration)
- Which team to onboard second: Fenerbahçe (larger audience) or Galatasaray (more global)
- Whether to build mobile app or PWA first (Sprint 8)
- Journalist partnership program (paid verified accounts) — Sprint 9+
