-- Apply locally in the target Supabase project before enabling Supabase JS allowlist reads.
-- This grants authenticated users read access only to their own allowlist row.
BEGIN;

ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."User" FROM anon, authenticated, PUBLIC;
REVOKE ALL PRIVILEGES ("id", "supabaseUserId", "email", "displayName", "role", "createdAt", "updatedAt")
  ON TABLE public."User" FROM anon, authenticated, PUBLIC;

GRANT SELECT ("id", "supabaseUserId", "email", "displayName", "role")
  ON TABLE public."User" TO authenticated;

CREATE POLICY user_allowlist_self_read
  ON public."User"
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ("supabaseUserId" = (SELECT auth.uid()::text));

-- Restrict this read even if another permissive SELECT policy is added later.
CREATE POLICY user_allowlist_self_read_guard
  ON public."User"
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING ("supabaseUserId" = (SELECT auth.uid()::text));

COMMIT;
