import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMonthlyPeriodService } from "./monthly-period-service.ts";
import { MonthlyOperationError } from "./monthly-service-core.ts";
import { ROLES } from "./roles.ts";

const period = { year: 2026, month: 10 };
const requestId = "8a44d805-8ee6-41df-a1f4-8a74aebec6d2";

test("only verified ALBA_ADMIN service actors can invoke blank-month creation", async () => {
  const calls: Array<{ period: typeof period; requestId: string }> = [];
  const service = createMonthlyPeriodService({
    currentUser: async () => ({ id: "alba-user", role: ROLES.ALBA_ADMIN }),
    async createPeriod(receivedPeriod, receivedRequestId) { calls.push({ period: receivedPeriod, requestId: receivedRequestId }); },
  });
  await service.create(period, requestId);
  assert.deepEqual(calls, [{ period, requestId }]);

  const earnes = createMonthlyPeriodService({
    currentUser: async () => ({ id: "earnes-user", role: ROLES.EARNES }),
    async createPeriod(receivedPeriod, receivedRequestId) { calls.push({ period: receivedPeriod, requestId: receivedRequestId }); },
  });
  await assert.rejects(earnes.create(period, requestId),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "UNAUTHORIZED");
  assert.equal(calls.length, 1);
});

test("creation validates year, month, and request ID before invoking the database adapter", async () => {
  let calls = 0;
  const service = createMonthlyPeriodService({
    currentUser: async () => ({ id: "alba-user", role: ROLES.ALBA_ADMIN }),
    async createPeriod() { calls += 1; },
  });
  await assert.rejects(service.create({ year: 0, month: 1 }, requestId),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "INVALID_PERIOD");
  await assert.rejects(service.create(period, "bad-id"), /Monthly request ID required/);
  assert.equal(calls, 0);
});
