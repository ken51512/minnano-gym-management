import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  callMonthlyChangeRpc,
  callMonthlyCreateRpc,
  callMonthlyFinalizeRpc,
  callMonthlyUnlockRpc,
  callMonthlyRegisterExpenseItemRpc,
  callMonthlyRegisterExpenseItemWithAmountRpc,
  callMonthlySetExpenseItemAmountRpc,
  callMonthlyRenameExpenseItemRpc,
  callMonthlyRetireExpenseItemRpc,
  type MonthlyActionRpcArgs,
  type MonthlyChangeRpcArgs,
} from "./monthly-rpc-core.ts";
import { SafeSupabaseOperationError } from "./supabase-health-core.ts";

const requestId = "8a44d805-8ee6-41df-a1f4-8a74aebec6d2";

test("POST request ID is attached to a server-side RPC HTTP request", async () => {
  const observed: { headers?: Record<string, string>; request?: Request } = {};
  const { createMonthlyRpcTransport } = await import("./monthly-rpc-transport-core.ts");
  const transport = createMonthlyRpcTransport(requestId, (headers) => {
    observed.headers = headers;
    return {
      async rpc(name, args) {
        observed.request = new Request(`https://example.supabase.co/rest/v1/rpc/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(args),
        });
        return { error: null };
      },
    };
  });
  await callMonthlyChangeRpc(transport, { year: 2026, month: 8 }, {
    type: "revenueEntry", operation: "create", description: "Mock receipt", amount: 0,
  }, requestId);
  assert.deepEqual(observed.headers, { "x-monthly-request-id": requestId });
  assert.equal(observed.request?.headers.get("x-monthly-request-id"), requestId);
  assert.match(observed.request?.url ?? "", /\/rest\/v1\/rpc\/apply_monthly_change$/);
});

test("monthly update adapter sends one period and change to the atomic RPC", async () => {
  const change = { type: "revenueEntry", operation: "create", description: "Refund", amount: -125 } as const;
  let call: { name: string; args: MonthlyChangeRpcArgs | MonthlyActionRpcArgs; requestId: string } | null = null;
  await callMonthlyChangeRpc(async (name, args, receivedRequestId) => {
    call = { name, args, requestId: receivedRequestId };
    return { error: null };
  }, { year: 2026, month: 8 }, change, requestId);
  assert.deepEqual(call, {
    name: "apply_monthly_change",
    args: { p_year: 2026, p_month: 8, p_change: change },
    requestId,
  });
});

test("finalize and unlock adapters each make one RPC call with the existing API inputs", async () => {
  const calls: { name: string; args: MonthlyChangeRpcArgs | MonthlyActionRpcArgs }[] = [];
  const rpc = async (name: string, args: MonthlyChangeRpcArgs | MonthlyActionRpcArgs, _requestId: string) => {
    calls.push({ name, args });
    return { error: null };
  };
  await callMonthlyFinalizeRpc(rpc, { year: 2026, month: 8 }, requestId);
  await callMonthlyUnlockRpc(rpc, { year: 2026, month: 8 }, " Fix the source entry ", requestId);
  assert.deepEqual(calls, [
    { name: "finalize_monthly_record", args: { p_year: 2026, p_month: 8 } },
    { name: "unlock_monthly_record", args: { p_year: 2026, p_month: 8, p_reason: " Fix the source entry " } },
  ]);
});

test("blank-month creation adapter invokes the preserved request-ID RPC with only year and month", async () => {
  let received: unknown;
  await callMonthlyCreateRpc(async (name, args, receivedRequestId) => {
    received = { name, args, requestId: receivedRequestId };
    return { error: null };
  }, { year: 2026, month: 10 }, requestId);
  assert.deepEqual(received, {
    name: "create_monthly_record",
    args: { p_year: 2026, p_month: 10 },
    requestId,
  });
});

test("a database duplicate-period SQLSTATE becomes a safe HTTP conflict", async () => {
  await assert.rejects(
    callMonthlyCreateRpc(async () => ({ error: { code: "23505", message: "Monthly record already exists" } }), { year: 2026, month: 10 }, requestId),
    (error: unknown) => error instanceof Error && error.name === "MonthlyOperationError" && (error as { code?: string }).code === "ALREADY_EXISTS",
  );
});

test("finalize and unlock RPC failures propagate", async () => {
  const failure = new Error("database audit insert failed");
  const rpc = async () => ({ error: failure });
  for (const call of [
    callMonthlyFinalizeRpc(rpc, { year: 2026, month: 8 }, requestId),
    callMonthlyUnlockRpc(rpc, { year: 2026, month: 8 }, "Correction", requestId),
  ]) {
    await assert.rejects(call, (error: unknown) => error instanceof SafeSupabaseOperationError &&
      error.code === "error" && error.message === "Supabase operation failed");
  }
});

test("monthly update adapter propagates RPC failures", async () => {
  const failure = new Error("database transaction failed");
  await assert.rejects(
    callMonthlyChangeRpc(async () => ({ error: failure }), { year: 2026, month: 8 }, {
      type: "membershipStats", memberCount: 0, newMembers: null, cancellations: 0,
    }, requestId),
    (error: unknown) => error instanceof SafeSupabaseOperationError && error.code === "error" &&
      error.message === "Supabase operation failed",
  );
});

test("named expense RPC adapters forward exact period, name/item, and request id", async () => {
  const calls: unknown[] = [];
  const rpc = async (name: string, args: unknown, id: string) => { calls.push({ name, args, id }); return { error: null }; };
  await callMonthlyRegisterExpenseItemRpc(rpc, { year: 2026, month: 8 }, "category-fixture", "Synthetic Person", requestId);
  await callMonthlyRegisterExpenseItemWithAmountRpc(rpc, { year: 2026, month: 8 }, "category-fixture", "Synthetic Person 2", 0, requestId);
  await callMonthlyRegisterExpenseItemWithAmountRpc(rpc, { year: 2026, month: 8 }, "category-fixture", "Synthetic Person 3", null, requestId);
  await callMonthlySetExpenseItemAmountRpc(rpc, { year: 2026, month: 9 }, "item-fixture", 0, requestId);
  await callMonthlyRenameExpenseItemRpc(rpc, { year: 2026, month: 10 }, "item-fixture", "Coach B", requestId);
  await callMonthlyRetireExpenseItemRpc(rpc, { year: 2026, month: 10 }, "item-fixture", requestId);
  assert.deepEqual(calls, [
    { name: "register_monthly_expense_item", args: { p_year: 2026, p_month: 8, p_category_id: "category-fixture", p_name: "Synthetic Person" }, id: requestId },
    { name: "register_monthly_expense_item_with_amount", args: { p_year: 2026, p_month: 8, p_category_id: "category-fixture", p_name: "Synthetic Person 2", p_amount: 0 }, id: requestId },
    { name: "register_monthly_expense_item_with_amount", args: { p_year: 2026, p_month: 8, p_category_id: "category-fixture", p_name: "Synthetic Person 3", p_amount: null }, id: requestId },
    { name: "set_monthly_expense_item_amount", args: { p_year: 2026, p_month: 9, p_item_id: "item-fixture", p_amount: 0 }, id: requestId },
    { name: "rename_monthly_expense_item", args: { p_year: 2026, p_month: 10, p_item_id: "item-fixture", p_name: "Coach B" }, id: requestId },
    { name: "retire_monthly_expense_item", args: { p_year: 2026, p_month: 10, p_item_id: "item-fixture" }, id: requestId },
  ]);
});

test("RPC adapter preserves safe authentication, permission, network, and unavailable codes", async () => {
  const cases = [
    [{ status: 401, message: "private auth response" }, "unauthenticated"],
    [{ code: "42501", message: "private policy details" }, "forbidden"],
    [{ name: "AuthRetryableFetchError", message: "private transport details" }, "network"],
    [{ code: "PGRST202", message: "private schema cache detail" }, "unavailable"],
  ] as const;
  for (const [failure, code] of cases) {
    await assert.rejects(
      callMonthlyFinalizeRpc(async () => ({ error: failure }), { year: 2026, month: 8 }, requestId),
      (error: unknown) => error instanceof SafeSupabaseOperationError && error.code === code &&
        !error.message.includes("private"),
    );
  }
});
