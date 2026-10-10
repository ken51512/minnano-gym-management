-- Local Supabase schema/RLS preparation only. Review existing schema, policies and grants first.
-- Run before 20261006000000_user_allowlist_self_read.sql.
BEGIN;

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY (ARRAY[
        'User', 'MonthlyRecord', 'RevenueEntry', 'ExpenseEntry', 'ExpenseCategory',
        'MembershipStats', 'MonthlyClosing', 'AuditLog'
      ])
  ) THEN
    RAISE EXCEPTION 'Existing RLS policies found on protected tables; review them before applying this migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'User'
      AND c.relkind = 'r'
      AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'public."User" has FORCE ROW LEVEL SECURITY; review function ownership before applying this migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = ANY (ARRAY[
        'User', 'MonthlyRecord', 'RevenueEntry', 'ExpenseEntry', 'ExpenseCategory',
        'MembershipStats', 'MonthlyClosing', 'AuditLog'
      ])
      AND (
        grantee IN ('anon', 'PUBLIC')
        OR (grantee = 'authenticated' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'))
      )
  ) OR EXISTS (
    SELECT 1
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = ANY (ARRAY[
        'User', 'MonthlyRecord', 'RevenueEntry', 'ExpenseEntry', 'ExpenseCategory',
        'MembershipStats', 'MonthlyClosing', 'AuditLog'
      ])
      AND (
        grantee IN ('anon', 'PUBLIC')
        OR (grantee = 'authenticated' AND privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES'))
      )
  ) THEN
    RAISE EXCEPTION 'Broad existing grants found on protected tables; review them before applying this migration';
  END IF;
END
$preflight$;

DO $role_type$
DECLARE
  existing_labels text[];
BEGIN
  IF to_regtype('public."Role"') IS NULL THEN
    CREATE TYPE public."Role" AS ENUM ('ALBA_ADMIN', 'EARNES');
  ELSE
    SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
      INTO existing_labels
      FROM pg_catalog.pg_enum AS e
      JOIN pg_catalog.pg_type AS t ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = 'Role';
    IF existing_labels IS DISTINCT FROM ARRAY['ALBA_ADMIN', 'EARNES']::text[] THEN
      RAISE EXCEPTION 'Existing public.Role enum differs from the Prisma schema; review it before applying this migration';
    END IF;
  END IF;
END
$role_type$;

CREATE TABLE IF NOT EXISTS public."User" (
  "id" TEXT NOT NULL,
  "supabaseUserId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "role" public."Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "User_supabaseUserId_key" UNIQUE ("supabaseUserId"),
  CONSTRAINT "User_email_key" UNIQUE ("email")
);

CREATE TABLE IF NOT EXISTS public."MonthlyRecord" (
  "id" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "month" INTEGER NOT NULL,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonthlyRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonthlyRecord_year_month_key" UNIQUE ("year", "month"),
  CONSTRAINT "MonthlyRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MonthlyRecord_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES public."User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS public."RevenueEntry" (
  "id" TEXT NOT NULL,
  "monthlyRecordId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevenueEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RevenueEntry_monthlyRecordId_fkey" FOREIGN KEY ("monthlyRecordId") REFERENCES public."MonthlyRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS public."ExpenseCategory" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExpenseCategory_name_key" UNIQUE ("name")
);

CREATE TABLE IF NOT EXISTS public."ExpenseEntry" (
  "id" TEXT NOT NULL,
  "monthlyRecordId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExpenseEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExpenseEntry_monthlyRecordId_fkey" FOREIGN KEY ("monthlyRecordId") REFERENCES public."MonthlyRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ExpenseEntry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES public."ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS public."MembershipStats" (
  "id" TEXT NOT NULL,
  "monthlyRecordId" TEXT NOT NULL,
  "memberCount" INTEGER,
  "newMembers" INTEGER,
  "cancellations" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MembershipStats_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipStats_monthlyRecordId_key" UNIQUE ("monthlyRecordId"),
  CONSTRAINT "MembershipStats_monthlyRecordId_fkey" FOREIGN KEY ("monthlyRecordId") REFERENCES public."MonthlyRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS public."MonthlyClosing" (
  "id" TEXT NOT NULL,
  "monthlyRecordId" TEXT NOT NULL,
  "closedAt" TIMESTAMP(3) NOT NULL,
  "closedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonthlyClosing_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MonthlyClosing_monthlyRecordId_key" UNIQUE ("monthlyRecordId"),
  CONSTRAINT "MonthlyClosing_monthlyRecordId_fkey" FOREIGN KEY ("monthlyRecordId") REFERENCES public."MonthlyRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS public."AuditLog" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "beforeJson" TEXT,
  "afterJson" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RevenueEntry_monthlyRecordId_idx" ON public."RevenueEntry"("monthlyRecordId");
CREATE INDEX IF NOT EXISTS "ExpenseEntry_monthlyRecordId_idx" ON public."ExpenseEntry"("monthlyRecordId");
CREATE INDEX IF NOT EXISTS "AuditLog_entityType_entityId_idx" ON public."AuditLog"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "AuditLog_userId_createdAt_idx" ON public."AuditLog"("userId", "createdAt");

CREATE FUNCTION public.current_app_role()
RETURNS public."Role"
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $current_app_role$
  SELECT u."role"
  FROM public."User" AS u
  WHERE u."supabaseUserId" = (SELECT auth.uid()::text)
  LIMIT 1
$current_app_role$;

DO $role_function_owner$
DECLARE
  user_table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)
    INTO user_table_owner
    FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public."User"'::regclass;
  EXECUTE format('ALTER FUNCTION public.current_app_role() OWNER TO %I', user_table_owner);
END
$role_function_owner$;

REVOKE ALL PRIVILEGES ON FUNCTION public.current_app_role() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated;
GRANT USAGE ON TYPE public."Role" TO authenticated;

ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MonthlyRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RevenueEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ExpenseEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ExpenseCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MembershipStats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MonthlyClosing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AuditLog" ENABLE ROW LEVEL SECURITY;

DO $revoke_client_access$
DECLARE
  target_table regclass;
  target_column record;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'public."User"'::regclass,
    'public."MonthlyRecord"'::regclass,
    'public."RevenueEntry"'::regclass,
    'public."ExpenseEntry"'::regclass,
    'public."ExpenseCategory"'::regclass,
    'public."MembershipStats"'::regclass,
    'public."MonthlyClosing"'::regclass,
    'public."AuditLog"'::regclass
  ] LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM anon, authenticated, PUBLIC', target_table);
    FOR target_column IN
      SELECT a.attname
      FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = target_table AND a.attnum > 0 AND NOT a.attisdropped
    LOOP
      EXECUTE format('REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM anon, authenticated, PUBLIC', target_column.attname, target_table);
    END LOOP;
  END LOOP;
END
$revoke_client_access$;

GRANT SELECT ON TABLE public."MonthlyRecord", public."RevenueEntry", public."ExpenseEntry",
  public."ExpenseCategory", public."MembershipStats", public."MonthlyClosing", public."AuditLog"
  TO authenticated;

CREATE POLICY monthly_record_allowlisted_read ON public."MonthlyRecord"
  FOR SELECT TO authenticated USING (public.current_app_role() IS NOT NULL);
CREATE POLICY revenue_entry_allowlisted_read ON public."RevenueEntry"
  FOR SELECT TO authenticated USING (public.current_app_role() IS NOT NULL);
CREATE POLICY expense_entry_allowlisted_read ON public."ExpenseEntry"
  FOR SELECT TO authenticated USING (public.current_app_role() IS NOT NULL);
CREATE POLICY expense_category_allowlisted_read ON public."ExpenseCategory"
  FOR SELECT TO authenticated USING (public.current_app_role() IS NOT NULL);
CREATE POLICY membership_stats_allowlisted_read ON public."MembershipStats"
  FOR SELECT TO authenticated USING (public.current_app_role() IS NOT NULL);
CREATE POLICY monthly_closing_allowlisted_read ON public."MonthlyClosing"
  FOR SELECT TO authenticated USING (public.current_app_role() IS NOT NULL);
CREATE POLICY audit_log_allowlisted_read ON public."AuditLog"
  FOR SELECT TO authenticated USING (public.current_app_role() IS NOT NULL);

COMMIT;
