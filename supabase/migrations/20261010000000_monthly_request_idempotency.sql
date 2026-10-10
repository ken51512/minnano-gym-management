-- Local Supabase RPC preparation only. Run after the existing monthly and health RPCs.
-- Preserves the health-checked public names/signatures while requiring a per-operation
-- request ID. The former implementations are renamed and made non-callable by clients.
BEGIN;

CREATE TABLE public."MonthlyRequest" (
  "actorId" text NOT NULL,
  "requestId" uuid NOT NULL,
  "operation" text NOT NULL,
  "year" integer NOT NULL,
  "month" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "result" jsonb NOT NULL DEFAULT '{"status":"ok"}'::jsonb,
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonthlyRequest_pkey" PRIMARY KEY ("actorId", "requestId"),
  CONSTRAINT "MonthlyRequest_actorId_fkey" FOREIGN KEY ("actorId")
    REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MonthlyRequest_period_check" CHECK ("year" >= 1 AND "month" BETWEEN 1 AND 12),
  CONSTRAINT "MonthlyRequest_operation_check" CHECK ("operation" IN ('change', 'finalize', 'unlock'))
);
ALTER TABLE public."MonthlyRequest" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."MonthlyRequest" FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_monthly_request(
  p_operation text,
  p_year integer,
  p_month integer,
  p_payload jsonb,
  p_required_role public."Role"
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $claim_monthly_request$
DECLARE
  v_headers jsonb;
  v_request_id uuid;
  v_actor_id text;
  v_role public."Role";
  v_operation text;
  v_year integer;
  v_month integer;
  v_payload jsonb;
  v_rows integer;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  v_headers := COALESCE(NULLIF(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  IF jsonb_typeof(v_headers) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_headers->'x-monthly-request-id') IS DISTINCT FROM 'string'
     OR (v_headers->>'x-monthly-request-id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Monthly request ID required' USING ERRCODE = '22023';
  END IF;
  v_request_id := (v_headers->>'x-monthly-request-id')::uuid;
  IF p_operation NOT IN ('change', 'finalize', 'unlock')
     OR p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month NOT BETWEEN 1 AND 12
     OR p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR p_required_role IS NULL THEN
    RAISE EXCEPTION 'Invalid monthly request' USING ERRCODE = '22023';
  END IF;

  SELECT u."id", u."role" INTO v_actor_id, v_role
    FROM public."User" AS u
    WHERE u."supabaseUserId" = (SELECT auth.uid()::text);
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501';
  END IF;
  IF v_role IS DISTINCT FROM p_required_role THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public."MonthlyRequest" ("actorId", "requestId", "operation", "year", "month", "payload")
    VALUES (v_actor_id, v_request_id, p_operation, p_year, p_month, p_payload)
    ON CONFLICT ("actorId", "requestId") DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 1 THEN
    RETURN true;
  END IF;

  SELECT r."operation", r."year", r."month", r."payload"
    INTO v_operation, v_year, v_month, v_payload
    FROM public."MonthlyRequest" AS r
    WHERE r."actorId" = v_actor_id AND r."requestId" = v_request_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Monthly request could not be claimed' USING ERRCODE = '40001';
  END IF;
  IF v_operation IS DISTINCT FROM p_operation OR v_year IS DISTINCT FROM p_year
     OR v_month IS DISTINCT FROM p_month OR v_payload IS DISTINCT FROM p_payload THEN
    RAISE EXCEPTION 'Request ID was already used for a different operation' USING ERRCODE = '22023';
  END IF;
  RETURN false;
END
$claim_monthly_request$;

-- Keep the historical public signatures for health-check and client compatibility.
-- Their old bodies become private implementation functions and lose client EXECUTE.
ALTER FUNCTION public.apply_monthly_change(integer, integer, jsonb) RENAME TO _apply_monthly_change_unchecked;
ALTER FUNCTION public.finalize_monthly_record(integer, integer) RENAME TO _finalize_monthly_record_unchecked;
ALTER FUNCTION public.unlock_monthly_record(integer, integer, text) RENAME TO _unlock_monthly_record_unchecked;
REVOKE ALL PRIVILEGES ON FUNCTION public._apply_monthly_change_unchecked(integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public._finalize_monthly_record_unchecked(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public._unlock_monthly_record_unchecked(integer, integer, text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.apply_monthly_change(p_year integer, p_month integer, p_change jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $apply_monthly_change$
DECLARE
  v_required_role public."Role";
BEGIN
  v_required_role := CASE p_change->>'type'
    WHEN 'membershipStats' THEN 'EARNES'::public."Role"
    WHEN 'revenueEntry' THEN 'ALBA_ADMIN'::public."Role"
    WHEN 'expenseEntry' THEN 'ALBA_ADMIN'::public."Role"
    ELSE NULL
  END;
  IF public.claim_monthly_request('change', p_year, p_month, p_change, v_required_role) THEN
    PERFORM public._apply_monthly_change_unchecked(p_year, p_month, p_change);
  END IF;
END
$apply_monthly_change$;

CREATE FUNCTION public.finalize_monthly_record(p_year integer, p_month integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $finalize_monthly_record$
BEGIN
  IF public.claim_monthly_request('finalize', p_year, p_month, '{}'::jsonb, 'ALBA_ADMIN'::public."Role") THEN
    PERFORM public._finalize_monthly_record_unchecked(p_year, p_month);
  END IF;
END
$finalize_monthly_record$;

CREATE FUNCTION public.unlock_monthly_record(p_year integer, p_month integer, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $unlock_monthly_record$
BEGIN
  IF public.claim_monthly_request('unlock', p_year, p_month,
      jsonb_build_object('reason', p_reason), 'ALBA_ADMIN'::public."Role") THEN
    PERFORM public._unlock_monthly_record_unchecked(p_year, p_month, p_reason);
  END IF;
END
$unlock_monthly_record$;

REVOKE ALL PRIVILEGES ON FUNCTION public.claim_monthly_request(text, integer, integer, jsonb, public."Role") FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.apply_monthly_change(integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.finalize_monthly_record(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.unlock_monthly_record(integer, integer, text) FROM PUBLIC, anon, authenticated;

-- The application user table owner already owns the role helper. Give it ownership
-- of the wrappers and claim helper so the internal calls and private ledger work under
-- the same reviewed SECURITY DEFINER boundary. The migration role must be permitted
-- to transfer these function owners, as for current_app_role() in the bootstrap SQL.
DO $function_owners$
DECLARE
  user_table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)::name INTO user_table_owner
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public."User"'::regclass;
  IF user_table_owner IS NULL THEN
    RAISE EXCEPTION 'Could not resolve public."User" owner';
  END IF;
  EXECUTE format('ALTER TABLE public."MonthlyRequest" OWNER TO %I', user_table_owner);
  EXECUTE format('ALTER FUNCTION public.claim_monthly_request(text, integer, integer, jsonb, public."Role") OWNER TO %I', user_table_owner);
  EXECUTE format('ALTER FUNCTION public.apply_monthly_change(integer, integer, jsonb) OWNER TO %I', user_table_owner);
  EXECUTE format('ALTER FUNCTION public.finalize_monthly_record(integer, integer) OWNER TO %I', user_table_owner);
  EXECUTE format('ALTER FUNCTION public.unlock_monthly_record(integer, integer, text) OWNER TO %I', user_table_owner);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public._apply_monthly_change_unchecked(integer, integer, jsonb) TO %I', user_table_owner);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public._finalize_monthly_record_unchecked(integer, integer) TO %I', user_table_owner);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public._unlock_monthly_record_unchecked(integer, integer, text) TO %I', user_table_owner);
END
$function_owners$;

GRANT EXECUTE ON FUNCTION public.apply_monthly_change(integer, integer, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_monthly_record(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_monthly_record(integer, integer, text) TO authenticated;

-- Keep health green only when the request-ledger guard is installed on the
-- public entrypoints; the historical signatures alone are not sufficient.
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
     OR pg_catalog.to_regprocedure('public.unlock_monthly_record(integer,integer,text)') IS NULL THEN
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
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.unlock_monthly_record(integer,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Monthly RPC permissions are unavailable' USING ERRCODE = '42501';
  END IF;
END
$monthly_backend_health$;

COMMIT;
