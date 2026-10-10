-- Atomically create a named recurring expense and its optional first monthly amount.
-- Null amount means not entered; zero is a persisted amount.
BEGIN;

CREATE FUNCTION public.register_monthly_expense_item_with_amount(
  p_year integer,
  p_month integer,
  p_category_id text,
  p_name text,
  p_amount integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $register_monthly_expense_item_with_amount$
DECLARE
  v_actor_id text;
  v_record_id text;
  v_category_name text;
  v_max_items integer;
  v_item_count bigint;
  v_item_id text;
  v_entry_id text;
  v_item_json jsonb;
  v_entry_json jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT u."id" INTO v_actor_id FROM public."User" AS u
    WHERE u."supabaseUserId" = (SELECT auth.uid()::text) AND u."role" = 'ALBA_ADMIN'::public."Role";
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month NOT BETWEEN 1 AND 12
     OR p_category_id IS NULL OR p_category_id = '' OR p_name IS NULL
     OR public._trim_expense_item_name(p_name) = ''
     OR pg_catalog.char_length(public._trim_expense_item_name(p_name)) > 200 THEN
    RAISE EXCEPTION 'Invalid expense item' USING ERRCODE = '22023';
  END IF;

  IF NOT public.claim_monthly_request(
    'change', p_year, p_month,
    jsonb_build_object('type', 'expenseItemRegistrationWithAmount', 'categoryId', p_category_id,
      'name', public._trim_expense_item_name(p_name), 'amount', p_amount),
    'ALBA_ADMIN'::public."Role"
  ) THEN RETURN; END IF;

  SELECT m."id" INTO v_record_id FROM public."MonthlyRecord" AS m
    WHERE m."year" = p_year AND m."month" = p_month FOR UPDATE;
  IF v_record_id IS NULL THEN RAISE EXCEPTION 'Monthly record not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM m."id" FROM public."MonthlyRecord" AS m
    WHERE (m."year", m."month") >= (p_year, p_month)
    ORDER BY m."year", m."month" FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public."MonthlyRecord" AS m JOIN public."MonthlyClosing" AS c ON c."monthlyRecordId" = m."id"
    WHERE (m."year", m."month") >= (p_year, p_month)
  ) THEN RAISE EXCEPTION 'Registration would alter a finalized month view' USING ERRCODE = 'P0001'; END IF;

  SELECT c."name" INTO v_category_name FROM public."ExpenseCategory" AS c WHERE c."id" = p_category_id FOR UPDATE;
  IF v_category_name IS NULL THEN RAISE EXCEPTION 'Expense category not found' USING ERRCODE = 'P0002'; END IF;
  v_max_items := CASE v_category_name WHEN '人件費' THEN 20 WHEN '広告費' THEN 3 WHEN 'その他' THEN 3 ELSE NULL END;
  IF v_max_items IS NULL THEN RAISE EXCEPTION 'This category does not accept named items' USING ERRCODE = '22023'; END IF;
  SELECT count(*) INTO v_item_count FROM public."ExpenseItem" AS i WHERE i."categoryId" = p_category_id;
  IF v_item_count >= v_max_items THEN RAISE EXCEPTION 'Expense item limit reached' USING ERRCODE = '22023'; END IF;

  v_item_id := gen_random_uuid()::text;
  INSERT INTO public."ExpenseItem" ("id", "categoryId", "name", "effectiveYear", "effectiveMonth", "effectiveMonthlyRecordId", "createdAt")
    VALUES (v_item_id, p_category_id, public._trim_expense_item_name(p_name), p_year, p_month, v_record_id, CURRENT_TIMESTAMP)
    RETURNING to_jsonb("ExpenseItem".*) INTO v_item_json;
  INSERT INTO public."AuditLog" ("id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt")
    VALUES (gen_random_uuid()::text, v_actor_id, 'CREATE', 'ExpenseItem', v_item_id, NULL, v_item_json::text, CURRENT_TIMESTAMP);

  IF p_amount IS NOT NULL THEN
    v_entry_id := gen_random_uuid()::text;
    INSERT INTO public."ExpenseEntry" ("id", "monthlyRecordId", "categoryId", "expenseItemId", "description", "amount", "createdAt")
      VALUES (v_entry_id, v_record_id, p_category_id, v_item_id, public._trim_expense_item_name(p_name), p_amount, CURRENT_TIMESTAMP)
      RETURNING to_jsonb("ExpenseEntry".*) INTO v_entry_json;
    INSERT INTO public."AuditLog" ("id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt")
      VALUES (gen_random_uuid()::text, v_actor_id, 'CREATE', 'ExpenseEntry', v_entry_id, NULL, v_entry_json::text, CURRENT_TIMESTAMP);
  END IF;
  UPDATE public."MonthlyRecord" SET "updatedById" = v_actor_id, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = v_record_id;
END
$register_monthly_expense_item_with_amount$;

DO $function_owner$
DECLARE user_table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)::name INTO user_table_owner
    FROM pg_catalog.pg_class AS c WHERE c.oid = 'public."User"'::regclass;
  IF user_table_owner IS NULL THEN RAISE EXCEPTION 'Could not resolve public."User" owner'; END IF;
  EXECUTE format('ALTER FUNCTION public.register_monthly_expense_item_with_amount(integer,integer,text,text,integer) OWNER TO %I', user_table_owner);
END
$function_owner$;
REVOKE ALL PRIVILEGES ON FUNCTION public.register_monthly_expense_item_with_amount(integer,integer,text,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_monthly_expense_item_with_amount(integer,integer,text,text,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.monthly_backend_health()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $monthly_backend_health$
DECLARE
  v_auth_id text;
  v_change_definition text;
  v_finalize_definition text;
  v_unlock_definition text;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  v_auth_id := (SELECT auth.uid()::text);
  IF NOT EXISTS (SELECT 1 FROM public."User" AS u WHERE u."supabaseUserId" = v_auth_id) THEN
    RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.to_regclass('public."MonthlyRequest"') IS NULL
     OR pg_catalog.to_regclass('public."ExpenseItem"') IS NULL
     OR pg_catalog.to_regclass('public."ExpenseItemNameHistory"') IS NULL
     OR pg_catalog.to_regprocedure('public.claim_monthly_request(text,integer,integer,jsonb,public."Role")') IS NULL
     OR pg_catalog.to_regprocedure('public._apply_monthly_change_unchecked(integer,integer,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public._finalize_monthly_record_unchecked(integer,integer)') IS NULL
     OR pg_catalog.to_regprocedure('public._unlock_monthly_record_unchecked(integer,integer,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.apply_monthly_change(integer,integer,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.finalize_monthly_record(integer,integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.unlock_monthly_record(integer,integer,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.create_monthly_record(integer,integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.register_monthly_expense_item(integer,integer,text,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.set_monthly_expense_item_amount(integer,integer,text,integer)') IS NULL
     OR pg_catalog.to_regprocedure('public.rename_monthly_expense_item(integer,integer,text,text)') IS NULL
     OR pg_catalog.to_regprocedure('public.register_monthly_expense_item_with_amount(integer,integer,text,text,integer)') IS NULL THEN
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
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.set_monthly_expense_item_amount(integer,integer,text,integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.rename_monthly_expense_item(integer,integer,text,text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'public.register_monthly_expense_item_with_amount(integer,integer,text,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Monthly RPC permissions are unavailable' USING ERRCODE = '42501';
  END IF;
END
$monthly_backend_health$;
REVOKE ALL PRIVILEGES ON FUNCTION public.monthly_backend_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monthly_backend_health() TO authenticated;

COMMIT;
