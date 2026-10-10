import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createPendingMonthlyRequest } from "./monthly-request-core.ts";
import { fetchMonthlySnapshot, fetchVerifiedSession, postMonthlyMutation, resolveVerifiedSession, type MonthlyUiDependencies } from "./monthly-ui-client.ts";

const actorId = "allowlisted-user-1";
const requestId = "8a44d805-8ee6-41df-a1f4-8a74aebec6d2";

function fakeDependencies(role: "ALBA_ADMIN" | "EARNES" = "EARNES", rpcError: unknown | null = null): MonthlyUiDependencies {
  const client = {
    auth: { async getUser() { return { data: { user: { id: "supabase-user-1" } }, error: null }; } },
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: { id: actorId, supabaseUserId: "supabase-user-1", email: "person@example.test", displayName: "Test", role }, error: null }),
        order() { return this; },
        or() { return this; },
        then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: [], error: null }).then(resolve); },
      };
    },
  };
  return {
    client: () => client as never,
    rpc: () => async () => ({ error: rpcError }),
  };
}

test("the static UI accepts only an Auth-verified and RLS-readable application role", async () => {
  const success = await fetchVerifiedSession(fakeDependencies("EARNES"));
  assert.equal(resolveVerifiedSession(success.response, success.body).role, "EARNES");
  const forbidden = await fetchVerifiedSession({
    ...fakeDependencies(),
    client: () => ({ auth: { async getUser() { return { data: { user: null }, error: null }; } } }) as never,
  });
  assert.equal(forbidden.response.status, 401);
  assert.throws(() => resolveVerifiedSession(forbidden.response, forbidden.body), /unauthenticated/);
});

test("monthly reads use the browser session and preserve invalid-period rejection", async () => {
  const result = await fetchMonthlySnapshot("2026-08", fakeDependencies());
  assert.equal(result.response.status, 200);
  assert.equal((result.body?.snapshot as { period?: { year?: number } }).period?.year, 2026);
  await assert.rejects(fetchMonthlySnapshot("26-10", fakeDependencies()), /Invalid monthly period/);
});

test("an EARNES direct call to an ALBA-only RPC is surfaced as forbidden, not hidden by the UI", async () => {
  const pending = createPendingMonthlyRequest(actorId, { period: { year: 2099, month: 1 }, action: "create_month" }, () => requestId);
  const result = await postMonthlyMutation(pending, fakeDependencies("EARNES", { code: "42501" }));
  assert.equal(result.response.status, 403);
  assert.equal(result.body?.code, "forbidden");
});
