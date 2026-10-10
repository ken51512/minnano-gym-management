import type { Role } from "./roles.ts";
import type { MonthlyChange, MonthPeriod } from "./monthly-service-core.ts";
import { resolveExpenseItemName } from "./expense-item-core.ts";

export type MonthlySnapshot = {
  period: MonthPeriod;
  exists: boolean;
  closed: boolean;
  revenueEntries: { id: string; description: string; amount: number }[];
  expenseEntries: { id: string; categoryId: string; categoryName: string; description: string; amount: number; expenseItemId: string | null }[];
  expenseItems: { id: string; categoryId: string; categoryName: string; name: string; expenseEntryId: string | null; amount: number | null }[];
  expenseCategories: { id: string; name: string }[];
  membershipStats: { memberCount: number | null; newMembers: number | null; cancellations: number | null } | null;
};

export type MonthlyReadResult = { data: unknown; error: unknown | null };
export type MonthlyReadPort = {
  findRecord(period: MonthPeriod): Promise<MonthlyReadResult>;
  listCategories(period?: MonthPeriod): Promise<MonthlyReadResult>;
};

export type MonthlyHttpFailureCode = "unauthenticated" | "forbidden" | "network" | "unavailable" | "error";

export type ClosingReadiness = {
  exists: boolean;
  closed: boolean;
  revenueTotal: number | null;
  expenseTotal: number | null;
  memberCount: number | null;
  newMembers: number | null;
  cancellations: number | null;
  revenueEntered: boolean;
  expensesEntered: boolean;
  memberCountEntered: boolean;
  newMembersEntered: boolean;
  cancellationsEntered: boolean;
  complete: boolean;
};

export function closingReadiness(snapshot: MonthlySnapshot | null): ClosingReadiness {
  if (!snapshot || !snapshot.exists) return {
    exists: false, closed: false, revenueTotal: null, expenseTotal: null,
    memberCount: null, newMembers: null, cancellations: null,
    revenueEntered: false, expensesEntered: false, memberCountEntered: false,
    newMembersEntered: false, cancellationsEntered: false, complete: false,
  };
  const sum = (amounts: number[]) => {
    if (!amounts.length) return null;
    const value = amounts.reduce((total, amount) => total + amount, 0);
    return Number.isSafeInteger(value) ? value : null;
  };
  const stats = snapshot.membershipStats;
  const revenueEntered = snapshot.revenueEntries.length > 0;
  const expensesEntered = snapshot.expenseEntries.length > 0;
  const memberCountEntered = stats?.memberCount !== null && stats?.memberCount !== undefined;
  const newMembersEntered = stats?.newMembers !== null && stats?.newMembers !== undefined;
  const cancellationsEntered = stats?.cancellations !== null && stats?.cancellations !== undefined;
  return {
    exists: true,
    closed: snapshot.closed,
    revenueTotal: sum(snapshot.revenueEntries.map(({ amount }) => amount)),
    expenseTotal: sum(snapshot.expenseEntries.map(({ amount }) => amount)),
    memberCount: stats?.memberCount ?? null,
    newMembers: stats?.newMembers ?? null,
    cancellations: stats?.cancellations ?? null,
    revenueEntered,
    expensesEntered,
    memberCountEntered,
    newMembersEntered,
    cancellationsEntered,
    complete: revenueEntered && expensesEntered && memberCountEntered && newMembersEntered && cancellationsEntered,
  };
}

export function parsePeriod(value: unknown): MonthPeriod | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["year", "month"])) return null;
  if (!Number.isInteger(input.year) || (input.year as number) < 1 ||
      !Number.isInteger(input.month) || (input.month as number) < 1 || (input.month as number) > 12) return null;
  return { year: input.year as number, month: input.month as number };
}

const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function validText(value: unknown, maxLength = 200): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function validAmount(value: unknown): value is number {
  return Number.isInteger(value) && Number.isFinite(value) && (value as number) >= -2147483648 && (value as number) <= 2147483647;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

export function parseMonthlyChange(value: unknown): MonthlyChange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const change = value as Record<string, unknown>;
  if (change.type === "membershipStats") {
    if (!exactKeys(change, ["type", "memberCount", "newMembers", "cancellations"])) return null;
    const values = [change.memberCount, change.newMembers, change.cancellations];
    if (values.some((item) => item !== null && (!Number.isInteger(item) || (item as number) < 0 || (item as number) > 2147483647))) return null;
    return { type: "membershipStats", memberCount: change.memberCount as number | null, newMembers: change.newMembers as number | null, cancellations: change.cancellations as number | null };
  }
  if (change.type !== "revenueEntry" && change.type !== "expenseEntry") return null;
  const type = change.type;
  if (change.operation === "create") {
    const keys = type === "revenueEntry" ? ["type", "operation", "description", "amount"] : ["type", "operation", "categoryId", "description", "amount"];
    if (!exactKeys(change, keys) || !validText(change.description) || !validAmount(change.amount)) return null;
    return type === "revenueEntry"
      ? { type, operation: "create", description: change.description.trim(), amount: change.amount }
      : validId(change.categoryId) ? { type, operation: "create", categoryId: change.categoryId, description: change.description.trim(), amount: change.amount } : null;
  }
  if (change.operation === "update") {
    if (!validId(change.id)) return null;
    const allowed = type === "revenueEntry" ? ["type", "operation", "id", "description", "amount"] : ["type", "operation", "id", "categoryId", "description", "amount"];
    if (Object.keys(change).some((key) => !allowed.includes(key)) ||
        (change.description !== undefined && !validText(change.description)) ||
        (change.amount !== undefined && !validAmount(change.amount)) ||
        (type === "expenseEntry" && change.categoryId !== undefined && !validId(change.categoryId))) return null;
    if (change.description === undefined && change.amount === undefined && (type === "revenueEntry" || change.categoryId === undefined)) return null;
    if (type === "revenueEntry") {
      return { type, operation: "update", id: change.id, ...(change.description !== undefined ? { description: change.description.trim() } : {}), ...(change.amount !== undefined ? { amount: change.amount } : {}) };
    }
    return { type, operation: "update", id: change.id, ...(typeof change.categoryId === "string" ? { categoryId: change.categoryId } : {}), ...(change.description !== undefined ? { description: change.description.trim() } : {}), ...(change.amount !== undefined ? { amount: change.amount } : {}) };
  }
  if (change.operation === "delete" && exactKeys(change, ["type", "operation", "id"]) && validId(change.id)) {
    return { type, operation: "delete", id: change.id };
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function oneRelation(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return value.length === 1 ? objectValue(value[0]) : null;
  return objectValue(value);
}

function revenueEntries(value: unknown): MonthlySnapshot["revenueEntries"] {
  if (!Array.isArray(value)) return [];
  const rows: MonthlySnapshot["revenueEntries"] = [];
  for (const raw of value) {
    const row = objectValue(raw);
    if (!row || !validId(row.id) || !validText(row.description) || !Number.isInteger(row.amount)) continue;
    rows.push({ id: row.id, description: row.description, amount: row.amount as number });
  }
  return rows;
}

function expenseEntries(value: unknown): MonthlySnapshot["expenseEntries"] {
  if (!Array.isArray(value)) return [];
  const rows: MonthlySnapshot["expenseEntries"] = [];
  for (const raw of value) {
    const row = objectValue(raw);
    if (!row || !validId(row.id) || !validText(row.description) || !Number.isInteger(row.amount) || !validId(row.categoryId)) continue;
    const category = oneRelation(row.category);
    if (category && validText(category.name)) rows.push({ id: row.id, categoryId: row.categoryId, categoryName: category.name, description: row.description, amount: row.amount as number, expenseItemId: validId(row.expenseItemId) ? row.expenseItemId : null });
  }
  return rows;
}

export async function readMonthlySnapshot(port: MonthlyReadPort, period: MonthPeriod): Promise<MonthlySnapshot> {
  const recordResult = await port.findRecord(period);
  if (recordResult.error) throw recordResult.error;
  const categoryResult = await port.listCategories(period);
  if (categoryResult.error) throw categoryResult.error;
  const record = objectValue(recordResult.data);
  const categories = Array.isArray(categoryResult.data) ? categoryResult.data.flatMap((raw) => {
    const category = objectValue(raw);
    return category && validId(category.id) && validText(category.name) ? [{ id: category.id, name: category.name }] : [];
  }) : [];
  const expenseItems = categories.flatMap((category) => {
    const rawCategory = Array.isArray(categoryResult.data) ? categoryResult.data.map(objectValue).find((item) => item?.id === category.id) : null;
    const registered = rawCategory && Array.isArray(rawCategory.expenseItems) ? rawCategory.expenseItems : [];
    return registered.flatMap((rawItem) => {
      const item = objectValue(rawItem);
      if (!item || !validId(item.id) || !validText(item.name)) return [];
      const histories = Array.isArray(item.nameHistory) ? item.nameHistory.flatMap((rawHistory) => {
        const history = objectValue(rawHistory);
        return history && validText(history.name) && Number.isInteger(history.year) && (history.year as number) >= 1 && Number.isInteger(history.month) && (history.month as number) >= 1 && (history.month as number) <= 12
          ? [{ year: history.year as number, month: history.month as number, name: history.name.trim() }]
          : [];
      }).filter((history) => history.year < period.year || (history.year === period.year && history.month <= period.month)) : [];
      const name = resolveExpenseItemName(item.name, period.year, period.month, histories);
      const entries = Array.isArray(record?.expenseEntries) ? record.expenseEntries : [];
      const entry = entries.map(objectValue).find((row) => row?.expenseItemId === item.id);
      return [{ id: item.id, categoryId: category.id, categoryName: category.name, name,
        expenseEntryId: entry && validId(entry.id) ? entry.id : null,
        amount: entry && Number.isInteger(entry.amount) ? entry.amount as number : null }];
    });
  });
  if (!record) return { period, exists: false, closed: false, revenueEntries: [], expenseEntries: [], expenseItems, expenseCategories: categories, membershipStats: null };
  const membership = oneRelation(record.membershipStats);
  const closing = objectValue(record.monthlyClosing);
  const closingRelationIsValid = record.monthlyClosing === null || (closing !== null && validId(closing.id));
  const membershipStats = membership && [membership.memberCount, membership.newMembers, membership.cancellations].every((item) => item === null || Number.isInteger(item))
    ? { memberCount: membership.memberCount as number | null, newMembers: membership.newMembers as number | null, cancellations: membership.cancellations as number | null }
    : null;
  return {
    period,
    exists: true,
    // The PostgREST read explicitly aliases this one-to-one relation. Null is
    // a confirmed open month; omitted or malformed relation data stays fail-closed.
    closed: !closingRelationIsValid || closing !== null,
    revenueEntries: revenueEntries(record.revenueEntries),
    expenseEntries: expenseEntries(record.expenseEntries),
    expenseItems,
    expenseCategories: categories,
    membershipStats,
  };
}

export function canSubmitMonthlyChange(role: Role, change: MonthlyChange): boolean {
  return change.type === "membershipStats" ? role === "EARNES" : role === "ALBA_ADMIN";
}
