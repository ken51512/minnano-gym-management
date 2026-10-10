"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

/** The static app uses only the public Supabase client; Auth, RLS, and RPCs authorize every operation. */
export function createBrowserSupabaseClient(headers?: Record<string, string>): SupabaseClient {
  if (typeof window === "undefined") throw new Error("Browser client is unavailable");
  if (!client && !headers) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Supabase browser configuration is missing");
    client = createClient(url, key, {
      auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    });
  }
  if (headers) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Supabase browser configuration is missing");
    return createClient(url, key, {
      auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
      global: { headers },
    });
  }
  return client!;
}

/** Backwards-compatible recovery name; recovery uses the shared browser client. */
export const createRecoveryBrowserClient = createBrowserSupabaseClient;
