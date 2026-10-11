BEGIN;

-- Removes only the selected month's amount for a named expense item.
-- The ExpenseItem itself and its name history remain intact.
CREATE FUNCTION public.clear_monthly_expense_item_amount(
  p_year integer,
  p_month integer,
  p_item_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $clear_monthly_expense_item_amount$
DECLARE
  v_record_id text;
  v_actor_id text;
  v_entry_id text;
  v_before jsonb;
BEGIN
  IF p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month NOT BETWEEN 1 AND 12
     OR p_item_id IS NULL OR p_item_id = '' THEN
    RAISE EXCEPTION 'Invalid expense item amount clear request' USING ERRCODE = '22023';
  END IF;

  IF NOT public.claim_monthly_request(
    'change', p_year, p_month,
    jsonb_build_object('type', 'clearExpenseItemAmount', 'itemId', p_item_id),
    'ALBA_ADMIN'::public."Role"
  ) THEN
    RETURN;
  END IF;

  SELECT m."id" INTO v_record_id
    FROM public."MonthlyRecord" AS m
    WHERE m."year" = p_year AND m."month" = p_month
    FOR UPDATE;
  IF v_record_id IS NULL THEN
    RAISE EXCEPTION 'Monthly record not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public."MonthlyClosing" AS c WHERE c."monthlyRecordId" = v_record_id) THEN
    RAISE EXCEPTION 'Month is closed' USING ERRCODE = 'P0001';
  END IF;

  SELECT e."id", to_jsonb(e.*) INTO v_entry_id, v_before
    FROM public."ExpenseEntry" AS e
    WHERE e."monthlyRecordId" = v_record_id AND e."expenseItemId" = p_item_id
    FOR UPDATE;
  IF v_entry_id IS NULL THEN
    RAISE EXCEPTION 'Expense amount not found' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public."ExpenseEntry" WHERE "id" = v_entry_id;
  SELECT u."id" INTO v_actor_id
    FROM public."User" AS u
    WHERE u."supabaseUserId" = (SELECT auth.uid()::text);
  INSERT INTO public."AuditLog" ("id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt")
    VALUES (gen_random_uuid()::text, v_actor_id, 'DELETE', 'ExpenseEntry', v_entry_id, v_before::text, NULL, CURRENT_TIMESTAMP);
  UPDATE public."MonthlyRecord"
    SET "updatedById" = v_actor_id, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = v_record_id;
END
$clear_monthly_expense_item_amount$;

DO $function_owner$
DECLARE
  user_table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)::name INTO user_table_owner
    FROM pg_catalog.pg_class AS c WHERE c.oid = 'public."User"'::regclass;
  IF user_table_owner IS NULL THEN RAISE EXCEPTION 'Could not resolve public."User" owner'; END IF;
  EXECUTE format('ALTER FUNCTION public.clear_monthly_expense_item_amount(integer,integer,text) OWNER TO %I', user_table_owner);
END
$function_owner$;

REVOKE ALL PRIVILEGES ON FUNCTION public.clear_monthly_expense_item_amount(integer,integer,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.clear_monthly_expense_item_amount(integer,integer,text) TO authenticated;

COMMIT;
