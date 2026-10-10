-- Store recurring expense labels separately from monthly amount entries.
-- Apply after the month-creation RPC migration; this file does not delete or rewrite existing rows.
BEGIN;

ALTER TABLE public."ExpenseEntry"
  ADD COLUMN "expenseItemId" text;

CREATE FUNCTION public._trim_expense_item_name(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $trim_expense_item_name$
  SELECT pg_catalog.btrim(p_value,
    pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(11) || pg_catalog.chr(12) ||
    pg_catalog.chr(13) || pg_catalog.chr(32) || pg_catalog.chr(160) || pg_catalog.chr(5760) ||
    pg_catalog.chr(8192) || pg_catalog.chr(8193) || pg_catalog.chr(8194) || pg_catalog.chr(8195) ||
    pg_catalog.chr(8196) || pg_catalog.chr(8197) || pg_catalog.chr(8198) || pg_catalog.chr(8199) ||
    pg_catalog.chr(8200) || pg_catalog.chr(8201) || pg_catalog.chr(8202) || pg_catalog.chr(8232) ||
    pg_catalog.chr(8233) || pg_catalog.chr(8239) || pg_catalog.chr(8287) || pg_catalog.chr(12288) ||
    pg_catalog.chr(65279))
$trim_expense_item_name$;

CREATE TABLE public."ExpenseItem" (
  "id" text PRIMARY KEY,
  "categoryId" text NOT NULL REFERENCES public."ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "name" text NOT NULL,
  "effectiveYear" integer NOT NULL,
  "effectiveMonth" integer NOT NULL,
  "effectiveMonthlyRecordId" text NOT NULL REFERENCES public."MonthlyRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExpenseItem_effective_period_check" CHECK ("effectiveYear" >= 1 AND "effectiveMonth" BETWEEN 1 AND 12),
  CONSTRAINT "ExpenseItem_name_check" CHECK (public._trim_expense_item_name("name") <> '' AND pg_catalog.char_length(public._trim_expense_item_name("name")) <= 200)
);

ALTER TABLE public."ExpenseEntry"
  ADD CONSTRAINT "ExpenseEntry_expenseItemId_fkey"
  FOREIGN KEY ("expenseItemId") REFERENCES public."ExpenseItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."ExpenseEntry"
  ADD CONSTRAINT "ExpenseEntry_monthlyRecordId_expenseItemId_key" UNIQUE ("monthlyRecordId", "expenseItemId");
CREATE INDEX "ExpenseItem_categoryId_effectiveYear_effectiveMonth_idx"
  ON public."ExpenseItem"("categoryId", "effectiveYear", "effectiveMonth");

ALTER TABLE public."ExpenseItem" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."ExpenseItem" FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public."ExpenseItem" TO authenticated;
CREATE POLICY expense_item_allowlisted_read ON public."ExpenseItem"
  FOR SELECT TO authenticated USING (public.current_app_role() IS NOT NULL);

CREATE FUNCTION public.register_monthly_expense_item(
  p_year integer,
  p_month integer,
  p_category_id text,
  p_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $register_monthly_expense_item$
DECLARE
  v_auth_id text;
  v_actor_id text;
  v_role public."Role";
  v_request_id uuid;
  v_headers jsonb;
  v_operation text;
  v_old_year integer;
  v_old_month integer;
  v_payload jsonb;
  v_rows integer;
  v_record_id text;
  v_category_name text;
  v_max_items integer;
  v_item_count bigint;
  v_item_id text;
  v_after jsonb;
  v_request_payload jsonb;
BEGIN
  v_auth_id := (SELECT auth.uid()::text);
  IF v_auth_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT u."id", u."role" INTO v_actor_id, v_role FROM public."User" AS u WHERE u."supabaseUserId" = v_auth_id;
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501'; END IF;
  IF v_role IS DISTINCT FROM 'ALBA_ADMIN'::public."Role" THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month NOT BETWEEN 1 AND 12
     OR p_category_id IS NULL OR p_name IS NULL OR public._trim_expense_item_name(p_name) = ''
     OR pg_catalog.char_length(public._trim_expense_item_name(p_name)) > 200 THEN
    RAISE EXCEPTION 'Invalid expense item' USING ERRCODE = '22023';
  END IF;

  v_headers := COALESCE(NULLIF(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  IF jsonb_typeof(v_headers->'x-monthly-request-id') IS DISTINCT FROM 'string'
     OR (v_headers->>'x-monthly-request-id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Monthly request ID required' USING ERRCODE = '22023';
  END IF;
  v_request_id := (v_headers->>'x-monthly-request-id')::uuid;
  v_request_payload := jsonb_build_object('type', 'expenseItemRegistration', 'categoryId', p_category_id, 'name', public._trim_expense_item_name(p_name));

  -- Keep the shared actor/request ledger first in the lock order, as in the existing mutation wrappers.
  INSERT INTO public."MonthlyRequest" ("actorId", "requestId", "operation", "year", "month", "payload")
    VALUES (v_actor_id, v_request_id, 'change', p_year, p_month, v_request_payload)
    ON CONFLICT ("actorId", "requestId") DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    SELECT r."operation", r."year", r."month", r."payload" INTO v_operation, v_old_year, v_old_month, v_payload
      FROM public."MonthlyRequest" AS r WHERE r."actorId" = v_actor_id AND r."requestId" = v_request_id FOR UPDATE;
    IF NOT FOUND OR v_operation IS DISTINCT FROM 'change' OR v_old_year IS DISTINCT FROM p_year
       OR v_old_month IS DISTINCT FROM p_month OR v_payload IS DISTINCT FROM v_request_payload THEN
      RAISE EXCEPTION 'Request ID was already used for a different operation' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  SELECT m."id" INTO v_record_id FROM public."MonthlyRecord" AS m
    WHERE m."year" = p_year AND m."month" = p_month FOR UPDATE;
  IF v_record_id IS NULL THEN RAISE EXCEPTION 'Monthly record not found' USING ERRCODE = 'P0002'; END IF;
  -- Lock this and every later existing month in ascending period order. This prevents
  -- a concurrent finalization from making a newly registered name appear retroactively.
  PERFORM m."id" FROM public."MonthlyRecord" AS m
    WHERE (m."year", m."month") >= (p_year, p_month)
    ORDER BY m."year", m."month"
    FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public."MonthlyClosing" AS c WHERE c."monthlyRecordId" = v_record_id) THEN
    RAISE EXCEPTION 'Month is closed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."MonthlyRecord" AS m
      JOIN public."MonthlyClosing" AS c ON c."monthlyRecordId" = m."id"
      WHERE (m."year", m."month") >= (p_year, p_month)
  ) THEN
    RAISE EXCEPTION 'Registration would alter a finalized month view' USING ERRCODE = 'P0001';
  END IF;

  -- This category row is the shared serialization point across registration months.
  SELECT c."name" INTO v_category_name FROM public."ExpenseCategory" AS c
    WHERE c."id" = p_category_id FOR UPDATE;
  IF v_category_name IS NULL THEN RAISE EXCEPTION 'Expense category not found' USING ERRCODE = 'P0002'; END IF;
  v_max_items := CASE v_category_name
    WHEN '人件費' THEN 20
    WHEN '広告費' THEN 3
    WHEN 'その他' THEN 3
    ELSE NULL
  END;
  IF v_max_items IS NULL THEN RAISE EXCEPTION 'This category does not accept named items' USING ERRCODE = '22023'; END IF;
  SELECT count(*) INTO v_item_count FROM public."ExpenseItem" AS i WHERE i."categoryId" = p_category_id;
  IF v_item_count >= v_max_items THEN RAISE EXCEPTION 'Expense item limit reached' USING ERRCODE = '22023'; END IF;

  v_item_id := gen_random_uuid()::text;
  INSERT INTO public."ExpenseItem" ("id", "categoryId", "name", "effectiveYear", "effectiveMonth", "effectiveMonthlyRecordId", "createdAt")
    VALUES (v_item_id, p_category_id, public._trim_expense_item_name(p_name), p_year, p_month, v_record_id, CURRENT_TIMESTAMP)
    RETURNING to_jsonb("ExpenseItem".*) INTO v_after;
  INSERT INTO public."AuditLog" ("id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt")
    VALUES (gen_random_uuid()::text, v_actor_id, 'CREATE', 'ExpenseItem', v_item_id, NULL, v_after::text, CURRENT_TIMESTAMP);
  UPDATE public."MonthlyRecord" SET "updatedById" = v_actor_id, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = v_record_id;
END
$register_monthly_expense_item$;

CREATE FUNCTION public.set_monthly_expense_item_amount(
  p_year integer,
  p_month integer,
  p_item_id text,
  p_amount integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $set_monthly_expense_item_amount$
DECLARE
  v_auth_id text;
  v_actor_id text;
  v_role public."Role";
  v_request_id uuid;
  v_headers jsonb;
  v_operation text;
  v_old_year integer;
  v_old_month integer;
  v_payload jsonb;
  v_request_payload jsonb;
  v_rows integer;
  v_record_id text;
  v_item public."ExpenseItem"%ROWTYPE;
  v_before jsonb;
  v_after jsonb;
  v_entry_id text;
BEGIN
  v_auth_id := (SELECT auth.uid()::text);
  IF v_auth_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT u."id", u."role" INTO v_actor_id, v_role FROM public."User" AS u WHERE u."supabaseUserId" = v_auth_id;
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501'; END IF;
  IF v_role IS DISTINCT FROM 'ALBA_ADMIN'::public."Role" THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month NOT BETWEEN 1 AND 12
     OR p_item_id IS NULL OR p_amount IS NULL THEN RAISE EXCEPTION 'Invalid expense amount' USING ERRCODE = '22023'; END IF;
  v_headers := COALESCE(NULLIF(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  IF jsonb_typeof(v_headers->'x-monthly-request-id') IS DISTINCT FROM 'string'
     OR (v_headers->>'x-monthly-request-id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Monthly request ID required' USING ERRCODE = '22023';
  END IF;
  v_request_id := (v_headers->>'x-monthly-request-id')::uuid;
  v_request_payload := jsonb_build_object('type', 'expenseItemAmount', 'itemId', p_item_id, 'amount', p_amount);
  INSERT INTO public."MonthlyRequest" ("actorId", "requestId", "operation", "year", "month", "payload")
    VALUES (v_actor_id, v_request_id, 'change', p_year, p_month, v_request_payload)
    ON CONFLICT ("actorId", "requestId") DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    SELECT r."operation", r."year", r."month", r."payload" INTO v_operation, v_old_year, v_old_month, v_payload
      FROM public."MonthlyRequest" AS r WHERE r."actorId" = v_actor_id AND r."requestId" = v_request_id FOR UPDATE;
    IF NOT FOUND OR v_operation IS DISTINCT FROM 'change' OR v_old_year IS DISTINCT FROM p_year
       OR v_old_month IS DISTINCT FROM p_month OR v_payload IS DISTINCT FROM v_request_payload THEN
      RAISE EXCEPTION 'Request ID was already used for a different operation' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  SELECT m."id" INTO v_record_id FROM public."MonthlyRecord" AS m
    WHERE m."year" = p_year AND m."month" = p_month FOR UPDATE;
  IF v_record_id IS NULL THEN RAISE EXCEPTION 'Monthly record not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM public."MonthlyClosing" AS c WHERE c."monthlyRecordId" = v_record_id) THEN
    RAISE EXCEPTION 'Month is closed' USING ERRCODE = 'P0001';
  END IF;
  SELECT i.* INTO v_item FROM public."ExpenseItem" AS i WHERE i."id" = p_item_id FOR UPDATE;
  IF NOT FOUND OR (v_item."effectiveYear", v_item."effectiveMonth") > (p_year, p_month) THEN
    RAISE EXCEPTION 'Expense item is not active for this month' USING ERRCODE = '22023';
  END IF;
  SELECT to_jsonb(e), e."id" INTO v_before, v_entry_id FROM public."ExpenseEntry" AS e
    WHERE e."monthlyRecordId" = v_record_id AND e."expenseItemId" = p_item_id FOR UPDATE;
  IF v_entry_id IS NULL THEN
    INSERT INTO public."ExpenseEntry" ("id", "monthlyRecordId", "categoryId", "expenseItemId", "description", "amount", "createdAt")
      VALUES (gen_random_uuid()::text, v_record_id, v_item."categoryId", v_item."id", v_item."name", p_amount, CURRENT_TIMESTAMP)
      RETURNING "id", to_jsonb("ExpenseEntry".*) INTO v_entry_id, v_after;
  ELSE
    UPDATE public."ExpenseEntry" AS e SET "amount" = p_amount
      WHERE e."id" = v_entry_id
      RETURNING to_jsonb(e.*) INTO v_after;
  END IF;
  INSERT INTO public."AuditLog" ("id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt")
    VALUES (gen_random_uuid()::text, v_actor_id, CASE WHEN v_before IS NULL THEN 'CREATE' ELSE 'UPDATE' END,
      'ExpenseEntry', v_entry_id, v_before::text, v_after::text, CURRENT_TIMESTAMP);
  UPDATE public."MonthlyRecord" SET "updatedById" = v_actor_id, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = v_record_id;
END
$set_monthly_expense_item_amount$;

DO $function_owners$
DECLARE user_table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)::name INTO user_table_owner
    FROM pg_catalog.pg_class AS c WHERE c.oid = 'public."User"'::regclass;
  IF user_table_owner IS NULL THEN RAISE EXCEPTION 'Could not resolve public."User" owner'; END IF;
  EXECUTE format('ALTER TABLE public."ExpenseItem" OWNER TO %I', user_table_owner);
  EXECUTE format('ALTER FUNCTION public._trim_expense_item_name(text) OWNER TO %I', user_table_owner);
  EXECUTE format('ALTER FUNCTION public.register_monthly_expense_item(integer,integer,text,text) OWNER TO %I', user_table_owner);
  EXECUTE format('ALTER FUNCTION public.set_monthly_expense_item_amount(integer,integer,text,integer) OWNER TO %I', user_table_owner);
END
$function_owners$;

REVOKE ALL PRIVILEGES ON FUNCTION public._trim_expense_item_name(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON FUNCTION public.register_monthly_expense_item(integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON FUNCTION public.set_monthly_expense_item_amount(integer,integer,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_monthly_expense_item(integer,integer,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_monthly_expense_item_amount(integer,integer,text,integer) TO authenticated;

-- Replace only the private implementation after the nullable link exists.
-- The public request-ID wrapper from migration 010 remains installed.
CREATE OR REPLACE FUNCTION public._apply_monthly_change_unchecked(
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
      -- Named recurring expense rows are exclusively maintained by their item RPC.
      -- Keep the existing generic-entry update/delete path unchanged.
      IF v_type = 'expenseEntry' AND v_before->>'expenseItemId' IS NOT NULL THEN
        RAISE EXCEPTION 'Named expense entries require the item amount RPC' USING ERRCODE = '42501';
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
REVOKE ALL PRIVILEGES ON FUNCTION public._apply_monthly_change_unchecked(integer, integer, jsonb) FROM PUBLIC, anon, authenticated, service_role;

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
     OR pg_catalog.to_regclass('public."ExpenseItem"') IS NULL
     OR pg_catalog.to_regprocedure('public.claim_monthly_request(text,integer,integer,jsonb,public."Role")') IS NULL
     OR pg_catalog.to_regprocedure('public._apply_monthly_change_unchecked(integer,integer,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public._finalize_monthly_record_unchecked(integer,integer)') IS NULL
     OR pg_catalog.to_regprocedure('public._unlock_monthly_record_unchecked(integer,integer,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.apply_monthly_change(integer,integer,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.finalize_monthly_record(integer,integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.unlock_monthly_record(integer,integer,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.create_monthly_record(integer,integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.register_monthly_expense_item(integer,integer,text,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.set_monthly_expense_item_amount(integer,integer,text,integer)') IS NULL THEN
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
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.create_monthly_record(integer,integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.register_monthly_expense_item(integer,integer,text,text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.set_monthly_expense_item_amount(integer,integer,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Monthly RPC permissions are unavailable' USING ERRCODE = '42501';
  END IF;
END
$monthly_backend_health$;

REVOKE ALL PRIVILEGES ON FUNCTION public.monthly_backend_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monthly_backend_health() TO authenticated;

COMMIT;
