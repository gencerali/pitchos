# Kartalix — Product Roadmap
Last updated: April 17, 2026

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

## Match Template System (Sprint 3-4)

### Core Principles
- Templates fire INSTANTLY on RSS trigger detection
- No scheduled delays except time-based templates
- Pipeline runs every 15 min on match days (vs 2h normal)
- Maximum publish delay = pipeline interval
- All templates generic — work for any team via Supabase config
- Each template has: enabled toggle, NVS override, social toggles,
  trigger keywords, time window, min confidence threshold
- Stored in: sites table → match_config JSONB column (Sprint 6)

### YouTube Channel IDs (confirmed)
BJK Official:    UCLJVUlpsxZcIMECVDcZaM2g
beIN Sports TR:  UCPe9vNjHF1kEExT5kHwc7aw
RSS format: https://www.youtube.com/feeds/videos.xml?channel_id={ID}

### Match Day Cron Schedule
Normal days:   every 120 min
Match day:     every 15 min (T-3h to FT+2h)
Config in:     sites table → match_config JSONB
  match_day_cron_interval_minutes: 15
  normal_cron_interval_minutes: 120
  match_window_start_hours_before: 3
  match_window_end_hours_after: 2

### Complete Template List (24 templates)

#### GROUP 1 — PRE-MATCH TIME-BASED (scheduled)
01 Fixture Announcement    T-48h    social:✅  nvs:70
   Title: "[Team] [Day] Akşamı [Opponent]'u Ağırlıyor"
   Source: NEXT_MATCH config in Supabase

02 Form Guide              T-48h    social:❌  nvs:60
   Title: "[Team] Son 5 Maçta X Galibiyet Aldı"
   Source: RSS last results articles

03 Head to Head            T-48h    social:❌  nvs:60
   Title: "[Team] - [Opponent]: Son Karşılaşmalar"
   Source: RSS H2H articles

04 Opponent Analysis       T-24h    social:❌  nvs:60
   Title: "Rakip Analizi: [Opponent] Bu Sezon..."
   Source: RSS articles about opponent

05 Match Day Card          match    social:✅  nvs:85
   morning 08:00
   Title: "Maç Günü! [Team] - [Opponent] | [Time]"
   Content: venue, TV channel, injuries, weather
   Source: NEXT_MATCH config + injury RSS

#### GROUP 2 — PRE-MATCH RSS-TRIGGERED (instant)
06 Referee Announced       instant  social:✅  nvs:70
   Keywords: "hakem atandı/belli/açıklandı"
   Title: "[Team]-[Opponent] Maçını [Referee] Yönetecek"
   Include VAR referee if in same article

07 Injury & Suspension     instant  social:✅  nvs:80
   Report
   Keywords: "cezalı/sakatlık/yok/kadro dışı"
             + squad_member match
   Title: "[Team]'da Eksikler Belli Oldu: [Player] Yok!"

08 Press Conference        instant  social:✅  nvs:75
   Quotes
   Keywords: "basın toplantısı/açıklama yaptı/konuştu"
   Title: "[Coach]: '[Quote]'"

09 Confirmed Lineup        instant  social:✅  nvs:85
   Keywords: "ilk 11/kadro belli/sahaya çıkıyor/muhtemel 11"
   Title: "[Team]'ın 11'i Belli Oldu!"
   Requires: Claude extracts min 8 player names
             from squad_members table

#### GROUP 3 — LIVE (single updating article)
10 Live Match Blog         instant  social:   nvs:90
                                    per event
   Title: "CANLI | [Team] - [Opponent] Maç Anlatımı"
   Format: reverse chronological, max 20 updates
   Poll: every 3 min during match window
   Source: NTV Spor / A Spor / Hürriyet live RSS

   Update triggers (with social):
   ⚽ Goal (fan team)        → ✅ tweet
   ⚽ Goal (opponent)        → ❌
   🟥 Red card               → ✅ tweet
   🏥 Serious injury         → ✅ tweet
   🔴 VAR controversial      → ✅ tweet
   ⚠️ Penalty awarded/missed → ✅ tweet
   😡 Fan reaction/scandal   → ✅ tweet
   ⏸️ Half time summary      → ❌
   🏁 Full time note         → ❌

   NOT triggered by:
   Substitutions, yellow cards, corners, normal stats

#### GROUP 4 — POST-MATCH RSS-TRIGGERED (instant)
11 Result Flash            instant  social:✅  nvs:90
   Keywords: "maç sona erdi/final/bitti/sonuçlandı"
   Title: "🦅 [Team] [Score] [Opponent] | Maç Sona Erdi"

12 Match Report            instant  social:✅  nvs:85
   Trigger: 2+ post-match articles available
   Title: "[Team] [Opponent]'u [Score] Mağlup Etti"
   Content: full report from Readability + Claude

13 Manager Quotes          instant  social:✅  nvs:80
   Keywords: "maç sonu/teknik direktör/basın toplantısı"
   Title: "[Coach]: '[Post-match quote]'"

14 Fan Reaction Roundup    instant  social:❌  nvs:65
   Keywords: "taraftar/sosyal medya/tepki/yorum"
   Title: "Taraftarlar Ne Dedi? Sosyal Medya Yıkıldı"

#### GROUP 5 — NEXT DAY RSS-TRIGGERED
15 Injury Assessment       instant  social:✅  nvs:80
   Keywords: "sakatlık/durum belli/hafta"
             + squad_member match
   Title: "[Player]'ın Durumu Belli Oldu: X Hafta Yok"

16 Press Review            instant  social:❌  nvs:65
   Keywords: "köşe yazısı/yorum/değerlendirdi"
   Title: "Spor Yazarları Maçı Değerlendirdi"

17 Standings Update        instant  social:✅  nvs:70
   Keywords: league table articles post-match
   Title: "[Team] [N]. Sıraya [Yükseldi/Düştü]"

18 Next Match Preview      T+24h    social:✅  nvs:70
   after FT
   Title: "Gözler Şimdi [Next Opponent]'a Çevrildi"

#### GROUP 6 — VIDEO TEMPLATES (YouTube RSS, instant)
RSS Sources:
  BJK Official:    feeds/videos.xml?channel_id=UCLJVUlpsxZcIMECVDcZaM2g
  beIN Sports TR:  feeds/videos.xml?channel_id=UCPe9vNjHF1kEExT5kHwc7aw

19 Post-Match Coach Video  instant  social:✅  nvs:85
   Keywords: "maç sonu/sonrası/basın toplantısı"
             + coach name in title
   Title: "[Coach] Maç Sonrası Konuştu [VİDEO]"
   Source: BJK Official + beIN Sports (BJK filter)
   Content: YouTube embed + 2-3 transcript quotes
   Window: FT+0 to FT+120min

20 Player Interview Video  instant  social:✅  nvs:75
   Keywords: squad_member name
             + "röportaj/konuştu/açıkladı"
   Title: "[Player]: '[Quote]' [VİDEO]"
   Source: BJK Official + beIN Sports (BJK filter)
   Window: any time

21 Pre-Match Interview     instant  social:✅  nvs:80
   Video
   Keywords: "maç öncesi/hazırlık/yarın"
             + squad_member OR coach name
   Title: "[Player] [Opponent] Maçı Öncesi Konuştu [VİDEO]"
   Window: T-48h to kickoff

22 Match Highlights Video  instant  social:✅  nvs:90
   Keywords: "özet/highlights/maç özeti"
             + team name in title
   Title: "Maçın Özeti: [Team] [Score] [Opponent] [VİDEO]"
   Source: BJK Official + beIN Sports
   Window: FT+0 to FT+180min
   Note: highest fan engagement

23 Training Video          instant  social:❌  nvs:55
   Keywords: "antrenman/idman/hazırlık çalışması"
   Title: "[Team] [Opponent] Hazırlıklarını Sürdürüyor [VİDEO]"
   Source: BJK Official only
   Window: T-72h to T-24h

24 Official Announcement   instant  social:✅  nvs:90
   Video
   Keywords: "açıklama/duyuru/resmi/transfer/imza/veda"
   Title: "[Team]'tan Resmi Açıklama [VİDEO]"
   Source: BJK Official only
   Window: any time

### Summary
Total templates: 24
Fully automatic: 24/24
Social enabled:  18/24
Sprint 3 (before April 10): Templates 05, 09, 10, 11, 12
Sprint 3 (after April 10):  Templates 01-04, 06-08, 13-18
Sprint 4:                    Templates 19-24 (video)

### Sprint 3 Implementation Order (match timeline)
1. Template 05 — Match Day Card (today)
2. Template 09 — Confirmed Lineup (today)
3. Template 10 — Live Match Blog (Thursday)
4. Template 11 — Result Flash (Thursday)
5. Template 12 — Match Report (already works)
Live test: Beşiktaş vs Antalyaspor, April 10 2026, 20:00

### Video Display (index.html)
publish_mode: 'video'
Card: YouTube thumbnail + 📹 badge + title
Modal: YouTube iframe (16:9) + transcript quotes
Legal: ✅ YouTube embeds explicitly permitted in YouTube ToS

### Transcript Extraction (Sprint 4)
Render proxy: /transcript?video_id=ID endpoint
Library: youtube-transcript-api
Claude Haiku: extracts 2-3 key quotes
Cost: ~€0.001 per video

### Supabase: youtube_sources table (Sprint 4)
id, site_id, channel_id, channel_name, channel_url,
trust_tier, filter_keywords (JSONB),
filter_squad_members (bool), enabled, added_at

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

**Auto-generation of keyword_config (Sprint 6 target):**
- On each squad_members INSERT/UPDATE, a Supabase function rebuilds keyword_config for that site
- Generates name + name_variations + transliteration for every current/departed_1y/target member
- Scheduled weekly Claude call: "Given this squad list, generate all name variations, nicknames, and common misspellings" → writes back to keyword_config JSONB
- Departures automatically stop being monitored after 1 year (status → departed_2y drops them from active keywords)
- Transfer window mode: targets + rumored players added to keyword list automatically during May–Aug and Jan–Feb windows

**Team Console — keyword management (Sprint 6):**
- Console shows keyword_config as an editable tag list per team
- Add/remove individual keywords without touching SQL
- "Regenerate from squad" button triggers the auto-generation flow above
- Shows last updated timestamp and which keywords matched articles in the last 7 days (so dead keywords are visible)
- Keyword performance: click through to articles each keyword triggered

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

- **AdSense:** apply end of Sprint 4 (once individual article pages exist), approval ~6 weeks, live by Sprint 5
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

### ✅ Sprint 3 — Pipeline Reliability + Content Quality (COMPLETE — April 17, 2026)

**What was built:**
- KV ceiling raised 8 → 30 → 50 articles (articles no longer silently dropped)
- Permanent URL dedup against Supabase content_items (eliminated re-scoring cost, was €17/mo)
- pubDate fix: original RSS published_at stored everywhere (KV + Supabase), no more fetch-time timestamps
- Scoring prompt rewritten: 7 explicit NVS bands, age penalty (−15 at 24h, −30 at 48h), story-aware (last 24h published titles injected)
- Post-scoring story dedup: highest-NVS article kept per story cluster, duplicates suppressed
- feed_config + keyword_config moved to Supabase sites table (configurable without deploy)
- Match templates T05/T08b/T09 rewritten as natural Turkish news prose via Haiku (SEO titles, clean URL slugs, fallback bodies)
- Funnel reporting fixed (funnelStats saved on all run types, not just success)
- Proxy feed pubDate bug fixed (empty string → null fallback)

**Known gaps carrying forward:**
- NEXT_MATCH is still hardcoded in worker — must update manually per match
- Cron runs every 2h — breaking news lag up to 2h
- No individual article pages — everything is SPA, nothing is shareable or indexable
- No AdSense, no Google News, no sitemap

---

### 🔄 Sprint 4 — "Make it shareable" (IN PROGRESS — April 17, 2026)

**Goal: a fan should be able to share a specific article URL. Google should be able to index every story.**

- ✅ Individual article pages: `/haber/[slug]` — Worker serves full HTML, canonical URL
- ✅ Meta tags + Open Graph per article (title, description, image)
- ✅ NewsArticle structured data (JSON-LD) — Google News eligibility
- ✅ Sitemap.xml dynamic at kartalix.com/sitemap.xml (Google News tags)
- ✅ RSS feed at kartalix.com/rss (30 latest articles)
- ✅ Cron 2h → 30min (breaking news lag reduced from 120min to 30min)
- ✅ WhatsApp + Twitter share buttons on article pages + modal
- ✅ GDPR/KVKK cookie banner (already in place)
- ✅ Privacy policy page (already in place)
- ✅ slug column added to Supabase content_items + URL pushState in SPA
- 📋 **Run** `supabase-migration-sprint4.sql` (add slug column to DB)
- 📋 **Submit** sitemap to Google Search Console
- 📋 **Submit** to Google News Publisher Center
- 📋 **Apply for Google AdSense** — start 6-week approval clock

### 📋 Sprint 5 — "Make it reliable" (before 2nd team)

**Goal: zero manual intervention on match days. NEXT_MATCH never hardcoded again.**

- NEXT_MATCH auto-fetched from a football data API (API-Football or similar)
- Match day cron: auto-switches to 15min interval on match days (T-3h to FT+2h)
- Post-Match result template: score + scorers auto-published at full time
- Result Flash template (T11): instant publish when final whistle detected in RSS
- Match day live blog: minute-by-minute updating article (T10)
- Produce Agent v1: move Readability enrichment to Render.com async job (no Worker timeout risk, all articles get full content)
- Qualify Agent v1: replace single-prompt scoring with 3-judgment system (2A Relevance, 2B Sentiment, 2C Value) — see Agent Architecture section
- agent_learnings table in Supabase + manual entry for first false positives
- Squad keywords auto-rebuild when player row added/updated in Supabase
- Squad auto-update via Transfermarkt RSS (departed players flagged automatically)
- Pageview/click tracking per article (engagement_events table)
- Source performance dashboard (which sources drive best NVS)
- Journalist accuracy tracker (transfer rumors confirmed/failed)
- AdSense should be live and earning by end of this sprint

### 📋 Sprint 6 — "Make it scalable" (2nd team gate)

**Goal: onboard Team 2 from a console UI. Zero code changes.**

- Console: add team (name, feeds, keywords, squad, thresholds)
- Console: squad management (add/edit/remove players, status, position)
- Console: keyword management — editable tag list, "Regenerate from squad" button
- Console: scoring threshold configuration per team
- Console: article review queue with admin feedback (→ agent_learnings)
- Auto-generate keyword_config from squad_members (Supabase function)
- Weekly keyword refresh via Claude (name variations, nicknames, transliterations)
- Transfer window auto-expand: targets/rumored keywords active May–Aug, Jan–Feb
- Team 2 onboarding end-to-end (Galatasaray or Fenerbahçe)
- Learn Agent v1: weekly pattern extraction from engagement signals
- Transfer prediction history dashboard (rumor → confirmed/denied timeline)
- scoring_config JSONB per team (NVS thresholds configurable without deploy)
- Squad members seed: populate squad_members table via console

### 📋 Sprint 7 — Growth + Distribution

- Auto-tweet high NVS articles (@kartalix)
- Transfer Radar Pro (paid tier, €3.99/mo)
- 3 more Turkish teams from console
- Revenue dashboard cross-team
- Fan comment integration as learning signal
- Cross-team learning propagation (global learnings applied to all teams)

**Revenue checkpoint:**
```
After Sprint 4:  AdSense applied
After Sprint 5:  AdSense live, €20-80/month
After Sprint 6:  2 teams, €100-300/month
After Sprint 7:  5 teams, €500-1500/month
```
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
