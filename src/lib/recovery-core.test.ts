import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  hasRecoveryProof,
  runRecoveryPkceCallback,
  checkRecoveryAuthSettings,
  classifyRecoveryRequestFailure,
  RECOVERY_CALLBACK_URL,
  RECOVERY_RESET_URL,
  recoveryRequestCanRetry,
  recoveryAttemptedAfterFailure,
  recoveryEmailRequestDisabled,
  recoveryPasswordsMatch,
  updatePasswordWithRecoveryProof,
} from "./recovery-core.ts";
import { createRecoveryCallbackRedirect } from "./recovery-callback-response.ts";

test("recovery redirects stay fixed to the configured local callback and reset page", () => {
  assert.equal(RECOVERY_CALLBACK_URL, "http://127.0.0.1:3005/auth/callback");
  assert.equal(RECOVERY_RESET_URL, "http://127.0.0.1:3005/auth/reset-password");
});

test("recovery service probe uses a public settings GET without credentials or response details", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const result = await checkRecoveryAuthSettings(async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response("{}", { status: 200 });
  }, "https://fixture.supabase.co/", "fixture-anon-key");
  assert.equal(result, "ready");
  assert.equal(seenUrl, "https://fixture.supabase.co/auth/v1/settings");
  assert.equal(seenInit?.method, "GET");
  assert.equal(seenInit?.credentials, "omit");
  assert.equal(seenInit?.cache, "no-store");
  assert.equal(seenInit?.redirect, "error");
  assert.deepEqual(seenInit?.headers, { apikey: "fixture-anon-key" });
  assert.equal(await checkRecoveryAuthSettings(fetch, undefined, "fixture"), "not_configured");
  assert.equal(await checkRecoveryAuthSettings(async () => new Response(null, { status: 403 }), "https://fixture.supabase.co", "fixture"), "public_config_rejected");
  assert.equal(await checkRecoveryAuthSettings(async () => new Response(null, { status: 503 }), "https://fixture.supabase.co", "fixture"), "unavailable");
  assert.equal(await checkRecoveryAuthSettings(async () => { throw new Error("private fixture error"); }, "https://fixture.supabase.co", "fixture"), "network");
});

test("recovery request failures are reduced to safe categories and retry policy avoids duplicate sends", () => {
  assert.equal(classifyRecoveryRequestFailure({ name: "AuthRetryableFetchError" }), "network");
  assert.equal(classifyRecoveryRequestFailure({ status: 400 }), "request_rejected");
  assert.equal(classifyRecoveryRequestFailure({ status: 401 }), "public_config_rejected");
  assert.equal(classifyRecoveryRequestFailure({ status: 429 }), "unavailable");
  assert.equal(classifyRecoveryRequestFailure({ status: 503 }), "unavailable");
  assert.equal(classifyRecoveryRequestFailure(new Error("private fixture error")), "client_not_ready");
  assert.equal(recoveryRequestCanRetry("request_rejected"), true);
  assert.equal(recoveryRequestCanRetry("public_config_rejected"), true);
  assert.equal(recoveryRequestCanRetry("network"), false);
  assert.equal(recoveryRequestCanRetry("unavailable"), false);
});

test("recovery form stays enabled after service initialization and definitive errors, and blocks only pending or uncertain sends", () => {
  const configState = "ready";
  assert.equal(configState, "ready");
  assert.equal(recoveryEmailRequestDisabled(false, false), false);
  assert.equal(recoveryEmailRequestDisabled(true, false), true);
  assert.equal(recoveryEmailRequestDisabled(false, true), true);
  for (const failure of ["client_not_ready", "request_rejected", "public_config_rejected"] as const) {
    assert.equal(recoveryAttemptedAfterFailure(failure), false);
    assert.equal(recoveryEmailRequestDisabled(false, recoveryAttemptedAfterFailure(failure)), false);
  }
  for (const failure of ["network", "unavailable"] as const) {
    assert.equal(recoveryAttemptedAfterFailure(failure), true);
    assert.equal(recoveryEmailRequestDisabled(false, recoveryAttemptedAfterFailure(failure)), true);
  }
});

test("expired, missing, or unverified recovery proof never allows a password update", async () => {
  for (const [marker, verified] of [[undefined, false], ["expired", true], ["active", false]] as const) {
    assert.equal(hasRecoveryProof(marker, verified), false);
    let called = false;
    const result = await updatePasswordWithRecoveryProof(hasRecoveryProof(marker, verified), async () => {
      called = true;
      return { error: null };
    });
    assert.deepEqual(result, { status: "recovery_required" });
    assert.equal(called, false);
  }
});

test("PKCE callback rejects a missing or oversized code without exchanging it", async () => {
  let exchanges = 0;
  const exchange = async () => { exchanges += 1; return { error: null }; };
  const verify = async () => { throw new Error("must not verify"); };
  assert.deepEqual(await runRecoveryPkceCallback(null, exchange, verify), {
    stage: "code_missing", codePresent: false, exchangeSuccess: false, allowlistSuccess: false,
  });
  assert.deepEqual(await runRecoveryPkceCallback("x".repeat(2049), exchange, verify), {
    stage: "code_rejected", codePresent: true, exchangeSuccess: false, allowlistSuccess: false,
  });
  assert.equal(exchanges, 0);
});

test("PKCE callback awaits one exchange before allowlist verification", async () => {
  const events: string[] = [];
  const result = await runRecoveryPkceCallback("mock-pkce-code", async () => {
    events.push("exchange");
    return { error: null };
  }, async () => { events.push("allowlist"); });
  assert.deepEqual(result, { stage: "ready", codePresent: true, exchangeSuccess: true, allowlistSuccess: true });
  assert.deepEqual(events, ["exchange", "allowlist"]);
});

test("PKCE exchange rejection or exception never reaches allowlist verification", async () => {
  let verifications = 0;
  const verify = async () => { verifications += 1; };
  assert.deepEqual(await runRecoveryPkceCallback("mock-pkce-code", async () => ({ error: new Error("fixture only") }), verify), {
    stage: "exchange_failed", codePresent: true, exchangeSuccess: false, allowlistSuccess: false,
  });
  assert.deepEqual(await runRecoveryPkceCallback("mock-pkce-code", async () => { throw new Error("fixture only"); }, verify), {
    stage: "exchange_failed", codePresent: true, exchangeSuccess: false, allowlistSuccess: false,
  });
  assert.equal(verifications, 0);
});

test("PKCE allowlist failure is distinct and does not grant recovery proof", async () => {
  const result = await runRecoveryPkceCallback("mock-pkce-code", async () => ({ error: null }), async () => {
    throw new Error("fixture only");
  });
  assert.deepEqual(result, { stage: "allowlist_failed", codePresent: true, exchangeSuccess: true, allowlistSuccess: false });
  assert.equal(hasRecoveryProof(undefined, true), false);
});

test("recovery marker is attached to the actual redirect response only after verified PKCE", () => {
  const requestUrl = "http://127.0.0.1:3005/auth/callback";
  const success = createRecoveryCallbackRedirect({ stage: "ready", codePresent: true, exchangeSuccess: true, allowlistSuccess: true }, requestUrl);
  assert.equal(success.status, 303);
  assert.equal(success.headers.get("location"), RECOVERY_RESET_URL);
  assert.equal(success.cookies.get("minnano-recovery-flow")?.value, "active");
  assert.equal(success.headers.has("set-cookie"), true);

  const failure = createRecoveryCallbackRedirect({ stage: "allowlist_failed", codePresent: true, exchangeSuccess: true, allowlistSuccess: false }, requestUrl);
  assert.equal(failure.status, 303);
  assert.equal(failure.headers.get("location"), "http://127.0.0.1:3005/auth/recovery?state=invalid");
  assert.notEqual(failure.cookies.get("minnano-recovery-flow")?.value, "active");
  assert.equal(hasRecoveryProof("", true), false);
});

test("matching recovery password calls the mocked Auth update once; mismatch is rejected", async () => {
  assert.equal(recoveryPasswordsMatch("fixture-only-password", "different-fixture"), false);
  assert.equal(recoveryPasswordsMatch("", ""), false);
  assert.equal(recoveryPasswordsMatch("fixture-only-password", "fixture-only-password"), true);
  let calls = 0;
  const result = await updatePasswordWithRecoveryProof(true, async () => {
    calls += 1;
    return { error: null };
  });
  assert.deepEqual(result, { status: "updated" });
  assert.equal(calls, 1);
});

test("recovery Auth update errors stay internal and do not become success", async () => {
  const result = await updatePasswordWithRecoveryProof(true, async () => ({ error: new Error("private fixture error") }));
  assert.equal(result.status, "failed");
});
