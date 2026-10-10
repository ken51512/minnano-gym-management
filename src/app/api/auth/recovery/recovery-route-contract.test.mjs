import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const recovery = readFileSync(new URL("../../../auth/recovery/page.tsx", import.meta.url), "utf8");
const callback = readFileSync(new URL("../../../auth/callback/page.tsx", import.meta.url), "utf8");
const reset = readFileSync(new URL("../../../auth/reset-password/page.tsx", import.meta.url), "utf8");
const complete = readFileSync(new URL("../../../../legacy-server-routes/api/auth/recovery/complete/route.ts", import.meta.url), "utf8");
const session = readFileSync(new URL("../../../../legacy-server-routes/api/auth/recovery/session/route.ts", import.meta.url), "utf8");

test("recovery email request is fixed, generic, and protected against repeated clicks", () => {
  assert.match(recovery, /resetPasswordForEmail\(email\.trim\(\), \{ redirectTo: appAbsoluteUrl\(window\.location\.origin, "\/auth\/callback\/"\) \}\)/);
  assert.match(recovery, /pending \|\| attempted/);
  assert.match(recovery, /該当するアカウントがある場合/);
  assert.doesNotMatch(recovery, /console\.(?:log|error|warn)\s*\(/);
  assert.match(recovery, /checkRecoveryAuthSettings\(fetch/);
  assert.match(recovery, /recoveryEmailRequestDisabled\(pending, attempted\)/);
  assert.match(recovery, /recoveryAttemptedAfterFailure\(/);
  assert.doesNotMatch(recovery, /api\/health/);
});

test("static PKCE callback exchanges code then redirects only to a fixed reset route", () => {
  assert.match(callback, /runRecoveryPkceCallback\(\s*code,/);
  assert.match(callback, /exchangeCodeForSession/);
  assert.match(callback, /sessionStorage\.setItem\(RECOVERY_MARKER, "active"\)/);
  assert.match(callback, /window\.location\.replace\(appPath\("\/auth\/reset-password\/"\)\)/);
  assert.doesNotMatch(callback, /console\.(?:log|error|warn)\s*\(/);
  assert.doesNotMatch(callback, /console\.(?:info|debug)\([^\n]*(?:error|message|url|cookie|session|token)/i);
  assert.doesNotMatch(callback, /searchParams\.get\(['"](?:returnTo|next)['"]\)/);
  assert.doesNotMatch(callback, /location\.hash|access_token|refresh_token/);
});

test("password update requires an Auth-verified recovery marker and stores no password", () => {
  assert.match(complete, /isValidSameOriginPost\(request\)/);
  assert.match(complete, /hasRecoveryProof\(/);
  assert.match(complete, /getCurrentUserOrThrow\(\)/);
  assert.match(complete, /updateUser\(\{ password: input\.password as string \}\)/);
  assert.match(session, /hasRecoveryProof\(/);
  assert.match(reset, /recoveryPasswordsMatch\(password, confirmation\)/);
  assert.match(reset, /hasRecoveryProof\(/);
  assert.match(reset, /auth\.updateUser\(\{ password \}\)/);
  assert.doesNotMatch(complete + callback + reset, /console\.(?:log|error|warn)\s*\(/);
  assert.doesNotMatch(complete, /prisma\.|from\(['"]User['"]\).*update/);
});
