-- ============================================================
-- Legal Cleanup Migration — 2026-04-28
-- Run in: Supabase Dashboard → SQL Editor → New Query
--
-- Purpose: Delete stored P4 source text from content_items.
-- Required by Turkish IP lawyer 48-hour action plan.
-- P4 sources: Fotomaç, A Spor, Sabah, Hürriyet, Fanatik, Milliyet.
-- See DECISIONS.md 2026-04-28 entries.
-- ============================================================

-- 1. Wipe full_body for all P4-sourced articles.
--    These contain Readability-extracted or RSS full text from
--    commercial outlets — legally indefensible to store.
UPDATE content_items
SET
  full_body    = NULL,
  publish_mode = 'pre_firewall_cleaned'
WHERE source_name IN (
  'Fotomaç', 'A Spor', 'Fotomaç Basketbol',
  'Sabah Spor', 'Hürriyet', 'Fanatik', 'Milliyet'
)
AND publish_mode IN ('readability', 'copy_source', 'rss_summary');

-- 2. Wipe image_url for all P4-sourced articles (IT3 images).
UPDATE content_items
SET image_url = NULL
WHERE source_name IN (
  'Fotomaç', 'A Spor', 'Fotomaç Basketbol',
  'Sabah Spor', 'Hürriyet', 'Fanatik', 'Milliyet'
)
AND image_url IS NOT NULL
AND image_url != '';

-- 3. Verify — should return 0 rows after cleanup.
SELECT id, source_name, publish_mode, length(full_body) as body_len
FROM content_items
WHERE source_name IN (
  'Fotomaç', 'A Spor', 'Fotomaç Basketbol',
  'Sabah Spor', 'Hürriyet', 'Fanatik', 'Milliyet'
)
AND full_body IS NOT NULL
AND length(full_body) > 100;
