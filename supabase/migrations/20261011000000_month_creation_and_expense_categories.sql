-- Add an ALBA_ADMIN-only blank-month creation RPC and idempotent initial expense categories.
-- Apply only after review; this migration does not alter existing monthly data or policies.
BEGIN;

INSERT INTO public."ExpenseCategory" ("id", "name", "createdAt")
VALUES
  (gen_random_uuid()::text, '家賃', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, '手数料（スグラム）', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, '人件費', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'Wi-Fi', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, '携帯', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, '広告費', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, '電気代', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, '水道代', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'ガス代', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'その他', CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

CREATE FUNCTION public.create_monthly_record(
  p_year integer,
  p_month integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $create_monthly_record$
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
  v_monthly_record_id text;
  v_after jsonb;
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

  IF p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'Invalid monthly period' USING ERRCODE = '22023';
  END IF;

  SELECT u."id", u."role"
    INTO v_actor_id, v_role
    FROM public."User" AS u
    WHERE u."supabaseUserId" = (SELECT auth.uid()::text);
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501';
  END IF;
  IF v_role IS DISTINCT FROM 'ALBA_ADMIN'::public."Role" THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  -- Share the actor/request ledger with the existing monthly mutations.
  -- Claim and business writes run in this RPC transaction, so failures roll back the claim.
  INSERT INTO public."MonthlyRequest" ("actorId", "requestId", "operation", "year", "month", "payload")
    VALUES (v_actor_id, v_request_id, 'change', p_year, p_month, '{"type":"monthlyRecord","operation":"create"}'::jsonb)
    ON CONFLICT ("actorId", "requestId") DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    SELECT r."operation", r."year", r."month", r."payload"
      INTO v_operation, v_year, v_month, v_payload
      FROM public."MonthlyRequest" AS r
      WHERE r."actorId" = v_actor_id AND r."requestId" = v_request_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Monthly request could not be claimed' USING ERRCODE = '40001';
    END IF;
    IF v_operation IS DISTINCT FROM 'change'
       OR v_year IS DISTINCT FROM p_year
       OR v_month IS DISTINCT FROM p_month
       OR v_payload IS DISTINCT FROM '{"type":"monthlyRecord","operation":"create"}'::jsonb THEN
      RAISE EXCEPTION 'Request ID was already used for a different operation' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  INSERT INTO public."MonthlyRecord" (
    "id", "year", "month", "createdById", "updatedById", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, p_year, p_month, v_actor_id, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("year", "month") DO NOTHING
  RETURNING "id", to_jsonb("MonthlyRecord".*) INTO v_monthly_record_id, v_after;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Monthly record already exists' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public."AuditLog" (
    "id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt"
  ) VALUES (
    gen_random_uuid()::text,
    v_actor_id,
    'CREATE',
    'MonthlyRecord',
    v_monthly_record_id,
    NULL,
    v_after::text,
    CURRENT_TIMESTAMP
  );
END
$create_monthly_record$;

REVOKE ALL PRIVILEGES ON FUNCTION public.create_monthly_record(integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

DO $function_owner$
DECLARE
  user_table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)::name INTO user_table_owner
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public."User"'::regclass;
  IF user_table_owner IS NULL THEN
    RAISE EXCEPTION 'Could not resolve public."User" owner';
  END IF;
  EXECUTE format(
    'ALTER FUNCTION public.create_monthly_record(integer, integer) OWNER TO %I',
    user_table_owner
  );
END
$function_owner$;

GRANT EXECUTE ON FUNCTION public.create_monthly_record(integer, integer) TO authenticated;

COMMIT;
