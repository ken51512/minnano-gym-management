export type HealthFailureCode =
  | "network"
  | "unauthenticated"
  | "forbidden"
  | "unavailable"
  | "error";

export type AuthDiagnosticStage = "request_origin" | "auth_signin" | "auth_session" | "allowlist_lookup" | "role_check";

export class SafeSupabaseOperationError extends Error {
  readonly code: HealthFailureCode;
  readonly stage: AuthDiagnosticStage;

  constructor(code: HealthFailureCode, stage: AuthDiagnosticStage = "auth_session") {
    super("Supabase operation failed");
    this.name = "SafeSupabaseOperationError";
    this.code = code;
    this.stage = stage;
  }
}

export type HealthProbeState =
  | { status: "ok" }
  | { status: "not_checked" }
  | { status: "error"; code: HealthFailureCode };

export type SupabaseHealthReport = {
  overall: "ok" | "unauthenticated" | "degraded";
  auth: HealthProbeState;
  database: HealthProbeState;
  rpc: HealthProbeState;
};

export type SupabaseHealthProbes = {
  auth(): Promise<{ userId: string | null; error: unknown | null }>;
  readAllowlist(supabaseUserId: string): Promise<{
    appUserId: string | null;
    supabaseUserId: string | null;
    error: unknown | null;
  }>;
  rpc(): Promise<{ error: unknown | null }>;
};

const networkCodes = new Set([
  "ECONNRESET", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "ENOTFOUND",
  "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

function errorField(error: unknown, field: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    return (error as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

/** Convert SDK/HTTP/SQL errors into a closed set of safe labels; never return messages. */
export function classifySupabaseFailure(error: unknown): HealthFailureCode {
  const name = errorField(error, "name");
  const code = errorField(error, "code");
  const status = errorField(error, "status");
  const causeCode = errorField(errorField(error, "cause"), "code");

  if (code === "network" || code === "unauthenticated" || code === "forbidden" || code === "unavailable" || code === "error") return code;

  if (name === "AuthSessionMissingError" || name === "AuthInvalidCredentialsError" ||
      code === "session_not_found" || code === "refresh_token_not_found" ||
      code === "invalid_grant" || code === "invalid_credentials" || code === "bad_jwt" ||
      code === "token_expired" || status === 401) return "unauthenticated";
  if (status === 403 || code === "42501") return "forbidden";
  if (name === "AuthRetryableFetchError" || status === 0 ||
      (typeof causeCode === "string" && networkCodes.has(causeCode))) return "network";
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504 ||
      code === "PGRST000" || code === "PGRST001" || code === "PGRST002" || code === "PGRST003" ||
      code === "PGRST202" || code === "42883") return "unavailable";
  return "error";
}

function failed(error: unknown): HealthProbeState {
  return { status: "error", code: classifySupabaseFailure(error) };
}

export async function checkSupabaseHealthWith(probes: SupabaseHealthProbes): Promise<SupabaseHealthReport> {
  let authResult: Awaited<ReturnType<SupabaseHealthProbes["auth"]>>;
  try {
    authResult = await probes.auth();
  } catch (error) {
    const auth = failed(error);
    const overall = auth.status === "error" && auth.code === "unauthenticated" ? "unauthenticated" : "degraded";
    return { overall, auth, database: { status: "not_checked" }, rpc: { status: "not_checked" } };
  }
  if (authResult.error) {
    const auth = failed(authResult.error);
    const overall = auth.status === "error" && auth.code === "unauthenticated" ? "unauthenticated" : "degraded";
    return { overall, auth, database: { status: "not_checked" }, rpc: { status: "not_checked" } };
  }
  if (!authResult.userId) {
    return {
      overall: "unauthenticated",
      auth: { status: "error", code: "unauthenticated" },
      database: { status: "not_checked" },
      rpc: { status: "not_checked" },
    };
  }

  const auth: HealthProbeState = { status: "ok" };
  let database: HealthProbeState;
  try {
    const result = await probes.readAllowlist(authResult.userId);
    if (result.error) database = failed(result.error);
    else if (!result.appUserId || result.supabaseUserId !== authResult.userId) {
      database = { status: "error", code: "forbidden" };
    } else database = { status: "ok" };
  } catch (error) {
    database = failed(error);
  }

  let rpc: HealthProbeState;
  try {
    const result = await probes.rpc();
    rpc = result.error ? failed(result.error) : { status: "ok" };
  } catch (error) {
    rpc = failed(error);
  }

  return {
    overall: database.status === "ok" && rpc.status === "ok" ? "ok" : "degraded",
    auth,
    database,
    rpc,
  };
}
