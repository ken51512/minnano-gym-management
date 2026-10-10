import { classifySupabaseFailure, type AuthDiagnosticStage, type HealthFailureCode } from "./supabase-health-core.ts";

export type RouteFailure = { code: HealthFailureCode; status: number; stage: AuthDiagnosticStage };

export function safeRouteFailure(error: unknown, stage: AuthDiagnosticStage = "auth_session"): RouteFailure {
  const classified = classifySupabaseFailure(error);
  const code = classified === "unauthenticated" || classified === "forbidden" || classified === "network" || classified === "unavailable"
    ? classified
    : "error";
  const status = code === "unauthenticated" ? 401
    : code === "forbidden" ? 403
      : code === "network" || code === "unavailable" ? 503 : 500;
  return { code, status, stage };
}

export function passwordSignInFailure(error: unknown | null): RouteFailure {
  const classified = classifySupabaseFailure(error ?? { status: 401 });
  if (classified === "network" || classified === "unavailable") return { code: classified, status: 503, stage: "auth_signin" };
  return { code: "unauthenticated", status: 401, stage: "auth_signin" };
}

export function isTrustedSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const suppliedOrigin = new URL(origin);
    const requestUrl = new URL(request.url);
    if (suppliedOrigin.origin === requestUrl.origin) return true;

    const loopbacks = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const isLoopback = (hostname: string) => loopbacks.has(hostname.toLowerCase());
    if (suppliedOrigin.protocol !== requestUrl.protocol || suppliedOrigin.port !== requestUrl.port ||
        !isLoopback(suppliedOrigin.hostname) || !isLoopback(requestUrl.hostname)) return false;

    // Next may expose an internal loopback alias in request.url. The direct Host must match
    // the browser Origin authority; Forwarded headers are deliberately ignored.
    const host = request.headers.get("host")?.trim().toLowerCase();
    return Boolean(host && host === suppliedOrigin.host.toLowerCase());
  } catch {
    return false;
  }
}

export function isValidSameOriginPost(request: Request): boolean {
  if (request.method !== "POST") return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return isTrustedSameOriginRequest(request);
}

export function loginReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) return "/";
  try {
    const parsed = new URL(value, "https://local.invalid");
    return parsed.origin === "https://local.invalid" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/";
  } catch {
    return "/";
  }
}
