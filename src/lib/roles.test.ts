import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canEditFinancials, canEditMembershipStats, canUnlockClosing, ROLES } from "./roles.ts";

test("ALBA_ADMIN and EARNES can edit membership statistics", () => {
  assert.equal(canEditMembershipStats(ROLES.EARNES), true);
  assert.equal(canEditMembershipStats(ROLES.ALBA_ADMIN), true);
});

test("financial edits and closing unlocks remain ALBA_ADMIN only", () => {
  assert.equal(canEditFinancials(ROLES.ALBA_ADMIN), true);
  assert.equal(canEditFinancials(ROLES.EARNES), false);
  assert.equal(canUnlockClosing(ROLES.ALBA_ADMIN), true);
  assert.equal(canUnlockClosing(ROLES.EARNES), false);
});

test("invalid roles cannot receive membership edit permission", () => {
  assert.equal(canEditMembershipStats("OWNER" as never), false);
});

test("server authorization matrix keeps financial, membership, and unlock boundaries separate", () => {
  assert.equal(canEditFinancials(ROLES.ALBA_ADMIN), true);
  assert.equal(canEditMembershipStats(ROLES.ALBA_ADMIN), true);
  assert.equal(canUnlockClosing(ROLES.ALBA_ADMIN), true);

  assert.equal(canEditFinancials(ROLES.EARNES), false);
  assert.equal(canEditMembershipStats(ROLES.EARNES), true);
  assert.equal(canUnlockClosing(ROLES.EARNES), false);
});
