import { getCurrentUserOrThrow } from "@/lib/auth";
import { createRequestSupabaseClient } from "@/lib/supabase-server";
import { SafeSupabaseOperationError } from "@/lib/supabase-health-core";
import { runRecoveryPkceCallback } from "@/lib/recovery-core";
import { createRecoveryCallbackRedirect } from "@/lib/recovery-callback-response";

export const dynamic = "force-dynamic";

function safeQueryKeyNames(request: Request): string[] {
  const names = new Set<string>();
  for (const key of new URL(request.url).searchParams.keys()) {
    names.add(/^[a-zA-Z0-9_.-]{1,40}$/.test(key) ? key : "other");
  }
  return [...names].slice(0, 16);
}

function recordRecoveryStage(stage: string, details: Record<string, unknown> = {}) {
  console.info("[recovery-callback]", JSON.stringify({ stage, ...details }));
}

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  recordRecoveryStage("callback_received", { queryKeyNames: safeQueryKeyNames(request), codePresent: Boolean(code) });
  let supabase: ReturnType<typeof createRequestSupabaseClient> | undefined;
  let verificationStage = "not_reached";
  const result = await runRecoveryPkceCallback(code, async (authCode) => {
    supabase = createRequestSupabaseClient({ writeCookies: true });
    return await supabase.auth.exchangeCodeForSession(authCode);
  }, async () => {
    try {
      await getCurrentUserOrThrow();
      verificationStage = "verified";
    } catch (error) {
      verificationStage = error instanceof SafeSupabaseOperationError
        ? (error.stage === "auth_session" || error.stage === "allowlist_lookup" || error.stage === "role_check" ? error.stage : "verification_error")
        : "verification_error";
      throw error;
    }
  });

  recordRecoveryStage(result.stage, {
    codePresent: result.codePresent,
    exchangeSuccess: result.exchangeSuccess,
    allowlistSuccess: result.allowlistSuccess,
    verificationStage,
  });

  if ((result.stage === "exchange_failed" || result.stage === "allowlist_failed") && supabase) {
    try { await supabase.auth.signOut({ scope: "local" }); } catch { /* Invalid recovery remains denied. */ }
  }

  const response = createRecoveryCallbackRedirect(result, request.url);
  recordRecoveryStage(result.stage === "ready" ? "recovery_marker_set" : "recovery_marker_cleared", { success: true });
  return response;
}
