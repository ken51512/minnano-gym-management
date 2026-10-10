import { NextResponse } from "next/server";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { createPasswordSignInClient, createRequestSupabaseClient } from "@/lib/supabase-server";
import { isValidSameOriginPost, loginReturnPath, passwordSignInFailure, safeRouteFailure } from "@/lib/auth-route-core";
import { SafeSupabaseOperationError } from "@/lib/supabase-health-core";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getCurrentUserOrThrow();
    return NextResponse.json({ status: "ok", user: { id: user.id, role: user.role, displayName: user.displayName } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const failure = safeRouteFailure(error, error instanceof SafeSupabaseOperationError ? error.stage : "auth_session");
    return NextResponse.json({ status: "error", code: failure.code, stage: failure.stage }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  if (!isValidSameOriginPost(request)) {
    return NextResponse.json({ status: "error", code: "forbidden", stage: "request_origin" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 8192) return NextResponse.json({ status: "error", code: "invalid_request", stage: "auth_signin" }, { status: 413, headers: { "Cache-Control": "no-store" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", code: "invalid_request", stage: "auth_signin" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ status: "error", code: "invalid_request", stage: "auth_signin" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "email") || !Object.hasOwn(input, "password")) {
    return NextResponse.json({ status: "error", code: "invalid_request", stage: "auth_signin" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const { email, password } = input;
  if (typeof email !== "string" || !email.trim() || email.length > 320 || typeof password !== "string" || !password || password.length > 1024) {
    return NextResponse.json({ status: "error", code: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const authClient = createPasswordSignInClient();
    const { data, error } = await authClient.auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data.user || !data.session) {
      const failure = passwordSignInFailure(error);
      return NextResponse.json({ status: "error", code: failure.code, stage: failure.stage }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
    }

    let supabase: ReturnType<typeof createRequestSupabaseClient>;
    try {
      supabase = createRequestSupabaseClient({ writeCookies: true });
      const { error: setSessionError } = await supabase.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
      if (setSessionError) throw setSessionError;
    } catch (error) {
      const failure = safeRouteFailure(error, "auth_session");
      return NextResponse.json({ status: "error", code: failure.code, stage: failure.stage }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
    }
    try {
      // Reuse the client whose in-memory session was just established. A new
      // request-bound client can still see only the request-start cookies.
      const user = await getCurrentUserOrThrow(supabase);
      return NextResponse.json({ status: "ok", user: { id: user.id, role: user.role, displayName: user.displayName }, returnTo: loginReturnPath(new URL(request.url).searchParams.get("returnTo")) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      try { await supabase.auth.signOut({ scope: "local" }); } catch { /* Failed validation remains denied even if provider sign-out is unavailable. */ }
      const stage = error instanceof SafeSupabaseOperationError ? error.stage : "auth_session";
      const failure = safeRouteFailure(error, stage);
      return NextResponse.json({ status: "error", code: failure.code, stage: failure.stage }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
    }
  } catch (error) {
    const failure = safeRouteFailure(error, "auth_signin");
    return NextResponse.json({ status: "error", code: failure.code, stage: failure.stage }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
  }
}
