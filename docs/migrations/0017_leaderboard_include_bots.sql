-- Leaderboard views: include bots for social proof
-- Removes is_bot = false filter; adds is_bot column to all views
-- so the frontend can distinguish bots if needed.

DROP VIEW IF EXISTS public.leaderboard_alltime;
DROP VIEW IF EXISTS public.leaderboard_monthly;
DROP VIEW IF EXISTS public.leaderboard_weekly;
DROP VIEW IF EXISTS public.leaderboard_seasonal;
DROP VIEW IF EXISTS public.leaderboard_streak;

CREATE VIEW public.leaderboard_alltime AS
SELECT p.site_id,
  p.id AS user_id,
  p.username,
  p.display_name,
  p.avatar_url,
  p.is_bot,
  (COALESCE(sum(e.xp_earned) FILTER (WHERE NOT e.nullified), 0))::integer AS total_xp,
  (SELECT lt.level FROM level_thresholds lt
    WHERE lt.xp_required <= COALESCE(sum(e.xp_earned) FILTER (WHERE NOT e.nullified), 0)
    ORDER BY lt.level DESC LIMIT 1) AS current_level,
  (SELECT lt.tier_name FROM level_thresholds lt
    WHERE lt.xp_required <= COALESCE(sum(e.xp_earned) FILTER (WHERE NOT e.nullified), 0)
    ORDER BY lt.level DESC LIMIT 1) AS tier_name
FROM profiles p
LEFT JOIN xp_events e ON e.user_id = p.id AND e.site_id = p.site_id
WHERE p.leaderboard_visible = true AND p.shadow_banned = false
GROUP BY p.site_id, p.id, p.username, p.display_name, p.avatar_url, p.is_bot;

CREATE VIEW public.leaderboard_monthly AS
SELECT p.site_id,
  p.id AS user_id,
  p.username,
  p.display_name,
  p.avatar_url,
  p.is_bot,
  (COALESCE(sum(e.xp_earned) FILTER (WHERE NOT e.nullified), 0))::integer AS monthly_xp
FROM profiles p
LEFT JOIN xp_events e ON e.user_id = p.id AND e.site_id = p.site_id
  AND date_trunc('month', e.created_at AT TIME ZONE 'UTC') = date_trunc('month', now() AT TIME ZONE 'UTC')
WHERE p.leaderboard_visible = true AND p.shadow_banned = false
GROUP BY p.site_id, p.id, p.username, p.display_name, p.avatar_url, p.is_bot;

CREATE VIEW public.leaderboard_weekly AS
SELECT p.site_id,
  p.id AS user_id,
  p.username,
  p.display_name,
  p.avatar_url,
  p.is_bot,
  (COALESCE(sum(e.xp_earned) FILTER (WHERE NOT e.nullified), 0))::integer AS weekly_xp
FROM profiles p
LEFT JOIN xp_events e ON e.user_id = p.id AND e.site_id = p.site_id
  AND date_trunc('week', e.created_at AT TIME ZONE 'UTC') = date_trunc('week', now() AT TIME ZONE 'UTC')
WHERE p.leaderboard_visible = true AND p.shadow_banned = false
GROUP BY p.site_id, p.id, p.username, p.display_name, p.avatar_url, p.is_bot;

CREATE VIEW public.leaderboard_seasonal AS
SELECT p.site_id,
  p.id AS user_id,
  p.username,
  p.display_name,
  p.avatar_url,
  p.is_bot,
  (COALESCE(sum(e.xp_earned) FILTER (WHERE NOT e.nullified), 0))::integer AS seasonal_xp
FROM profiles p
LEFT JOIN xp_events e ON e.user_id = p.id AND e.site_id = p.site_id
  AND e.created_at >= CASE
    WHEN EXTRACT(month FROM now()) >= 6 THEN date_trunc('year', now()) + '5 mons'::interval
    ELSE date_trunc('year', now()) - '7 mons'::interval
  END
WHERE p.leaderboard_visible = true AND p.shadow_banned = false
GROUP BY p.site_id, p.id, p.username, p.display_name, p.avatar_url, p.is_bot;

CREATE VIEW public.leaderboard_streak AS
SELECT p.site_id,
  p.id AS user_id,
  p.username,
  p.display_name,
  p.avatar_url,
  p.is_bot,
  COALESCE(s.current_streak, 0) AS current_streak,
  COALESCE(s.longest_streak, 0) AS longest_streak,
  s.streak_started_at
FROM profiles p
LEFT JOIN user_streaks s ON s.user_id = p.id AND s.site_id = p.site_id
WHERE p.leaderboard_visible = true AND p.shadow_banned = false;
