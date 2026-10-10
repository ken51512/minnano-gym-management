import { NextResponse } from "next/server";
import { checkSupabaseHealth } from "@/lib/supabase-health";

export const dynamic = "force-dynamic";

/** Public-safe health summary: only probe states and fixed error codes, never identity or business data. */
export async function GET() {
  const report = await checkSupabaseHealth();
  const statusCode = report.overall === "ok" ? 200 : report.overall === "unauthenticated" ? 401 : 503;
  return NextResponse.json(report, {
    status: statusCode,
    headers: { "Cache-Control": "no-store" },
  });
}
