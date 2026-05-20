-- Migration 0013: store original RSS title on rewrite/synthesis articles
-- Preserves the source title for audit and A/B comparison.
-- article.title becomes the Kartalix-generated headline after this migration.

ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS original_rss_title TEXT;
