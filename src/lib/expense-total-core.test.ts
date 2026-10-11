import assert from "node:assert/strict";
import test from "node:test";
import { sumEnteredExpenseAmounts } from "./expense-total-core.ts";

test("expense subtotal includes fixed categories, named items, free items, zero, and negative amounts", () => {
  assert.equal(sumEnteredExpenseAmounts([100000, 150000, 30000, 3000, -2500, 0, null]), 280500);
});

test("empty expense months are excluded while an explicit zero month remains valid", () => {
  assert.equal(sumEnteredExpenseAmounts([]), null);
  assert.equal(sumEnteredExpenseAmounts([0]), 0);
});
