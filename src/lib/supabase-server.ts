import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  return { url, key };
}

/** Create the request-bound Supabase client using only the public anon key. */
export function createRequestSupabaseClient(options: { writeCookies?: boolean; headers?: Record<string, string> } = {}) {
  const { url, key } = supabaseConfig();
  const cookieStore = cookies();
  return createServerClient(url, key, {
    global: options.headers ? { headers: options.headers } : undefined,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        if (options.writeCookies) cookiesToSet.forEach(({ name, value, options: cookieOptions }) => cookieStore.set(name, value, cookieOptions));
      },
    },
  });
}

/** Password sign-in transport; persistence and cookie writes stay inside the server route. */
export function createPasswordSignInClient() {
  const { url, key } = supabaseConfig();
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
