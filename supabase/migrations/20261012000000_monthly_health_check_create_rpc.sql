-- Extend the latest authenticated idempotency health check with the blank-month RPC.
-- Apply after the idempotency and month-creation migrations.
BEGIN;

CREATE OR REPLACE FUNCTION public.monthly_backend_health()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $monthly_backend_health$
DECLARE
  v_auth_id text;
  v_change_definition text;
  v_finalize_definition text;
  v_unlock_definition text;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  v_auth_id := (SELECT auth.uid()::text);
  IF NOT EXISTS (SELECT 1 FROM public."User" AS u WHERE u."supabaseUserId" = v_auth_id) THEN
    RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.to_regclass('public."MonthlyRequest"') IS NULL
     OR pg_catalog.to_regprocedure('public.claim_monthly_request(text,integer,integer,jsonb,public."Role")') IS NULL
     OR pg_catalog.to_regprocedure('public._apply_monthly_change_unchecked(integer,integer,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public._finalize_monthly_record_unchecked(integer,integer)') IS NULL
     OR pg_catalog.to_regprocedure('public._unlock_monthly_record_unchecked(integer,integer,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.apply_monthly_change(integer,integer,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.finalize_monthly_record(integer,integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.unlock_monthly_record(integer,integer,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.create_monthly_record(integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'Monthly request protection is not installed' USING ERRCODE = '42883';
  END IF;
  SELECT pg_catalog.pg_get_functiondef('public.apply_monthly_change(integer,integer,jsonb)'::regprocedure),
         pg_catalog.pg_get_functiondef('public.finalize_monthly_record(integer,integer)'::regprocedure),
         pg_catalog.pg_get_functiondef('public.unlock_monthly_record(integer,integer,text)'::regprocedure)
    INTO v_change_definition, v_finalize_definition, v_unlock_definition;
  IF pg_catalog.strpos(v_change_definition, 'claim_monthly_request') = 0
     OR pg_catalog.strpos(v_change_definition, '_apply_monthly_change_unchecked') = 0
     OR pg_catalog.strpos(v_finalize_definition, 'claim_monthly_request') = 0
     OR pg_catalog.strpos(v_finalize_definition, '_finalize_monthly_record_unchecked') = 0
     OR pg_catalog.strpos(v_unlock_definition, 'claim_monthly_request') = 0
     OR pg_catalog.strpos(v_unlock_definition, '_unlock_monthly_record_unchecked') = 0 THEN
    RAISE EXCEPTION 'Monthly request guard is not active' USING ERRCODE = '42883';
  END IF;
  IF NOT pg_catalog.has_function_privilege('authenticated', 'public.apply_monthly_change(integer,integer,jsonb)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.finalize_monthly_record(integer,integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.unlock_monthly_record(integer,integer,text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.create_monthly_record(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Monthly RPC permissions are unavailable' USING ERRCODE = '42501';
  END IF;
END
$monthly_backend_health$;

REVOKE ALL PRIVILEGES ON FUNCTION public.monthly_backend_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monthly_backend_health() TO authenticated;

COMMIT;
