import { MonthlyOperationError, type MonthPeriod, type MonthlyActor } from "./monthly-service-core.ts";
import { expenseItemNameLength, normalizeExpenseItemName } from "./expense-item-core.ts";

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createExpenseItemService(deps: {
  currentUser(): Promise<MonthlyActor>;
  register(period: MonthPeriod, categoryId: string, name: string, requestId: string): Promise<void>;
  registerWithAmount(period: MonthPeriod, categoryId: string, name: string, amount: number | null, requestId: string): Promise<void>;
  rename(period: MonthPeriod, itemId: string, name: string, requestId: string): Promise<void>;
  retire?(period: MonthPeriod, itemId: string, requestId: string): Promise<void>;
  setAmount(period: MonthPeriod, itemId: string, amount: number, requestId: string): Promise<void>;
}) {
  async function authorize(period: MonthPeriod, requestId: string): Promise<void> {
    if (!Number.isInteger(period.year) || period.year < 1 || !Number.isInteger(period.month) || period.month < 1 || period.month > 12) throw new MonthlyOperationError("INVALID_PERIOD");
    if (!requestIdPattern.test(requestId)) throw new MonthlyOperationError("INVALID_CHANGE");
    if ((await deps.currentUser()).role !== "ALBA_ADMIN") throw new MonthlyOperationError("UNAUTHORIZED");
  }
  return {
    async register(period: MonthPeriod, categoryId: string, name: string, requestId: string): Promise<void> {
      await authorize(period, requestId);
      const normalizedName = normalizeExpenseItemName(name);
      if (!categoryId || categoryId.length > 200 || !normalizedName || expenseItemNameLength(normalizedName) > 200) throw new MonthlyOperationError("INVALID_CHANGE");
      await deps.register(period, categoryId, normalizedName, requestId);
    },
    async registerWithAmount(period: MonthPeriod, categoryId: string, name: string, amount: number | null, requestId: string): Promise<void> {
      await authorize(period, requestId);
      const normalizedName = normalizeExpenseItemName(name);
      if (!categoryId || categoryId.length > 200 || !normalizedName || expenseItemNameLength(normalizedName) > 200 ||
          (amount !== null && (!Number.isInteger(amount) || amount < -2147483648 || amount > 2147483647))) throw new MonthlyOperationError("INVALID_CHANGE");
      await deps.registerWithAmount(period, categoryId, normalizedName, amount, requestId);
    },
    async setAmount(period: MonthPeriod, itemId: string, amount: number, requestId: string): Promise<void> {
      await authorize(period, requestId);
      if (!itemId || itemId.length > 200 || !Number.isInteger(amount) || amount < -2147483648 || amount > 2147483647) throw new MonthlyOperationError("INVALID_CHANGE");
      await deps.setAmount(period, itemId, amount, requestId);
    },
    async rename(period: MonthPeriod, itemId: string, name: string, requestId: string): Promise<void> {
      await authorize(period, requestId);
      const normalizedName = normalizeExpenseItemName(name);
      if (!itemId || itemId.length > 200 || !normalizedName || expenseItemNameLength(normalizedName) > 200) throw new MonthlyOperationError("INVALID_CHANGE");
      await deps.rename(period, itemId, normalizedName, requestId);
    },
    async retire(period: MonthPeriod, itemId: string, requestId: string): Promise<void> {
      await authorize(period, requestId);
      if (!itemId || itemId.length > 200) throw new MonthlyOperationError("INVALID_CHANGE");
      if (!deps.retire) throw new MonthlyOperationError("INVALID_CHANGE");
      await deps.retire(period, itemId, requestId);
    },
  };
}
