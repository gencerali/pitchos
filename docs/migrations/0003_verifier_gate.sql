-- Verifier Gate: adds needs_review flag and verification_result audit column
-- to content_items. Run once in Supabase SQL editor.

ALTER TABLE content_items
  ADD COLUMN IF NOT EXISTS needs_review       BOOLEAN  DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_result JSONB    DEFAULT NULL;

-- Index for fast admin queries: find all articles needing review
CREATE INDEX IF NOT EXISTS idx_content_items_needs_review
  ON content_items (needs_review)
  WHERE needs_review = true;
