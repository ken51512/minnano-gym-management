import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveSessionUser, resolveSessionUserFromAllowlist } from "./auth-core.ts";
import { ROLES } from "./roles.ts";

const verifiedIdentity = { id: "supabase-user-1" };
const allowlistedUser = {
  id: "app-user-1",
  supabaseUserId: "supabase-user-1",
  email: "admin@example.test",
  displayName: "Admin",
  role: ROLES.ALBA_ADMIN,
};

test("maps a verified Auth identity to its server allowlist role", () => {
  assert.deepEqual(resolveSessionUser(verifiedIdentity, allowlistedUser), {
    id: "app-user-1",
    email: "admin@example.test",
    displayName: "Admin",
    role: ROLES.ALBA_ADMIN,
  });
});

test("rejects missing Auth identity and unallowlisted users", () => {
  assert.equal(resolveSessionUser(null, allowlistedUser), null);
  assert.equal(resolveSessionUser(verifiedIdentity, null), null);
});

test("rejects an allowlist row bound to a different Supabase identity", () => {
  assert.equal(resolveSessionUser({ id: "forged-id" }, allowlistedUser), null);
});

test("rejects invalid persisted roles", () => {
  assert.equal(resolveSessionUser(verifiedIdentity, { ...allowlistedUser, role: "OWNER" }), null);
});

test("preserves EARNES as the allowlisted application role", () => {
  assert.equal(resolveSessionUser(verifiedIdentity, { ...allowlistedUser, role: ROLES.EARNES })?.role, ROLES.EARNES);
});

test("resolves ALBA_ADMIN and EARNES only from the server allowlist lookup", async () => {
  for (const role of [ROLES.ALBA_ADMIN, ROLES.EARNES]) {
    const session = await resolveSessionUserFromAllowlist(verifiedIdentity, async (supabaseUserId) => {
      assert.equal(supabaseUserId, verifiedIdentity.id);
      return { ...allowlistedUser, role };
    });
    assert.equal(session?.role, role);
  }
});

test("does not query the allowlist without a verified identity and rejects missing rows", async () => {
  let lookupCalled = false;
  assert.equal(await resolveSessionUserFromAllowlist(null, async () => {
    lookupCalled = true;
    return allowlistedUser;
  }), null);
  assert.equal(lookupCalled, false);
  assert.equal(await resolveSessionUserFromAllowlist(verifiedIdentity, async () => null), null);
});

test("fails closed when the allowlist database read throws", async () => {
  assert.equal(await resolveSessionUserFromAllowlist(verifiedIdentity, async () => {
    throw new Error("database read failed");
  }), null);
});

test("rejects invalid roles returned by the allowlist lookup", async () => {
  assert.equal(await resolveSessionUserFromAllowlist(verifiedIdentity, async () => ({
    ...allowlistedUser,
    role: "OWNER",
  })), null);
});
