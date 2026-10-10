import { expenseItemNameLength } from "@/lib/expense-item-core";
import { NextResponse } from "next/server";
import { requireUser, AuthenticationError, AuthorizationError } from "@/lib/auth";
import { createMonthlyRecord, editMonthlyRecord, finalizeMonthlyRecord, registerMonthlyExpenseItem, registerMonthlyExpenseItemWithAmount, setMonthlyExpenseItemAmount, renameMonthlyExpenseItem, unlockMonthlyRecord } from "@/lib/monthly-service";
import { createRequestSupabaseClient } from "@/lib/supabase-server";
import { safeRouteFailure } from "@/lib/auth-route-core";
import { SafeSupabaseOperationError } from "@/lib/supabase-health-core";
import { parseMonthlyChange, parsePeriod, readMonthlySnapshot } from "@/lib/monthly-query-core";
import { MonthlyOperationError } from "@/lib/monthly-service-core";
import { isValidSameOriginPost } from "@/lib/auth-route-core";

export const dynamic = "force-dynamic";

async function getAuthorizedUser() {
  return requireUser();
}

function failureResponse(error: unknown) {
  if (error instanceof AuthenticationError) return NextResponse.json({ status: "error", code: "unauthenticated" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (error instanceof AuthorizationError) return NextResponse.json({ status: "error", code: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  if (error instanceof MonthlyOperationError) {
    const status = error.code === "UNAUTHORIZED" ? 403 : error.code === "CLOSED" || error.code === "ALREADY_EXISTS" ? 409 : error.code === "NOT_FOUND" ? 404 : error.code === "INCOMPLETE_INPUTS" ? 422 : 400;
    return NextResponse.json({ status: "error", code: error.code.toLowerCase() }, { status, headers: { "Cache-Control": "no-store" } });
  }
  if (error instanceof SafeSupabaseOperationError) {
    const status = error.code === "unauthenticated" ? 401 : error.code === "forbidden" ? 403 : error.code === "network" || error.code === "unavailable" ? 503 : 500;
    const code = error.code === "network" || error.code === "unavailable" ? "outcome_unknown" : error.code;
    return NextResponse.json({ status: "error", code }, { status, headers: { "Cache-Control": "no-store" } });
  }
  const failure = safeRouteFailure(error);
  const code = failure.code === "network" || failure.code === "unavailable" ? "outcome_unknown" : failure.code;
  return NextResponse.json({ status: "error", code }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    await getAuthorizedUser();
    const url = new URL(request.url);
    const period = parsePeriod({ year: Number(url.searchParams.get("year")), month: Number(url.searchParams.get("month")) });
    if (!period) return NextResponse.json({ status: "error", code: "invalid_period" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const supabase = createRequestSupabaseClient({ writeCookies: true });
    const snapshot = await readMonthlySnapshot({
      async findRecord(target) {
        const { data, error } = await supabase.from("MonthlyRecord")
          .select('id,year,month,revenueEntries:RevenueEntry(id,description,amount),expenseEntries:ExpenseEntry(id,expenseItemId,categoryId,description,amount,category:ExpenseCategory(name)),membershipStats:MembershipStats(memberCount,newMembers,cancellations),monthlyClosing:MonthlyClosing(id)')
          .eq("year", target.year).eq("month", target.month).maybeSingle();
        return { data, error };
      },
      async listCategories(target) {
        let query = supabase.from("ExpenseCategory").select("id,name,expenseItems:ExpenseItem(id,name,effectiveYear,effectiveMonth,nameHistory:ExpenseItemNameHistory(year,month,name))").order("name");
        if (target) query = query.or(`effectiveYear.lt.${target.year},and(effectiveYear.eq.${target.year},effectiveMonth.lte.${target.month})`, { referencedTable: "ExpenseItem" });
        const { data, error } = await query;
        return { data, error };
      },
    }, period);
    return NextResponse.json({ status: "ok", snapshot }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!isValidSameOriginPost(request)) return NextResponse.json({ status: "error", code: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    await getAuthorizedUser();
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 16384) return NextResponse.json({ status: "error", code: "invalid_request" }, { status: 413, headers: { "Cache-Control": "no-store" } });
    const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") return NextResponse.json({ status: "error", code: "invalid_request" }, { status: 415, headers: { "Cache-Control": "no-store" } });
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ status: "error", code: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ status: "error", code: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const input = body as Record<string, unknown>;
    if (!Object.hasOwn(input, "period")) return NextResponse.json({ status: "error", code: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const requestId = typeof input.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)
      ? input.requestId.toLowerCase()
      : null;
    if (!requestId) return NextResponse.json({ status: "error", code: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const period = parsePeriod(input.period);
    if (!period) return NextResponse.json({ status: "error", code: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    if (Object.keys(input).length === 3 && Object.hasOwn(input, "change")) {
      const change = parseMonthlyChange(input.change);
      if (!change) return NextResponse.json({ status: "error", code: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      await editMonthlyRecord(period, change, requestId);
    } else if (Object.keys(input).length === 3 && input.action === "finalize") {
      await finalizeMonthlyRecord(period, requestId);
    } else if (Object.keys(input).length === 3 && input.action === "create_month") {
      await createMonthlyRecord(period, requestId);
    } else if (Object.keys(input).length === 5 && input.action === "register_expense_item" && typeof input.categoryId === "string" && input.categoryId.length > 0 && input.categoryId.length <= 200 && typeof input.name === "string" && input.name.trim().length > 0 && expenseItemNameLength(input.name.trim()) <= 200) {
      await registerMonthlyExpenseItem(period, input.categoryId, input.name.trim(), requestId);
    } else if (Object.keys(input).length === 6 && input.action === "register_expense_item_with_amount" && typeof input.categoryId === "string" && input.categoryId.length > 0 && input.categoryId.length <= 200 && typeof input.name === "string" && input.name.trim().length > 0 && expenseItemNameLength(input.name.trim()) <= 200 && (input.amount === null || (typeof input.amount === "number" && Number.isInteger(input.amount) && input.amount >= -2147483648 && input.amount <= 2147483647))) {
      await registerMonthlyExpenseItemWithAmount(period, input.categoryId, input.name.trim(), input.amount as number | null, requestId);
    } else if (Object.keys(input).length === 5 && input.action === "expense_item_amount" && typeof input.itemId === "string" && input.itemId.length > 0 && input.itemId.length <= 200 && typeof input.amount === "number" && Number.isInteger(input.amount) && input.amount >= -2147483648 && input.amount <= 2147483647) {
      await setMonthlyExpenseItemAmount(period, input.itemId, input.amount, requestId);
    } else if (Object.keys(input).length === 5 && input.action === "rename_expense_item" && typeof input.itemId === "string" && input.itemId.length > 0 && input.itemId.length <= 200 && typeof input.name === "string" && input.name.trim().length > 0 && expenseItemNameLength(input.name.trim()) <= 200) {
      await renameMonthlyExpenseItem(period, input.itemId, input.name.trim(), requestId);
    } else if (Object.keys(input).length === 4 && input.action === "unlock" && Object.hasOwn(input, "reason") && typeof input.reason === "string") {
      await unlockMonthlyRecord(period, input.reason, requestId);
    } else {
      return NextResponse.json({ status: "error", code: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureResponse(error);
  }
}
