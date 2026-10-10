import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canRegisterExpenseItem, canSaveExpenseAmount, expenseItemLimit, expenseItemNameLength, isValidExpenseAmount, resolveExpenseItemName } from "./expense-item-core.ts";
import { createExpenseItemService } from "./expense-item-service-core.ts";
import { MonthlyOperationError } from "./monthly-service-core.ts";

test("named expense registrations enforce the requested category boundaries", () => {
  const labor = "\u4eba\u4ef6\u8cbb";
  const advertising = "\u5e83\u544a\u8cbb";
  const other = "\u305d\u306e\u4ed6";
  assert.equal(expenseItemLimit(labor), 20);
  assert.equal(canRegisterExpenseItem(labor, 19, "Synthetic Person 20"), true);
  assert.equal(canRegisterExpenseItem(labor, 20, "Synthetic Person 21"), false);
  for (const category of [advertising, other]) {
    assert.equal(expenseItemLimit(category), 3);
    assert.equal(canRegisterExpenseItem(category, 2, "Fixture 3"), true);
    assert.equal(canRegisterExpenseItem(category, 3, "Fixture 4"), false);
  }
  assert.equal(canRegisterExpenseItem("\u5bb6\u8cc3", 0, "Not a named category"), false);
  assert.equal(canRegisterExpenseItem(labor, 0, "   "), false);
  assert.equal(canRegisterExpenseItem(labor, 0, "x".repeat(201)), false);
  assert.equal(canRegisterExpenseItem(labor, 0, "😀".repeat(100)), true);
  assert.equal(canRegisterExpenseItem(labor, 0, "😀".repeat(201)), false);
  for (const whitespace of ["\t", "\n", "\v", "\f", "\r", "\u00a0", "\u1680", "\u2000", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"]) {
    assert.equal(canRegisterExpenseItem(labor, 0, whitespace), false, `whitespace-only label: ${JSON.stringify(whitespace)}`);
  }
});

test("named expense cap policy uses only the exact existing category names", () => {
  assert.equal(expenseItemLimit("\u5e83\u544a\u8cbb"), 3);
  assert.equal(expenseItemLimit("\u5e83\u5ba3\u4f1d\u8cbb"), null);
});

test("named expense input uses trim whitespace and Unicode code-point length", () => {
  const whitespace = ["\t", "\n", "\v", "\f", "\r", "\u00a0", "\u1680", "\u2000", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"];
  for (const character of whitespace) assert.equal(character.trim(), "");
  assert.equal(expenseItemNameLength("😀".repeat(100)), 100);
  assert.equal(expenseItemNameLength("😀".repeat(201)), 201);
});

test("a changed valid amount such as 123 enables the row save button only for editable, idle rows", () => {
  assert.equal(isValidExpenseAmount("123"), true);
  assert.equal(canSaveExpenseAmount({ canEdit: true, busy: false, changed: true, value: "123" }), true);
  assert.equal(canSaveExpenseAmount({ canEdit: false, busy: false, changed: true, value: "123" }), false);
  assert.equal(canSaveExpenseAmount({ canEdit: true, busy: true, changed: true, value: "123" }), false);
  assert.equal(canSaveExpenseAmount({ canEdit: true, busy: false, changed: false, value: "123" }), false);
  assert.equal(canSaveExpenseAmount({ canEdit: true, busy: false, changed: true, value: "" }), false);
  assert.equal(canSaveExpenseAmount({ canEdit: true, busy: false, changed: true, value: "2147483648" }), false);
  assert.equal(canSaveExpenseAmount({ canEdit: true, busy: false, changed: true, value: "-123" }), true);
});

test("name history preserves the original label and applies each version from its effective month onward", () => {
  const history = [
    { year: 2026, month: 9, name: "Coach B" },
    { year: 2026, month: 12, name: "Coach C" },
    { year: 2027, month: 2, name: "Coach D" },
  ];
  assert.equal(resolveExpenseItemName("Coach A", 2026, 8, history), "Coach A");
  assert.equal(resolveExpenseItemName("Coach A", 2026, 9, history), "Coach B");
  assert.equal(resolveExpenseItemName("Coach A", 2026, 11, history), "Coach B");
  assert.equal(resolveExpenseItemName("Coach A", 2026, 12, history), "Coach C");
  assert.equal(resolveExpenseItemName("Coach A", 2027, 1, history), "Coach C");
  assert.equal(resolveExpenseItemName("Coach A", 2027, 2, history), "Coach D");
});

test("only the server-resolved ALBA_ADMIN can register expense names or amounts", async () => {
  let calls = 0;
  const service = createExpenseItemService({ currentUser: async () => ({ id: "fixture-admin", role: "ALBA_ADMIN" }), async register() { calls++; }, async registerWithAmount() { calls++; }, async setAmount() { calls++; }, async rename() { calls++; } });
  await service.register({year:2026,month:9}, "fixture-category", "Fixture", "8a44d805-8ee6-41df-a1f4-8a74aebec6d2");
  await service.registerWithAmount({year:2026,month:9}, "fixture-category", "Fixture zero", 0, "8a44d805-8ee6-41df-a1f4-8a74aebec6d2");
  await service.registerWithAmount({year:2026,month:9}, "fixture-category", "Fixture blank", null, "8a44d805-8ee6-41df-a1f4-8a74aebec6d2");
  await service.setAmount({year:2026,month:9}, "fixture-item", 0, "8a44d805-8ee6-41df-a1f4-8a74aebec6d2");
  await service.rename({year:2026,month:9}, "fixture-item", " Renamed ", "8a44d805-8ee6-41df-a1f4-8a74aebec6d2");
  assert.equal(calls, 5);
  await assert.rejects(service.registerWithAmount({year:2026,month:9}, "fixture-category", "Out of range", 2147483648, "8a44d805-8ee6-41df-a1f4-8a74aebec6d2"), (e:unknown) => e instanceof MonthlyOperationError && e.code === "INVALID_CHANGE");
  await assert.rejects(service.register({year:2026,month:9}, "fixture-category", "\u00a0\ufeff\u3000", "8a44d805-8ee6-41df-a1f4-8a74aebec6d2"), (e:unknown) => e instanceof MonthlyOperationError && e.code === "INVALID_CHANGE");
  await service.register({year:2026,month:9}, "fixture-category", "😀".repeat(100), "8a44d805-8ee6-41df-a1f4-8a74aebec6d2");
  await assert.rejects(service.register({year:2026,month:9}, "fixture-category", "😀".repeat(201), "8a44d805-8ee6-41df-a1f4-8a74aebec6d2"), (e:unknown) => e instanceof MonthlyOperationError && e.code === "INVALID_CHANGE");
  assert.equal(calls, 6);
  const earnes = createExpenseItemService({ currentUser: async () => ({ id: "fixture-earnes", role: "EARNES" }), async register() { calls++; }, async registerWithAmount() { calls++; }, async setAmount() { calls++; }, async rename() { calls++; } });
  await assert.rejects(earnes.register({year:2026,month:9}, "fixture-category", "Fixture", "8a44d805-8ee6-41df-a1f4-8a74aebec6d2"), (e:unknown) => e instanceof MonthlyOperationError && e.code === "UNAUTHORIZED");
  await assert.rejects(earnes.registerWithAmount({year:2026,month:9}, "fixture-category", "Fixture", 0, "8a44d805-8ee6-41df-a1f4-8a74aebec6d2"), (e:unknown) => e instanceof MonthlyOperationError && e.code === "UNAUTHORIZED");
  await assert.rejects(earnes.rename({year:2026,month:9}, "fixture-item", "Nope", "8a44d805-8ee6-41df-a1f4-8a74aebec6d2"), (e:unknown) => e instanceof MonthlyOperationError && e.code === "UNAUTHORIZED");
  await assert.rejects(service.rename({year:2026,month:9}, "fixture-item", "\u00a0\ufeff", "8a44d805-8ee6-41df-a1f4-8a74aebec6d2"), (e:unknown) => e instanceof MonthlyOperationError && e.code === "INVALID_CHANGE");
  await assert.rejects(service.rename({year:2026,month:9}, "fixture-item", "x".repeat(201), "8a44d805-8ee6-41df-a1f4-8a74aebec6d2"), (e:unknown) => e instanceof MonthlyOperationError && e.code === "INVALID_CHANGE");
  assert.equal(calls, 6);
});
