import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isValidSameOriginPost, loginReturnPath, passwordSignInFailure, safeRouteFailure } from "./auth-route-core.ts";

test("auth mutations require same-origin POST and reject cross-site fetch metadata", () => {
  assert.equal(isValidSameOriginPost(new Request("https://gym.example/api/session", { method: "POST", headers: { origin: "https://gym.example" } })), true);
  assert.equal(isValidSameOriginPost(new Request("http://127.0.0.1:3003/api/session", { method: "POST", headers: { origin: "http://127.0.0.1:3003" } })), true);
  assert.equal(isValidSameOriginPost(new Request("http://internal-host/api/session", { method: "POST", headers: { origin: "http://127.0.0.1:3003" } })), false);
  assert.equal(isValidSameOriginPost(new Request("http://localhost:3004/api/session", { method: "POST", headers: { origin: "http://127.0.0.1:3004", host: "127.0.0.1:3004" } })), true);
  assert.equal(isValidSameOriginPost(new Request("http://127.0.0.1:3004/api/session", { method: "POST", headers: { origin: "http://localhost:3004", host: "127.0.0.1:3004" } })), false);
  assert.equal(isValidSameOriginPost(new Request("http://localhost:3004/api/session", { method: "POST", headers: { origin: "http://127.0.0.1:3004", host: "evil.example:3004", "x-forwarded-host": "127.0.0.1:3004" } })), false);
  assert.equal(isValidSameOriginPost(new Request("http://localhost:3004/api/session", { method: "POST", headers: { origin: "http://127.0.0.1:3005", host: "127.0.0.1:3005" } })), false);
  assert.equal(isValidSameOriginPost(new Request("https://gym.example/api/session", { method: "POST", headers: { origin: "https://attacker.example" } })), false);
  assert.equal(isValidSameOriginPost(new Request("https://gym.example/api/session", { method: "POST" })), false);
  assert.equal(isValidSameOriginPost(new Request("https://gym.example/api/session", { method: "POST", headers: { origin: "https://gym.example", "sec-fetch-site": "cross-site" } })), false);
  assert.equal(isValidSameOriginPost(new Request("https://gym.example/api/session", { method: "GET", headers: { origin: "https://gym.example" } })), false);
});

test("login return path accepts local paths and rejects open redirects", () => {
  assert.equal(loginReturnPath("/dashboard?period=2026-09#top"), "/dashboard?period=2026-09#top");
  for (const value of ["https://attacker.example", "//attacker.example", "/\\attacker", "javascript:alert(1)", "/x\r\ny"]) {
    assert.equal(loginReturnPath(value), "/");
  }
  assert.equal(loginReturnPath(null), "/");
});

test("route errors expose only safe fixed classification and status", () => {
  assert.deepEqual(safeRouteFailure({ status: 401, message: "secret token" }), { code: "unauthenticated", status: 401, stage: "auth_session" });
  assert.deepEqual(safeRouteFailure({ code: "unauthenticated", message: "private auth detail" }), { code: "unauthenticated", status: 401, stage: "auth_session" });
  assert.deepEqual(safeRouteFailure({ code: "42501", message: "private policy" }, "allowlist_lookup"), { code: "forbidden", status: 403, stage: "allowlist_lookup" });
  assert.deepEqual(safeRouteFailure({ name: "AuthRetryableFetchError", message: "private URL" }), { code: "network", status: 503, stage: "auth_session" });
  assert.deepEqual(safeRouteFailure({ code: "network", message: "private transport detail" }), { code: "network", status: 503, stage: "auth_session" });
  assert.deepEqual(safeRouteFailure(new Error("private database detail")), { code: "error", status: 500, stage: "auth_session" });
});

test("password sign-in failures distinguish wrong credentials, authorization, and transport outages", () => {
  assert.deepEqual(passwordSignInFailure({ code: "invalid_credentials", message: "private auth response" }), { code: "unauthenticated", status: 401, stage: "auth_signin" });
  assert.deepEqual(passwordSignInFailure(null), { code: "unauthenticated", status: 401, stage: "auth_signin" });
  assert.deepEqual(passwordSignInFailure({ name: "AuthRetryableFetchError", message: "private transport detail" }), { code: "network", status: 503, stage: "auth_signin" });
  assert.deepEqual(passwordSignInFailure({ status: 503, message: "private upstream detail" }), { code: "unavailable", status: 503, stage: "auth_signin" });
  assert.deepEqual(safeRouteFailure({ code: "forbidden", message: "private allowlist detail" }, "role_check"), { code: "forbidden", status: 403, stage: "role_check" });
});
