-- Migration 0009: ref_sources on content_items
-- Tracks which source articles were used as reference for YZ/YZ+ generated content.
-- Populated at generation time; empty array for templates, manual, copy_source, rss_summary.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS ref_sources JSONB DEFAULT '[]';
