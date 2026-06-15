-- 0015_level_thresholds.sql
-- Populates level_thresholds so the XP progress bar on /profil works.
-- get_user_level RPC queries this table. me.js reads min_xp for the bar.
--
-- Tier mapping (mirrors badge_id checks in xp.js checkBadges):
--   Tier 1 (Misafir Kartal) : levels 1–3
--   Tier 2 (Atmaca)         : levels 4–6   ← badge at level 4
--   Tier 3 (Şahin)          : levels 7–9   ← badge at level 7
--   Tier 4 (Kartal)         : levels 10–12 ← badge at level 10
--   Tier 5 (Efsane Kartal)  : levels 13–20 ← badge at level 13
--
-- XP economy reference:
--   daily_checkin = ~10 XP, article_read = ~15 XP
--   streak_5_bonus = ~25 XP every 5 days
--   Estimated ~4 500 XP/year for an active daily user → Tier 4 in ~2 years

CREATE TABLE IF NOT EXISTS public.level_thresholds (
  level        integer PRIMARY KEY,
  min_xp       integer NOT NULL,
  tier_number  integer NOT NULL DEFAULT 1,
  tier_name    text    NOT NULL DEFAULT 'Misafir Kartal'
);

-- Clear and repopulate (idempotent)
TRUNCATE public.level_thresholds;

INSERT INTO public.level_thresholds (level, min_xp, tier_number, tier_name) VALUES
  ( 1,     0, 1, 'Misafir Kartal'),
  ( 2,    50, 1, 'Misafir Kartal'),
  ( 3,   125, 1, 'Misafir Kartal'),
  ( 4,   250, 2, 'Atmaca'),
  ( 5,   400, 2, 'Atmaca'),
  ( 6,   600, 2, 'Atmaca'),
  ( 7,   850, 3, 'Şahin'),
  ( 8,  1150, 3, 'Şahin'),
  ( 9,  1500, 3, 'Şahin'),
  (10,  2000, 4, 'Kartal'),
  (11,  2600, 4, 'Kartal'),
  (12,  3300, 4, 'Kartal'),
  (13,  4200, 5, 'Efsane Kartal'),
  (14,  5200, 5, 'Efsane Kartal'),
  (15,  6500, 5, 'Efsane Kartal'),
  (16,  8000, 5, 'Efsane Kartal'),
  (17,  9800, 5, 'Efsane Kartal'),
  (18, 12000, 5, 'Efsane Kartal'),
  (19, 14500, 5, 'Efsane Kartal'),
  (20, 17500, 5, 'Efsane Kartal');

-- Grant read access (used by service role key in API, but anon needs it for the RPC)
ALTER TABLE public.level_thresholds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read" ON public.level_thresholds FOR SELECT USING (true);
