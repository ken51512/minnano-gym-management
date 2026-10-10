import { expenseItemNameLength } from "./expense-item-core.ts";
export type MonthlyMutationBody = {
  period: { year: number; month: number };
  change?: unknown;
  action?: "create_month" | "finalize" | "unlock" | "register_expense_item" | "register_expense_item_with_amount" | "expense_item_amount" | "rename_expense_item";
  reason?: string;
  categoryId?: string;
  name?: string;
  itemId?: string;
  amount?: number | null;
};

export type PendingMonthlyRequest = {
  actorId: string;
  requestId: string;
  body: MonthlyMutationBody;
};

export const PENDING_MONTHLY_REQUEST_KEY = "minnano.pending-monthly-request.v1";

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPendingMonthlyRequest(
  actorId: string,
  body: MonthlyMutationBody,
  createId: () => string = () => globalThis.crypto.randomUUID(),
): PendingMonthlyRequest {
  if (typeof actorId !== "string" || !actorId || actorId.length > 200) throw new Error("Invalid monthly request actor");
  const requestId = createId();
  if (!requestIdPattern.test(requestId)) throw new Error("Invalid monthly request ID");
  return { actorId, requestId: requestId.toLowerCase(), body };
}

export function isPendingMonthlyRequest(value: unknown): value is PendingMonthlyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).length !== 3 || typeof request.actorId !== "string" || !request.actorId || request.actorId.length > 200 ||
      typeof request.requestId !== "string" || !requestIdPattern.test(request.requestId)) return false;
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return false;
  const body = request.body as Record<string, unknown>;
  if (!body.period || typeof body.period !== "object" || Array.isArray(body.period)) return false;
  const period = body.period as Record<string, unknown>;
  if (!Number.isInteger(period.year) || !Number.isInteger(period.month)) return false;
  const hasChange = Object.hasOwn(body, "change");
  const hasCreateMonth = body.action === "create_month" && Object.keys(body).length === 2;
  const hasRegistration = body.action === "register_expense_item" && Object.keys(body).length === 4 &&
    ["period", "action", "categoryId", "name"].every((key) => Object.hasOwn(body, key)) &&
    typeof body.categoryId === "string" && body.categoryId.length > 0 && body.categoryId.length <= 200 &&
    typeof body.name === "string" && body.name.trim().length > 0 && expenseItemNameLength(body.name.trim()) <= 200;
  const hasRegistrationWithAmount = body.action === "register_expense_item_with_amount" && Object.keys(body).length === 5 &&
    ["period", "action", "categoryId", "name", "amount"].every((key) => Object.hasOwn(body, key)) &&
    typeof body.categoryId === "string" && body.categoryId.length > 0 && body.categoryId.length <= 200 &&
    typeof body.name === "string" && body.name.trim().length > 0 && expenseItemNameLength(body.name.trim()) <= 200 &&
    (body.amount === null || (Number.isInteger(body.amount) && (body.amount as number) >= -2147483648 && (body.amount as number) <= 2147483647));
  const hasItemAmount = body.action === "expense_item_amount" && Object.keys(body).length === 4 &&
    ["period", "action", "itemId", "amount"].every((key) => Object.hasOwn(body, key)) &&
    typeof body.itemId === "string" && body.itemId.length > 0 && body.itemId.length <= 200 &&
    Number.isInteger(body.amount) && (body.amount as number) >= -2147483648 && (body.amount as number) <= 2147483647;
  const hasItemRename = body.action === "rename_expense_item" && Object.keys(body).length === 4 &&
    ["period", "action", "itemId", "name"].every((key) => Object.hasOwn(body, key)) &&
    typeof body.itemId === "string" && body.itemId.length > 0 && body.itemId.length <= 200 &&
    typeof body.name === "string" && body.name.trim().length > 0 && expenseItemNameLength(body.name.trim()) <= 200;
  const hasFinalize = body.action === "finalize" && Object.keys(body).length === 2;
  const hasUnlock = body.action === "unlock" && typeof body.reason === "string" && Object.keys(body).length === 3;
  return hasChange ? Object.keys(body).length === 2 : hasCreateMonth || hasRegistration || hasRegistrationWithAmount || hasItemAmount || hasItemRename || hasFinalize || hasUnlock;
}

export function pendingMonthlyRequestBelongsToActor(request: PendingMonthlyRequest, actorId: string | null): boolean {
  return typeof actorId === "string" && actorId.length > 0 && request.actorId === actorId;
}

export function readPendingMonthlyRequest(storage: Pick<Storage, "getItem">): PendingMonthlyRequest | null {
  try {
    const raw = storage.getItem(PENDING_MONTHLY_REQUEST_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPendingMonthlyRequest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
