import { prismaUnsafe } from "./db";
import { tryGetActiveContext } from "./session";
import { GrantError, grantAllowed } from "./grants";

// Re-exported so existing callers keep importing them from here.
export { GrantError, grantAllowed };

/**
 * Grant checks (CLAUDE.md hard rule #7): documents.* / templates.* capabilities
 * are per user per workspace, default Owner-only. Checked server-side on every
 * mutation. Owner/Admin roles carry all grants implicitly.
 *
 * Deliberately uses the NON-redirecting context. Authorization answers a
 * question ("may this user do X?") and its callers wrap it in try/catch to turn
 * a denial into a friendly message. If this path redirected, `redirect()`'s
 * NEXT_REDIRECT signal would be swallowed by those catch blocks. No session
 * simply means no membership, which means no grant — a safe denial. Pages use
 * `getActiveContext()`, which redirects to /login.
 */
async function membershipOf() {
  const ctx = await tryGetActiveContext();
  if (!ctx) return null;
  return prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
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
