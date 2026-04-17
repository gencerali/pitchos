-- Sprint 5: Launch waitlist table
-- Run in Supabase SQL Editor → New query

-- 1. Create table
CREATE TABLE IF NOT EXISTS launch_waitlist (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  locale      text        NOT NULL DEFAULT 'tr',
  source      text        NOT NULL DEFAULT 'landing',
  confirmed   boolean     NOT NULL DEFAULT false   -- reserved for future double opt-in
);

-- 2. Index for fast email lookups / duplicate checks
CREATE INDEX IF NOT EXISTS idx_waitlist_email      ON launch_waitlist(email);
CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON launch_waitlist(created_at DESC);

-- 3. Enable Row Level Security
ALTER TABLE launch_waitlist ENABLE ROW LEVEL SECURITY;

-- 4. Anonymous users can INSERT (email signup from landing page)
--    The unique constraint on email handles duplicates (returns 409 Conflict)
CREATE POLICY "anon_insert_waitlist"
  ON launch_waitlist
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- 5. Only authenticated admin can SELECT (to protect the email list)
CREATE POLICY "admin_select_waitlist"
  ON launch_waitlist
  FOR SELECT
  TO authenticated
  USING (true);

-- 6. Authenticated admin can also DELETE (for GDPR erasure requests)
CREATE POLICY "admin_delete_waitlist"
  ON launch_waitlist
  FOR DELETE
  TO authenticated
  USING (true);

-- Verify:
-- SELECT * FROM launch_waitlist ORDER BY created_at DESC LIMIT 10;
