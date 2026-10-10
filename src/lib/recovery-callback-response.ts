import { NextResponse } from "next/server.js";
import { RECOVERY_COOKIE, RECOVERY_RESET_URL, type RecoveryCallbackResult } from "./recovery-core.ts";

const INVALID_RECOVERY_URL = "http://127.0.0.1:3005/auth/recovery?state=invalid";

export function createRecoveryCallbackRedirect(result: RecoveryCallbackResult, requestUrl: string): NextResponse {
  const success = result.stage === "ready" && result.exchangeSuccess && result.allowlistSuccess;
  const response = NextResponse.redirect(success ? RECOVERY_RESET_URL : INVALID_RECOVERY_URL, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(RECOVERY_COOKIE, success ? "active" : "", {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(requestUrl).protocol === "https:",
    path: "/",
    ...(success ? { maxAge: 600 } : { maxAge: 0 }),
  });
  return response;
}
