import { MonthlyOperationError, type MonthPeriod, type MonthlyChange } from "./monthly-service-core.ts";
import { classifySupabaseFailure, SafeSupabaseOperationError } from "./supabase-health-core.ts";

export type MonthlyChangeRpcArgs = {
  p_year: number;
  p_month: number;
  p_change: MonthlyChange;
};

export type MonthlyActionRpcArgs = {
  p_year: number;
  p_month: number;
  p_reason?: string;
};

export type ExpenseItemRpcArgs = {
  p_year: number;
  p_month: number;
  p_category_id?: string;
  p_name?: string;
  p_item_id?: string;
  p_amount?: number | null;
};

export type MonthlyRpcCall = (
  name: string,
  args: MonthlyChangeRpcArgs | MonthlyActionRpcArgs | ExpenseItemRpcArgs,
  requestId: string,
) => Promise<{ error: unknown | null }>;

async function invokeMonthlyRpc(
  rpc: MonthlyRpcCall,
  name: string,
  args: MonthlyChangeRpcArgs | MonthlyActionRpcArgs | ExpenseItemRpcArgs,
  requestId: string,
  duplicatePeriodIsConflict = false,
  expenseItemDomainErrors = false,
): Promise<void> {
  try {
    const { error } = await rpc(name, args, requestId);
    if (error) {
      if (expenseItemDomainErrors && typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "P0001") throw new MonthlyOperationError("CLOSED");
        if (error.code === "P0002") throw new MonthlyOperationError("NOT_FOUND");
        if (error.code === "22023") throw new MonthlyOperationError("INVALID_CHANGE");
      }
      if (duplicatePeriodIsConflict && typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new MonthlyOperationError("ALREADY_EXISTS");
      }
      throw new SafeSupabaseOperationError(classifySupabaseFailure(error));
    }
  } catch (error) {
    if (error instanceof MonthlyOperationError) throw error;
    if (error instanceof SafeSupabaseOperationError) throw error;
    throw new SafeSupabaseOperationError(classifySupabaseFailure(error));
  }
}

/** Thin transport adapter; the database RPC owns authorization and transactionality. */
export async function callMonthlyChangeRpc(
  rpc: MonthlyRpcCall,
  period: MonthPeriod,
  change: MonthlyChange,
  requestId: string,
): Promise<void> {
  await invokeMonthlyRpc(rpc, "apply_monthly_change", {
    p_year: period.year,
    p_month: period.month,
    p_change: change,
  }, requestId);
}

export async function callMonthlyFinalizeRpc(
  rpc: MonthlyRpcCall,
  period: MonthPeriod,
  requestId: string,
): Promise<void> {
  await invokeMonthlyRpc(rpc, "finalize_monthly_record", {
    p_year: period.year,
    p_month: period.month,
  }, requestId);
}

export async function callMonthlyUnlockRpc(
  rpc: MonthlyRpcCall,
  period: MonthPeriod,
  reason: string,
  requestId: string,
): Promise<void> {
  await invokeMonthlyRpc(rpc, "unlock_monthly_record", {
    p_year: period.year,
    p_month: period.month,
    p_reason: reason,
  }, requestId);
}

/** Create a blank month through the database-owned ALBA_ADMIN/idempotency boundary. */
export async function callMonthlyCreateRpc(
  rpc: MonthlyRpcCall,
  period: MonthPeriod,
  requestId: string,
): Promise<void> {
  await invokeMonthlyRpc(rpc, "create_monthly_record", {
    p_year: period.year,
    p_month: period.month,
  }, requestId, true);
}

export async function callMonthlyRegisterExpenseItemRpc(rpc: MonthlyRpcCall, period: MonthPeriod, categoryId: string, name: string, requestId: string): Promise<void> {
  await invokeMonthlyRpc(rpc, "register_monthly_expense_item", {
    p_year: period.year, p_month: period.month, p_category_id: categoryId, p_name: name,
  }, requestId, false, true);
}

export async function callMonthlyRegisterExpenseItemWithAmountRpc(rpc: MonthlyRpcCall, period: MonthPeriod, categoryId: string, name: string, amount: number | null, requestId: string): Promise<void> {
  await invokeMonthlyRpc(rpc, "register_monthly_expense_item_with_amount", {
    p_year: period.year, p_month: period.month, p_category_id: categoryId, p_name: name, p_amount: amount,
  }, requestId, false, true);
}

export async function callMonthlySetExpenseItemAmountRpc(rpc: MonthlyRpcCall, period: MonthPeriod, itemId: string, amount: number, requestId: string): Promise<void> {
  await invokeMonthlyRpc(rpc, "set_monthly_expense_item_amount", {
    p_year: period.year, p_month: period.month, p_item_id: itemId, p_amount: amount,
  }, requestId, false, true);
}

export async function callMonthlyRenameExpenseItemRpc(rpc: MonthlyRpcCall, period: MonthPeriod, itemId: string, name: string, requestId: string): Promise<void> {
  await invokeMonthlyRpc(rpc, "rename_monthly_expense_item", {
    p_year: period.year, p_month: period.month, p_item_id: itemId, p_name: name,
  }, requestId, false, true);
}
