import { redirect, unstable_rethrow } from "next/navigation";
import { currentSessionToken } from "./auth";
import { resolveSession, setSessionWorkspace } from "./auth/sessions";
import { prismaUnsafe } from "./db";
import { setRequestUser } from "./request-user";

export interface ActiveContext {
  workspaceId: string;
  userId: string;
  sessionId: string;
}

/**
 * Active session context (spec §7).
 *
 * Identity comes from the `sessions` table via the opaque token in the Auth.js
 * cookie — never from a client-writable value. There is NO fallback: an
 * unauthenticated request is redirected to /login. (This replaced a pre-auth
 * stand-in that read the user id straight from a `vos_user` cookie, which meant
 * anyone who could reach the app was the Owner. Do not reintroduce a fallback
 * here; background jobs pass their workspace id explicitly instead.)
 *
 * TENANCY INVARIANT: the returned workspace is ALWAYS one the user is a member
 * of. A session pointing at a workspace the user no longer belongs to is
 * ignored and repaired to one of their own memberships — a workspace switch can
 * never cross into another tenant. Enforced here, on top of the Prisma guard
 * and RLS.
 */
export async function tryGetActiveContext(): Promise<ActiveContext | null> {
  const token = await currentSessionToken();
  const session = await resolveSession(token);
  if (!session) return null;

  const memberships = await prismaUnsafe.membership.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "asc" },
    select: { workspaceId: true },
  });
  if (memberships.length === 0) return null;

  // Hand the acting user to the row-level-security policies (src/lib/rls.ts).
  // Set here because this is the one place every authenticated path passes
  // through, and because an unset value degrades safely to workspace-only.
  setRequestUser(session.userId);

  const memberWsIds = new Set(memberships.map((m) => m.workspaceId));
  const stored = session.workspaceId;
  if (stored && memberWsIds.has(stored)) {
    return { workspaceId: stored, userId: session.userId, sessionId: session.sessionId };
  }

  // Session points nowhere valid (revoked membership, deleted workspace, or a
  // brand-new session): fall back to their own first workspace and repair it.
  const workspaceId = memberships[0].workspaceId;
  await setSessionWorkspace(session.sessionId, workspaceId).catch(() => {
    /* repair is best-effort; the returned context is already safe */
  });
  return { workspaceId, userId: session.userId, sessionId: session.sessionId };
}

/**
 * The context every page and server action uses. Redirects to /login when
 * there is no live session.
 *
 * Redirecting here rather than throwing matters: middleware can only see that a
 * cookie EXISTS (it runs on the edge, with no database), so a revoked or
 * expired session still reaches the page. Without this, that combination
 * rendered a 500 instead of a login form.
 *
 * `redirect()` signals by throwing a NEXT_REDIRECT error. Callers that wrap
 * this in try/catch must `unstable_rethrow(e)` first — see `src/lib/authz.ts`.
 */
export async function getActiveContext(): Promise<ActiveContext> {
  const ctx = await tryGetActiveContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/** Thrown by `tryGetActiveContextOrThrow` when there is no live session. */
export class UnauthenticatedError extends Error {
  constructor(message = "Not signed in.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/**
 * For route handlers, which must answer with a status code rather than a
 * redirect — a `fetch()` or an <img> cannot do anything useful with a login
 * page, and following the redirect would hand the caller HTML where it expected
 * a file. Callers catch this and return 401.
 */
export async function tryGetActiveContextOrThrow(): Promise<ActiveContext> {
  const ctx = await tryGetActiveContext();
  if (!ctx) throw new UnauthenticatedError();
  return ctx;
}

/** Re-export so callers do not need to reach into next/navigation themselves. */
export { unstable_rethrow };
