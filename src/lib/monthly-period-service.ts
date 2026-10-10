import { MonthlyOperationError, type MonthPeriod, type MonthlyActor } from "./monthly-service-core.ts";

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-side role gate; the database RPC independently verifies the Auth identity and role. */
export function createMonthlyPeriodService(deps: {
  currentUser(): Promise<MonthlyActor>;
  createPeriod(period: MonthPeriod, requestId: string): Promise<void>;
}) {
  return {
    async create(period: MonthPeriod, requestId: string): Promise<void> {
      if (!Number.isInteger(period.year) || period.year < 1 || !Number.isInteger(period.month) || period.month < 1 || period.month > 12) {
        throw new MonthlyOperationError("INVALID_PERIOD");
      }
      if (!requestIdPattern.test(requestId)) throw new Error("Monthly request ID required");
      const actor = await deps.currentUser();
      if (actor.role !== "ALBA_ADMIN") throw new MonthlyOperationError("UNAUTHORIZED");
      await deps.createPeriod(period, requestId);
    },
  };
}
