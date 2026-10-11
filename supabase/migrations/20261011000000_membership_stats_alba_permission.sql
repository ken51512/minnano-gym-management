-- Allow both ALBA_ADMIN and EARNES to update membership statistics.
-- Financial mutations continue to use apply_monthly_change and remain ALBA_ADMIN-only.
CREATE OR REPLACE FUNCTION public.apply_membership_stats(
  p_year integer,
  p_month integer,
  p_change jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $apply_membership_stats$
DECLARE
  v_headers jsonb;
  v_request_id uuid;
  v_actor_id text;
  v_role public."Role";
  v_monthly_record_id text;
  v_before jsonb;
  v_after jsonb;
  v_rows integer;
  v_operation text;
  v_year integer;
  v_month integer;
  v_payload jsonb;
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
  IF p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month NOT BETWEEN 1 AND 12
     OR p_change IS NULL OR jsonb_typeof(p_change) IS DISTINCT FROM 'object'
     OR p_change->>'type' IS DISTINCT FROM 'membershipStats' THEN
    RAISE EXCEPTION 'Invalid membership statistics' USING ERRCODE = '22023';
  END IF;

  SELECT u."id", u."role" INTO v_actor_id, v_role
    FROM public."User" AS u
    WHERE u."supabaseUserId" = (SELECT auth.uid()::text);
  IF v_actor_id IS NULL OR v_role NOT IN ('ALBA_ADMIN'::public."Role", 'EARNES'::public."Role") THEN
    RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501';
  END IF;
  IF NOT (p_change ? 'memberCount' AND p_change ? 'newMembers' AND p_change ? 'cancellations')
     OR EXISTS (
       SELECT 1 FROM jsonb_each(p_change) AS item(key, value)
       WHERE item.key NOT IN ('type', 'memberCount', 'newMembers', 'cancellations')
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_each(p_change) AS item(key, value)
       WHERE item.key <> 'type' AND item.value <> 'null'::jsonb
         AND (jsonb_typeof(item.value) <> 'number'
           OR (item.value::text)::numeric <> trunc((item.value::text)::numeric)
           OR (item.value::text)::numeric < 0
           OR (item.value::text)::numeric > 2147483647)
     ) THEN
    RAISE EXCEPTION 'Invalid membership statistics' USING ERRCODE = '22023';
  END IF;

  SELECT m."id" INTO v_monthly_record_id
    FROM public."MonthlyRecord" AS m
    WHERE m."year" = p_year AND m."month" = p_month
    FOR UPDATE;
  IF v_monthly_record_id IS NULL THEN
    RAISE EXCEPTION 'Monthly record not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public."MonthlyClosing" AS c WHERE c."monthlyRecordId" = v_monthly_record_id) THEN
    RAISE EXCEPTION 'Month is closed' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public."MonthlyRequest" ("actorId", "requestId", "operation", "year", "month", "payload")
    VALUES (v_actor_id, v_request_id, 'change', p_year, p_month, p_change)
    ON CONFLICT ("actorId", "requestId") DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    SELECT r."operation", r."year", r."month", r."payload"
      INTO v_operation, v_year, v_month, v_payload
      FROM public."MonthlyRequest" AS r
      WHERE r."actorId" = v_actor_id AND r."requestId" = v_request_id
      FOR UPDATE;
    IF v_operation IS DISTINCT FROM 'change' OR v_year IS DISTINCT FROM p_year
       OR v_month IS DISTINCT FROM p_month OR v_payload IS DISTINCT FROM p_change THEN
      RAISE EXCEPTION 'Request ID was already used for a different operation' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  SELECT to_jsonb(s) INTO v_before
    FROM public."MembershipStats" AS s
    WHERE s."monthlyRecordId" = v_monthly_record_id;
  INSERT INTO public."MembershipStats" (
    "id", "monthlyRecordId", "memberCount", "newMembers", "cancellations", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text,
    v_monthly_record_id,
    (p_change->>'memberCount')::integer,
    (p_change->>'newMembers')::integer,
    (p_change->>'cancellations')::integer,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("monthlyRecordId") DO UPDATE SET
    "memberCount" = EXCLUDED."memberCount",
    "newMembers" = EXCLUDED."newMembers",
    "cancellations" = EXCLUDED."cancellations",
    "updatedAt" = CURRENT_TIMESTAMP
  RETURNING to_jsonb("MembershipStats".*) INTO v_after;

  UPDATE public."MonthlyRecord"
    SET "updatedById" = v_actor_id, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = v_monthly_record_id;
  INSERT INTO public."AuditLog" (
    "id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt"
  ) VALUES (
    gen_random_uuid()::text, v_actor_id, 'UPDATE', 'MembershipStats', v_after->>'id',
    CASE WHEN v_before IS NULL THEN NULL ELSE v_before::text END,
    v_after::text, CURRENT_TIMESTAMP
  );
END
$apply_membership_stats$;

REVOKE ALL PRIVILEGES ON FUNCTION public.apply_membership_stats(integer, integer, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_membership_stats(integer, integer, jsonb) TO authenticated;
