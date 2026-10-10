import { ROLES, type Role } from "./roles.ts";

export type AuthenticatedIdentity = { id: string };
export type AllowlistedUser = {
  id: string;
  supabaseUserId: string;
  email: string;
  displayName: string;
  role: string;
};
export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
};

/** Maps only a verified Auth identity to an explicitly allowlisted application user. */
export function resolveSessionUser(
  identity: AuthenticatedIdentity | null,
  allowlistedUser: AllowlistedUser | null,
): SessionUser | null {
  if (!identity || typeof identity.id !== "string" || !identity.id || !allowlistedUser ||
      typeof allowlistedUser.id !== "string" || !allowlistedUser.id ||
      typeof allowlistedUser.supabaseUserId !== "string" ||
      typeof allowlistedUser.email !== "string" ||
      typeof allowlistedUser.displayName !== "string" ||
      identity.id !== allowlistedUser.supabaseUserId) return null;
  if (allowlistedUser.role !== ROLES.ALBA_ADMIN && allowlistedUser.role !== ROLES.EARNES) return null;
  return {
    id: allowlistedUser.id,
    email: allowlistedUser.email,
    displayName: allowlistedUser.displayName,
    role: allowlistedUser.role,
  };
}

/** Resolve an Auth identity through a server-only allowlist reader; lookup errors fail closed. */
export async function resolveSessionUserFromAllowlist(
  identity: AuthenticatedIdentity | null,
  findAllowlistedUser: (supabaseUserId: string) => Promise<AllowlistedUser | null>,
): Promise<SessionUser | null> {
  if (!identity || typeof identity.id !== "string" || !identity.id) return null;
  try {
    return resolveSessionUser(identity, await findAllowlistedUser(identity.id));
  } catch {
    return null;
  }
}
