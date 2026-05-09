-- European competition spots per league/season.
-- Maps finishing positions to competition, entry round, start month,
-- and extra qualifying games. Multi-tenant: works for any league.

CREATE TABLE IF NOT EXISTS league_european_spots (
  id            UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  league_id     INTEGER NOT NULL,
  season        INTEGER NOT NULL,
  position_from INTEGER NOT NULL,
  position_to   INTEGER NOT NULL,
  competition   TEXT    NOT NULL,  -- 'UEFA Champions League'
  comp_short    TEXT    NOT NULL,  -- 'UCL'
  entry_round   TEXT,              -- '3. Eleme Turu', 'Grup Aşaması'
  start_month   INTEGER,           -- 7 = Temmuz, 8 = Ağustos, 9 = Eylül
  extra_games   TEXT,              -- '3-4' (qualifying legs before group/league phase)
  notes         TEXT,
  UNIQUE (league_id, season, position_from)
);

-- ── Trendyol Süper Lig 2025-26 (league_id = 203) ──────────────
-- Turkey's UEFA coefficient: improving. Entry rounds approximate.
INSERT INTO league_european_spots (league_id, season, position_from, position_to, competition, comp_short, entry_round, start_month, extra_games, notes) VALUES
  (203, 2025, 1, 1, 'UEFA Şampiyonlar Ligi', 'UCL',  'Ön Eleme / Play-off',  8, '2-4', 'Katsayıya göre 3. tur veya play-off'),
  (203, 2025, 2, 2, 'UEFA Şampiyonlar Ligi', 'UCL',  '3. Eleme Turu',         8, '2-4', NULL),
  (203, 2025, 3, 3, 'UEFA Avrupa Ligi',       'UEL',  '3. Eleme Turu',         8, '2-3', 'Grup aşamasına 2 tur kaldı'),
  (203, 2025, 4, 4, 'UEFA Konferans Ligi',    'UECL', '2. Eleme Turu',         7, '3-4', 'Temmuz başı — sezon öncesi 3-4 eleme maçı'),
  (203, 2025, 5, 5, 'UEFA Konferans Ligi',    'UECL', '1. Eleme Turu',         7, '4-6', 'En erken başlayan — Haziran/Temmuz');

-- ── Serie A 2025-26 (league_id = 135) — for Juventus etc. ─────
INSERT INTO league_european_spots (league_id, season, position_from, position_to, competition, comp_short, entry_round, start_month, extra_games, notes) VALUES
  (135, 2025, 1, 4, 'UEFA Şampiyonlar Ligi', 'UCL',  'Liga Aşaması',          9, '0',   'Doğrudan liga aşaması'),
  (135, 2025, 5, 5, 'UEFA Avrupa Ligi',       'UEL',  'Liga Aşaması',          9, '0',   NULL),
  (135, 2025, 6, 6, 'UEFA Konferans Ligi',    'UECL', 'Liga Aşaması',          9, '0',   NULL);
