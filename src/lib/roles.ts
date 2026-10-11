export const ROLES = {
  ALBA_ADMIN: "ALBA_ADMIN",
  EARNES: "EARNES",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const canEditFinancials = (role: Role) => role === ROLES.ALBA_ADMIN;
export const canUnlockClosing = (role: Role) => role === ROLES.ALBA_ADMIN;
export const canEditMembershipStats = (role: Role) =>
  role === ROLES.EARNES || role === ROLES.ALBA_ADMIN;
