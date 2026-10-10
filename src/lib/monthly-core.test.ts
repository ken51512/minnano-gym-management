import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  calculateAlbaReward,
  calculateMonthlyMetrics,
  canEditMonthlyRecord,
  canFinalizeMonth,
  canUnlockMonthlyRecord,
  formatPercent,
  InvalidMemberCountError,
  priorComparisonState,
} from "./monthly-core.ts";
import type { MonthlyInputs } from "./monthly-core.ts";
import { ROLES } from "./roles.ts";

test("ALBA reward thresholds are correct at 59, 60, and 61 prior-month-end members", () => {
  assert.equal(calculateAlbaReward(59), 100_000);
  assert.equal(calculateAlbaReward(60), 100_000);
  assert.equal(calculateAlbaReward(61), 105_000);
});

test("zero is a valid member count", () => {
  assert.equal(calculateAlbaReward(0), 100_000);
  assert.equal(calculateMonthlyMetrics({
    revenueAmounts: null,
    expenseAmounts: null,
    memberCountAtPreviousMonthEnd: 0,
  }).albaReward, 100_000);
});

test("missing or invalid member counts are rejected at both calculation boundaries", () => {
  const invalidValues: unknown[] = [
    null, undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY, "61", "",
  ];

  for (const value of invalidValues) {
    assert.throws(
      () => calculateAlbaReward(value as number),
      InvalidMemberCountError,
    );
    assert.throws(
      () => calculateMonthlyMetrics({
        revenueAmounts: null,
        expenseAmounts: null,
        memberCountAtPreviousMonthEnd: value,
      } as MonthlyInputs),
      InvalidMemberCountError,
    );
  }
});

test("sums refunds and expense reversals as negative entries", () => {
  const result = calculateMonthlyMetrics({
    revenueAmounts: [100, -25],
    expenseAmounts: [40, -10],
    memberCountAtPreviousMonthEnd: 59,
  });
  assert.equal(result.revenue, 75);
  assert.equal(result.expenses, 30);
  assert.equal(result.grossProfit, 45);
  assert.equal(result.albaReward, 100_000);
  assert.equal(result.earnesReward, -99_955);
});

test("negative gross profit and negative EarneS reward are preserved", () => {
  const result = calculateMonthlyMetrics({
    revenueAmounts: [10],
    expenseAmounts: [30],
    memberCountAtPreviousMonthEnd: 59,
  });
  assert.equal(result.grossProfit, -20);
  assert.equal(result.earnesReward, -100_020);
});

test("unentered totals remain null and are not confused with explicit zero", () => {
  const missing = calculateMonthlyMetrics({
    revenueAmounts: null,
    expenseAmounts: undefined,
    memberCountAtPreviousMonthEnd: 0,
  });
  const zero = calculateMonthlyMetrics({
    revenueAmounts: [0],
    expenseAmounts: [],
    memberCountAtPreviousMonthEnd: 0,
  });
  assert.equal(missing.revenue, null);
  assert.equal(missing.expenses, null);
  assert.equal(missing.grossProfit, null);
  assert.equal(missing.albaReward, 100_000);
  assert.equal(missing.earnesReward, null);
  assert.equal(zero.revenue, 0);
  assert.equal(zero.expenses, 0);
  assert.equal(zero.grossProfit, 0);
});

test("an unentered line prevents silently summing it as zero", () => {
  const result = calculateMonthlyMetrics({
    revenueAmounts: [100, null],
    expenseAmounts: [0],
    memberCountAtPreviousMonthEnd: 60,
  });
  assert.equal(result.revenue, null);
  assert.equal(result.grossProfit, null);
});

test("rates are percentages and a zero or missing revenue denominator is uncalculated", () => {
  const normal = calculateMonthlyMetrics({
    revenueAmounts: [200],
    expenseAmounts: [50],
    memberCountAtPreviousMonthEnd: 60,
  });
  const zero = calculateMonthlyMetrics({
    revenueAmounts: [0],
    expenseAmounts: [0],
    memberCountAtPreviousMonthEnd: 60,
  });
  assert.equal(normal.grossProfitRate, 75);
  assert.equal(normal.earnesRate, -49_925);
  assert.equal(zero.grossProfitRate, null);
  assert.equal(zero.earnesRate, null);
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(undefined), "—");
});

test("zero/missing prior value displays a placeholder; nonzero comparison stays blocked", () => {
  assert.deepEqual(priorComparisonState(0), { status: "placeholder", display: "—" });
  assert.deepEqual(priorComparisonState(null), { status: "placeholder", display: "—" });
  assert.deepEqual(priorComparisonState(10), { status: "blocked", display: null });
});

test("month finalization requires a supplied nonempty checklist with every item entered", () => {
  assert.equal(canFinalizeMonth(undefined), false);
  assert.equal(canFinalizeMonth(null), false);
  assert.equal(canFinalizeMonth([]), false);
  assert.equal(canFinalizeMonth([true, false]), false);
  assert.equal(canFinalizeMonth([true, true]), true);
});

test("ordinary edits are rejected after closing", () => {
  assert.equal(canEditMonthlyRecord(false), true);
  assert.equal(canEditMonthlyRecord(true), false);
});

test("only ALBA_ADMIN can unlock a closing, and a nonblank reason is required", () => {
  assert.equal(canUnlockMonthlyRecord(ROLES.ALBA_ADMIN, "Correction"), true);
  assert.equal(canUnlockMonthlyRecord(ROLES.EARNES, "Correction"), false);
  assert.equal(canUnlockMonthlyRecord(ROLES.ALBA_ADMIN, ""), false);
  assert.equal(canUnlockMonthlyRecord(ROLES.ALBA_ADMIN, "   "), false);
  assert.equal(canUnlockMonthlyRecord(ROLES.EARNES, null), false);
});
