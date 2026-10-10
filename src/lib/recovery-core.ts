export const RECOVERY_CALLBACK_URL = "http://127.0.0.1:3005/auth/callback";
export const RECOVERY_RESET_URL = "http://127.0.0.1:3005/auth/reset-password";
export const RECOVERY_COOKIE = "minnano-recovery-flow";

export type RecoveryServiceState = "ready" | "not_configured" | "public_config_rejected" | "unavailable" | "network";
export type RecoveryServiceDisplayState = RecoveryServiceState | "checking";
export type RecoveryRequestFailure = "client_not_ready" | "request_rejected" | "public_config_rejected" | "unavailable" | "network";
export type RecoveryCallbackStage = "code_missing" | "code_rejected" | "exchange_failed" | "allowlist_failed" | "ready";

export type RecoveryCallbackResult = {
  stage: RecoveryCallbackStage;
  codePresent: boolean;
  exchangeSuccess: boolean;
  allowlistSuccess: boolean;
};

export async function runRecoveryPkceCallback(
  code: string | null | undefined,
  exchange: (authCode: string) => Promise<{ error: unknown | null }>,
  verifyAllowlistedSession: () => Promise<void>,
): Promise<RecoveryCallbackResult> {
  if (!code) return { stage: "code_missing", codePresent: false, exchangeSuccess: false, allowlistSuccess: false };
  if (code.length > 2048) return { stage: "code_rejected", codePresent: true, exchangeSuccess: false, allowlistSuccess: false };
  try {
    const result = await exchange(code);
    if (result.error) return { stage: "exchange_failed", codePresent: true, exchangeSuccess: false, allowlistSuccess: false };
  } catch {
    return { stage: "exchange_failed", codePresent: true, exchangeSuccess: false, allowlistSuccess: false };
  }
  try {
    await verifyAllowlistedSession();
    return { stage: "ready", codePresent: true, exchangeSuccess: true, allowlistSuccess: true };
  } catch {
    return { stage: "allowlist_failed", codePresent: true, exchangeSuccess: true, allowlistSuccess: false };
  }
}

export async function checkRecoveryAuthSettings(
  fetcher: typeof fetch,
  url: string | undefined,
  anonKey: string | undefined,
): Promise<RecoveryServiceState> {
  if (!url || !anonKey) return "not_configured";
  try {
    const response = await fetcher(`${url.replace(/\/+$/, "")}/auth/v1/settings`, {
      method: "GET",
      headers: { apikey: anonKey },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (response.ok) return "ready";
    if (response.status === 401 || response.status === 403) return "public_config_rejected";
    if (response.status === 429 || response.status >= 500) return "unavailable";
    return "public_config_rejected";
  } catch {
    return "network";
  }
}

export function classifyRecoveryRequestFailure(error: unknown): RecoveryRequestFailure {
  let status: unknown;
  let name: unknown;
  let causeCode: unknown;
  if (typeof error === "object" && error !== null) {
    try {
      status = (error as { status?: unknown }).status;
      name = (error as { name?: unknown }).name;
      causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
    } catch {
      return "client_not_ready";
    }
  }
  if (name === "AuthRetryableFetchError" || status === 0 || ["ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "ENETUNREACH"].includes(String(causeCode))) return "network";
  if (status === 401 || status === 403) return "public_config_rejected";
  if (status === 429 || status === 408 || status === 502 || status === 503 || status === 504 || (typeof status === "number" && status >= 500)) return "unavailable";
  if (typeof status === "number" && status >= 400) return "request_rejected";
  return "client_not_ready";
}

export function recoveryRequestCanRetry(failure: RecoveryRequestFailure): boolean {
  return failure === "client_not_ready" || failure === "request_rejected" || failure === "public_config_rejected";
}

export function recoveryEmailRequestDisabled(pending: boolean, attempted: boolean): boolean {
  return pending || attempted;
}

export function recoveryAttemptedAfterFailure(failure: RecoveryRequestFailure): boolean {
  return !recoveryRequestCanRetry(failure);
}

export function hasRecoveryProof(marker: string | undefined, verifiedUser: boolean): boolean {
  return marker === "active" && verifiedUser;
}

export function recoveryPasswordsMatch(password: string, confirmation: string): boolean {
  return password.length > 0 && password === confirmation;
}

export async function updatePasswordWithRecoveryProof(
  proofValid: boolean,
  updateUser: () => Promise<{ error: unknown | null }>,
): Promise<{ status: "updated" } | { status: "recovery_required" } | { status: "failed"; error: unknown }> {
  if (!proofValid) return { status: "recovery_required" };
  try {
    const result = await updateUser();
    return result.error ? { status: "failed", error: result.error } : { status: "updated" };
  } catch (error) {
    return { status: "failed", error };
  }
}
