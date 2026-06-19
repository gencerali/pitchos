-- 0016_bot_columns.sql
-- Adds bot management columns to profiles table.
-- bot_tier: 'power' | 'regular' | 'casual' | 'dormant'
-- bot_activity_rate: 0.0-1.0, probability of action per cron window

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bot_tier          TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS bot_activity_rate NUMERIC DEFAULT 0;

-- Fast lookup for tick queries (all active non-dormant bots)
CREATE INDEX IF NOT EXISTS idx_profiles_bot_tier
  ON public.profiles (bot_tier)
  WHERE is_bot = true AND bot_tier IS NOT NULL;
