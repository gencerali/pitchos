-- ============================================================
-- 1. Function search_path mutable
--    Add SET search_path = '' and qualify table refs
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_daily_action_count(p_user_id uuid, p_action_id text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT COUNT(*)::INTEGER
  FROM public.xp_events
  WHERE user_id = p_user_id
    AND action_id = p_action_id
    AND created_at > now() - INTERVAL '24 hours'
    AND NOT nullified;
$function$;

CREATE OR REPLACE FUNCTION public.get_daily_action_count(p_user_id uuid, p_site_id uuid, p_action_id text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT COUNT(*)::INTEGER
  FROM public.xp_events
  WHERE user_id  = p_user_id
    AND site_id  = p_site_id
    AND action_id = p_action_id
    AND created_at > now() - INTERVAL '24 hours'
    AND NOT nullified;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_level(total_xp integer)
RETURNS TABLE(level integer, tier_name text, tier_number integer, xp_to_next integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT
    lt.level,
    lt.tier_name,
    lt.tier_number,
    COALESCE(
      (SELECT lt2.xp_required FROM public.level_thresholds lt2
       WHERE lt2.level = lt.level + 1) - total_xp,
      0
    ) AS xp_to_next
  FROM public.level_thresholds lt
  WHERE lt.xp_required <= GREATEST(total_xp, 0)
  ORDER BY lt.level DESC
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_streak_multiplier(streak_days integer)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN streak_days >= 10 THEN 1.50
    WHEN streak_days >= 5  THEN 1.20
    ELSE 1.00
  END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

-- ============================================================
-- 2. Fix toggle functions: guard against p_user_id forgery
--    Raise if a non-null p_user_id doesn't match the JWT uid.
--    Anon users (auth.uid() IS NULL) must pass p_user_id = NULL.
-- ============================================================

CREATE OR REPLACE FUNCTION public.toggle_comment_like(p_comment_id uuid, p_ip_hash text, p_user_id uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing UUID;
  v_count    INTEGER;
BEGIN
  -- Prevent user_id forgery: caller may only claim their own uid
  IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_user_id must match the authenticated user';
  END IF;

  SELECT id INTO v_existing FROM public.comment_reactions
  WHERE comment_id = p_comment_id AND ip_hash = p_ip_hash;

  IF v_existing IS NOT NULL THEN
    DELETE FROM public.comment_reactions WHERE id = v_existing;
    UPDATE public.article_comments
      SET like_count = GREATEST(0, like_count - 1)
      WHERE id = p_comment_id
      RETURNING like_count INTO v_count;
  ELSE
    INSERT INTO public.comment_reactions(comment_id, ip_hash, user_id)
      VALUES(p_comment_id, p_ip_hash, p_user_id);
    UPDATE public.article_comments
      SET like_count = like_count + 1
      WHERE id = p_comment_id
      RETURNING like_count INTO v_count;
  END IF;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.toggle_comment_reaction(p_comment_id uuid, p_ip_hash text, p_reaction text, p_user_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(like_count integer, dislike_count integer, was_new_like boolean, comment_author_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing_id       UUID;
  v_existing_reaction TEXT;
  v_was_new_like      BOOLEAN := false;
  v_author_id         UUID;
  v_cur_likes         INT;
  v_cur_dislikes      INT;
BEGIN
  -- Prevent user_id forgery: caller may only claim their own uid
  IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'p_user_id must match the authenticated user';
  END IF;

  SELECT ac.user_id INTO v_author_id
  FROM public.article_comments ac WHERE ac.id = p_comment_id;

  -- Self-like: return current counts unchanged
  IF p_user_id IS NOT NULL AND p_user_id = v_author_id THEN
    SELECT ac.like_count, ac.dislike_count INTO v_cur_likes, v_cur_dislikes
    FROM public.article_comments ac WHERE ac.id = p_comment_id;
    RETURN QUERY SELECT v_cur_likes, v_cur_dislikes, false::boolean, v_author_id;
    RETURN;
  END IF;

  -- Dedup by user_id first (handles IP changes), then ip_hash
  IF p_user_id IS NOT NULL THEN
    SELECT cr.id, cr.reaction INTO v_existing_id, v_existing_reaction
    FROM public.comment_reactions cr
    WHERE cr.comment_id = p_comment_id AND cr.user_id = p_user_id;
  END IF;
  IF v_existing_id IS NULL THEN
    SELECT cr.id, cr.reaction INTO v_existing_id, v_existing_reaction
    FROM public.comment_reactions cr
    WHERE cr.comment_id = p_comment_id AND cr.ip_hash = p_ip_hash;
  END IF;

  IF v_existing_id IS NOT NULL THEN
    IF v_existing_reaction = p_reaction THEN
      -- Same button → toggle off
      DELETE FROM public.comment_reactions cr WHERE cr.id = v_existing_id;
      IF p_reaction = 'like' THEN
        UPDATE public.article_comments AS ac
          SET like_count = GREATEST(0, ac.like_count - 1)
          WHERE ac.id = p_comment_id;
      ELSE
        UPDATE public.article_comments AS ac
          SET dislike_count = GREATEST(0, ac.dislike_count - 1)
          WHERE ac.id = p_comment_id;
      END IF;
    ELSE
      -- Different button → switch reaction
      UPDATE public.comment_reactions AS cr
        SET reaction = p_reaction,
            user_id  = COALESCE(p_user_id, cr.user_id)
        WHERE cr.id = v_existing_id;
      IF p_reaction = 'like' THEN
        UPDATE public.article_comments AS ac
          SET like_count    = ac.like_count + 1,
              dislike_count = GREATEST(0, ac.dislike_count - 1)
          WHERE ac.id = p_comment_id;
        v_was_new_like := true;
      ELSE
        UPDATE public.article_comments AS ac
          SET dislike_count = ac.dislike_count + 1,
              like_count    = GREATEST(0, ac.like_count - 1)
          WHERE ac.id = p_comment_id;
      END IF;
    END IF;
  ELSE
    -- No prior reaction → insert
    INSERT INTO public.comment_reactions(comment_id, ip_hash, user_id, reaction)
      VALUES(p_comment_id, p_ip_hash, p_user_id, p_reaction);
    IF p_reaction = 'like' THEN
      UPDATE public.article_comments AS ac
        SET like_count = ac.like_count + 1
        WHERE ac.id = p_comment_id;
      v_was_new_like := true;
    ELSE
      UPDATE public.article_comments AS ac
        SET dislike_count = ac.dislike_count + 1
        WHERE ac.id = p_comment_id;
    END IF;
  END IF;

  RETURN QUERY
    SELECT ac.like_count, ac.dislike_count, v_was_new_like, v_author_id
    FROM public.article_comments ac WHERE ac.id = p_comment_id;
END;
$function$;

-- ============================================================
-- 3. handle_new_user is a trigger function — revoke direct RPC
--    access from anon and authenticated roles
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;

-- ============================================================
-- 4. Drop overly permissive PUBLIC ALL policies on backend tables
--    (service_role bypasses RLS; no client access needed)
-- ============================================================
DROP POLICY service_role_stories       ON public.stories;
DROP POLICY service_role_contributions ON public.story_contributions;
DROP POLICY service_role_transitions   ON public.story_state_transitions;

-- ============================================================
-- 5. Fix launch_waitlist policies
--    admin_delete_waitlist gave any authenticated user delete access —
--    drop it (worker uses service_role and bypasses RLS).
--    anon_insert_waitlist: add minimal WITH CHECK to prevent null emails.
-- ============================================================
DROP POLICY admin_delete_waitlist ON public.launch_waitlist;

DROP POLICY anon_insert_waitlist ON public.launch_waitlist;
CREATE POLICY anon_insert_waitlist ON public.launch_waitlist
  FOR INSERT TO anon
  WITH CHECK (email IS NOT NULL AND char_length(email) > 0);
