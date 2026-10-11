import assert from "node:assert/strict";
import test from "node:test";
import { albaReward, averageExpense, averageMemberUnitPrice, calculateSimulation, monthlyMetrics } from "./simulator-core.ts";

const months = [
  { year: 2026, month: 1, memberCount: 60, revenueAmounts: [600000], expenseAmounts: [200000] },
  { year: 2026, month: 2, memberCount: 70, revenueAmounts: [700000], expenseAmounts: [0] },
];

test("simulation averages entered months and keeps explicit zero expenses", () => {
  assert.equal(averageMemberUnitPrice(months), 10000);
  assert.equal(averageExpense(months), 100000);
});

test("average expense includes every category, including rent, and matches the monthly total", () => {
  const month = {
    year: 2026,
    month: 8,
    memberCount: 60,
    revenueAmounts: [600000],
    expenseAmounts: [100000, 20000, 150000, 8800, 5000, 30000, 12000, 7000, 4000, 3000],
    expenseTotal: 339800,
    expenseCategoryAmounts: [
      { categoryName: "家賃", amount: 100000 },
      { categoryName: "手数料（スグラム）", amount: 20000 },
      { categoryName: "人件費", amount: 150000 },
      { categoryName: "Wi-Fi", amount: 8800 },
      { categoryName: "携帯", amount: 5000 },
      { categoryName: "広告費", amount: 30000 },
      { categoryName: "電気代", amount: 12000 },
      { categoryName: "水道代", amount: 7000 },
      { categoryName: "ガス代", amount: 4000 },
      { categoryName: "その他", amount: 3000 },
    ],
  };
  assert.equal(month.expenseAmounts.reduce((total, amount) => total + amount, 0), month.expenseTotal);
  assert.equal(averageExpense([month]), 339800);
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

test("ALBA reward thresholds cover the confirmed member counts", () => {
  assert.deepEqual([59, 60, 61, 65, 70, 80, 90, 100].map(albaReward), [100000, 100000, 105000, 125000, 150000, 200000, 250000, 300000]);
});

test("simulation preserves a negative EarneS reward and calculates operating margin", () => {
  const result = calculateSimulation(60, [{ year: 2026, month: 1, memberCount: 60, revenueAmounts: [50000], expenseAmounts: [200000] }]);
  assert.equal(result?.earnesReward, -250000);
  assert.equal(result?.operatingMargin, -3);
});

test("monthly metrics calculate category rates and cancellation rate", () => {
  const metrics = monthlyMetrics({ year: 2026, month: 1, memberCount: 65, cancellations: 3, revenueAmounts: [1000000], expenseAmounts: [300000], expenseCategoryAmounts: [
    { categoryName: "人件費", amount: 224000 },
    { categoryName: "広告費", amount: 68000 },
    { categoryName: "その他", amount: 8000 },
  ] });
  assert.equal(metrics.laborRate, 0.224);
  assert.equal(metrics.advertisingRate, 0.068);
  assert.equal(metrics.operatingMargin, 0.7);
  assert.equal(metrics.cancellationRate, 3 / 65);
});

test("zero revenue and zero members show unavailable rates", () => {
  const metrics = monthlyMetrics({ year: 2026, month: 1, memberCount: 0, cancellations: 0, revenueAmounts: [0], expenseAmounts: [0], expenseCategoryAmounts: [{ categoryName: "人件費", amount: 0 }] });
  assert.equal(metrics.laborRate, null);
  assert.equal(metrics.advertisingRate, null);
  assert.equal(metrics.operatingMargin, null);
  assert.equal(metrics.cancellationRate, null);
});

test("one entered month is enough and missing months stay excluded", () => {
  const oneMonth = [{ year: 2026, month: 1, memberCount: 50, revenueAmounts: [500000], expenseAmounts: [100000] }];
  const result = calculateSimulation(60, oneMonth);
  assert.equal(result?.averageMemberUnitPrice, 10000);
  assert.equal(result?.averageExpense, 100000);
  assert.ok(calculateSimulation(60, [...oneMonth, { year: 2026, month: 2, memberCount: null, revenueAmounts: [], expenseAmounts: [] }]));
});
