import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { createRequestSupabaseClient } from "@/lib/supabase-server";
import { hasRecoveryProof, RECOVERY_COOKIE, updatePasswordWithRecoveryProof } from "@/lib/recovery-core";
import { isValidSameOriginPost } from "@/lib/auth-route-core";
import { classifySupabaseFailure } from "@/lib/supabase-health-core";

export const dynamic = "force-dynamic";

function failure(code: string, status: number) {
  return NextResponse.json({ status: "error", code }, { status, headers: { "Cache-Control": "no-store" } });
}

function clearRecoveryMarker() {
  cookies().set(RECOVERY_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

export async function POST(request: Request) {
  if (!isValidSameOriginPost(request)) return failure("forbidden", 403);
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 8192) return failure("invalid_request", 413);

  let body: unknown;
  try { body = await request.json(); } catch { return failure("invalid_request", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return failure("invalid_request", 400);
  const input = body as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "password") || typeof input.password !== "string" || !input.password || input.password.length > 1024) return failure("invalid_request", 400);
  if (!hasRecoveryProof(cookies().get(RECOVERY_COOKIE)?.value, true)) return failure("recovery_required", 401);

  try {
    await getCurrentUserOrThrow();
  } catch (error) {
    clearRecoveryMarker();
    const classification = classifySupabaseFailure(error);
    if (classification === "network" || classification === "unavailable") return failure("unavailable", 503);
    if (classification === "forbidden") return failure("not_allowed", 403);
    return failure("recovery_invalid", 401);
  }

  const supabase = createRequestSupabaseClient({ writeCookies: true });
  const updated = await updatePasswordWithRecoveryProof(
    hasRecoveryProof(cookies().get(RECOVERY_COOKIE)?.value, true),
    () => supabase.auth.updateUser({ password: input.password as string }),
  );
  if (updated.status !== "updated") {
    if (updated.status === "recovery_required") return failure("recovery_required", 401);
    const classification = classifySupabaseFailure(updated.error);
    if (classification === "unauthenticated") {
      clearRecoveryMarker();
      try { await supabase.auth.signOut({ scope: "local" }); } catch { /* Invalid recovery remains denied. */ }
      return failure("recovery_invalid", 401);
    }
    if (classification === "network" || classification === "unavailable") return failure("unavailable", 503);
    if (classification === "forbidden") return failure("not_allowed", 403);
    return failure("password_rejected", 400);
  }

  clearRecoveryMarker();
  try { await supabase.auth.signOut({ scope: "local" }); } catch { /* Password update already succeeded. */ }
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
