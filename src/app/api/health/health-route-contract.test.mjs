import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../../../legacy-server-routes/api/health/route.ts", import.meta.url), "utf8");
const health = readFileSync(new URL("../../../lib/supabase-health.ts", import.meta.url), "utf8");

test("public health route returns only safe probe codes and disables caching", () => {
  assert.match(route, /checkSupabaseHealth\(\)/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.match(route, /report\.overall === "unauthenticated" \? 401 : 503/);
  assert.doesNotMatch(route, /console\.|user\.role|email|monthlyRecord/);
});

test("health probes verify Auth, read only the caller allowlist identifiers, and call a non-mutating RPC", () => {
  assert.match(health, /auth\.getUser\(\)/);
  assert.match(health, /\.select\("id,supabaseUserId"\)/);
  assert.match(health, /\.maybeSingle\(\)/);
  assert.match(health, /\.rpc\("monthly_backend_health"\)/);
  assert.doesNotMatch(health, /service_role|role,email,displayName|apply_monthly_change|finalize_monthly_record|unlock_monthly_record/);
});
