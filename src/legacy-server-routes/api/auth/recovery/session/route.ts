import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { RECOVERY_COOKIE, hasRecoveryProof } from "@/lib/recovery-core";
import { SafeSupabaseOperationError, classifySupabaseFailure } from "@/lib/supabase-health-core";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = cookies();
  if (!hasRecoveryProof(store.get(RECOVERY_COOKIE)?.value, true)) {
    return NextResponse.json({ status: "error", code: "recovery_required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    await getCurrentUserOrThrow();
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    store.set(RECOVERY_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
    return NextResponse.json({ status: "error", code: "recovery_invalid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
}
