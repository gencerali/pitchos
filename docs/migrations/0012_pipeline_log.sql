-- Migration 0012: per-article pipeline log
-- Stores disposition of every article that enters the pre-filter stage.
-- Retention: 7 days (cleaned up by cron on each run).
CREATE TABLE IF NOT EXISTS pipeline_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid        NOT NULL,
  run_at      timestamptz NOT NULL,
  source_name text,
  title       text,
  url         text,
  stage       text        NOT NULL,
  nvs_score   integer,
  publish_mode text,
  created_at  timestamptz DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_log_site_run ON pipeline_log (site_id, run_at DESC);
