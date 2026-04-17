-- Sprint 4: Add slug column to content_items
-- Run this in Supabase SQL editor

ALTER TABLE content_items ADD COLUMN IF NOT EXISTS slug TEXT;

-- Index for fast article page lookups
CREATE INDEX IF NOT EXISTS idx_content_items_slug ON content_items(slug);

-- Backfill slugs for existing rows (optional, uses a simplified slug)
-- UPDATE content_items
-- SET slug = lower(regexp_replace(
--   regexp_replace(
--     regexp_replace(title, '[^\w\s-]', '', 'g'),
--     '\s+', '-', 'g'),
--   '-{2,}', '-', 'g'))
-- WHERE slug IS NULL;
