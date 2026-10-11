BEGIN;

-- Retire an expense item from the selected month onward without deleting
-- historical rows that still reference it.
ALTER TABLE public."ExpenseItem"
  ADD COLUMN "retiredYear" integer,
  ADD COLUMN "retiredMonth" integer,
  ADD CONSTRAINT "ExpenseItem_retired_period_check"
    CHECK (("retiredYear" IS NULL AND "retiredMonth" IS NULL)
      OR ("retiredYear" >= 1 AND "retiredMonth" BETWEEN 1 AND 12));

CREATE INDEX "ExpenseItem_retired_period_idx"
  ON public."ExpenseItem"("retiredYear", "retiredMonth");

CREATE FUNCTION public.retire_monthly_expense_item(
  p_year integer,
  p_month integer,
  p_item_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $retire_monthly_expense_item$
DECLARE
  v_record_id text;
  v_actor_id text;
  v_item public."ExpenseItem"%ROWTYPE;
  v_before jsonb;
  v_after jsonb;
  v_entry record;
BEGIN
  IF p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month NOT BETWEEN 1 AND 12
     OR p_item_id IS NULL OR p_item_id = '' THEN
    RAISE EXCEPTION 'Invalid expense item retirement request' USING ERRCODE = '22023';
  END IF;

  IF NOT public.claim_monthly_request(
    'change', p_year, p_month,
    jsonb_build_object('type', 'retireExpenseItem', 'itemId', p_item_id),
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

  PERFORM m."id"
    FROM public."MonthlyRecord" AS m
    WHERE (m."year", m."month") >= (p_year, p_month)
    ORDER BY m."year", m."month"
    FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public."MonthlyClosing" AS c
    JOIN public."MonthlyRecord" AS m ON m."id" = c."monthlyRecordId"
    WHERE (m."year", m."month") >= (p_year, p_month)
  ) THEN
    RAISE EXCEPTION 'Month is closed' USING ERRCODE = 'P0001';
  END IF;

  SELECT i.* INTO v_item
    FROM public."ExpenseItem" AS i
    WHERE i."id" = p_item_id
    FOR UPDATE;
  IF NOT FOUND
     OR (v_item."effectiveYear", v_item."effectiveMonth") > (p_year, p_month)
     OR (v_item."retiredYear" IS NOT NULL
       AND (v_item."retiredYear", v_item."retiredMonth") <= (p_year, p_month)) THEN
    RAISE EXCEPTION 'Expense item is not active for this month' USING ERRCODE = 'P0002';
  END IF;

  SELECT u."id" INTO v_actor_id
    FROM public."User" AS u
    WHERE u."supabaseUserId" = (SELECT auth.uid()::text)
      AND u."role" = 'ALBA_ADMIN'::public."Role";
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  FOR v_entry IN
    SELECT e."id", e."monthlyRecordId", to_jsonb(e) AS before_json
      FROM public."ExpenseEntry" AS e
      JOIN public."MonthlyRecord" AS m ON m."id" = e."monthlyRecordId"
      WHERE e."expenseItemId" = p_item_id
        AND (m."year", m."month") >= (p_year, p_month)
      ORDER BY m."year", m."month", e."id"
      FOR UPDATE
  LOOP
    DELETE FROM public."ExpenseEntry" WHERE "id" = v_entry."id";
    INSERT INTO public."AuditLog"
      ("id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt")
      VALUES
      (gen_random_uuid()::text, v_actor_id, 'DELETE', 'ExpenseEntry', v_entry."id",
       v_entry.before_json::text, NULL, CURRENT_TIMESTAMP);
    UPDATE public."MonthlyRecord"
      SET "updatedById" = v_actor_id, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = v_entry."monthlyRecordId";
  END LOOP;

  v_before := to_jsonb(v_item);
  UPDATE public."ExpenseItem"
    SET "retiredYear" = p_year, "retiredMonth" = p_month
    WHERE "id" = p_item_id
    RETURNING to_jsonb("ExpenseItem".*) INTO v_after;
  INSERT INTO public."AuditLog"
    ("id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt")
    VALUES
    (gen_random_uuid()::text, v_actor_id, 'DELETE', 'ExpenseItem', p_item_id,
     v_before::text, v_after::text, CURRENT_TIMESTAMP);
  UPDATE public."MonthlyRecord"
    SET "updatedById" = v_actor_id, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = v_record_id;
END
$retire_monthly_expense_item$;

DO $function_owner$
DECLARE
  user_table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)::name INTO user_table_owner
    FROM pg_catalog.pg_class AS c WHERE c.oid = 'public."User"'::regclass;
  IF user_table_owner IS NULL THEN RAISE EXCEPTION 'Could not resolve public."User" owner'; END IF;
  EXECUTE format('ALTER FUNCTION public.retire_monthly_expense_item(integer,integer,text) OWNER TO %I', user_table_owner);
END
$function_owner$;

REVOKE ALL PRIVILEGES ON FUNCTION public.retire_monthly_expense_item(integer,integer,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retire_monthly_expense_item(integer,integer,text) TO authenticated;

COMMIT;
