import assert from "node:assert/strict";
import test from "node:test";
import { averageExpense, averageMemberUnitPrice, calculateSimulation } from "./simulator-core.ts";

const months = [
  { year: 2026, month: 1, memberCount: 60, revenueAmounts: [600000], expenseAmounts: [200000] },
  { year: 2026, month: 2, memberCount: 70, revenueAmounts: [700000], expenseAmounts: [0] },
];

test("simulation averages entered months and keeps explicit zero expenses", () => {
  assert.equal(averageMemberUnitPrice(months), 10000);
  assert.equal(averageExpense(months), 100000);
});

test("simulation returns no result when either baseline is unavailable", () => {
  assert.equal(calculateSimulation(60, [{ ...months[0], expenseAmounts: [] }]), null);
});

test("simulation applies the confirmed ALBA and EarneS formulas", () => {
  const result = calculateSimulation(70, months, months[0]);
  assert.equal(result?.revenue, 700000);
  assert.equal(result?.expense, 100000);
  assert.equal(result?.grossProfit, 600000);
  assert.equal(result?.albaReward, 150000);
  assert.equal(result?.earnesReward, 450000);
  assert.equal(result?.memberDifference, 10);
});
