-- Migration: 0002_facts_firewall
-- Run once in Supabase SQL editor.
-- Creates facts + fact_lineage tables for the Slice 1 Facts Extraction Firewall.
-- These tables are the legal core: source text is NEVER stored here.
-- Only structured entities, numbers, and dates — plus an audit trail of destruction.

CREATE TABLE IF NOT EXISTS facts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id           uuid REFERENCES content_items(id) ON DELETE SET NULL,
  site_id                   uuid REFERENCES sites(id) ON DELETE CASCADE,

  -- Story classification
  story_type                text NOT NULL DEFAULT 'other',
    -- transfer / injury / disciplinary / contract / match_result / squad / institutional / other

  -- Extracted structured facts (no source text, no paraphrase)
  entities                  jsonb NOT NULL DEFAULT '{"players":[],"clubs":[],"competitions":[]}',
  numbers                   jsonb NOT NULL DEFAULT '{}',
  dates                     jsonb NOT NULL DEFAULT '{}',

  -- Extraction audit
  extraction_model          text,
  extraction_input_tokens   integer,
  extraction_output_tokens  integer,

  created_at                timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS facts_content_item ON facts(content_item_id);
CREATE INDEX IF NOT EXISTS facts_site_type    ON facts(site_id, story_type);

-- ─── FACT LINEAGE (legal audit trail) ────────────────────────────────────────
-- One row per extraction. Records that source text existed, was processed,
-- and was destroyed. destruction_confirmed_at is the legal timestamp.
-- Source text is intentionally NOT stored here.

CREATE TABLE IF NOT EXISTS fact_lineage (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id           uuid REFERENCES content_items(id) ON DELETE SET NULL,
  facts_id                  uuid REFERENCES facts(id) ON DELETE SET NULL,

  -- Source provenance (no source text — only metadata)
  source_url                text,
  source_name               text,
  source_text_length        integer,  -- proof we processed something; text itself discarded

  -- Extraction audit
  extraction_model          text,
  extraction_tokens_in      integer,
  extraction_tokens_out     integer,

  -- Legal core: timestamp proving source text was not retained
  destruction_confirmed_at  timestamptz NOT NULL,

  created_at                timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fact_lineage_content_item ON fact_lineage(content_item_id);
CREATE INDEX IF NOT EXISTS fact_lineage_facts_id     ON fact_lineage(facts_id);
