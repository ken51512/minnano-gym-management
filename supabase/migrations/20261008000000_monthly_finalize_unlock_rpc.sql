-- Local Supabase RPC preparation only. Apply after 20261007000000_monthly_update_rpc.sql.
-- Both operations serialize on MonthlyRecord, just like apply_monthly_change.
BEGIN;

CREATE FUNCTION public.finalize_monthly_record(
  p_year integer,
  p_month integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $finalize_monthly_record$
DECLARE
  v_auth_id text;
  v_actor_id text;
  v_role public."Role";
  v_record_id text;
  v_closing_id text;
  v_closed_at timestamp(3) without time zone;
  v_revenue_count bigint;
  v_expense_count bigint;
  v_revenue_total numeric;
  v_expense_total numeric;
  v_revenue_entries jsonb;
  v_expense_entries jsonb;
  v_membership jsonb;
  v_member_count integer;
  v_new_members integer;
  v_cancellations integer;
  v_gross_profit numeric;
  v_alba_reward numeric;
  v_earnes_reward numeric;
  v_metrics jsonb;
  v_after jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'Invalid month' USING ERRCODE = '22023';
  END IF;
  v_auth_id := (SELECT auth.uid()::text);
  SELECT u."id" INTO v_actor_id
    FROM public."User" AS u
    WHERE u."supabaseUserId" = v_auth_id;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501';
  END IF;

  SELECT m."id" INTO v_record_id
    FROM public."MonthlyRecord" AS m
    WHERE m."year" = p_year AND m."month" = p_month
    FOR UPDATE;
  IF v_record_id IS NULL THEN
    RAISE EXCEPTION 'Monthly record not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT u."role" INTO v_role FROM public."User" AS u WHERE u."id" = v_actor_id;
  IF v_role IS DISTINCT FROM 'ALBA_ADMIN'::public."Role" THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public."MonthlyClosing" AS c WHERE c."monthlyRecordId" = v_record_id) THEN
    RAISE EXCEPTION 'Month is already closed' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*), sum(e."amount")::numeric,
         COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e."id"), '[]'::jsonb)
    INTO v_revenue_count, v_revenue_total, v_revenue_entries
    FROM public."RevenueEntry" AS e
    WHERE e."monthlyRecordId" = v_record_id;
  SELECT count(*), sum(e."amount")::numeric,
         COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e."id"), '[]'::jsonb)
    INTO v_expense_count, v_expense_total, v_expense_entries
    FROM public."ExpenseEntry" AS e
    WHERE e."monthlyRecordId" = v_record_id;
  SELECT to_jsonb(s), s."memberCount", s."newMembers", s."cancellations"
    INTO v_membership, v_member_count, v_new_members, v_cancellations
    FROM public."MembershipStats" AS s
    WHERE s."monthlyRecordId" = v_record_id;

  IF v_revenue_count < 1 OR v_revenue_total IS NULL
     OR v_expense_count < 1 OR v_expense_total IS NULL
     OR v_membership IS NULL OR v_member_count IS NULL
     OR v_new_members IS NULL OR v_cancellations IS NULL
     OR v_member_count < 0 OR v_new_members < 0 OR v_cancellations < 0 THEN
    RAISE EXCEPTION 'Required monthly inputs are incomplete or invalid' USING ERRCODE = '22023';
  END IF;

  v_gross_profit := v_revenue_total - v_expense_total;
  v_alba_reward := 100000 + GREATEST(v_member_count - 60, 0) * 5000;
  v_earnes_reward := v_gross_profit - v_alba_reward;
  v_metrics := jsonb_build_object(
    'revenue', v_revenue_total,
    'expenses', v_expense_total,
    'grossProfit', v_gross_profit,
    'albaReward', v_alba_reward,
    'earnesReward', v_earnes_reward,
    'grossProfitRate', CASE WHEN v_revenue_total = 0 THEN NULL ELSE (v_gross_profit / v_revenue_total) * 100 END,
    'earnesRate', CASE WHEN v_revenue_total = 0 THEN NULL ELSE (v_earnes_reward / v_revenue_total) * 100 END
  );

  v_closed_at := CURRENT_TIMESTAMP(3)::timestamp(3) without time zone;
  v_closing_id := gen_random_uuid()::text;
  INSERT INTO public."MonthlyClosing" ("id", "monthlyRecordId", "closedAt", "closedByUserId")
    VALUES (v_closing_id, v_record_id, v_closed_at, v_actor_id);
  UPDATE public."MonthlyRecord" AS m
    SET "updatedById" = v_actor_id, "updatedAt" = CURRENT_TIMESTAMP
    WHERE m."id" = v_record_id;

  v_after := jsonb_build_object(
    'period', jsonb_build_object('year', p_year, 'month', p_month),
    'closedAt', v_closed_at,
    'closedByUserId', v_actor_id,
    'revenueEntries', v_revenue_entries,
    'revenueTotal', v_revenue_total,
    'expenseEntries', v_expense_entries,
    'expenseTotal', v_expense_total,
    'membershipStats', v_membership,
    'metrics', v_metrics
  );
  INSERT INTO public."AuditLog" (
    "id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt"
  ) VALUES (
    gen_random_uuid()::text, v_actor_id, 'FINALIZE', 'MonthlyClosing', v_closing_id,
    NULL, v_after::text, CURRENT_TIMESTAMP
  );
END
$finalize_monthly_record$;

CREATE FUNCTION public.unlock_monthly_record(
  p_year integer,
  p_month integer,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $unlock_monthly_record$
DECLARE
  v_auth_id text;
  v_actor_id text;
  v_role public."Role";
  v_record_id text;
  v_closed_at timestamp(3) without time zone;
  v_closed_by text;
  v_reason text;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_year IS NULL OR p_year < 1 OR p_month IS NULL OR p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'Invalid month' USING ERRCODE = '22023';
  END IF;
  v_auth_id := (SELECT auth.uid()::text);
  SELECT u."id" INTO v_actor_id
    FROM public."User" AS u
    WHERE u."supabaseUserId" = v_auth_id;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Allowlisted user required' USING ERRCODE = '42501';
  END IF;

  SELECT m."id" INTO v_record_id
    FROM public."MonthlyRecord" AS m
    WHERE m."year" = p_year AND m."month" = p_month
    FOR UPDATE;
  IF v_record_id IS NULL THEN
    RAISE EXCEPTION 'Monthly record not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT u."role" INTO v_role FROM public."User" AS u WHERE u."id" = v_actor_id;
  IF v_role IS DISTINCT FROM 'ALBA_ADMIN'::public."Role" THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  v_reason := btrim(p_reason,
    ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(160) || chr(5760) ||
    chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) ||
    chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) ||
    chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279));
  IF v_reason IS NULL OR v_reason = '' THEN
    RAISE EXCEPTION 'A nonblank unlock reason is required' USING ERRCODE = '22023';
  END IF;

  SELECT c."closedAt", c."closedByUserId"
    INTO v_closed_at, v_closed_by
    FROM public."MonthlyClosing" AS c
    WHERE c."monthlyRecordId" = v_record_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Month is not closed' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM public."MonthlyClosing" AS c WHERE c."monthlyRecordId" = v_record_id;
  UPDATE public."MonthlyRecord" AS m
    SET "updatedById" = v_actor_id, "updatedAt" = CURRENT_TIMESTAMP
    WHERE m."id" = v_record_id;
  INSERT INTO public."AuditLog" (
    "id", "userId", "action", "entityType", "entityId", "beforeJson", "afterJson", "createdAt"
  ) VALUES (
    gen_random_uuid()::text,
    v_actor_id,
    'UNLOCK',
    'MonthlyClosing',
    v_record_id,
    jsonb_build_object('closedAt', v_closed_at, 'closedByUserId', v_closed_by)::text,
    jsonb_build_object('closed', false, 'reason', v_reason)::text,
    CURRENT_TIMESTAMP
  );
END
$unlock_monthly_record$;

REVOKE ALL PRIVILEGES ON FUNCTION public.finalize_monthly_record(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.unlock_monthly_record(integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_monthly_record(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_monthly_record(integer, integer, text) TO authenticated;

COMMIT;
