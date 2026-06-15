-- 0015_level_thresholds.sql
-- Populates level_thresholds so get_user_level RPC returns real levels
-- and the XP bar on /profil shows accurate progress.
--
-- The function (already in DB) queries: xp_required, tier_name, tier_number
--
-- Tier mapping (mirrors checkBadges in xp.js):
--   Tier 1 (Misafir Kartal) : levels 1–3
--   Tier 2 (Atmaca)         : levels 4–6   ← tier_2 badge
--   Tier 3 (Şahin)          : levels 7–9   ← tier_3 badge
--   Tier 4 (Kartal)         : levels 10–12 ← tier_4 badge
--   Tier 5 (Efsane Kartal)  : levels 13–20 ← tier_5 badge
--
-- XP economy (daily_checkin ~10 XP, article_read ~15 XP, streak bonuses):
--   Active daily user earns ~4 500 XP/year → Tier 4 in ~2 years

CREATE TABLE IF NOT EXISTS public.level_thresholds (
  level        integer PRIMARY KEY,
  xp_required  integer NOT NULL,
  tier_number  integer NOT NULL DEFAULT 1,
  tier_name    text    NOT NULL DEFAULT 'Misafir Kartal'
);

-- Idempotent repopulation
TRUNCATE public.level_thresholds;

INSERT INTO public.level_thresholds (level, xp_required, tier_number, tier_name) VALUES
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

-- RLS: anyone can read (needed by the RPC which runs as invoker)
ALTER TABLE public.level_thresholds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read" ON public.level_thresholds;
CREATE POLICY "public read" ON public.level_thresholds FOR SELECT USING (true);
