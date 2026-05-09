-- Add team_id and league_id to sites table for multi-tenant league context.
-- Run in Supabase SQL Editor, then update each site row with correct IDs.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS team_id    INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS league_id  INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS season     INTEGER DEFAULT 2025;

-- BJK: team_id=549, league_id=203 (Trendyol Süper Lig), season=2025 (2025-26)
UPDATE sites
SET team_id = 549, league_id = 203, season = 2025
WHERE team_name = 'Beşiktaş JK';
