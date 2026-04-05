-- ============================================================
-- Kartalix — Sprint 2 Migration
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Add columns that the worker now writes to content_items
alter table content_items
  add column if not exists content_type  text,          -- 'fact' | 'rumor' | 'analysis'
  add column if not exists golden_score  text,          -- '5','4','3','2','1' or 'eye3','eye2','eye1'
  add column if not exists full_body     text,          -- full article text (copy_source or template)
  add column if not exists image_url     text,          -- og:image URL
  add column if not exists publish_mode  text,          -- 'rss_summary'|'copy_source'|'template_matchday' etc.
  add column if not exists sport         text           -- 'football'|'basketball'|'volleyball'
                           default 'football';
