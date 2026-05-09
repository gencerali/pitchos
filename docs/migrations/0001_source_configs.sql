-- Migration: 0001_source_configs
-- Run once in Supabase SQL editor.
-- Creates the source_configs table that replaces hardcoded RSS_FEEDS + YOUTUBE_CHANNELS.

CREATE TABLE IF NOT EXISTS source_configs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid REFERENCES sites(id) ON DELETE CASCADE,
  name         text NOT NULL,
  source_type  text NOT NULL CHECK (source_type IN ('rss', 'youtube', 'bjk_official')),

  -- Identifiers (one will be set depending on source_type)
  url          text,         -- RSS feed URL
  channel_id   text,         -- YouTube channel ID

  -- Scoring + classification
  trust_tier   text NOT NULL DEFAULT 'press',   -- official/broadcast/press/journalist/digital/aggregator
  treatment    text NOT NULL DEFAULT 'publish', -- publish/embed/synthesize/signal_only
  sport        text DEFAULT 'football',
  is_p4        boolean DEFAULT true,
  nvs_hint     integer,      -- preset NVS; bypasses Claude scoring when set

  -- Filtering
  bjk_filter   boolean DEFAULT false,  -- require BJK keyword match in title/description
  all_qualify  boolean DEFAULT false,  -- YouTube: all videos qualify regardless of title

  -- Infrastructure
  proxy        boolean DEFAULT false,  -- route through pitchos-proxy

  -- Admin
  is_active    boolean DEFAULT true,
  notes        text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_configs_site_active ON source_configs(site_id, is_active);

-- Seed defaults by calling POST /admin/sources/seed after running this migration.
