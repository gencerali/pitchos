-- Migration 0008: editorial_context on sites
-- Stores per-team editorial context for Sprint K Situational Awareness Engine (Layer 3).
-- Fields: manager, narrative_arc, transfer_posture, key_editorial_dates, concerns,
--         european_path_override, last_edited.
-- Managed via /admin editorial form; read by src/situation.js editorialContext().
ALTER TABLE sites ADD COLUMN IF NOT EXISTS editorial_context JSONB DEFAULT '{}';
