import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  checkSupabaseHealthWith,
  classifySupabaseFailure,
  type SupabaseHealthProbes,
} from "./supabase-health-core.ts";

function probes(overrides: Partial<SupabaseHealthProbes> = {}): SupabaseHealthProbes {
  return {
    async auth() { return { userId: "verified-auth-id", error: null }; },
    async readAllowlist(supabaseUserId) {
      return { appUserId: "internal-app-id", supabaseUserId, error: null };
    },
    async rpc() { return { error: null }; },
    ...overrides,
  };
}

test("health runs Auth, minimal allowlist read, and dedicated RPC as separate checks", async () => {
  const calls: string[] = [];
  const result = await checkSupabaseHealthWith(probes({
    async auth() { calls.push("auth"); return { userId: "verified-auth-id", error: null }; },
    async readAllowlist(id) {
      calls.push("database");
      assert.equal(id, "verified-auth-id");
      return { appUserId: "internal-app-id", supabaseUserId: id, error: null };
    },
    async rpc() { calls.push("rpc"); return { error: null }; },
  }));
  assert.deepEqual(calls, ["auth", "database", "rpc"]);
  assert.deepEqual(result, {
    overall: "ok",
    auth: { status: "ok" },
    database: { status: "ok" },
    rpc: { status: "ok" },
  });
  assert.doesNotMatch(JSON.stringify(result), /verified-auth-id|internal-app-id|role|email/i);
});

test("missing or expired authentication is distinct and prevents database/RPC probes", async () => {
  for (const auth of [
    async () => ({ userId: null, error: null }),
    async () => ({ userId: null, error: { status: 401, message: "expired token" } }),
    async () => { throw { name: "AuthSessionMissingError", message: "session missing" }; },
  ]) {
    let downstreamCalls = 0;
    const result = await checkSupabaseHealthWith(probes({
      auth,
      async readAllowlist() { downstreamCalls += 1; return { appUserId: null, supabaseUserId: null, error: null }; },
      async rpc() { downstreamCalls += 1; return { error: null }; },
    }));
    assert.equal(result.overall, "unauthenticated");
    assert.deepEqual(result.auth, { status: "error", code: "unauthenticated" });
    assert.deepEqual(result.database, { status: "not_checked" });
    assert.deepEqual(result.rpc, { status: "not_checked" });
    assert.equal(downstreamCalls, 0);
  }
});

test("Auth transport failure is classified as network without being called a DB outage", async () => {
  const result = await checkSupabaseHealthWith(probes({
    async auth() { throw Object.assign(new Error("secret endpoint and token"), { name: "AuthRetryableFetchError" }); },
  }));
  assert.equal(result.auth.status, "error");
  assert.deepEqual(result.auth, { status: "error", code: "network" });
  assert.deepEqual(result.database, { status: "not_checked" });
  assert.deepEqual(result.rpc, { status: "not_checked" });
});

test("allowlist absence and RLS denial are permission failures while RPC remains independently checked", async () => {
  const result = await checkSupabaseHealthWith(probes({
    async readAllowlist() { return { appUserId: null, supabaseUserId: null, error: null }; },
  }));
  assert.deepEqual(result.database, { status: "error", code: "forbidden" });
  assert.deepEqual(result.rpc, { status: "ok" });
  assert.equal(result.overall, "degraded");

  assert.equal(classifySupabaseFailure({ status: 403 }), "forbidden");
  assert.equal(classifySupabaseFailure({ code: "42501" }), "forbidden");
});

test("allowlist read transport errors are classified safely", async () => {
  const result = await checkSupabaseHealthWith(probes({
    async readAllowlist() {
      return { appUserId: null, supabaseUserId: null, error: { cause: { code: "ECONNRESET" }, message: "private URL" } };
    },
  }));
  assert.deepEqual(result.database, { status: "error", code: "network" });
  assert.deepEqual(result.rpc, { status: "ok" });
  assert.doesNotMatch(JSON.stringify(result), /ECONNRESET|private URL|verified-auth-id/i);
});

test("missing readiness RPC or unavailable Supabase service is never reported as success", async () => {
  for (const error of [
    { code: "PGRST202", message: "function cache details" },
    { code: "42883", message: "undefined function" },
    { status: 503, message: "service unavailable" },
  ]) {
    const result = await checkSupabaseHealthWith(probes({ async rpc() { return { error }; } }));
    assert.equal(result.overall, "degraded");
    assert.deepEqual(result.rpc, { status: "error", code: "unavailable" });
    assert.doesNotMatch(JSON.stringify(result), /function cache details|undefined function|service unavailable/);
  }
});

test("unknown SDK errors receive only the generic safe classification", async () => {
  const rawDetail = "raw SDK endpoint detail";
  assert.equal(classifySupabaseFailure(new Error(rawDetail)), "error");
  const result = await checkSupabaseHealthWith(probes({
    async rpc() { throw new Error(rawDetail); },
  }));
  assert.deepEqual(result.rpc, { status: "error", code: "error" });
  assert.doesNotMatch(JSON.stringify(result), /raw SDK endpoint detail/i);
});
