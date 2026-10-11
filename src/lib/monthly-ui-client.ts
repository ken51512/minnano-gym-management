"use client";

import { resolveSessionUser, type AllowlistedUser } from "./auth-core.ts";
import { expenseItemNameLength } from "./expense-item-core.ts";
import { createBrowserMonthlyRpc } from "./monthly-browser-rpc.ts";
import { parseMonthlyChange, parsePeriod, readMonthlySnapshot, type MonthlyReadPort } from "./monthly-query-core.ts";
import {
  callMonthlyChangeRpc,
  callMonthlyClearExpenseItemAmountRpc,
  callMonthlyCreateRpc,
  callMonthlyFinalizeRpc,
  callMonthlyRegisterExpenseItemRpc,
  callMonthlyRegisterExpenseItemWithAmountRpc,
  callMonthlyRenameExpenseItemRpc,
  callMonthlyRetireExpenseItemRpc,
  callMonthlySetExpenseItemAmountRpc,
  callMonthlyUnlockRpc,
  type MonthlyRpcCall,
} from "./monthly-rpc-core.ts";
import type { PendingMonthlyRequest } from "./monthly-request-core.ts";
import { MonthlyOperationError } from "./monthly-service-core.ts";
import { SafeSupabaseOperationError, classifySupabaseFailure } from "./supabase-health-core.ts";
import { createBrowserSupabaseClient } from "./supabase-browser.ts";
import { sumEnteredExpenseAmounts } from "./expense-total-core.ts";
import type { SimulationMonth } from "./simulator-core.ts";

export type UiRole = "ALBA_ADMIN" | "EARNES";
export type UiSession = { id: string; role: UiRole; displayName?: string };
export type UiApiBody = { status?: string; code?: string; stage?: string; user?: UiSession; snapshot?: unknown };

type BrowserClient = ReturnType<typeof createBrowserSupabaseClient>;
export type MonthlyUiDependencies = {
  client(): BrowserClient;
  rpc(requestId: string): MonthlyRpcCall;
};

const dependencies: MonthlyUiDependencies = {
  client: createBrowserSupabaseClient,
  rpc: createBrowserMonthlyRpc,
};

function jsonResponse(body: UiApiBody, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function readBody(response: Response): Promise<UiApiBody | null> {
  return response.json().catch(() => null) as Promise<UiApiBody | null>;
}

function failureResponse(error: unknown): Response {
  if (error instanceof MonthlyOperationError) {
    const status = error.code === "UNAUTHORIZED" ? 403 : error.code === "CLOSED" || error.code === "ALREADY_EXISTS" ? 409 : error.code === "NOT_FOUND" ? 404 : error.code === "INCOMPLETE_INPUTS" ? 422 : 400;
    return jsonResponse({ status: "error", code: error.code.toLowerCase() }, status);
  }
  const code = error instanceof SafeSupabaseOperationError ? error.code : classifySupabaseFailure(error);
  const status = code === "unauthenticated" ? 401 : code === "forbidden" ? 403 : code === "network" || code === "unavailable" ? 503 : 500;
  return jsonResponse({ status: "error", code: code === "network" || code === "unavailable" ? "outcome_unknown" : code }, status);
}

async function resolveBrowserSession(client: BrowserClient): Promise<UiSession> {
  const { data, error } = await client.auth.getUser();
  if (error) throw new SafeSupabaseOperationError(classifySupabaseFailure(error), "auth_session");
  if (!data.user) throw new SafeSupabaseOperationError("unauthenticated", "auth_session");
  const { data: row, error: lookupError } = await client.from("User")
    .select("id,supabaseUserId,email,displayName,role")
    .eq("supabaseUserId", data.user.id)
    .maybeSingle();
  if (lookupError) throw new SafeSupabaseOperationError(classifySupabaseFailure(lookupError), "allowlist_lookup");
  const user = resolveSessionUser({ id: data.user.id }, row as AllowlistedUser | null);
  if (!user) throw new SafeSupabaseOperationError("forbidden", "role_check");
  return { id: user.id, role: user.role, displayName: user.displayName };
}

export async function fetchVerifiedSession(deps: MonthlyUiDependencies = dependencies) {
  try {
    const user = await resolveBrowserSession(deps.client());
    const response = jsonResponse({ status: "ok", user });
    return { response, body: await readBody(response) };
  } catch (error) {
    const response = failureResponse(error);
    return { response, body: await readBody(response) };
  }
}

export function resolveVerifiedSession(response: Response, body: UiApiBody | null): UiSession {
  if (response.ok && body?.status === "ok" && typeof body.user?.id === "string" && body.user.id.length > 0 &&
      (body.user.role === "ALBA_ADMIN" || body.user.role === "EARNES")) return body.user;
  if (response.status === 401 || body?.code === "unauthenticated") throw new Error("unauthenticated");
  if (response.status === 403 || body?.code === "forbidden") throw new Error("forbidden");
  if (body?.code === "network" || response.status === 503 || !response.ok) throw new Error("unavailable");
  throw new Error("error");
}

function monthlyReadPort(client: BrowserClient): MonthlyReadPort {
  return {
    async findRecord(period) {
      const { data, error } = await client.from("MonthlyRecord")
        .select('id,year,month,revenueEntries:RevenueEntry(id,description,amount),expenseEntries:ExpenseEntry(id,expenseItemId,categoryId,description,amount,category:ExpenseCategory(name)),membershipStats:MembershipStats(memberCount,newMembers,cancellations),monthlyClosing:MonthlyClosing(id)')
        .eq("year", period.year).eq("month", period.month).maybeSingle();
      return { data, error };
    },
    async listCategories(period) {
      let query = client.from("ExpenseCategory").select("id,name,expenseItems:ExpenseItem(id,name,effectiveYear,effectiveMonth,retiredYear,retiredMonth,nameHistory:ExpenseItemNameHistory(year,month,name))").order("name");
      if (period) query = query.or(`effectiveYear.lt.${period.year},and(effectiveYear.eq.${period.year},effectiveMonth.lte.${period.month})`, { referencedTable: "ExpenseItem" });
      const { data, error } = await query;
      return { data, error };
    },
  };
}

export async function fetchMonthlySnapshot(period: string, deps: MonthlyUiDependencies = dependencies) {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error("Invalid monthly period");
  try {
    await resolveBrowserSession(deps.client());
    const snapshot = await readMonthlySnapshot(monthlyReadPort(deps.client()), { year: Number(match[1]), month: Number(match[2]) });
    const response = jsonResponse({ status: "ok", snapshot });
    return { response, body: await readBody(response) };
  } catch (error) {
    const response = failureResponse(error);
    return { response, body: await readBody(response) };
  }
}

export async function fetchSimulationHistory(): Promise<SimulationMonth[]> {
  const client = createBrowserSupabaseClient();
  await resolveBrowserSession(client);
  // Keep history independent from the selected month. Category names are
  // only needed for rate labels; all expense totals come from ExpenseEntry.
  const [{ data, error }, { data: categoryRows, error: categoryError }] = await Promise.all([
    client.from("MonthlyRecord")
      .select("year,month,revenueEntries:RevenueEntry(amount),expenseEntries:ExpenseEntry(amount,categoryId),membershipStats:MembershipStats(memberCount,newMembers,cancellations),monthlyClosing:MonthlyClosing(id)")
      .order("year", { ascending: true }).order("month", { ascending: true }),
    client.from("ExpenseCategory").select("id,name"),
  ]);
  if (error) throw error;
  if (!Array.isArray(data)) return [];
  const categoryNames = new Map<string, string>();
  if (!categoryError && Array.isArray(categoryRows)) {
    for (const raw of categoryRows) {
      if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).id === "string" && typeof (raw as Record<string, unknown>).name === "string") {
        categoryNames.set((raw as Record<string, unknown>).id as string, (raw as Record<string, unknown>).name as string);
      }
    }
  }
  const one = (value: unknown): Record<string, unknown> | null => Array.isArray(value) ? (value.length === 1 && value[0] && typeof value[0] === "object" ? value[0] as Record<string, unknown> : null) : value && typeof value === "object" ? value as Record<string, unknown> : null;
  const rows: SimulationMonth[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const stats = one(row.membershipStats);
    const closing = one(row.monthlyClosing);
    const amounts = (value: unknown) => Array.isArray(value) ? value.flatMap((item) => item && typeof item === "object" && Number.isInteger((item as Record<string, unknown>).amount) ? [(item as Record<string, unknown>).amount as number] : []) : [];
    const expenseAmounts = amounts(row.expenseEntries);
    const categoryAmounts = Array.isArray(row.expenseEntries) ? row.expenseEntries.flatMap((item) => {
      if (!item || typeof item !== "object" || !Number.isInteger((item as Record<string, unknown>).amount)) return [];
      const categoryId = (item as Record<string, unknown>).categoryId;
      const categoryName = typeof categoryId === "string" ? categoryNames.get(categoryId) : undefined;
      return categoryName ? [{ categoryName, amount: (item as Record<string, unknown>).amount as number }] : [];
    }) : [];
    if (!Number.isInteger(row.year) || !Number.isInteger(row.month)) continue;
    rows.push({ year: row.year as number, month: row.month as number, closed: closing !== null, memberCount: stats && (stats.memberCount === null || Number.isInteger(stats.memberCount)) ? stats.memberCount as number | null : null, newMembers: stats && (stats.newMembers === null || Number.isInteger(stats.newMembers)) ? stats.newMembers as number | null : null, cancellations: stats && (stats.cancellations === null || Number.isInteger(stats.cancellations)) ? stats.cancellations as number | null : null, revenueAmounts: amounts(row.revenueEntries), expenseAmounts, expenseTotal: sumEnteredExpenseAmounts(expenseAmounts), expenseCategoryAmounts: categoryAmounts });
  }
  return rows;
}

async function executeMonthlyMutation(pending: PendingMonthlyRequest, rpc: MonthlyRpcCall): Promise<void> {
  const period = parsePeriod(pending.body.period);
  if (!period) throw new MonthlyOperationError("INVALID_PERIOD");
  const body = pending.body;
  if (body.change !== undefined) {
    const change = parseMonthlyChange(body.change);
    if (!change) throw new MonthlyOperationError("INVALID_CHANGE");
    return callMonthlyChangeRpc(rpc, period, change, pending.requestId);
  }
  if (body.action === "create_month") return callMonthlyCreateRpc(rpc, period, pending.requestId);
  if (body.action === "finalize") return callMonthlyFinalizeRpc(rpc, period, pending.requestId);
  if (body.action === "unlock" && typeof body.reason === "string") return callMonthlyUnlockRpc(rpc, period, body.reason, pending.requestId);
  if (body.action === "register_expense_item" && typeof body.categoryId === "string" && typeof body.name === "string" && body.name.trim() && expenseItemNameLength(body.name.trim()) <= 200) return callMonthlyRegisterExpenseItemRpc(rpc, period, body.categoryId, body.name.trim(), pending.requestId);
  if (body.action === "register_expense_item_with_amount" && typeof body.categoryId === "string" && typeof body.name === "string" && body.name.trim() && expenseItemNameLength(body.name.trim()) <= 200 && (body.amount === null || (typeof body.amount === "number" && Number.isInteger(body.amount)))) return callMonthlyRegisterExpenseItemWithAmountRpc(rpc, period, body.categoryId, body.name.trim(), body.amount, pending.requestId);
  if (body.action === "expense_item_amount" && typeof body.itemId === "string" && typeof body.amount === "number" && Number.isInteger(body.amount)) return callMonthlySetExpenseItemAmountRpc(rpc, period, body.itemId, body.amount, pending.requestId);
  if (body.action === "clear_expense_item_amount" && typeof body.itemId === "string") return callMonthlyClearExpenseItemAmountRpc(rpc, period, body.itemId, pending.requestId);
  if (body.action === "rename_expense_item" && typeof body.itemId === "string" && typeof body.name === "string" && body.name.trim() && expenseItemNameLength(body.name.trim()) <= 200) return callMonthlyRenameExpenseItemRpc(rpc, period, body.itemId, body.name.trim(), pending.requestId);
  if (body.action === "retire_expense_item" && typeof body.itemId === "string") return callMonthlyRetireExpenseItemRpc(rpc, period, body.itemId, pending.requestId);
  throw new MonthlyOperationError("INVALID_CHANGE");
}

export async function postMonthlyMutation(pending: PendingMonthlyRequest, deps: MonthlyUiDependencies = dependencies) {
  try {
    await resolveBrowserSession(deps.client());
    await executeMonthlyMutation(pending, deps.rpc(pending.requestId));
    const response = jsonResponse({ status: "ok" });
    return { response, body: await readBody(response) };
  } catch (error) {
    const response = failureResponse(error);
    return { response, body: await readBody(response) };
  }
}

export async function signInWithBrowserPassword(email: string, password: string): Promise<{ code?: string }> {
  try {
    const { data, error } = await createBrowserSupabaseClient().auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data.user || !data.session) return { code: classifySupabaseFailure(error) };
    return {};
  } catch (error) {
    return { code: classifySupabaseFailure(error) };
  }
}

export async function signOutBrowserSession(): Promise<void> {
  await createBrowserSupabaseClient().auth.signOut({ scope: "local" });
}
