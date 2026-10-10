import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../../../legacy-server-routes/api/monthly/route.ts", import.meta.url), "utf8");

test("monthly POST verifies same-origin session and requires a request ID on every write", () => {
  const csrf = route.indexOf("isValidSameOriginPost(request)");
  const auth = route.indexOf("await getAuthorizedUser()", csrf);
  const parse = route.indexOf("parseMonthlyChange(input.change)");
  const edit = route.indexOf("await editMonthlyRecord(period, change, requestId)");
  assert.ok(csrf >= 0 && auth > csrf && parse > auth && edit > parse);
  assert.match(route, /Object\.keys\(input\)\.length === 3 && Object\.hasOwn\(input, "change"\)/);
  assert.match(route, /input\.requestId/);
  assert.match(route, /await editMonthlyRecord\(period, change, requestId\)/);
  assert.match(route, /parseMonthlyChange\(input\.change\)/);
  assert.match(route, /createRequestSupabaseClient\(\{ writeCookies: true \}\)/);
  assert.match(route, /await finalizeMonthlyRecord\(period, requestId\)/);
  assert.match(route, /await unlockMonthlyRecord\(period, input\.reason, requestId\)/);
  assert.match(route, /input\.action === "create_month"/);
  assert.match(route, /await createMonthlyRecord\(period, requestId\)/);
  assert.match(route, /input\.action === "finalize"/);
  assert.match(route, /input\.action === "unlock"/);
  assert.match(route, /input\.action === "register_expense_item"/);
  assert.match(route, /await registerMonthlyExpenseItem\(period, input\.categoryId, input\.name\.trim\(\), requestId\)/);
  assert.match(route, /input\.action === "register_expense_item_with_amount"/);
  assert.match(route, /await registerMonthlyExpenseItemWithAmount\(period, input\.categoryId, input\.name\.trim\(\), input\.amount as number \| null, requestId\)/);
  assert.match(route, /input\.action === "expense_item_amount"/);
  assert.match(route, /await setMonthlyExpenseItemAmount\(period, input\.itemId, input\.amount, requestId\)/);
  assert.match(route, /input\.action === "rename_expense_item"/);
  assert.match(route, /await renameMonthlyExpenseItem\(period, input\.itemId, input\.name\.trim\(\), requestId\)/);
  assert.doesNotMatch(route, /console\.(?:log|error|warn)\s*\(/);
});

test("month creation stays behind same-origin and verified-session gates with an exact request shape", () => {
  const csrf = route.indexOf("isValidSameOriginPost(request)");
  const auth = route.indexOf("await getAuthorizedUser()", csrf);
  const create = route.indexOf('input.action === "create_month"');
  assert.ok(csrf >= 0 && auth > csrf && create > auth);
  assert.match(route, /Object\.keys\(input\)\.length === 3 && input\.action === "create_month"/);
  assert.match(route, /await createMonthlyRecord\(period, requestId\)/);
});

test("month read is verified-session scoped, no-store, and never provides create-month behavior", () => {
  assert.match(route, /await getAuthorizedUser\(\)/);
  assert.match(route, /from\("MonthlyRecord"\)/);
  assert.match(route, /from\("ExpenseCategory"\)/);
  assert.match(route, /nameHistory:ExpenseItemNameHistory\(year,month,name\)/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /insert\s*\(|upsert\s*\(/i);
});

test("monthly read aliases PostgREST relations to the snapshot reader's lower-camel keys", () => {
  assert.match(route, /revenueEntries:RevenueEntry\(/);
  assert.match(route, /expenseEntries:ExpenseEntry\(/);
  assert.match(route, /membershipStats:MembershipStats\(/);
  assert.match(route, /monthlyClosing:MonthlyClosing\(/);
});
