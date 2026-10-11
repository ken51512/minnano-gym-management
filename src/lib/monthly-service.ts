import "server-only";

import { requireUser } from "./auth.ts";
import { createAuthenticatedMonthlyRpc } from "./monthly-rpc-transport.ts";
import {
  callMonthlyChangeRpc,
  callMonthlyCreateRpc,
  callMonthlyRegisterExpenseItemRpc,
  callMonthlyRegisterExpenseItemWithAmountRpc,
  callMonthlySetExpenseItemAmountRpc,
  callMonthlyRenameExpenseItemRpc,
  callMonthlyRetireExpenseItemRpc,
  callMonthlyFinalizeRpc,
  callMonthlyUnlockRpc,
  type MonthlyRpcCall,
} from "./monthly-rpc-core.ts";
import {
  createMonthlyService,
  type MonthlyChange,
  type MonthPeriod,
} from "./monthly-service-core.ts";
import { createMonthlyPeriodService } from "./monthly-period-service.ts";
import { createExpenseItemService } from "./expense-item-service-core.ts";

const service = createMonthlyService({
  currentUser: requireUser,
  async editChange(period, change, requestId) {
    if (!requestId) throw new Error("Monthly request ID required");
    await callMonthlyChangeRpc(createAuthenticatedMonthlyRpc(requestId), period, change, requestId);
  },
  async finalizePeriod(period, requestId) {
    if (!requestId) throw new Error("Monthly request ID required");
    await callMonthlyFinalizeRpc(createAuthenticatedMonthlyRpc(requestId), period, requestId);
  },
  async unlockPeriod(period, reason, requestId) {
    if (!requestId) throw new Error("Monthly request ID required");
    await callMonthlyUnlockRpc(createAuthenticatedMonthlyRpc(requestId), period, reason, requestId);
  },
});

const periodService = createMonthlyPeriodService({
  currentUser: requireUser,
  async createPeriod(period, requestId) {
    await callMonthlyCreateRpc(createAuthenticatedMonthlyRpc(requestId), period, requestId);
  },
});

/** Create a blank month after server role validation; DB RPC rechecks identity and ALBA_ADMIN. */
export function createMonthlyRecord(period: MonthPeriod, requestId: string): Promise<void> {
  return periodService.create(period, requestId);
}

/** Server-only write boundary. Identity and role are also independently checked by the database RPC. */
export function editMonthlyRecord(period: MonthPeriod, change: MonthlyChange, requestId: string): Promise<void> {
  return service.edit(period, change, requestId);
}

/** Server-only finalization boundary; the RPC loads and validates persisted inputs under the month lock. */
export function finalizeMonthlyRecord(period: MonthPeriod, requestId: string): Promise<void> {
  return service.finalize(period, requestId);
}

/** Server-only unlock boundary; ALBA_ADMIN and a nonblank reason are enforced in service and RPC. */
export function unlockMonthlyRecord(period: MonthPeriod, reason: string, requestId: string): Promise<void> {
  return service.unlock(period, reason, requestId);
}

const expenseItemService = createExpenseItemService({
  currentUser: requireUser,
  async register(period, categoryId, name, requestId) {
    await callMonthlyRegisterExpenseItemRpc(createAuthenticatedMonthlyRpc(requestId), period, categoryId, name, requestId);
  },
  async registerWithAmount(period, categoryId, name, amount, requestId) {
    await callMonthlyRegisterExpenseItemWithAmountRpc(createAuthenticatedMonthlyRpc(requestId), period, categoryId, name, amount, requestId);
  },
  async setAmount(period, itemId, amount, requestId) {
    await callMonthlySetExpenseItemAmountRpc(createAuthenticatedMonthlyRpc(requestId), period, itemId, amount, requestId);
  },
  async rename(period, itemId, name, requestId) {
    await callMonthlyRenameExpenseItemRpc(createAuthenticatedMonthlyRpc(requestId), period, itemId, name, requestId);
  },
  async retire(period, itemId, requestId) {
    await callMonthlyRetireExpenseItemRpc(createAuthenticatedMonthlyRpc(requestId), period, itemId, requestId);
  },
});

export const registerMonthlyExpenseItem = expenseItemService.register;
export const registerMonthlyExpenseItemWithAmount = expenseItemService.registerWithAmount;
export const setMonthlyExpenseItemAmount = expenseItemService.setAmount;
export const renameMonthlyExpenseItem = expenseItemService.rename;
export const retireMonthlyExpenseItem = expenseItemService.retire;
