import { cookies } from "next/headers";
import { prismaUnsafe } from "./db";

export interface ActiveContext {
  workspaceId: string;
  userId: string;
}

export const USER_COOKIE = "vos_user";
export const WORKSPACE_COOKIE = "vos_workspace";

/**
 * Active session context (spec §7). Pre-auth stand-in: the current user and
 * selected workspace come from cookies (the Auth.js session will set these same
 * cookies when it lands — every caller uses this one function, so the swap is
 * localized). Outside a request (scripts, the worker), it falls back to the
 * seeded owner + first workspace.
 *
 * TENANCY INVARIANT: the returned workspace is ALWAYS one the user is a member
 * of. A cookie pointing at a workspace the user doesn't belong to is ignored and
 * we fall back to their own membership — a workspace switch can never cross into
 * another tenant. Enforced here, on top of the Prisma guard and RLS.
 */
export async function getActiveContext(): Promise<ActiveContext> {
  let userCookie: string | null = null;
  let wsCookie: string | null = null;
  try {
    const c = await cookies();
    userCookie = c.get(USER_COOKIE)?.value ?? null;
    wsCookie = c.get(WORKSPACE_COOKIE)?.value ?? null;
  } catch {
    /* not in a request scope — use seeded defaults below */
  }

  const user =
    (userCookie
      ? await prismaUnsafe.user.findUnique({ where: { id: userCookie }, select: { id: true } })
      : null) ??
    (await prismaUnsafe.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }));
  if (!user) throw new Error("No user provisioned — run `npm run db:seed`.");

  const memberships = await prismaUnsafe.membership.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { workspaceId: true },
  });
  const memberWsIds = new Set(memberships.map((m) => m.workspaceId));

  // Honour the cookie ONLY if the user is a member of that workspace.
  const workspaceId =
    wsCookie && memberWsIds.has(wsCookie) ? wsCookie : memberships[0]?.workspaceId;
  if (!workspaceId) throw new Error("User has no workspace membership.");

  return { workspaceId, userId: user.id };
}
