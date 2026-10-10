-- Local, read-only readiness RPC for the authenticated health endpoint.
-- Apply only after the four existing schema, allowlist, update, and closing migrations.
BEGIN;

CREATE FUNCTION public.monthly_backend_health()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $monthly_backend_health$
DECLARE
  v_auth_id text;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  v_auth_id := (SELECT auth.uid()::text);
  IF NOT EXISTS (
    SELECT 1 FROM public."User" AS u WHERE u."supabaseUserId" = v_auth_id
  ) THEN
    RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501';
  END IF;

  IF pg_catalog.to_regprocedure('public.current_app_role()') IS NULL
     OR pg_catalog.to_regprocedure('public.apply_monthly_change(integer,integer,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.finalize_monthly_record(integer,integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.unlock_monthly_record(integer,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'Monthly RPCs are not installed' USING ERRCODE = '42883';
  END IF;
  IF NOT pg_catalog.has_function_privilege('authenticated', 'public.current_app_role()', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.apply_monthly_change(integer,integer,jsonb)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.finalize_monthly_record(integer,integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.unlock_monthly_record(integer,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Monthly RPC permissions are unavailable' USING ERRCODE = '42501';
  END IF;
END
$monthly_backend_health$;

REVOKE ALL PRIVILEGES ON FUNCTION public.monthly_backend_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monthly_backend_health() TO authenticated;

COMMIT;
