import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  createPendingMonthlyRequest,
  isPendingMonthlyRequest,
  pendingMonthlyRequestBelongsToActor,
  PENDING_MONTHLY_REQUEST_KEY,
  readPendingMonthlyRequest,
} from "./monthly-request-core.ts";

const id = "8a44d805-8ee6-41df-a1f4-8a74aebec6d2";
const actorId = "allowlisted-user-a";
const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const uiClient = readFileSync(new URL("./monthly-ui-client.ts", import.meta.url), "utf8");

test("a retry record keeps one request ID and the complete operation envelope", () => {
  const body = { period: { year: 2026, month: 8 }, change: { type: "revenueEntry", operation: "create", description: "Receipt", amount: 0 } };
  const request = createPendingMonthlyRequest(actorId, body, () => id.toUpperCase());
  assert.deepEqual(request, { actorId, requestId: id, body });
  assert.equal(isPendingMonthlyRequest(request), true);
});

test("pending request reader restores a valid request and rejects malformed or incomplete data", () => {
  const value = { actorId, requestId: id, body: { period: { year: 2026, month: 8 }, action: "unlock", reason: "Correction" } };
  assert.deepEqual(readPendingMonthlyRequest({ getItem: (key) => key === PENDING_MONTHLY_REQUEST_KEY ? JSON.stringify(value) : null }), value);
  assert.equal(readPendingMonthlyRequest({ getItem: () => "not-json" }), null);
  const legacy = { requestId: id, body: value.body };
  assert.equal(isPendingMonthlyRequest(legacy), false);
  assert.equal(readPendingMonthlyRequest({ getItem: () => JSON.stringify(legacy) }), null);
  assert.equal(isPendingMonthlyRequest({ actorId, requestId: id, body: { period: { year: 2026, month: 8 }, action: "finalize", extra: true } }), false);
  assert.throws(() => createPendingMonthlyRequest(actorId, { period: { year: 2026, month: 8 }, action: "finalize" }, () => "not-an-id"), /Invalid monthly request ID/);
});

test("reauthentication permits a retry only for the same verified actor", () => {
  const request = createPendingMonthlyRequest(actorId, { period: { year: 2026, month: 8 }, action: "finalize" }, () => id);
  assert.equal(pendingMonthlyRequestBelongsToActor(request, actorId), true);
  assert.equal(pendingMonthlyRequestBelongsToActor(request, "allowlisted-user-b"), false);
  assert.equal(pendingMonthlyRequestBelongsToActor(request, null), false);
  const guard = page.indexOf("if (!pendingMonthlyRequestBelongsToActor(pending, verifiedActorId.current))");
  const send = page.indexOf("sendMonthlyMutation(pending)", guard);
  assert.notEqual(guard, -1);
  assert.ok(send > guard, "actor guard must run before sending the stored request");
});

test("blank-month creation is a valid pending operation for actor-scoped safe retry", () => {
  const request = createPendingMonthlyRequest(actorId, { period: { year: 2026, month: 10 }, action: "create_month" }, () => id);
  assert.equal(isPendingMonthlyRequest(request), true);
  assert.equal(pendingMonthlyRequestBelongsToActor(request, actorId), true);
  assert.equal(pendingMonthlyRequestBelongsToActor(request, "allowlisted-user-b"), false);
});

test("expense item registration and amount writes retain exact retry envelopes", () => {
  const registration = createPendingMonthlyRequest(actorId, { period: { year: 2026, month: 8 }, action: "register_expense_item", categoryId: "labor-category", name: "Synthetic Person" }, () => id);
  const amount = createPendingMonthlyRequest(actorId, { period: { year: 2026, month: 9 }, action: "expense_item_amount", itemId: "fixture-item", amount: 0 }, () => id);
  const rename = createPendingMonthlyRequest(actorId, { period: { year: 2026, month: 10 }, action: "rename_expense_item", itemId: "fixture-item", name: "Coach B" }, () => id);
  const withAmount = createPendingMonthlyRequest(actorId, { period: { year: 2026, month: 9 }, action: "register_expense_item_with_amount", categoryId: "labor-category", name: "Coach C", amount: 0 }, () => id);
  const nameOnly = createPendingMonthlyRequest(actorId, { period: { year: 2026, month: 9 }, action: "register_expense_item_with_amount", categoryId: "labor-category", name: "Coach D", amount: null }, () => id);
  assert.equal(isPendingMonthlyRequest(registration), true);
  assert.equal(isPendingMonthlyRequest(amount), true);
  assert.equal(isPendingMonthlyRequest(rename), true);
  assert.equal(isPendingMonthlyRequest(withAmount), true);
  assert.equal(isPendingMonthlyRequest(nameOnly), true);
  assert.equal(isPendingMonthlyRequest({ ...withAmount, body: { ...withAmount.body, amount: 2147483648 } }), false);
  assert.equal(isPendingMonthlyRequest({ ...rename, body: { ...rename.body, name: "\u00a0\ufeff" } }), false);
  assert.equal(isPendingMonthlyRequest({ ...rename, body: { ...rename.body, role: "ALBA_ADMIN" } }), false);
  assert.equal(isPendingMonthlyRequest({ ...amount, body: { ...amount.body, actorId } }), false);
  assert.equal(pendingMonthlyRequestBelongsToActor(registration, "allowlisted-user-b"), false);
});

test("new intent gets a fresh ID while uncertain retry reuses the stored payload and guards double submits", () => {
  const ids = [id, "9a44d805-8ee6-41df-a1f4-8a74aebec6d2"];
  const nextId = () => ids.shift() as string;
  const operation = { period: { year: 2026, month: 8 }, change: { type: "revenueEntry", operation: "create", description: "Same value", amount: 10 } };
  const first = createPendingMonthlyRequest(actorId, operation, nextId);
  const separateIntent = createPendingMonthlyRequest(actorId, operation, nextId);
  assert.notEqual(first.requestId, separateIntent.requestId);
  assert.match(uiClient, /createBrowserMonthlyRpc/);
  assert.match(uiClient, /pending\.requestId/);
  assert.match(page, /sendMonthlyMutation\(pending\)/);
  assert.match(page, /saveLock\.current \|\| saveState === "outcome_unknown"/);
  assert.match(page, /setDirty\(false\)/);
});
