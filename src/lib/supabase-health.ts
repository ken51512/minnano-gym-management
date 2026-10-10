import "server-only";

import { createRequestSupabaseClient } from "./supabase-server.ts";
import { checkSupabaseHealthWith } from "./supabase-health-core.ts";

/** Authenticated, read-only probes. No user, role, business row, URL, or SDK error is returned. */
export async function checkSupabaseHealth() {
  let supabase: ReturnType<typeof createRequestSupabaseClient> | undefined;
  const client = () => supabase ?? (supabase = createRequestSupabaseClient());

  return checkSupabaseHealthWith({
    async auth() {
      const { data, error } = await client().auth.getUser();
      return { userId: data.user?.id ?? null, error };
    },
    async readAllowlist(supabaseUserId) {
      const { data, error } = await client()
        .from("User")
        .select("id,supabaseUserId")
        .eq("supabaseUserId", supabaseUserId)
        .maybeSingle();
      return {
        appUserId: typeof data?.id === "string" ? data.id : null,
        supabaseUserId: typeof data?.supabaseUserId === "string" ? data.supabaseUserId : null,
        error,
      };
    },
    async rpc() {
      const { error } = await client().rpc("monthly_backend_health");
      return { error };
    },
  });
}
