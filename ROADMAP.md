# Kartalix — Product Roadmap
Last updated: April 5, 2026

## Vision
AI-powered Beşiktaş (and multi-team) fan news platform with credibility scoring,
original content, and passive income through advertising and subscriptions.

## Live Infrastructure
- kartalix.com — domain purchased, connecting to Cloudflare
- Cloudflare Pages — hosting (free)
- Cloudflare Workers — fetch agent (pitchos-fetch-agent)
- Cloudflare KV — article cache (PITCHOS_CACHE)
- Supabase — database (pitchos project)
- GitHub — code repository (pitchos)

## Content Philosophy

### Content Tiers
- Tier 1: Kartalix Özel — original AI analysis, multi-source synthesis (5-8/day)
- Tier 2: Güvenilir Haber — verified news rewritten in Kartalix voice (10-15/day)
- Tier 3: Söylenti / Transfer Radar — rumors with credibility badges (5-10/day)

### Golden Score System (visible to readers)
- ⚡⚡⚡⚡⚡ Kesin — official source, confirmed fact
- ⚡⚡⚡⚡ Güçlü — verified journalist, highly reliable
- ⚡⚡⚡ Güvenilir — established media outlet
- ⚡⚡ Olası — unverified but plausible
- ⚡ Zayıf — weak signal, low confidence
- 👁️👁️👁️ Ciddi İddia — rumor from known journalist
- 👁️👁️ İddia — rumor, unverified claim
- 👁️ Söylenti — speculation, treat with caution

### Source Trust Tiers (internal, console-configurable per team)
- 🔵 Resmi Kaynak — club/player/coach official accounts (100% trust)
- 🟢 Doğrulanmış Gazeteci — Fırat Günayer, Fabrizio Romano etc.
- 🟡 Güvenilir Medya — Fotomac, Fanatik, Milliyet, TRT Spor
- 🟠 Bağımsız Kaynak — bloggers, YouTubers, smaller accounts
- 🔴 Sosyal Medya — unknown Twitter, forums

### Sport Priority
- Football: always show
- Basketball: weekly + important results (currently in EuroCup final)
- Volleyball/Handball/Other: only major news

## Content Pipeline (Worker)
1. Scout Phase (Haiku — cheap): RSS fetch → title+summary only → NVS score all items
2. Select top 8 by NVS
3. Deep Dive Phase (fetch full article from source URL for top 3)
4. Write Phase (Sonnet): top 3 = full Kartalix article, 4-8 = summary rewrite
5. Cache to KV, save to Supabase
6. Weekly Analysis (Sunday): squad gap analysis, transfer targets, tactical piece

## Learning Engine (data collected from day 1, used from Sprint 5)
- Track per article: views, read_time, clicks, shares, return_visit
- Learn per source: engagement rate → adjust trust weight
- Learn per team/country: content preferences
- Rumor tracking: prediction confirmed/failed → journalist accuracy score
- Feedback loop: Claude prompts updated with engagement weights

## Squad Intelligence System

A dynamic database of players, coaches, and staff per team — used for:
1. Keyword filtering on international feeds (catch news about BJK players without mentioning BJK)
2. Transfer Radar (track former players who might return)
3. Player Pulse cards (sentiment per player)
4. Journalist accuracy tracking (who predicted their transfer correctly)

#### Supabase table: squad_members
- id, site_id, name, name_variations (JSONB array e.g. ["Orkun","Kökçü","Kokcu"])
- role: player | coach | staff | president
- status: current | departed_1y | departed_2y | target | rumored
- position: GK | DEF | MID | FWD | coach | director
- nationality, age, market_value_eur
- joined_at, departed_at
- shirt_number
- social_handles (JSONB e.g. {twitter: "@orkunkokcu", instagram: "..."})
- created_at, updated_at

#### How it works:
- Sprint 3: Manually seed BJK squad from Transfermarkt
- Sprint 5: Auto-update via Transfermarkt RSS + Claude extraction
- Sprint 6: Console UI to add/edit/remove members
- Sprint 7: Cross-team when scaling to new clubs

#### Keyword filter logic:
- current players: always monitored
- departed_1y: monitored (loan returns, transfer links back)
- departed_2y: monitored only if mentioned with BJK keyword together
- targets/rumored: monitored (transfer window)
- Auto-generate name_variations: "Hyeon-gyu Oh" → ["Oh","Hyeon","현규","오현규"]
- journalist/international feeds filtered by BJK_KEYWORDS array (title + description)
- press/broadcast/official feeds use team-specific RSS URLs — no keyword filter needed

#### Active Keyword List (BJK_KEYWORDS — April 2026, hardcoded in src/utils.js):
beşiktaş, besiktas, bjk, kartal,
ersin destanoğlu, devis vasquez, vasquez,
amir murillo, murillo, emmanuel agbadou, agbadou,
tiago djalo, djalo, felix uduokhai, uduokhai,
emirhan topçu, emirhan, rıdvan yılmaz, rıdvan, taylan bulut, taylan,
gökhan sazdağı, orkun kökçü, orkun, wilfred ndidi, ndidi,
kristjan asllani, asllani, salih uçan, kartal kayra yılmaz, kartal kayra,
milot rashica, rashica, junior olaitan, olaitan,
tammy abraham, abraham, vaclav cerny, cerny,
el bilal touré, el bilal, hyeon-gyu oh, oh hyeon,
jota silva, jota, cengiz ünder, cengiz,
mustafa hekimoğlu, hekimoglu, sergen yalçın, sergen,
serdal adalı, serdal, mert günok, jean onana, onana
(Sprint 6: move to squad_members table, auto-build from DB)

#### Console UI (Sprint 6):
- Squad roster view per team with status badges
- Add player manually or import from Transfermarkt URL
- Edit name variations (critical for non-Latin names)
- Mark as departed → system keeps monitoring for X months
- Transfer window mode: promote rumored targets to active monitoring
- Show which articles each player triggered

#### Transfer Window Intelligence:
During transfer windows (Jan, June-Aug):
- Expand monitoring to rumored targets automatically
- Track how many times a name appears across sources
- Score rumor strength by: source trust × mention frequency × specificity
- Feed directly into Transfer Radar on fan site

#### Current BJK Squad (seed data — April 2026):
Kaleciler: Ersin Destanoğlu, Devis Vasquez
Defans: Amir Murillo, Emmanuel Agbadou, Tiago Djalo, Felix Uduokhai, Emirhan Topçu, Rıdvan Yılmaz, Taylan Bulut, Yasin Özcan, Gökhan Sazdağı
Orta Saha: Orkun Kökçü, Wilfred Ndidi, Kristjan Asllani, Salih Uçan, Kartal Kayra Yılmaz, Milot Rashica, Junior Olaitan
Forvet: Tammy Abraham, Vaclav Cerny, El Bilal Touré, Hyeon-gyu Oh, Jota Silva, Cengiz Ünder, Mustafa Hekimoğlu
Teknik Direktör: Sergen Yalçın
Başkan: Serdal Adalı

Departed (last 1 year — still monitor):
Mert Günok (→ Fenerbahçe), Jean Onana (→ Genoa loan)

---

## Revenue Plan
- AdSense: all tiers (apply Sprint 3)
- Transfer window newsletter: €5/month subscribers
- Kartalix Pro: early Transfer Radar access, prediction history €3/month
- Sponsored content: clearly labeled (Sprint 7+)

## Homepage Architecture
- Ticker: breaking news NVS > 75
- Featured: 1 big Kartalix Özel or top story
- Top Stories: 3 cards mixed tiers
- Transfer Radar: live rumor board with Golden Score
- Son Dakika: 8 cards mixed tiers labeled
- Diğer Sporlar: 2-3 cards high NVS non-football only
- Fan Pulse: daily sentiment
- Archive: paginated older stories

---

## Sprint Status

### ✅ Sprint 0 — Foundation (COMPLETE)
- Console HTML shell
- Supabase schema (10 tables)
- Beşiktaş fan site first version
- GitHub repo, Cloudflare Pages, Wrangler CLI
- Claude Code configured

### ✅ Sprint 1 — Live Pipeline (COMPLETE)
- Cloudflare Worker fetch agent live
- Claude API connected with web search
- NVS scoring (fact vs rumor classification)
- KV cache → fan site reads live news
- Cron trigger every hour
- Supabase logging fetch results
- Secrets permanent via wrangler secret put
- dev.bat shortcuts for common commands

### 🔄 Sprint 2 — Content Quality (IN PROGRESS)
#### Done:
- Two-phase pipeline (scout → deep dive)
- Fotomac RSS working (besiktas.xml)
- Duhuliye RSS working (full content:encoded)
- Article deduplication (40% title similarity)
- Full AI article writing (Sonnet)
- Article modal on fan site
- Cloudflare Pages connected to GitHub (auto-deploy on push)
- kartalix.com domain purchased

#### In Progress:
- waitUntil timeout fix (max_tokens reduction, brevity prompts)
- beIN Sports web search integration

#### Confirmed RSS Sources (12 feeds):
- Beşiktaş JK Resmi — nitter.privacydev.net/Besiktas/rss (official)
- NTV Spor — ntvspor.net/rss/kategori/futbol + HTML fallback (broadcast)
- Fotomaç — fotomac.com.tr/rss/Besiktas.xml (press)
- Fotomaç Basketbol — fotomac.com.tr/rss/Basketbol.xml (press)
- A Haber — ahaber.com.tr/rss/besiktas.xml (press)
- TRT Haber — trthaber.com/spor_articles.rss (broadcast)
- A Spor — aspor.com.tr/rss/anasayfa.xml (broadcast)
- Hürriyet — hurriyet.com.tr/rss/spor (press)
- Fırat Günayer — nitter.privacydev.net/firatgunayer/rss (journalist, title-only filter)
- Fabrizio Romano — nitter.privacydev.net/FabrizioRomano/rss (journalist, title-only filter)
- Transfermarkt — transfermarkt.com/rss/news (international, title-only filter)
- Sky Sports — skysports.com/rss/12040 (international, title-only filter)
- beIN Sports — Claude web search site:beinsports.com.tr (broadcast, ~1000 tokens)

#### Remaining Sprint 2:
- Golden Score system (⚡ and 👁️ badges) replacing NVS numbers
- Article page with full body display
- Transfer Radar with live data
- Fan Pulse with real sentiment
- Nitter RSS for Fırat Günayer Twitter
- kartalix.com connected to Cloudflare Pages
- Sport classification (football/basketball/other)
- Diğer Sporlar section on homepage

### 📋 Sprint 3 — Legal + Monetization Foundation
- GDPR/KVKK cookie banner (Turkey + EU)
- Privacy policy page auto-generated
- Source attribution on every article
- AdSense application submitted
- AdSense slots in fan site (header + in-feed)
- Google Search Console submission
- Google News submission
- Sitemap.xml auto-generated
- **squad_members table**: seed BJK squad manually from Transfermarkt

### 📋 Sprint 4 — SEO + Distribution
- NewsArticle structured data
- Meta tags + Open Graph per article
- RSS feed for kartalix.com
- Submit to Google News
- Auto-tweet high NVS articles (@kartalix Twitter)
- WhatsApp share buttons
- Article URLs with SEO-friendly slugs

### 📋 Sprint 5 — Analytics + Learning Engine
- Pageview/click tracking per article
- Source engagement dashboard
- API cost breakdown by model/day
- Site health monitor
- Alert rules (email on failure)
- Learning weights: source trust updated by engagement
- Journalist accuracy tracker (rumor confirmed/failed)
- Transfer prediction history dashboard
- **Squad auto-update**: Transfermarkt RSS + Claude extraction → squad_members

### 📋 Sprint 6 — Clone Engine + Team 2
- Console Site Factory fully operational
- Source management UI per team
- Social account management per team
- Feature flags working
- Clone Beşiktaş → Team 2 (Galatasaray or Fenerbahçe)
- Cross-site console dashboard
- **Console squad management UI**: add/edit/remove players, name variations, status

### Console — Fetch Schedule Configuration (Sprint 6)
Per-site settings manageable from console UI:

Fetch schedule:
- Global cron interval (every 1h / 2h / 4h / 6h / 12h / 24h)
- Active hours per site (e.g. 08:00-23:00 Istanbul time only)
- Per-source enable/disable toggle
- Per-source max items per fetch (5 / 10 / 15 / 20)
- beIN web search: on/off + max runs per day (1/2/4/8/24)
- Web search fallback: on/off

Token budget controls:
- Max tokens per run (soft limit — skip writeArticles if exceeded)
- Max Sonnet calls per run (1 / 2 / 3)
- Score-only mode toggle (skip writeArticles entirely, use RSS summary)
- Cost alert threshold per day (email if exceeded)

These settings stored in Supabase sites table as JSONB column fetch_config.
Worker reads fetch_config at start of each run and applies settings dynamically.
No redeployment needed to change schedule or limits.

### 📋 Sprint 7 — Scale to 5 Teams
- 3 more Turkish teams
- Social account discovery engine
- Revenue dashboard cross-site
- International source templates

### 📋 Sprint 8 — International Expansion
- First non-Turkish team (Bundesliga or Premier League)
- Multi-language content engine
- Country-specific legal templates
- International AdSense rates comparison

### 📋 Sprint 9 — Engagement + Community
- Comment system with AI moderation
- Fan Memory (personal accounts)
- Push notifications for NVS > 80
- Email newsletter weekly digest
- Kartalix Pro subscription tier

### 📋 Sprint 10 — AI Journalist Agent
- Dedicated journalist agent reviewing every article
- Quality gate before publish
- Story evolution tracking (rumor → confirmed → signed)
- Duplicate detection across all sources
- Weekly Kartalix Analiz pieces (squad gaps, transfer targets)
- Speculative transfer content clearly labeled

---

## Key Decisions Made
- No external AI tools needed — Claude does everything
- No server/VPS needed — Cloudflare + Supabase free tiers
- Wrangler CLI for deployment (wrangler deploy)
- Claude Code for code editing
- Domain only cost: €8/year (kartalix.com at Strato)
- Content model: Perplexity-style (AI rewrites, source attributed, no external links by default)
- Score visibility: Golden Score badges public, raw NVS internal only
- Learning: behavioral analytics not LLM retraining
- Photos: Sprint 3 (Wikimedia/Unsplash), Sprint 5 (Twitter embeds)
- Fetch schedule and token budgets will be console-configurable per site (Sprint 6)
- Current hardcoded values are temporary until console UI is built
- fetch_config JSONB column to be added to sites table in Sprint 6 migration

### Token Optimization Framework
- Pre-filter in pure JS before any Claude call: 48h recency, keyword regex, dedup, seen-hash check, min 50 chars, cap 20
- Scout phase (Haiku): title (100ch) + source + trust_tier + sport only — no summary, no full text
- Seen-hash cache in KV (`seen:BJK`, last 100 hashes, 48h TTL) — skip already-processed articles each run
- Deep dive: Duhuliye articles use content:encoded already fetched (zero extra fetch); others use fetchFullArticle() max 2000ch
- Write phase: top 3 = Sonnet (full text context), ranks 4-8 = Haiku (summary only, 400ch)
- Per-phase token tracking: scout_tokens, write_tokens logged to console + Supabase fetch_logs
- 2s delay between scout and score calls; 500ms between deep-dive fetches
- Rate limit: 50k input tokens/minute on Haiku org limit — pre-filter + seen-hash prevents re-scoring known articles

## Open Questions
- Kartalix Pro pricing and feature set (decide Sprint 8)
- Whether to show article read count publicly
- YouTube transcript extraction timing (Sprint 5)
- WebSub real-time push notifications (Sprint 4 consideration)
