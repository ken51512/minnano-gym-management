import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canSubmitMonthlyChange, closingReadiness, parseMonthlyChange, parsePeriod, readMonthlySnapshot, type MonthlySnapshot } from "./monthly-query-core.ts";

test("period parser rejects invalid ranges and extra fields", () => {
  assert.deepEqual(parsePeriod({ year: 2026, month: 9 }), { year: 2026, month: 9 });
  assert.equal(parsePeriod({ year: 2026, month: 0 }), null);
  assert.equal(parsePeriod({ year: 2026, month: 13 }), null);
  assert.equal(parsePeriod({ year: 2026, month: 9, role: "ALBA_ADMIN" }), null);
});

test("monthly change parser permits only exact existing contracts and rejects identity or role forgery", () => {
  assert.deepEqual(parseMonthlyChange({ type: "membershipStats", memberCount: 0, newMembers: null, cancellations: 2 }), { type: "membershipStats", memberCount: 0, newMembers: null, cancellations: 2 });
  assert.deepEqual(parseMonthlyChange({ type: "revenueEntry", operation: "update", id: "r1", amount: -5 }), { type: "revenueEntry", operation: "update", id: "r1", amount: -5 });
  assert.equal(parseMonthlyChange({ type: "membershipStats", memberCount: 0, newMembers: null, cancellations: 2, role: "ALBA_ADMIN" }), null);
  assert.equal(parseMonthlyChange({ type: "membershipStats", memberCount: -1, newMembers: null, cancellations: 2 }), null);
  assert.equal(parseMonthlyChange({ type: "revenueEntry", operation: "create", description: "", amount: 5 }), null);
  assert.equal(parseMonthlyChange({ type: "expenseEntry", operation: "create", description: "Taxi", amount: 5 }), null);
});

test("role gate maps membership and finance to the existing server role matrix", () => {
  const membership = { type: "membershipStats", memberCount: 0, newMembers: null, cancellations: 0 } as const;
  const revenue = { type: "revenueEntry", operation: "delete", id: "r1" } as const;
  assert.equal(canSubmitMonthlyChange("EARNES", membership), true);
  assert.equal(canSubmitMonthlyChange("ALBA_ADMIN", membership), false);
  assert.equal(canSubmitMonthlyChange("ALBA_ADMIN", revenue), true);
  assert.equal(canSubmitMonthlyChange("EARNES", revenue), false);
});

test("snapshot reader distinguishes missing months, null values, and closed state", async () => {
  const missing = await readMonthlySnapshot({
    async findRecord() { return { data: null, error: null }; },
    async listCategories() { return { data: [{ id: "c1", name: "Rent", expenseItems: [{ id: "i1", name: "Instructor" }] }], error: null }; },
  }, { year: 2026, month: 9 });
  assert.equal(missing.exists, false);
  assert.equal(missing.expenseCategories.length, 1);
  assert.deepEqual(missing.expenseItems, [{ id: "i1", categoryId: "c1", categoryName: "Rent", name: "Instructor", expenseEntryId: null, amount: null }]);

  const found = await readMonthlySnapshot({
    async findRecord() { return { data: { membershipStats: { memberCount: 0, newMembers: null, cancellations: 2 }, monthlyClosing: { id: "close-1" }, revenueEntries: [{ id: "r1", description: "Refund", amount: -50 }], expenseEntries: [{ id: "e1", expenseItemId: "i1", categoryId: "c1", category: { name: "Travel" }, description: "Train", amount: 0 }] }, error: null }; },
    async listCategories() { return { data: [{ id: "c1", name: "Travel", expenseItems: [{ id: "i1", name: "Train" }, { id: "i2", name: "Bus" }] }], error: null }; },
  }, { year: 2026, month: 9 });
  assert.equal(found.exists, true);
  assert.equal(found.closed, true);
  assert.deepEqual(found.membershipStats, { memberCount: 0, newMembers: null, cancellations: 2 });
  assert.equal(found.revenueEntries[0].amount, -50);
  assert.equal(found.expenseEntries[0].categoryName, "Travel");
  assert.deepEqual(found.expenseItems, [
    { id: "i1", categoryId: "c1", categoryName: "Travel", name: "Train", expenseEntryId: "e1", amount: 0 },
    { id: "i2", categoryId: "c1", categoryName: "Travel", name: "Bus", expenseEntryId: null, amount: null },
  ]);
});

test("snapshot reader maps aliased PostgREST one-to-one and one-to-many relations for an open month", async () => {
  const snapshot = await readMonthlySnapshot({
    async findRecord() {
      return { data: {
        monthlyClosing: null,
        membershipStats: { memberCount: 42, newMembers: 3, cancellations: 1 },
        revenueEntries: [{ id: "revenue-1", description: "Membership", amount: 120000 }],
        expenseEntries: [{ id: "expense-1", expenseItemId: null, categoryId: "category-1", category: { name: "Rent" }, description: "Studio", amount: 30000 }],
      }, error: null };
    },
    async listCategories() {
      return { data: [{ id: "category-1", name: "Rent", expenseItems: [] }], error: null };
    },
  }, { year: 2026, month: 11 });

  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.closed, false);
  assert.deepEqual(snapshot.membershipStats, { memberCount: 42, newMembers: 3, cancellations: 1 });
  assert.deepEqual(snapshot.revenueEntries, [{ id: "revenue-1", description: "Membership", amount: 120000 }]);
  assert.deepEqual(snapshot.expenseEntries, [{ id: "expense-1", categoryId: "category-1", categoryName: "Rent", description: "Studio", amount: 30000, expenseItemId: null }]);
});

test("snapshot reader keeps an omitted closing relation fail-closed", async () => {
  for (const record of [
    { revenueEntries: [], expenseEntries: [], membershipStats: null },
    { MonthlyClosing: [], revenueEntries: [], expenseEntries: [], membershipStats: null },
    { monthlyClosing: [], revenueEntries: [], expenseEntries: [], membershipStats: null },
  ]) {
    const snapshot = await readMonthlySnapshot({
      async findRecord() { return { data: record, error: null }; },
      async listCategories() { return { data: [], error: null }; },
    }, { year: 2026, month: 11 });
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.closed, true);
  }
});

test("registered expense amounts are read independently for each selected month", async () => {
  const monthlyExpenseRows = new Map<string, unknown[]>([
    ["2026-8", [{ id: "entry-aug", expenseItemId: "item-fixed", categoryId: "cat-labor", category: { name: "人件費" }, description: "Coach A", amount: 50000 }]],
    ["2026-9", []],
  ]);
  const port = {
    async findRecord(period: { year: number; month: number }) {
      return { data: { expenseEntries: monthlyExpenseRows.get(`${period.year}-${period.month}`) ?? [], revenueEntries: [], monthlyClosing: null }, error: null };
    },
    async listCategories() {
      return { data: [{ id: "cat-labor", name: "人件費", expenseItems: [{ id: "item-fixed", name: "Coach A", effectiveYear: 2026, effectiveMonth: 8 }] }], error: null };
    },
  };
  const augustBefore = await readMonthlySnapshot(port, { year: 2026, month: 8 });
  const septemberBlank = await readMonthlySnapshot(port, { year: 2026, month: 9 });
  assert.equal(augustBefore.expenseItems[0].amount, 50000);
  assert.equal(septemberBlank.expenseItems[0].amount, null);
  monthlyExpenseRows.set("2026-8", [{ id: "entry-aug", expenseItemId: "item-fixed", categoryId: "cat-labor", category: { name: "人件費" }, description: "Coach A", amount: 62000 }]);
  const septemberAfterAugustEdit = await readMonthlySnapshot(port, { year: 2026, month: 9 });
  assert.equal(septemberAfterAugustEdit.expenseItems[0].amount, null);
  monthlyExpenseRows.set("2026-9", [{ id: "entry-sep", expenseItemId: "item-fixed", categoryId: "cat-labor", category: { name: "人件費" }, description: "Coach A", amount: 0 }]);
  const septemberZero = await readMonthlySnapshot(port, { year: 2026, month: 9 });
  const augustAfterSeptemberEdit = await readMonthlySnapshot(port, { year: 2026, month: 8 });
  assert.equal(septemberZero.expenseItems[0].amount, 0);
  assert.equal(augustAfterSeptemberEdit.expenseItems[0].amount, 62000);
});

test("snapshot uses the latest effective name while retaining the same item's monthly amount", async () => {
  const port = {
    async findRecord(period: { year: number; month: number }) {
      return { data: { expenseEntries: [{ id: `entry-${period.month}`, expenseItemId: "item-fixed", categoryId: "cat-labor", category: { name: "人件費" }, description: "Coach A", amount: period.month * 100 }], revenueEntries: [], monthlyClosing: null }, error: null };
    },
    async listCategories() {
      return { data: [{ id: "cat-labor", name: "人件費", expenseItems: [{ id: "item-fixed", name: "Coach A", effectiveYear: 2026, effectiveMonth: 8, nameHistory: [
        { year: 2026, month: 9, name: "Coach B" }, { year: 2026, month: 12, name: "Coach C" },
      ] }] }], error: null };
    },
  };
  const before = await readMonthlySnapshot(port, { year: 2026, month: 8 });
  const renamed = await readMonthlySnapshot(port, { year: 2026, month: 9 });
  const later = await readMonthlySnapshot(port, { year: 2026, month: 12 });
  assert.equal(before.expenseItems[0].name, "Coach A");
  assert.equal(before.expenseItems[0].amount, 800);
  assert.equal(renamed.expenseItems[0].name, "Coach B");
  assert.equal(renamed.expenseItems[0].amount, 900);
  assert.equal(later.expenseItems[0].name, "Coach C");
  assert.equal(later.expenseItems[0].amount, 1200);
  assert.deepEqual([before.expenseItems[0].id, renamed.expenseItems[0].id, later.expenseItems[0].id], ["item-fixed", "item-fixed", "item-fixed"]);
});

test("same-name expense items keep their amounts separated by item ID", async () => {
  const snapshot = await readMonthlySnapshot({
    async findRecord() {
      return { data: { expenseEntries: [
        { id: "entry-a", expenseItemId: "item-a", categoryId: "cat-labor", category: { name: "Labor" }, description: "Shared label", amount: 41000 },
        { id: "entry-b", expenseItemId: "item-b", categoryId: "cat-labor", category: { name: "Labor" }, description: "Shared label", amount: -7000 },
      ], revenueEntries: [], monthlyClosing: null }, error: null };
    },
    async listCategories() {
      return { data: [{ id: "cat-labor", name: "Labor", expenseItems: [
        { id: "item-a", name: "Shared label", effectiveYear: 2026, effectiveMonth: 8 },
        { id: "item-b", name: "Shared label", effectiveYear: 2026, effectiveMonth: 8 },
      ] }], error: null };
    },
  }, { year: 2026, month: 9 });

  assert.deepEqual(snapshot.expenseItems.map(({ id, name, amount }) => ({ id, name, amount })), [
    { id: "item-a", name: "Shared label", amount: 41000 },
    { id: "item-b", name: "Shared label", amount: -7000 },
  ]);
});

test("closing readiness requires all five persisted inputs and accepts zero as entered", () => {
  assert.equal(closingReadiness(null).complete, false);
  const missingMonth = closingReadiness({
    period: { year: 2026, month: 9 }, exists: false, closed: false,
    revenueEntries: [], expenseEntries: [], expenseItems: [], expenseCategories: [], membershipStats: null,
  });
  assert.equal(missingMonth.complete, false);

  const complete: MonthlySnapshot = {
    period: { year: 2026, month: 9 }, exists: true, closed: false,
    revenueEntries: [{ id: "r1", description: "Sales", amount: 0 }],
    expenseEntries: [{ id: "e1", categoryId: "c1", categoryName: "Rent", description: "Rent", amount: 0, expenseItemId: null }],
    expenseCategories: [],
    expenseItems: [],
    membershipStats: { memberCount: 0, newMembers: 0, cancellations: 0 },
  };
  const ready = closingReadiness(complete);
  assert.equal(ready.complete, true);
  assert.equal(ready.revenueEntered, true);
  assert.equal(ready.expensesEntered, true);
  assert.equal(ready.revenueTotal, 0);
  assert.equal(ready.expenseTotal, 0);
  assert.equal(ready.memberCount, 0);
  assert.equal(closingReadiness({ ...complete, closed: true }).closed, true);
});

test("each missing persisted closing value blocks finalization", () => {
  const complete: MonthlySnapshot = {
    period: { year: 2026, month: 9 }, exists: true, closed: false,
    revenueEntries: [{ id: "r1", description: "Sales", amount: 100 }],
    expenseEntries: [{ id: "e1", categoryId: "c1", categoryName: "Rent", description: "Rent", amount: 20, expenseItemId: null }],
    expenseCategories: [],
    expenseItems: [],
    membershipStats: { memberCount: 10, newMembers: 1, cancellations: 0 },
  };
  const incomplete: MonthlySnapshot[] = [
    { ...complete, revenueEntries: [] },
    { ...complete, expenseEntries: [] },
    { ...complete, membershipStats: null },
    { ...complete, membershipStats: { ...complete.membershipStats!, memberCount: null } },
    { ...complete, membershipStats: { ...complete.membershipStats!, newMembers: null } },
    { ...complete, membershipStats: { ...complete.membershipStats!, cancellations: null } },
  ];
  for (const snapshot of incomplete) assert.equal(closingReadiness(snapshot).complete, false);
});
