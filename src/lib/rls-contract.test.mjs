import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("../../supabase/migrations/20261005000000_schema_and_rls.sql", import.meta.url), "utf8");
const allowlist = readFileSync(new URL("../../supabase/migrations/20261006000000_user_allowlist_self_read.sql", import.meta.url), "utf8");
const nameHistory = readFileSync(new URL("../../supabase/migrations/20261014000000_monthly_expense_item_name_history.sql", import.meta.url), "utf8");

const modelNames = ["User", "MonthlyRecord", "RevenueEntry", "ExpenseEntry", "ExpenseCategory", "MembershipStats", "MonthlyClosing", "AuditLog"];

test("static SQL contract declares all eight Prisma models with create-if-absent tables and RLS", () => {
  for (const name of modelNames) {
    assert.match(schema, new RegExp(`model ${name} \\{`));
    assert.ok(bootstrap.includes(`CREATE TABLE IF NOT EXISTS public."${name}"`), `missing SQL table ${name}`);
    assert.ok(bootstrap.includes(`ALTER TABLE public."${name}" ENABLE ROW LEVEL SECURITY`), `RLS not enabled for ${name}`);
  }
});

test("static SQL contract preserves Prisma enum, nullable fields, keys, indexes, and foreign-key actions", () => {
  assert.match(bootstrap, /CREATE TYPE public\."Role" AS ENUM \('ALBA_ADMIN', 'EARNES'\)/);
  assert.match(schema, /memberCount\s+Int\?/);
  assert.match(schema, /newMembers\s+Int\?/);
  assert.match(schema, /cancellations\s+Int\?/);
  for (const column of ["memberCount", "newMembers", "cancellations"]) {
    assert.match(bootstrap, new RegExp(`"${column}" INTEGER,`));
  }
  assert.match(bootstrap, /CONSTRAINT "MonthlyRecord_year_month_key" UNIQUE \("year", "month"\)/);
  assert.match(bootstrap, /CONSTRAINT "User_supabaseUserId_key" UNIQUE \("supabaseUserId"\)/);
  assert.match(bootstrap, /CONSTRAINT "User_email_key" UNIQUE \("email"\)/);
  assert.match(bootstrap, /CONSTRAINT "ExpenseCategory_name_key" UNIQUE \("name"\)/);
  assert.match(bootstrap, /CONSTRAINT "MembershipStats_monthlyRecordId_key" UNIQUE \("monthlyRecordId"\)/);
  assert.match(bootstrap, /CONSTRAINT "MonthlyClosing_monthlyRecordId_key" UNIQUE \("monthlyRecordId"\)/);
  assert.match(bootstrap, /"amount" INTEGER NOT NULL/);
  assert.match(bootstrap, /ON DELETE CASCADE ON UPDATE CASCADE/);
  assert.match(bootstrap, /ON DELETE SET NULL ON UPDATE CASCADE/);
  assert.match(bootstrap, /ON DELETE RESTRICT ON UPDATE CASCADE/);
  assert.match(bootstrap, /"RevenueEntry_monthlyRecordId_idx"/);
  assert.match(bootstrap, /"ExpenseEntry_monthlyRecordId_idx"/);
  assert.match(bootstrap, /"AuditLog_userId_createdAt_idx"/);
  assert.match(bootstrap, /"entityId" TEXT,/);
  assert.match(bootstrap, /"beforeJson" TEXT,/);
  assert.match(bootstrap, /"afterJson" TEXT,/);
  assert.match(bootstrap, /"updatedById" TEXT,/);
  assert.doesNotMatch(bootstrap, /CHECK\s*\(/i);
});

test("static SQL contract makes role lookup server-derived and protects the definer function", () => {
  assert.match(bootstrap, /CREATE FUNCTION public\.current_app_role\(\)/);
  assert.match(bootstrap, /SECURITY DEFINER[\s\S]*SET search_path = ''/);
  assert.match(bootstrap, /u\."supabaseUserId" = \(SELECT auth\.uid\(\)::text\)/);
  assert.match(bootstrap, /REVOKE ALL PRIVILEGES ON FUNCTION public\.current_app_role\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(bootstrap, /GRANT EXECUTE ON FUNCTION public\.current_app_role\(\) TO authenticated/);
  assert.doesNotMatch(bootstrap, /GRANT EXECUTE ON FUNCTION public\.current_app_role\(\) TO anon/);
});

test("static SQL contract grants allowlisted read only and no direct authenticated or anonymous writes", () => {
  for (const policy of ["monthly_record", "revenue_entry", "expense_entry", "expense_category", "membership_stats", "monthly_closing", "audit_log"]) {
    assert.match(bootstrap, new RegExp(`CREATE POLICY ${policy}_allowlisted_read`));
  }
  assert.match(bootstrap, /USING \(public\.current_app_role\(\) IS NOT NULL\)/);
  assert.match(bootstrap, /GRANT SELECT ON TABLE[\s\S]*TO authenticated/);
  assert.match(bootstrap, /REVOKE ALL PRIVILEGES ON TABLE %s FROM anon, authenticated, PUBLIC/);
  assert.doesNotMatch(bootstrap, /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)\b/i);
  assert.match(bootstrap, /pg_catalog\.pg_policies/);
  assert.match(bootstrap, /information_schema\.table_privileges/);
  assert.match(bootstrap, /information_schema\.column_privileges/);
});

test("static allowlist SQL permits only self-row read and has no self-update grant", () => {
  assert.match(allowlist, /GRANT SELECT \("id", "supabaseUserId", "email", "displayName", "role"\)/);
  assert.match(allowlist, /USING \("supabaseUserId" = \(SELECT auth\.uid\(\)::text\)\)/);
  assert.match(allowlist, /AS RESTRICTIVE/);
  assert.match(allowlist, /REVOKE ALL PRIVILEGES ON TABLE public\."User" FROM anon, authenticated, PUBLIC/);
  assert.doesNotMatch(allowlist, /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)\b/i);
});

test("expense name history grants allowlisted reads only and writes through its verified RPC", () => {
  assert.match(nameHistory, /ALTER TABLE public\."ExpenseItemNameHistory" ENABLE ROW LEVEL SECURITY/);
  assert.match(nameHistory, /REVOKE ALL PRIVILEGES ON TABLE public\."ExpenseItemNameHistory" FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(nameHistory, /CREATE POLICY expense_item_name_history_allowlisted_read[\s\S]*FOR SELECT TO authenticated USING \(public\.current_app_role\(\) IS NOT NULL\)/);
  assert.match(nameHistory, /REVOKE ALL PRIVILEGES ON FUNCTION public\.rename_monthly_expense_item\(integer,integer,text,text\) FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(nameHistory, /GRANT EXECUTE ON FUNCTION public\.rename_monthly_expense_item\(integer,integer,text,text\) TO authenticated/);
  assert.doesNotMatch(nameHistory, /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)\s+ON TABLE public\."ExpenseItemNameHistory"/i);
});
