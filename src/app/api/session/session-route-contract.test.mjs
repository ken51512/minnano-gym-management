import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../../../legacy-server-routes/api/session/route.ts", import.meta.url), "utf8");
const auth = readFileSync(new URL("../../../lib/auth.ts", import.meta.url), "utf8");

test("password login is server-only, same-origin, cookie-backed, and verifies the allowlist", () => {
  assert.match(route, /isValidSameOriginPost\(request\)/);
  assert.match(route, /signInWithPassword\(\{ email: email\.trim\(\), password \}\)/);
  assert.match(route, /passwordSignInFailure\(error\)/);
  assert.match(route, /stage: "request_origin"/);
  assert.match(route, /stage: failure\.stage/);
  assert.match(route, /createRequestSupabaseClient\(\{ writeCookies: true \}\)/);
  assert.match(route, /setSession\(\{ access_token: data\.session\.access_token, refresh_token: data\.session\.refresh_token \}\)/);
  assert.match(route, /getCurrentUserOrThrow\(\)/);
  assert.match(route, /supabase\.auth\.signOut\(\{ scope: "local" \}\)/);
  assert.match(route, /Object\.keys\(input\)\.length !== 2/);
  assert.doesNotMatch(route, /signUp\s*\(/);
  assert.doesNotMatch(route, /console\.(?:log|error|warn)\s*\(/);
  assert.match(auth, /auth\.getUser\(\)/);
  assert.match(auth, /from\("User"\)/);
  assert.match(auth, /resolveSessionUser\(identity, allowlistedUser\)/);
  assert.match(route, /user: \{ id: user\.id, role: user\.role, displayName: user\.displayName \}/);
  assert.doesNotMatch(route, /user:\s*\{[^}]*\b(?:email|supabaseUserId|access_token|refresh_token):/);
  assert.doesNotMatch(route, /console\.(?:log|error|warn)\s*\(/);
});

test("session endpoint sends no credential or provider error payloads and disables caching", () => {
  assert.match(route, /Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /JSON\.stringify\(error\)|message: error\.message/);
  assert.doesNotMatch(route, /NextResponse\.json\([^\n]*(?:access_token|refresh_token|password)/);
});
