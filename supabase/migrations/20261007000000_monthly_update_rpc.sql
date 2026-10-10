-- Local Supabase RPC preparation only. Apply after the schema and allowlist migrations.
-- Every accepted edit, updatedById change, and audit row commits or rolls back together.
BEGIN;

CREATE FUNCTION public.apply_monthly_change(
  p_year integer,
  p_month integer,
  p_change jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $apply_monthly_change$
DECLARE
  v_actor_id text;
  v_role public."Role";
  v_monthly_record_id text;
  v_type text;
  v_operation text;
  v_entry_id text;
  v_description text;
  v_amount integer;
  v_category_id text;
  v_before jsonb;
  v_after jsonb;
  v_entity_type text;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month < 1 OR p_month > 12
     OR p_change IS NULL OR jsonb_typeof(p_change) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid monthly change' USING ERRCODE = '22023';
  END IF;

  SELECT u."id"
    INTO v_actor_id
    FROM public."User" AS u
    WHERE u."supabaseUserId" = (SELECT auth.uid()::text);
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501';
  END IF;

  -- Shared serialization point for all edits and the later finalize/unlock RPCs.
  SELECT m."id"
    INTO v_monthly_record_id
    FROM public."MonthlyRecord" AS m
    WHERE m."year" = p_year AND m."month" = p_month
    FOR UPDATE;
  IF v_monthly_record_id IS NULL THEN
    RAISE EXCEPTION 'Monthly record not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT u."role" INTO v_role FROM public."User" AS u WHERE u."id" = v_actor_id;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."MonthlyClosing" AS c
    WHERE c."monthlyRecordId" = v_monthly_record_id
  ) THEN
    RAISE EXCEPTION 'Month is closed' USING ERRCODE = 'P0001';
  END IF;

  v_type := p_change->>'type';
  v_operation := p_change->>'operation';
  IF v_type = 'membershipStats' THEN
    IF v_role <> 'EARNES'::public."Role" THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
    IF NOT (p_change ? 'memberCount' AND p_change ? 'newMembers' AND p_change ? 'cancellations') THEN
      RAISE EXCEPTION 'Invalid membership statistics' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_each(p_change) AS item(key, value)
      WHERE item.key NOT IN ('type', 'memberCount', 'newMembers', 'cancellations')
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_each(p_change) AS item(key, value)
      WHERE item.key <> 'type' AND item.value <> 'null'::jsonb
        AND (jsonb_typeof(item.value) <> 'number'
          OR (item.value::text)::numeric <> trunc((item.value::text)::numeric)
          OR (item.value::text)::numeric < 0
          OR (item.value::text)::numeric > 2147483647)
    ) THEN
      RAISE EXCEPTION 'Invalid membership statistics' USING ERRCODE = '22023';
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
    v_entity_type := 'MembershipStats';
    v_entry_id := v_after->>'id';

  ELSIF v_type IN ('revenueEntry', 'expenseEntry') THEN
    IF v_role <> 'ALBA_ADMIN'::public."Role" THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
    IF v_operation NOT IN ('create', 'update', 'delete') THEN
      RAISE EXCEPTION 'Invalid financial operation' USING ERRCODE = '22023';
    END IF;
    v_entity_type := CASE WHEN v_type = 'revenueEntry' THEN 'RevenueEntry' ELSE 'ExpenseEntry' END;

    IF v_operation = 'create' THEN
      IF jsonb_typeof(p_change->'description') IS DISTINCT FROM 'string'
         OR jsonb_typeof(p_change->'amount') IS DISTINCT FROM 'number'
         OR (p_change->>'amount')::numeric <> trunc((p_change->>'amount')::numeric)
         OR (p_change->>'amount')::numeric < -2147483648
         OR (p_change->>'amount')::numeric > 2147483647 THEN
        RAISE EXCEPTION 'Invalid financial entry' USING ERRCODE = '22023';
      END IF;
      v_description := p_change->>'description';
      v_amount := (p_change->>'amount')::integer;
      v_entry_id := gen_random_uuid()::text;
      IF v_type = 'revenueEntry' THEN
        INSERT INTO public."RevenueEntry" ("id", "monthlyRecordId", "description", "amount", "createdAt")
        VALUES (v_entry_id, v_monthly_record_id, v_description, v_amount, CURRENT_TIMESTAMP)
        RETURNING to_jsonb("RevenueEntry".*) INTO v_after;
      ELSE
        IF jsonb_typeof(p_change->'categoryId') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'Invalid expense category' USING ERRCODE = '22023';
        END IF;
        v_category_id := p_change->>'categoryId';
        INSERT INTO public."ExpenseEntry" ("id", "monthlyRecordId", "categoryId", "description", "amount", "createdAt")
        VALUES (v_entry_id, v_monthly_record_id, v_category_id, v_description, v_amount, CURRENT_TIMESTAMP)
        RETURNING to_jsonb("ExpenseEntry".*) INTO v_after;
      END IF;
      v_before := NULL;
    ELSE
      IF jsonb_typeof(p_change->'id') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Invalid financial entry id' USING ERRCODE = '22023';
      END IF;
      v_entry_id := p_change->>'id';
      IF v_type = 'revenueEntry' THEN
        SELECT to_jsonb(e) INTO v_before
          FROM public."RevenueEntry" AS e
          WHERE e."id" = v_entry_id AND e."monthlyRecordId" = v_monthly_record_id
          FOR UPDATE;
      ELSE
        SELECT to_jsonb(e) INTO v_before
          FROM public."ExpenseEntry" AS e
          WHERE e."id" = v_entry_id AND e."monthlyRecordId" = v_monthly_record_id
          FOR UPDATE;
      END IF;
      IF v_before IS NULL THEN
        RAISE EXCEPTION 'Entry not found in the requested month' USING ERRCODE = 'P0002';
      END IF;
      IF v_operation = 'delete' THEN
        IF v_type = 'revenueEntry' THEN
          DELETE FROM public."RevenueEntry" AS e
            WHERE e."id" = v_entry_id AND e."monthlyRecordId" = v_monthly_record_id;
        ELSE
          DELETE FROM public."ExpenseEntry" AS e
            WHERE e."id" = v_entry_id AND e."monthlyRecordId" = v_monthly_record_id;
        END IF;
        v_after := NULL;
      ELSE
        IF NOT (p_change ? 'description' OR p_change ? 'amount'
          OR (v_type = 'expenseEntry' AND p_change ? 'categoryId')) THEN
          RAISE EXCEPTION 'Empty financial update' USING ERRCODE = '22023';
        END IF;
        IF p_change ? 'description' AND jsonb_typeof(p_change->'description') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'Invalid description' USING ERRCODE = '22023';
        END IF;
        IF p_change ? 'amount' THEN
          IF jsonb_typeof(p_change->'amount') IS DISTINCT FROM 'number'
             OR (p_change->>'amount')::numeric <> trunc((p_change->>'amount')::numeric)
             OR (p_change->>'amount')::numeric < -2147483648
             OR (p_change->>'amount')::numeric > 2147483647 THEN
            RAISE EXCEPTION 'Invalid amount' USING ERRCODE = '22023';
          END IF;
          v_amount := (p_change->>'amount')::integer;
        END IF;
        IF v_type = 'expenseEntry' AND p_change ? 'categoryId'
           AND jsonb_typeof(p_change->'categoryId') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'Invalid expense category' USING ERRCODE = '22023';
        END IF;
        v_description := CASE WHEN p_change ? 'description' THEN p_change->>'description' ELSE v_before->>'description' END;
        IF v_type = 'revenueEntry' THEN
          UPDATE public."RevenueEntry" AS e SET
            "description" = v_description,
            "amount" = CASE WHEN p_change ? 'amount' THEN v_amount ELSE (v_before->>'amount')::integer END
          WHERE e."id" = v_entry_id AND e."monthlyRecordId" = v_monthly_record_id
          RETURNING to_jsonb(e.*) INTO v_after;
        ELSE
          UPDATE public."ExpenseEntry" AS e SET
            "description" = v_description,
            "amount" = CASE WHEN p_change ? 'amount' THEN v_amount ELSE (v_before->>'amount')::integer END,
            "categoryId" = CASE WHEN p_change ? 'categoryId' THEN p_change->>'categoryId' ELSE v_before->>'categoryId' END
          WHERE e."id" = v_entry_id AND e."monthlyRecordId" = v_monthly_record_id
          RETURNING to_jsonb(e.*) INTO v_after;
        END IF;
      END IF;
    END IF;

  ELSE
    RAISE EXCEPTION 'Unknown monthly change type' USING ERRCODE = '22023';
  END IF;

  UPDATE public."MonthlyRecord" AS m
    SET "updatedById" = v_actor_id, "updatedAt" = CURRENT_TIMESTAMP
    WHERE m."id" = v_monthly_record_id;

  INSERT INTO public."AuditLog" (
    "id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt"
  ) VALUES (
    gen_random_uuid()::text,
    v_actor_id,
    'UPDATE',
    v_entity_type,
    v_entry_id,
    CASE WHEN v_before IS NULL THEN NULL ELSE v_before::text END,
    CASE WHEN v_after IS NULL THEN NULL ELSE v_after::text END,
    CURRENT_TIMESTAMP
  );
END
$apply_monthly_change$;

REVOKE ALL PRIVILEGES ON FUNCTION public.apply_monthly_change(integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_monthly_change(integer, integer, jsonb) TO authenticated;

COMMIT;
