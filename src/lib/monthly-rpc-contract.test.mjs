import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rpcSql = readFileSync(new URL("../../supabase/migrations/20261007000000_monthly_update_rpc.sql", import.meta.url), "utf8");
const closingSql = readFileSync(new URL("../../supabase/migrations/20261008000000_monthly_finalize_unlock_rpc.sql", import.meta.url), "utf8");
const healthSql = readFileSync(new URL("../../supabase/migrations/20261009000000_monthly_backend_health_rpc.sql", import.meta.url), "utf8");
const healthCreateSql = readFileSync(new URL("../../supabase/migrations/20261012000000_monthly_health_check_create_rpc.sql", import.meta.url), "utf8");
const monthlyIdempotencySql = readFileSync(new URL("../../supabase/migrations/20261010000000_monthly_request_idempotency.sql", import.meta.url), "utf8");
const monthlyService = readFileSync(new URL("./monthly-service.ts", import.meta.url), "utf8");
const monthlyRpcCore = readFileSync(new URL("./monthly-rpc-core.ts", import.meta.url), "utf8");
const healthCore = readFileSync(new URL("./supabase-health-core.ts", import.meta.url), "utf8");
const createMonthSql = readFileSync(new URL("../../supabase/migrations/20261011000000_month_creation_and_expense_categories.sql", import.meta.url), "utf8");
const namedExpenseSql = readFileSync(new URL("../../supabase/migrations/20261013000000_monthly_expense_named_items.sql", import.meta.url), "utf8");
const expenseNameHistorySql = readFileSync(new URL("../../supabase/migrations/20261014000000_monthly_expense_item_name_history.sql", import.meta.url), "utf8");
const expenseRegistrationAmountSql = readFileSync(new URL("../../supabase/migrations/20261015000000_monthly_expense_item_registration_amount.sql", import.meta.url), "utf8");
const expenseRetirementSql = readFileSync(new URL("../../supabase/migrations/20261016000000_retire_monthly_expense_item.sql", import.meta.url), "utf8");
const priorMonthlyUpdateSql = readFileSync(new URL("../../supabase/migrations/20261007000000_monthly_update_rpc.sql", import.meta.url), "utf8");

test("static RPC contract derives identity and role in the database and denies anonymous execution", () => {
  assert.match(rpcSql, /CREATE FUNCTION public\.apply_monthly_change\([\s\S]*p_change jsonb[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = ''/);
  assert.match(rpcSql, /auth\.uid\(\)/);
  assert.match(rpcSql, /u\."supabaseUserId" = \(SELECT auth\.uid\(\)::text\)/);
  assert.match(rpcSql, /v_role <> 'EARNES'::public\."Role"/);
  assert.match(rpcSql, /v_role <> 'ALBA_ADMIN'::public\."Role"/);
  assert.match(rpcSql, /REVOKE ALL PRIVILEGES ON FUNCTION public\.apply_monthly_change\(integer, integer, jsonb\) FROM PUBLIC, anon, authenticated/);
  assert.match(rpcSql, /GRANT EXECUTE ON FUNCTION public\.apply_monthly_change\(integer, integer, jsonb\) TO authenticated/);
});

test("expense item retirement preserves history, removes later entries, and is admin-only", () => {
  assert.match(expenseRetirementSql, /ADD COLUMN "retiredYear" integer/);
  assert.match(expenseRetirementSql, /ADD COLUMN "retiredMonth" integer/);
  assert.match(expenseRetirementSql, /CREATE FUNCTION public\.retire_monthly_expense_item\(/);
  assert.match(expenseRetirementSql, /JOIN public\."MonthlyRecord" AS m/);
  assert.match(expenseRetirementSql, /DELETE FROM public\."ExpenseEntry"/);
  assert.match(expenseRetirementSql, /'ExpenseEntry'/);
  assert.match(expenseRetirementSql, /UPDATE public\."ExpenseItem"[\s\S]*"retiredYear"/);
  assert.match(expenseRetirementSql, /'ExpenseItem'/);
  assert.match(expenseRetirementSql, /'ALBA_ADMIN'::public\."Role"/);
  assert.match(expenseRetirementSql, /REVOKE ALL PRIVILEGES ON FUNCTION public\.retire_monthly_expense_item/);
  assert.match(expenseRetirementSql, /GRANT EXECUTE ON FUNCTION public\.retire_monthly_expense_item\(integer,integer,text\) TO authenticated/);
  assert.doesNotMatch(expenseRetirementSql, /DELETE FROM public\."ExpenseItem"/);
});

test("static RPC contract locks the period before close checks and scopes entry mutations to it", () => {
  const lock = rpcSql.indexOf("FOR UPDATE;");
  const closing = rpcSql.indexOf("IF EXISTS (");
  const roleRead = rpcSql.indexOf('SELECT u."role" INTO v_role');
  assert.ok(lock >= 0 && closing > lock);
  assert.ok(roleRead > lock, "current role must be read after the month lock");
  assert.match(rpcSql, /e\."id" = v_entry_id AND e\."monthlyRecordId" = v_monthly_record_id/);
  assert.match(rpcSql, /'Month is closed'/);
});

test("existing expense RPC blocks named-row updates and deletes while preserving ordinary rows", () => {
  const start = namedExpenseSql.indexOf("CREATE OR REPLACE FUNCTION public._apply_monthly_change_unchecked(");
  const end = namedExpenseSql.indexOf("$apply_monthly_change$;", start);
  const originalStart = priorMonthlyUpdateSql.indexOf("CREATE FUNCTION public.apply_monthly_change(");
  const originalEnd = priorMonthlyUpdateSql.indexOf("$apply_monthly_change$;", originalStart);
  const originalBody = priorMonthlyUpdateSql.slice(originalStart, originalEnd);
  assert.match(originalBody, /UPDATE public\."ExpenseEntry" AS e SET[\s\S]*WHERE e\."id" = v_entry_id/);
  assert.match(originalBody, /DELETE FROM public\."ExpenseEntry" AS e[\s\S]*WHERE e\."id" = v_entry_id/);
  assert.equal(originalBody.includes("v_before->>'expenseItemId' IS NOT NULL"), false, "the previous RPC had no named-row guard");
  const body = namedExpenseSql.slice(start, end);
  const guardAt = body.indexOf("v_before->>'expenseItemId' IS NOT NULL");
  const deleteAt = body.indexOf("DELETE FROM public.\"ExpenseEntry\"", guardAt);
  const updateAt = body.indexOf("UPDATE public.\"ExpenseEntry\" AS e SET", guardAt);
  assert.ok(guardAt >= 0 && deleteAt > guardAt && updateAt > guardAt);
  assert.match(body, /IF v_type = 'expenseEntry' AND v_before->>'expenseItemId' IS NOT NULL THEN[\s\S]*RAISE EXCEPTION 'Named expense entries require the item amount RPC'/);
  assert.match(body, /SELECT to_jsonb\(e\) INTO v_before[\s\S]*WHERE e\.\"id\" = v_entry_id AND e\.\"monthlyRecordId\" = v_monthly_record_id/);
  assert.match(body, /UPDATE public\.\"ExpenseEntry\" AS e SET[\s\S]*\"categoryId\" = CASE WHEN p_change \? 'categoryId'/);
  // Exercise the same ordering with both entry shapes and all legacy operations.
  const legacyApply = (row, operation, patch = {}) => {
    if (row.expenseItemId !== null) return { rejected: true, row };
    if (operation === "delete") return { rejected: false, row: null };
    return { rejected: false, row: { ...row, ...patch } };
  };
  const linked = { id: "fixture-linked", expenseItemId: "fixture-item", categoryId: "fixture-category", description: "Item", amount: 10 };
  const ordinary = { id: "fixture-ordinary", expenseItemId: null, categoryId: "fixture-category", description: "Taxi", amount: 10 };
  for (const operation of ["update", "delete"]) assert.equal(legacyApply(linked, operation, { amount: 99 }).rejected, true);
  assert.equal(legacyApply(ordinary, "update", { amount: 99, categoryId: "another-category" }).row.amount, 99);
  assert.equal(legacyApply(ordinary, "update", { amount: 99, categoryId: "another-category" }).row.categoryId, "another-category");
  assert.equal(legacyApply(ordinary, "delete").row, null);
});

test("static RPC contract writes audit and business state from one function invocation", () => {
  assert.match(rpcSql, /INSERT INTO public\."AuditLog"[\s\S]*'UPDATE'[\s\S]*v_before::text[\s\S]*v_after::text/);
  assert.match(rpcSql, /"updatedById" = v_actor_id/);
  assert.match(rpcSql, /"beforeJson"[\s\S]*"afterJson"[\s\S]*CURRENT_TIMESTAMP/);
  assert.match(rpcSql, /gen_random_uuid\(\)::text/);
});

test("static RPC contract retains nullable membership values and signed integer amounts", () => {
  assert.match(rpcSql, /'memberCount', 'newMembers', 'cancellations'/);
  assert.match(rpcSql, /'null'::jsonb/);
  assert.match(rpcSql, /< -2147483648/);
  assert.match(rpcSql, /> 2147483647/);
  assert.doesNotMatch(rpcSql, /amount[^\n]*CHECK/i);
});

test("static closing RPC contract uses the same month row lock before role and state checks", () => {
  for (const fn of ["finalize_monthly_record", "unlock_monthly_record"]) {
    const start = closingSql.indexOf(`CREATE FUNCTION public.${fn}(`);
    const end = closingSql.indexOf(`$${fn}$;`, start);
    assert.ok(start >= 0 && end > start, `missing ${fn}`);
    const body = closingSql.slice(start, end);
    const lockAt = body.indexOf("FOR UPDATE;");
    assert.ok(lockAt >= 0);
    assert.ok(body.indexOf("u.\"role\"") > lockAt, `${fn} must check role after the month lock`);
    assert.match(body, /u\."supabaseUserId" = v_auth_id/);
    assert.match(body, /auth\.uid\(\)/);
    assert.match(body, /public\."MonthlyRecord"/);
    assert.match(body, /SECURITY DEFINER[\s\S]*SET search_path = ''/);
  }
  assert.match(closingSql, /GRANT EXECUTE ON FUNCTION public\.finalize_monthly_record\(integer, integer\) TO authenticated/);
  assert.match(closingSql, /GRANT EXECUTE ON FUNCTION public\.unlock_monthly_record\(integer, integer, text\) TO authenticated/);
  assert.match(closingSql, /FROM PUBLIC, anon, authenticated/);
});

test("static finalization contract validates persisted required inputs and preserves zero and generic income", () => {
  const start = closingSql.indexOf("CREATE FUNCTION public.finalize_monthly_record(");
  const end = closingSql.indexOf("$finalize_monthly_record$;", start);
  const body = closingSql.slice(start, end);
  assert.match(body, /v_revenue_count < 1 OR v_revenue_total IS NULL/);
  assert.match(body, /v_expense_count < 1 OR v_expense_total IS NULL/);
  assert.match(body, /v_membership IS NULL OR v_member_count IS NULL/);
  assert.match(body, /v_new_members IS NULL OR v_cancellations IS NULL/);
  assert.match(body, /v_member_count < 0 OR v_new_members < 0 OR v_cancellations < 0/);
  assert.match(body, /100000 \+ GREATEST\(v_member_count - 60, 0\) \* 5000/);
  assert.match(body, /v_gross_profit := v_revenue_total - v_expense_total/);
  assert.match(body, /v_earnes_reward := v_gross_profit - v_alba_reward/);
  assert.match(body, /'earnesReward', v_earnes_reward/);
  assert.doesNotMatch(body, /Sugram|sugram|source-specific/i);
  assert.match(body, /INSERT INTO public\."AuditLog"[\s\S]*'FINALIZE'[\s\S]*v_after::text/);
});

test("static closing RPC contract serializes unlock reason and closing state with audit", () => {
  const start = closingSql.indexOf("CREATE FUNCTION public.unlock_monthly_record(");
  const end = closingSql.indexOf("$unlock_monthly_record$;", start);
  const body = closingSql.slice(start, end);
  assert.match(body, /v_reason := btrim\(p_reason,[\s\S]*chr\(9\)[\s\S]*chr\(65279\)\)/);
  assert.match(body, /v_reason IS NULL OR v_reason = ''/);
  assert.match(body, /DELETE FROM public\."MonthlyClosing"/);
  assert.match(body, /UPDATE public\."MonthlyRecord"[\s\S]*"updatedById" = v_actor_id/);
  assert.match(body, /'UNLOCK'[\s\S]*jsonb_build_object\('closed', false, 'reason', v_reason\)/);
  assert.match(body, /INSERT INTO public\."AuditLog"/);
});

test("server RPC errors use fixed classifications before propagation", () => {
  assert.match(monthlyRpcCore, /classifySupabaseFailure\(error\)/);
  assert.match(monthlyRpcCore, /new SafeSupabaseOperationError\(classifySupabaseFailure\(error\)\)/);
  assert.match(healthCore, /super\("Supabase operation failed"\)/);
  assert.doesNotMatch(monthlyService, /console\.(?:log|error|warn)\s*\(/);
});

test("monthly runtime service has no Prisma client or direct database import", () => {
  assert.doesNotMatch(monthlyService, /@prisma\/client|from ["']\.\/db/);
});

test("health RPC is authenticated, read-only, and fails if a monthly RPC or grant is missing", () => {
  assert.match(healthSql, /CREATE FUNCTION public\.monthly_backend_health\(\)[\s\S]*RETURNS void[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = ''/);
  for (const routine of [
    "public.apply_monthly_change(integer,integer,jsonb)",
    "public.finalize_monthly_record(integer,integer)",
    "public.unlock_monthly_record(integer,integer,text)",
  ]) assert.ok(healthSql.includes(`'${routine}'`), `missing readiness check for ${routine}`);
  assert.match(healthSql, /public\."User"[\s\S]*"supabaseUserId" = v_auth_id/);
  assert.match(healthSql, /has_function_privilege\('authenticated'/);
  assert.match(healthSql, /FROM PUBLIC, anon, authenticated/);
  assert.match(healthSql, /TO authenticated/);
  assert.doesNotMatch(healthSql, /^\s*(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE|DROP)\b/im);
});

test("health replacement preserves existing auth and RPC checks and additionally requires create-month RPC access", () => {
  const body = healthCreateSql.slice(healthCreateSql.indexOf("CREATE OR REPLACE FUNCTION"), healthCreateSql.indexOf("$monthly_backend_health$;"));
  const idempotencyHealthStart = monthlyIdempotencySql.lastIndexOf("CREATE OR REPLACE FUNCTION public.monthly_backend_health()");
  const idempotencyHealthEnd = monthlyIdempotencySql.indexOf("$monthly_backend_health$;", idempotencyHealthStart);
  const idempotencyHealth = monthlyIdempotencySql.slice(idempotencyHealthStart, idempotencyHealthEnd);
  assert.match(body, /auth\.uid\(\)/);
  assert.match(body, /public\."User"[\s\S]*"supabaseUserId" = v_auth_id/);
  for (const invariant of [
    /to_regclass\('public\."MonthlyRequest"'\)/,
    /to_regprocedure\('public\.claim_monthly_request\(/,
    /to_regprocedure\('public\._apply_monthly_change_unchecked\(/,
    /to_regprocedure\('public\._finalize_monthly_record_unchecked\(/,
    /to_regprocedure\('public\._unlock_monthly_record_unchecked\(/,
    /pg_get_functiondef\('public\.apply_monthly_change\(/,
    /pg_get_functiondef\('public\.finalize_monthly_record\(/,
    /pg_get_functiondef\('public\.unlock_monthly_record\(/,
    /strpos\(v_change_definition, 'claim_monthly_request'\)/,
    /strpos\(v_finalize_definition, 'claim_monthly_request'\)/,
    /strpos\(v_unlock_definition, 'claim_monthly_request'\)/,
  ]) {
    assert.match(idempotencyHealth, invariant);
    assert.match(body, invariant, `idempotency health invariant lost: ${invariant}`);
  }
  for (const routine of [
    "public.apply_monthly_change(integer,integer,jsonb)",
    "public.finalize_monthly_record(integer,integer)",
    "public.unlock_monthly_record(integer,integer,text)",
  ]) {
    assert.ok(body.includes(`'${routine}'`), `missing preserved routine check ${routine}`);
    assert.ok(body.includes(`has_function_privilege('authenticated', '${routine}', 'EXECUTE')`), `missing preserved grant check ${routine}`);
  }
  assert.match(body, /to_regprocedure\('public\.create_monthly_record\(integer,integer\)'\) IS NULL/);
  assert.match(body, /has_function_privilege\('authenticated', 'public\.create_monthly_record\(integer,integer\)', 'EXECUTE'\)/);
  assert.match(healthCreateSql, /CREATE OR REPLACE FUNCTION public\.monthly_backend_health\(\)/);
  assert.match(healthCreateSql, /REVOKE ALL PRIVILEGES ON FUNCTION public\.monthly_backend_health\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(healthCreateSql, /GRANT EXECUTE ON FUNCTION public\.monthly_backend_health\(\) TO authenticated/);
  assert.doesNotMatch(healthCreateSql, /\bDROP\b|ALTER TABLE|CREATE POLICY|GRANT .* ON TABLE/i);
});

test("month creation migration seeds only the confirmed categories without overwriting existing rows", () => {
  const seed = createMonthSql.slice(createMonthSql.indexOf('INSERT INTO public."ExpenseCategory"'), createMonthSql.indexOf("CREATE FUNCTION"));
  const names = [...seed.matchAll(/CURRENT_TIMESTAMP\),?\s*\n?/g)];
  assert.equal(names.length, 10);
  for (const name of ["家賃","手数料（スグラム）","人件費","Wi-Fi","携帯","広告費","電気代","水道代","ガス代","その他"]) {
    assert.ok(seed.includes(`'${name}'`), `missing category ${name}`);
  }
  assert.match(seed, /ON CONFLICT \("name"\) DO NOTHING/);
  assert.doesNotMatch(seed, /DO UPDATE|DELETE FROM/i);
  assert.doesNotMatch(seed, /人件費[^\n]*(?:氏名|name)|氏名/);
});

test("month creation RPC verifies Auth allowlist and ALBA_ADMIN, uses idempotency, and audits a blank record", () => {
  const start = createMonthSql.indexOf("CREATE FUNCTION public.create_monthly_record(");
  const end = createMonthSql.indexOf("$create_monthly_record$;", start);
  const body = createMonthSql.slice(start, end);
  assert.match(body, /SECURITY DEFINER[\s\S]*SET search_path = ''/);
  assert.match(body, /auth\.uid\(\)/);
  assert.match(body, /u\."supabaseUserId" = \(SELECT auth\.uid\(\)::text\)/);
  assert.match(body, /v_role IS DISTINCT FROM 'ALBA_ADMIN'::public\."Role"/);
  assert.match(body, /VALUES \(v_actor_id, v_request_id, 'change', p_year, p_month, '\{\"type\":\"monthlyRecord\",\"operation\":\"create\"\}'::jsonb\)/);
  assert.match(body, /v_operation IS DISTINCT FROM 'change'[\s\S]*v_payload IS DISTINCT FROM '\{\"type\":\"monthlyRecord\",\"operation\":\"create\"\}'::jsonb/);
  assert.match(body, /ON CONFLICT \("actorId", "requestId"\) DO NOTHING/);
  assert.match(body, /SELECT r\."operation", r\."year", r\."month", r\."payload"[\s\S]*RETURN;/);
  assert.match(body, /ON CONFLICT \("year", "month"\) DO NOTHING/);
  assert.match(body, /ERRCODE = '23505'/);
  assert.match(body, /'CREATE'[\s\S]*'MonthlyRecord'[\s\S]*v_after::text/);
  assert.doesNotMatch(body, /INSERT INTO public\."(?:RevenueEntry|ExpenseEntry|MembershipStats|MonthlyClosing)"/);
  assert.match(createMonthSql, /REVOKE ALL PRIVILEGES ON FUNCTION public\.create_monthly_record\(integer, integer\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(createMonthSql, /GRANT EXECUTE ON FUNCTION public\.create_monthly_record\(integer, integer\) TO authenticated/);
  assert.doesNotMatch(createMonthSql, /DROP\s+CONSTRAINT|MonthlyRequest_operation_check/);
  assert.doesNotMatch(createMonthSql, /'create_month'/);
});

test("named expense SQL preserves existing entries and makes a missing amount distinct from zero", () => {
  assert.match(namedExpenseSql, /ADD COLUMN "expenseItemId" text/);
  assert.match(namedExpenseSql, /UNIQUE \("monthlyRecordId", "expenseItemId"\)/);
  assert.match(namedExpenseSql, /IF v_entry_id IS NULL THEN[\s\S]*INSERT INTO public\."ExpenseEntry"[\s\S]*ELSE[\s\S]*UPDATE public\."ExpenseEntry" AS e SET "amount" = p_amount/);
  assert.match(namedExpenseSql, /p_amount IS NULL/);
  assert.doesNotMatch(namedExpenseSql, /ALTER COLUMN "amount" DROP NOT NULL|ADD COLUMN "amount"/);
  assert.match(namedExpenseSql, /SET "amount" = p_amount/);
  assert.match(namedExpenseSql, /CREATE OR REPLACE FUNCTION public\._apply_monthly_change_unchecked\([\s\S]*Named expense entries require the item amount RPC/);
  assert.match(monthlyIdempotencySql, /CREATE FUNCTION public\.apply_monthly_change\(p_year integer, p_month integer, p_change jsonb\)[\s\S]*claim_monthly_request[\s\S]*_apply_monthly_change_unchecked/);
  assert.doesNotMatch(namedExpenseSql, /CREATE OR REPLACE FUNCTION public\.apply_monthly_change/);
});

test("database named-label trim and character count match the server's trim/code-point policy", () => {
  assert.match(namedExpenseSql, /CREATE FUNCTION public\._trim_expense_item_name\(p_value text\)[\s\S]*IMMUTABLE[\s\S]*pg_catalog\.btrim/);
  for (const codePoint of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) {
    assert.ok(namedExpenseSql.includes(`pg_catalog.chr(${codePoint})`), `missing trim whitespace U+${codePoint.toString(16)}`);
  }
  assert.match(namedExpenseSql, /char_length\(public\._trim_expense_item_name\(p_name\)\) > 200/);
  assert.match(namedExpenseSql, /ExpenseItem_name_check[\s\S]*char_length\(public\._trim_expense_item_name\("name"\)\) <= 200/);
  assert.match(namedExpenseSql, /'name', public\._trim_expense_item_name\(p_name\)/);
});

test("named expense registration is ALBA-only, request-idempotent, closed-month guarded, and audit atomic", () => {
  for (const functionName of ["register_monthly_expense_item", "set_monthly_expense_item_amount"]) {
    const start = namedExpenseSql.indexOf(`CREATE FUNCTION public.${functionName}(`);
    const end = namedExpenseSql.indexOf(`$${functionName}$;`, start);
    const body = namedExpenseSql.slice(start, end);
    assert.ok(start >= 0 && end > start, `missing ${functionName}`);
    assert.match(body, /auth\.uid\(\)/);
    assert.match(body, /u\."supabaseUserId" = v_auth_id/);
    assert.match(body, /v_role IS DISTINCT FROM 'ALBA_ADMIN'::public\."Role"/);
    assert.match(body, /INSERT INTO public\."MonthlyRequest"[\s\S]*'change'[\s\S]*ON CONFLICT \("actorId", "requestId"\) DO NOTHING/);
    assert.match(body, /v_payload IS DISTINCT FROM v_request_payload/);
    assert.match(body, /MonthlyRecord" AS m[\s\S]*FOR UPDATE/);
    assert.match(body, /MonthlyClosing/);
    assert.match(body, /INSERT INTO public\."AuditLog"/);
  }
  const registration = namedExpenseSql.slice(namedExpenseSql.indexOf("CREATE FUNCTION public.register_monthly_expense_item("), namedExpenseSql.indexOf("$register_monthly_expense_item$;"));
  assert.match(registration, /ExpenseCategory" AS c[\s\S]*FOR UPDATE/);
  assert.match(registration, /WHEN '人件費' THEN 20[\s\S]*WHEN '広告費' THEN 3[\s\S]*WHEN 'その他' THEN 3/);
  assert.doesNotMatch(registration, /広告宣伝費/);
  assert.match(registration, /count\(\*\).*ExpenseItem/);
  assert.match(registration, /Registration would alter a finalized month view/);
  assert.match(namedExpenseSql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(namedExpenseSql, /FOR SELECT TO authenticated USING \(public\.current_app_role\(\) IS NOT NULL\)/);
  assert.match(namedExpenseSql, /REVOKE ALL PRIVILEGES ON FUNCTION public\.register_monthly_expense_item/);
  assert.doesNotMatch(namedExpenseSql, /\bDROP\b|DELETE FROM public\."ExpenseItem"|DO UPDATE SET "name"/i);
  const baseHealthStart = healthCreateSql.indexOf("CREATE OR REPLACE FUNCTION public.monthly_backend_health()");
  const baseHealthEnd = healthCreateSql.indexOf("$monthly_backend_health$;", baseHealthStart);
  const updatedHealthStart = namedExpenseSql.lastIndexOf("CREATE OR REPLACE FUNCTION public.monthly_backend_health()");
  const updatedHealthEnd = namedExpenseSql.indexOf("$monthly_backend_health$;", updatedHealthStart);
  const baseHealth = healthCreateSql.slice(baseHealthStart, baseHealthEnd);
  const updatedHealth = namedExpenseSql.slice(updatedHealthStart, updatedHealthEnd);
  for (const guard of [
    /to_regclass\('public\."MonthlyRequest"'\)/,
    /to_regprocedure\('public\.claim_monthly_request\(/,
    /to_regprocedure\('public\._apply_monthly_change_unchecked\(/,
    /to_regprocedure\('public\._finalize_monthly_record_unchecked\(/,
    /to_regprocedure\('public\._unlock_monthly_record_unchecked\(/,
    /pg_get_functiondef\('public\.apply_monthly_change\(/,
    /strpos\(v_change_definition, 'claim_monthly_request'\)/,
    /strpos\(v_finalize_definition, 'claim_monthly_request'\)/,
    /strpos\(v_unlock_definition, 'claim_monthly_request'\)/,
  ]) {
    if (guard.test(baseHealth)) assert.match(updatedHealth, guard);
  }
  assert.match(updatedHealth, /to_regclass\('public\."ExpenseItem"'\)/);
  assert.match(updatedHealth, /to_regprocedure\('public\.register_monthly_expense_item\(integer,integer,text,text\)'\)/);
  assert.match(updatedHealth, /to_regprocedure\('public\.set_monthly_expense_item_amount\(integer,integer,text,integer\)'\)/);
  assert.match(updatedHealth, /has_function_privilege\('authenticated', 'public\.register_monthly_expense_item\(integer,integer,text,text\)', 'EXECUTE'\)/);
  assert.match(updatedHealth, /has_function_privilege\('authenticated', 'public\.set_monthly_expense_item_amount\(integer,integer,text,integer\)', 'EXECUTE'\)/);
});

test("expense name history keeps stable item IDs, monthly amounts, effective versions, and audited revisions while allowing duplicate names", () => {
  assert.match(expenseNameHistorySql, /CREATE TABLE public\."ExpenseItemNameHistory"/);
  assert.match(expenseNameHistorySql, /"itemId" text NOT NULL REFERENCES public\."ExpenseItem"\("id"\)/);
  assert.match(expenseNameHistorySql, /UNIQUE \("itemId", "year", "month"\)/);
  assert.match(expenseNameHistorySql, /CREATE FUNCTION public\.rename_monthly_expense_item\(/);
  assert.match(expenseNameHistorySql, /'change', p_year, p_month,[\s\S]*'expenseItemRename'/);
  assert.match(expenseNameHistorySql, /'ALBA_ADMIN'::public\."Role"/);
  assert.match(expenseNameHistorySql, /ORDER BY m\."year", m\."month" FOR UPDATE/);
  assert.match(expenseNameHistorySql, /WHERE \(m\."year", m\."month"\) >= \(p_year, p_month\)[\s\S]*MonthlyClosing[\s\S]*Rename would alter a finalized month view/);
  assert.match(expenseNameHistorySql, /current_app_role\(\) IS NOT NULL/);
  assert.match(expenseNameHistorySql, /GRANT SELECT ON TABLE public\."ExpenseItemNameHistory" TO authenticated/);
  assert.match(expenseNameHistorySql, /FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(expenseNameHistorySql, /GRANT EXECUTE ON FUNCTION public\.rename_monthly_expense_item\(integer,integer,text,text\) TO authenticated/);
  assert.match(expenseNameHistorySql, /ON CONFLICT \("itemId", "year", "month"\)[\s\S]*"name" = v_name|UPDATE public\."ExpenseItemNameHistory" AS h SET "name" = v_name/);
  assert.match(expenseNameHistorySql, /CASE WHEN v_before IS NULL THEN 'CREATE' ELSE 'UPDATE' END[\s\S]*'ExpenseItemNameHistory'[\s\S]*v_before::text, v_after::text/);
  assert.doesNotMatch(expenseNameHistorySql, /Expense item name already exists for this month/);
  assert.match(expenseNameHistorySql, /CREATE OR REPLACE FUNCTION public\.monthly_backend_health\(\)/);
  assert.match(expenseNameHistorySql, /pg_get_functiondef\('public\.apply_monthly_change/);
  assert.doesNotMatch(expenseNameHistorySql, /DROP\s+(?:TABLE|FUNCTION|POLICY)|DELETE FROM public\."ExpenseItemNameHistory"|UPDATE public\."ExpenseItem"\s+SET\s+"name"/i);
  assert.match(readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8"), /model ExpenseItemNameHistory \{/);
});

test("named item plus optional monthly amount is one ALBA-only, idempotent, audit-atomic transaction", () => {
  const start = expenseRegistrationAmountSql.indexOf("CREATE FUNCTION public.register_monthly_expense_item_with_amount(");
  const end = expenseRegistrationAmountSql.indexOf("$register_monthly_expense_item_with_amount$;", start);
  const body = expenseRegistrationAmountSql.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /auth\.uid\(\)/);
  assert.match(body, /u\."supabaseUserId" = \(SELECT auth\.uid\(\)::text\)[\s\S]*u\."role" = 'ALBA_ADMIN'::public\."Role"/);
  assert.match(body, /claim_monthly_request\([\s\S]*expenseItemRegistrationWithAmount[\s\S]*'ALBA_ADMIN'::public\."Role"/);
  assert.match(body, /ORDER BY m\."year", m\."month" FOR UPDATE/);
  assert.match(body, /MonthlyClosing[\s\S]*Registration would alter a finalized month view/);
  assert.match(body, /WHEN '人件費' THEN 20 WHEN '広告費' THEN 3 WHEN 'その他' THEN 3/);
  assert.match(body, /IF p_amount IS NOT NULL THEN[\s\S]*INSERT INTO public\."ExpenseEntry"/);
  assert.match(body, /INSERT INTO public\."AuditLog"[\s\S]*'CREATE', 'ExpenseItem'/);
  assert.match(body, /INSERT INTO public\."AuditLog"[\s\S]*'CREATE', 'ExpenseEntry'/);
  assert.match(expenseRegistrationAmountSql, /GRANT EXECUTE ON FUNCTION public\.register_monthly_expense_item_with_amount\(integer,integer,text,text,integer\) TO authenticated/);
  assert.match(expenseRegistrationAmountSql, /has_function_privilege\('authenticated', 'public\.register_monthly_expense_item_with_amount/);
  assert.doesNotMatch(body, /DELETE FROM|UPDATE public\."ExpenseItem"/i);
});
