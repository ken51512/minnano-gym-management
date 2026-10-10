import { resolveSessionUser, type AllowlistedUser } from "./auth-core";
import type { Role } from "./roles";
import { createRequestSupabaseClient } from "./supabase-server.ts";
import { SafeSupabaseOperationError, classifySupabaseFailure } from "./supabase-health-core.ts";

export type SessionUser = { id: string; email: string; displayName: string; role: Role };
export class AuthenticationError extends Error {}
export class AuthorizationError extends Error {}

/** Supabase Auth is authoritative; client cookies and user metadata are not trusted. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  try {
    return await getCurrentUserOrThrow();
  } catch {
    return null;
  }
}

/** Verifies the current cookie session with Supabase Auth and resolves its DB allowlist role. */
export async function getCurrentUserOrThrow(existingSupabase?: ReturnType<typeof createRequestSupabaseClient>): Promise<SessionUser> {
  let supabase: ReturnType<typeof createRequestSupabaseClient>;
  if (existingSupabase) {
    supabase = existingSupabase;
  } else {
    try {
      supabase = createRequestSupabaseClient({ writeCookies: true });
    } catch {
      throw new SafeSupabaseOperationError("unavailable", "auth_session");
    }
  }
  let identity: { id: string } | null = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw new SafeSupabaseOperationError(classifySupabaseFailure(error), "auth_session");
    identity = data.user ? { id: data.user.id } : null;
  } catch (error) {
    if (error instanceof SafeSupabaseOperationError) throw error;
    throw new SafeSupabaseOperationError(classifySupabaseFailure(error), "auth_session");
  }
  if (!identity) throw new SafeSupabaseOperationError("unauthenticated", "auth_session");

  let allowlistedUser: AllowlistedUser | null;
  try {
    const { data, error } = await supabase
      .from("User")
      .select("id,supabaseUserId,email,displayName,role")
      .eq("supabaseUserId", identity.id)
      .maybeSingle();
    if (error) throw new SafeSupabaseOperationError(classifySupabaseFailure(error), "allowlist_lookup");
    allowlistedUser = data as AllowlistedUser | null;
  } catch (error) {
    if (error instanceof SafeSupabaseOperationError) throw error;
    throw new SafeSupabaseOperationError(classifySupabaseFailure(error), "allowlist_lookup");
  }
  const user = resolveSessionUser(identity, allowlistedUser);
  if (!user) throw new SafeSupabaseOperationError("forbidden", "role_check");
  return user;
}

export async function requireUser(): Promise<SessionUser> {
  try {
    return await getCurrentUserOrThrow();
  } catch (error) {
    if (error instanceof SafeSupabaseOperationError && error.code === "unauthenticated") {
      throw new AuthenticationError("Authentication required");
    }
    if (error instanceof SafeSupabaseOperationError && error.code === "forbidden") {
      throw new AuthorizationError("Not authorized");
    }
    throw error;
  }
}

export async function requireRole(...allowedRoles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!allowedRoles.includes(user.role)) throw new AuthorizationError("Not authorized");
  return user;
}
