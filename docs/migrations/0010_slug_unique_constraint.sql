-- Migration 0010: unique constraint on (site_id, slug) for non-null slugs
-- Makes resolution=ignore-duplicates in saveArticles actually prevent duplicate slugs.
-- Partial index: NULL slugs are excluded (they're orphaned rows with no article page).
-- Run AFTER cleanup-orphans removes existing null-slug and same-slug duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS content_items_site_slug_unique
  ON content_items (site_id, slug)
  WHERE slug IS NOT NULL;
