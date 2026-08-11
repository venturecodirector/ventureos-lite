import { prismaUnsafe } from "./db";
import { getActiveContext } from "./session";

/**
 * Grant checks (CLAUDE.md hard rule #7): documents.* / templates.* capabilities
 * are per user per workspace, default Owner-only. Checked server-side on every
 * mutation. Owner/Admin roles carry all grants implicitly.
 */
export class GrantError extends Error {
  readonly grant: string;
  constructor(grant: string) {
    super(`Missing capability: ${grant}`);
    this.name = "GrantError";
    this.grant = grant;
    Object.setPrototypeOf(this, GrantError.prototype);
  }
}

/** Pure grant resolution — Owner/Admin carry everything; others need the grant. */
export function grantAllowed(role: string, grants: string[], grant: string): boolean {
  if (role === "OWNER" || role === "ADMIN") return true;
  return grants.includes(grant);
}

async function membershipOf() {
  const { workspaceId, userId } = await getActiveContext();
  return prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true, grants: true },
  });
}

export async function hasGrant(grant: string): Promise<boolean> {
  const membership = await membershipOf();
  if (!membership) return false;
  const grants = Array.isArray(membership.grants) ? (membership.grants as string[]) : [];
  return grantAllowed(membership.role, grants, grant);
}

export async function requireGrant(grant: string): Promise<void> {
  if (!(await hasGrant(grant))) throw new GrantError(grant);
}

export async function isOwner(): Promise<boolean> {
  const membership = await membershipOf();
  return membership?.role === "OWNER";
}

export async function requireOwner(): Promise<void> {
  if (!(await isOwner())) throw new GrantError("owner");
}
