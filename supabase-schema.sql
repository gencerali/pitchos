-- ============================================================
-- PitchOS — Supabase Schema
-- Sprint 0 Foundation
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Enable UUID generation
create extension if not exists "pgcrypto";


-- ============================================================
-- 1. SITES
-- Core table — one row per football team site
-- ============================================================
create table sites (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),

  -- Identity
  team_name       text not null,               -- "Beşiktaş JK"
  short_code      text not null unique,         -- "BJK"
  domain          text not null unique,         -- "kartal-haber.com"
  crest_emoji     text default '⚽',

  -- Locale
  country_code    text not null default 'TR',   -- ISO 3166-1 alpha-2
  languages       text[] default '{tr,en}',     -- primary first
  timezone        text default 'Europe/Istanbul',

  -- Branding
  primary_color   text default '#000000',
  secondary_color text default '#ffffff',

  -- Status
  status          text not null default 'draft'
                  check (status in ('draft','live','paused','archived')),

  -- Content config
  fetch_interval_minutes  int default 60,
  auto_publish_threshold  int default 60,       -- NVS >= this → auto-publish
  review_threshold        int default 40,       -- NVS >= this → queue
                                                -- NVS < 40 → discard

  -- Cloned from
  cloned_from     uuid references sites(id),

  -- Monetization
  adsense_publisher_id  text,
  ad_slots              jsonb default '{}',     -- {header: "slot_id", infeed: ".."}

  -- Legal
  gdpr_enabled    boolean default true,
  kvkk_enabled    boolean default false,
  privacy_policy_url text,
  contact_email   text
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger sites_updated_at
  before update on sites
  for each row execute function update_updated_at();


-- ============================================================
-- 2. SOURCES
-- RSS feeds, news APIs per site
-- ============================================================
create table sources (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz default now(),
  site_id     uuid not null references sites(id) on delete cascade,

  name        text not null,           -- "Fanatik"
  type        text not null            -- 'rss' | 'api' | 'scraper'
              check (type in ('rss','api','scraper')),
  url         text not null,
  language    text default 'tr',
  active      boolean default true,
  trust_score int default 70           -- 0-100, manually set
);


-- ============================================================
-- 3. SOCIAL ACCOUNTS
-- Twitter/X and YouTube trusted accounts
-- ============================================================
create table social_accounts (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),

  platform        text not null
                  check (platform in ('twitter','youtube','instagram')),
  handle          text not null,         -- "@firatgunayer" or "UCxxxx"
  display_name    text,
  feed_url        text,                  -- Nitter RSS or YT feed URL

  -- Trust system
  trust_status    text not null default 'probation'
                  check (trust_status in ('trusted','probation','archived')),
  trust_score     int default 50,        -- 0-100, calculated over time
  avg_nvs_30d     int,                   -- rolling 30-day avg NVS
  probation_start timestamptz default now(),

  -- Stats
  total_items_scored  int default 0,
  items_published     int default 0,
  items_rejected      int default 0
);

-- Link accounts to sites (many-to-many)
create table site_social_accounts (
  site_id           uuid references sites(id) on delete cascade,
  social_account_id uuid references social_accounts(id) on delete cascade,
  primary key (site_id, social_account_id)
);


-- ============================================================
-- 4. CONTENT ITEMS
-- Every article, tweet, video evaluated — raw + processed
-- ============================================================
create table content_items (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  fetched_at      timestamptz default now(),
  site_id         uuid not null references sites(id) on delete cascade,

  -- Source
  source_type     text not null
                  check (source_type in ('rss','twitter','youtube','manual')),
  source_name     text,                  -- "Fanatik", "Fırat Günayer"
  source_url      text,
  original_url    text,

  -- Raw content
  raw_title       text,
  raw_body        text,
  raw_published_at timestamptz,

  -- Processed
  title           text,                  -- AI-processed headline
  summary         text,                  -- AI summary (2-3 sentences)
  category        text,                  -- Transfer | Match | Injury | Squad | Club | European
  language        text default 'tr',

  -- For videos
  video_timestamp_seconds int,           -- key moment start time
  video_key_moment        text,          -- description of the key moment

  -- NVS scoring
  nvs_score           int,              -- 0-100
  nvs_specificity     int,
  nvs_source_auth     int,
  nvs_novelty         int,
  nvs_recency         int,
  nvs_engagement      int,
  nvs_relevance       int,
  nvs_confidence      text              -- 'high'|'medium'|'low'
                      check (nvs_confidence in ('high','medium','low')),
  nvs_notes           text,             -- AI reasoning

  -- Duplicate detection
  content_hash    text,                 -- SHA of title+summary to detect dupes
  is_duplicate    boolean default false,
  duplicate_of    uuid references content_items(id),

  -- Status
  status          text not null default 'pending'
                  check (status in ('pending','approved','rejected','published','archived')),
  reviewed_by     text,                 -- 'auto' | 'admin'
  reviewed_at     timestamptz,

  -- Published translations
  translations    jsonb default '{}'    -- {en: {title, summary}, de: {...}}
);

-- Index for fast lookups
create index content_items_site_status on content_items(site_id, status);
create index content_items_nvs        on content_items(nvs_score desc);
create index content_items_hash       on content_items(content_hash);


-- ============================================================
-- 5. FETCH LOGS
-- Every cron run — success, failure, cost
-- ============================================================
create table fetch_logs (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  site_id         uuid references sites(id) on delete cascade,

  trigger_type    text default 'cron'
                  check (trigger_type in ('cron','manual','webhook')),
  status          text not null
                  check (status in ('success','partial','failed')),

  items_fetched   int default 0,
  items_scored    int default 0,
  items_published int default 0,
  items_queued    int default 0,
  items_rejected  int default 0,

  -- API cost tracking
  claude_calls        int default 0,
  tokens_input        int default 0,
  tokens_output       int default 0,
  estimated_cost_eur  numeric(10,4) default 0,
  model_used          text,

  error_message   text,
  duration_ms     int
);


-- ============================================================
-- 6. API COST TRACKING
-- Daily rollup for billing dashboard
-- ============================================================
create table api_costs_daily (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  site_id     uuid references sites(id) on delete cascade,

  claude_calls        int default 0,
  tokens_input        int default 0,
  tokens_output       int default 0,
  cost_eur            numeric(10,4) default 0,
  model_breakdown     jsonb default '{}',  -- {sonnet: cost, haiku: cost}

  unique(date, site_id)
);


-- ============================================================
-- 7. FEATURE FLAGS
-- Global or per-site feature toggles
-- ============================================================
create table feature_flags (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),

  key         text not null unique,       -- e.g. 'comments_enabled'
  description text,
  global_value boolean default false,

  -- Per-site overrides stored as: {site_id: true/false}
  site_overrides jsonb default '{}'
);

create trigger feature_flags_updated_at
  before update on feature_flags
  for each row execute function update_updated_at();

-- Seed initial flags
insert into feature_flags (key, description, global_value) values
  ('comments_enabled',      'Fan comment section',            false),
  ('social_feed_enabled',   'Twitter/YouTube ingestion',      false),
  ('auto_translate',        'Auto-translate articles',        false),
  ('gdpr_banner',           'GDPR cookie consent banner',     true),
  ('rss_feed',              'Public RSS feed per site',       false),
  ('social_share_buttons',  'Share buttons on articles',      true),
  ('nvs_score_visible',     'Show NVS score on article cards',false),
  ('adsense_enabled',       'Google AdSense slots',           false);


-- ============================================================
-- 8. COMMENTS
-- Per-site fan comments with moderation
-- ============================================================
create table comments (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),

  site_id         uuid not null references sites(id) on delete cascade,
  content_item_id uuid references content_items(id) on delete cascade,

  author_name     text not null,
  author_email    text,                  -- hashed before storage
  body            text not null,

  -- Moderation
  status          text default 'pending'
                  check (status in ('pending','approved','rejected','spam')),
  toxicity_score  int,                   -- 0-100 from AI filter
  moderated_at    timestamptz,

  -- Reactions (stored as counts)
  reactions       jsonb default '{}'     -- {fire: 4, thumbsup: 12}
);

create index comments_site_status on comments(site_id, status);


-- ============================================================
-- 9. ALERTS
-- System alerts and notification rules
-- ============================================================
create table alert_rules (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz default now(),

  site_id     uuid references sites(id) on delete cascade,  -- null = global
  type        text not null,           -- 'fetch_failure' | 'cost_overrun' | 'queue_full'
  threshold   int,                     -- e.g. cost > 5 EUR triggers alert
  channel     text default 'email',    -- 'email' | 'slack'
  destination text,                    -- email address or Slack webhook
  active      boolean default true
);

create table alert_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz default now(),
  rule_id     uuid references alert_rules(id) on delete cascade,
  site_id     uuid references sites(id),
  message     text,
  resolved    boolean default false,
  resolved_at timestamptz
);


-- ============================================================
-- 10. ANALYTICS EVENTS
-- Lightweight click/view tracking per site
-- (For heavier analytics, pipe to Plausible or Cloudflare)
-- ============================================================
create table analytics_events (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),

  site_id         uuid not null references sites(id) on delete cascade,
  content_item_id uuid references content_items(id),

  event_type      text not null          -- 'pageview' | 'article_click' | 'source_click'
                  check (event_type in ('pageview','article_click','source_click','reaction')),
  country_code    text,
  referrer        text,
  user_agent_hash text                   -- hashed, no PII
);

-- Partition hint for scale (add when you hit 1M+ rows)
-- create index analytics_events_site_date on analytics_events(site_id, created_at desc);


-- ============================================================
-- ROW-LEVEL SECURITY (enable after adding Supabase Auth)
-- ============================================================
-- alter table sites enable row level security;
-- alter table content_items enable row level security;
-- create policy "admin only" on sites for all using (auth.role() = 'authenticated');


-- ============================================================
-- SEED DATA — Beşiktaş starter site
-- ============================================================
insert into sites (
  team_name, short_code, domain, crest_emoji,
  country_code, languages, timezone,
  primary_color, secondary_color,
  status, fetch_interval_minutes,
  auto_publish_threshold, review_threshold,
  gdpr_enabled, kvkk_enabled
) values (
  'Beşiktaş JK', 'BJK', 'kartal-haber.com', '🦅',
  'TR', '{tr,en}', 'Europe/Istanbul',
  '#000000', '#ffffff',
  'live', 60,
  60, 40,
  true, true
);

-- Seed trusted social accounts
insert into social_accounts (platform, handle, display_name, feed_url, trust_status, trust_score)
values
  ('twitter',  '@firatgunayer',  'Fırat Günayer',  'https://nitter.net/firatgunayer/rss',      'trusted', 88),
  ('youtube',  'UCRabonaTV',     'Rabona TV',       'https://www.youtube.com/feeds/videos.xml?channel_id=UCRabonaTV', 'trusted', 82),
  ('twitter',  '@fabrizio_romano','Fabrizio Romano', 'https://nitter.net/FabrizioRomano/rss',   'trusted', 95),
  ('twitter',  '@bjk_official',  'Beşiktaş JK',     'https://nitter.net/Besiktas/rss',          'trusted', 99);

-- Seed RSS sources for Beşiktaş site
insert into sources (site_id, name, type, url, language, trust_score)
select
  s.id,
  src.name,
  'rss',
  src.url,
  'tr',
  src.trust_score
from sites s, (values
  ('Fanatik',       'https://www.fanatik.com.tr/rss/besiktas',    90),
  ('TRT Spor',      'https://www.trtsport.com/rss',               85),
  ('Fotomac',       'https://www.fotomac.com.tr/rss/besiktas',    80),
  ('Milliyet Spor', 'https://www.milliyet.com.tr/rss/rssnew/spor',75)
) as src(name, url, trust_score)
where s.short_code = 'BJK';

-- Seed feature flags with per-site overrides for BJK
update feature_flags
set site_overrides = jsonb_build_object(
  (select id::text from sites where short_code = 'BJK'), true
)
where key in ('gdpr_banner', 'social_share_buttons', 'adsense_enabled');
