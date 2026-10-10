import { canEditFinancials, canEditMembershipStats, canUnlockClosing, type Role } from "./roles.ts";
import { calculateMonthlyMetrics } from "./monthly-core.ts";

export type MonthPeriod = { year: number; month: number };

export type MonthlyChange =
  | { type: "membershipStats"; memberCount: number | null; newMembers: number | null; cancellations: number | null }
  | { type: "revenueEntry"; operation: "create"; description: string; amount: number }
  | { type: "revenueEntry"; operation: "update"; id: string; description?: string; amount?: number }
  | { type: "revenueEntry"; operation: "delete"; id: string }
  | { type: "expenseEntry"; operation: "create"; categoryId: string; description: string; amount: number }
  | { type: "expenseEntry"; operation: "update"; id: string; categoryId?: string; description?: string; amount?: number }
  | { type: "expenseEntry"; operation: "delete"; id: string };

export type AuditEntry = {
  actorId: string;
  action: "UPDATE" | "UNLOCK" | "FINALIZE";
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
};

export type MonthlyTransaction = {
  loadForClosing(period: MonthPeriod): Promise<ClosingMonthSnapshot | null>;
  /** Atomically update the record only while it has no closing row. */
  guardOpenPeriod(period: MonthPeriod, actorId: string): Promise<{ id: string }>;
  createClosing(recordId: string, closedAt: Date, actorId: string): Promise<{ id: string }>;
  applyChange(recordId: string, change: MonthlyChange): Promise<{
    entityType: string; entityId: string; before: unknown; after: unknown;
  }>;
  findClosing(period: MonthPeriod): Promise<{
    recordId: string; closedAt: Date; closedByUserId: string;
  } | null>;
  removeClosing(recordId: string, actorId: string): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;
};

export type MonthlyRepository = {
  transaction<T>(work: (tx: MonthlyTransaction) => Promise<T>): Promise<T>;
};

export type MonthlyActor = { id: string; role: Role };

export type ClosingMonthSnapshot = {
  id: string;
  year: number;
  month: number;
  revenueEntries: readonly { id: string; description: string; amount: number }[];
  expenseEntries: readonly { id: string; categoryId: string; description: string; amount: number }[];
  membershipStats: {
    memberCount: number | null;
    newMembers: number | null;
    cancellations: number | null;
  } | null;
  closing: { id: string; closedAt: Date; closedByUserId: string } | null;
};

export class MonthlyOperationError extends Error {
  readonly code: "INVALID_PERIOD" | "NOT_FOUND" | "CLOSED" | "UNAUTHORIZED" | "INVALID_REASON" | "INVALID_CHANGE" | "INCOMPLETE_INPUTS" | "ALREADY_EXISTS";

  constructor(code: "INVALID_PERIOD" | "NOT_FOUND" | "CLOSED" | "UNAUTHORIZED" | "INVALID_REASON" | "INVALID_CHANGE" | "INCOMPLETE_INPUTS" | "ALREADY_EXISTS") {
    super(code);
    this.name = "MonthlyOperationError";
    this.code = code;
  }
}

function validatePeriod(period: MonthPeriod): void {
  if (!Number.isInteger(period.year) || period.year < 1 || !Number.isInteger(period.month) || period.month < 1 || period.month > 12) {
    throw new MonthlyOperationError("INVALID_PERIOD");
  }
}

function assertChangeAllowed(role: Role, change: MonthlyChange): void {
  const allowed = change.type === "membershipStats"
    ? canEditMembershipStats(role)
    : canEditFinancials(role);
  if (!allowed) throw new MonthlyOperationError("UNAUTHORIZED");
  const amount = change.type === "membershipStats" || change.operation === "delete"
    ? null
    : change.amount;
  if (amount !== null && amount !== undefined && (!Number.isInteger(amount) || !Number.isFinite(amount))) {
    throw new MonthlyOperationError("INVALID_CHANGE");
  }
  if (change.type === "membershipStats" &&
      [change.memberCount, change.newMembers, change.cancellations].some((value) => value !== null && (!Number.isInteger(value) || value < 0))) {
    throw new MonthlyOperationError("INVALID_CHANGE");
  }
  if ((change.type === "revenueEntry" || change.type === "expenseEntry") &&
      change.operation === "update" && change.description === undefined &&
      change.amount === undefined && (change.type === "revenueEntry" || change.categoryId === undefined)) {
    throw new MonthlyOperationError("INVALID_CHANGE");
  }
}

export function createMonthlyService(deps: {
  currentUser(): Promise<MonthlyActor>;
  repository?: MonthlyRepository;
  /** Optional atomic update implementation used by trusted database RPC adapters. */
  editChange?(period: MonthPeriod, change: MonthlyChange, requestId?: string): Promise<void>;
  /** Optional atomic finalization implementation used by trusted database RPC adapters. */
  finalizePeriod?(period: MonthPeriod, requestId?: string): Promise<void>;
  /** Optional atomic unlock implementation used by trusted database RPC adapters. */
  unlockPeriod?(period: MonthPeriod, reason: string, requestId?: string): Promise<void>;
  now?(): Date;
}) {
  const now = deps.now ?? (() => new Date());

  return {
    async finalize(period: MonthPeriod, requestId?: string): Promise<void> {
      validatePeriod(period);
      const actor = await deps.currentUser();
      if (actor.role !== "ALBA_ADMIN") throw new MonthlyOperationError("UNAUTHORIZED");
      if (deps.finalizePeriod) {
        await deps.finalizePeriod(period, requestId);
        return;
      }
      if (!deps.repository) throw new Error("Monthly repository is not configured");
      await deps.repository.transaction(async (tx) => {
        const stored = await tx.loadForClosing(period);
        if (!stored || stored.year !== period.year || stored.month !== period.month) {
          throw new MonthlyOperationError("NOT_FOUND");
        }
        if (stored.closing) throw new MonthlyOperationError("CLOSED");

        const revenueTotal = stored.revenueEntries.length === 0
          ? null
          : stored.revenueEntries.reduce((total, entry) => total + entry.amount, 0);
        const expenseTotal = stored.expenseEntries.length === 0
          ? null
          : stored.expenseEntries.reduce((total, entry) => total + entry.amount, 0);
        const membershipStats = stored.membershipStats;
        assertPersistedClosingInputs(actor.role, {
          revenueEntryCount: stored.revenueEntries.length,
          revenueTotal,
          expenseEntryCount: stored.expenseEntries.length,
          expenseTotal,
          memberCountAtPreviousMonthEnd: membershipStats?.memberCount ?? null,
          newMembers: membershipStats?.newMembers ?? null,
          cancellations: membershipStats?.cancellations ?? null,
        });

        const guardedRecord = await tx.guardOpenPeriod(period, actor.id);
        if (guardedRecord.id !== stored.id) throw new MonthlyOperationError("NOT_FOUND");
        const closedAt = now();
        const closing = await tx.createClosing(stored.id, closedAt, actor.id);
        const metrics = calculateMonthlyMetrics({
          revenueAmounts: stored.revenueEntries.map((entry) => entry.amount),
          expenseAmounts: stored.expenseEntries.map((entry) => entry.amount),
          memberCountAtPreviousMonthEnd: membershipStats?.memberCount as number,
        });
        await tx.appendAudit({
          actorId: actor.id,
          action: "FINALIZE",
          entityType: "MonthlyClosing",
          entityId: closing.id,
          before: null,
          after: {
            period: { year: stored.year, month: stored.month },
            closedAt,
            closedByUserId: actor.id,
            revenueEntries: stored.revenueEntries,
            revenueTotal,
            expenseEntries: stored.expenseEntries,
            expenseTotal,
            membershipStats,
            metrics,
          },
          createdAt: closedAt,
        });
      });
    },

    async edit(period: MonthPeriod, change: MonthlyChange, requestId?: string): Promise<void> {
      validatePeriod(period);
      const actor = await deps.currentUser();
      assertChangeAllowed(actor.role, change);
      if (deps.editChange) {
        await deps.editChange(period, change, requestId);
        return;
      }
      if (!deps.repository) throw new Error("Monthly repository is not configured");
      await deps.repository.transaction(async (tx) => {
        const record = await tx.guardOpenPeriod(period, actor.id);
        const diff = await tx.applyChange(record.id, change);
        await tx.appendAudit({
          actorId: actor.id,
          action: "UPDATE",
          ...diff,
          before: diff.before,
          after: diff.after,
          createdAt: now(),
        });
      });
    },

    async unlock(period: MonthPeriod, reason: string, requestId?: string): Promise<void> {
      validatePeriod(period);
      const actor = await deps.currentUser();
      if (!canUnlockClosing(actor.role)) throw new MonthlyOperationError("UNAUTHORIZED");
      const trimmedReason = reason.trim();
      if (!trimmedReason) throw new MonthlyOperationError("INVALID_REASON");
      if (deps.unlockPeriod) {
        await deps.unlockPeriod(period, trimmedReason, requestId);
        return;
      }
      if (!deps.repository) throw new Error("Monthly repository is not configured");
      await deps.repository.transaction(async (tx) => {
        const closing = await tx.findClosing(period);
        if (!closing) throw new MonthlyOperationError("NOT_FOUND");
        await tx.removeClosing(closing.recordId, actor.id);
        await tx.appendAudit({
          actorId: actor.id,
          action: "UNLOCK",
          entityType: "MonthlyClosing",
          entityId: closing.recordId,
          before: { closedAt: closing.closedAt, closedByUserId: closing.closedByUserId },
          after: { closed: false, reason: trimmedReason },
          createdAt: now(),
        });
      });
    },
  };
}

/** Values/counts here must be assembled from persisted rows inside a trusted transaction. */
export type PersistedClosingInputs = {
  revenueEntryCount: number;
  revenueTotal: number | null;
  expenseEntryCount: number;
  expenseTotal: number | null;
  memberCountAtPreviousMonthEnd: number | null;
  newMembers: number | null;
  cancellations: number | null;
};

/** Policy-only validation. This is not a closing operation and accepts no client-supplied readiness flags. */
export function assertPersistedClosingInputs(role: Role, inputs: PersistedClosingInputs): void {
  if (role !== "ALBA_ADMIN") throw new MonthlyOperationError("UNAUTHORIZED");
  const validAmount = (value: number | null) => value !== null && Number.isInteger(value) && Number.isFinite(value);
  const validCount = (value: number | null) => value !== null && Number.isInteger(value) && value >= 0;
  if (!Number.isInteger(inputs.revenueEntryCount) || inputs.revenueEntryCount < 1 ||
      !validAmount(inputs.revenueTotal) ||
      !Number.isInteger(inputs.expenseEntryCount) || inputs.expenseEntryCount < 1 ||
      !validAmount(inputs.expenseTotal) ||
      !validCount(inputs.memberCountAtPreviousMonthEnd) ||
      !validCount(inputs.newMembers) ||
      !validCount(inputs.cancellations)) {
    throw new MonthlyOperationError("INCOMPLETE_INPUTS");
  }
}
