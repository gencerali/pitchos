-- Replace the ALL policy with explicit write-only policies so SELECT
-- is covered by exactly one policy (user_streaks_public_read).
DROP POLICY user_streaks_owner_write ON public.user_streaks;

CREATE POLICY user_streaks_owner_insert ON public.user_streaks
  FOR INSERT TO public WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_streaks_owner_update ON public.user_streaks
  FOR UPDATE TO public USING (auth.uid() = user_id);

CREATE POLICY user_streaks_owner_delete ON public.user_streaks
  FOR DELETE TO public USING (auth.uid() = user_id);
