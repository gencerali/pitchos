-- ============================================================
-- 1. Fix SECURITY DEFINER views → SECURITY INVOKER
-- ============================================================
ALTER VIEW public.leaderboard_alltime   SET (security_invoker = true);
ALTER VIEW public.leaderboard_monthly   SET (security_invoker = true);
ALTER VIEW public.leaderboard_weekly    SET (security_invoker = true);
ALTER VIEW public.leaderboard_seasonal  SET (security_invoker = true);
ALTER VIEW public.leaderboard_streak    SET (security_invoker = true);

-- ============================================================
-- 2. Enable RLS — admin/backend tables (service role only)
--    Workers use service_role key which bypasses RLS.
--    No client-side policies needed.
-- ============================================================
ALTER TABLE public.sites                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sources                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_social_accounts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fetch_logs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_costs_daily        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_rules            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_sessions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_config              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_configs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_facts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_events       ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. Enable RLS — public read-only content tables
--    All rows readable by anyone; writes only via service-role workers.
-- ============================================================
ALTER TABLE public.fixtures               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squad_members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.actual_lineups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_european_spots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_groups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_group_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phases                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topics                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topic_edges            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facts                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_lineage           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.polls                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments               ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON public.fixtures              FOR SELECT USING (true);
CREATE POLICY "public read" ON public.squad_members         FOR SELECT USING (true);
CREATE POLICY "public read" ON public.actual_lineups        FOR SELECT USING (true);
CREATE POLICY "public read" ON public.league_european_spots FOR SELECT USING (true);
CREATE POLICY "public read" ON public.league_groups         FOR SELECT USING (true);
CREATE POLICY "public read" ON public.league_group_members  FOR SELECT USING (true);
CREATE POLICY "public read" ON public.phases                FOR SELECT USING (true);
CREATE POLICY "public read" ON public.topics                FOR SELECT USING (true);
CREATE POLICY "public read" ON public.topic_edges           FOR SELECT USING (true);
CREATE POLICY "public read" ON public.facts                 FOR SELECT USING (true);
CREATE POLICY "public read" ON public.fact_lineage          FOR SELECT USING (true);
CREATE POLICY "public read" ON public.content_items         FOR SELECT USING (true);
CREATE POLICY "public read" ON public.polls                 FOR SELECT USING (true);
CREATE POLICY "public read" ON public.feature_flags         FOR SELECT USING (true);
CREATE POLICY "public read" ON public.comments              FOR SELECT USING (true);

-- ============================================================
-- 4. Enable RLS — user-content tables
--    SELECT: everyone; INSERT/DELETE: authenticated owner only
-- ============================================================
ALTER TABLE public.article_comments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.article_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_votes        ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read"  ON public.article_comments  FOR SELECT USING (true);
CREATE POLICY "owner insert" ON public.article_comments  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "owner delete" ON public.article_comments  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE POLICY "public read"  ON public.article_reactions FOR SELECT USING (true);
CREATE POLICY "owner insert" ON public.article_reactions FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "owner delete" ON public.article_reactions FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE POLICY "public read"  ON public.comment_reactions FOR SELECT USING (true);
CREATE POLICY "owner insert" ON public.comment_reactions FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "owner delete" ON public.comment_reactions FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE POLICY "public read"  ON public.poll_votes        FOR SELECT USING (true);
CREATE POLICY "owner insert" ON public.poll_votes        FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "owner delete" ON public.poll_votes        FOR DELETE TO authenticated USING (user_id = auth.uid());
