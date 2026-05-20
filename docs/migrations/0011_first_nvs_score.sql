-- Migration 0011: first_nvs_score on content_items
-- Stores the NVS score at first publication. nvs_score may be updated later;
-- first_nvs_score is set once at INSERT and never changed.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS first_nvs_score INTEGER;
UPDATE content_items SET first_nvs_score = nvs_score WHERE first_nvs_score IS NULL AND nvs_score IS NOT NULL;
