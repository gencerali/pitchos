-- Rename publish_mode 'synthesis' → 'rewrite'
-- Single-source article rewriting is not synthesis. True synthesis (multi-source,
-- independent angle) will use publish_mode 'synthesis' when Sprint D2 ships.
-- Run once in Supabase SQL Editor.

UPDATE content_items
SET publish_mode = 'rewrite'
WHERE publish_mode = 'synthesis';
