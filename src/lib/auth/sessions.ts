import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prismaUnsafe } from "../db";

/**
 * Server-side session store (CLAUDE.md → Auth: "server sessions in DB").
 *
 * Auth.js carries an opaque token in a signed cookie; this module owns what
 * that token MEANS. The database row is authoritative, so:
 *   - an Owner can revoke a session and the next request is logged out,
 *   - the active workspace lives server-side and cannot be tampered with,
 *   - only a SHA-256 hash is stored, so a dump of `sessions` yields nothing
 *     usable.
 *
 * `sessions` is a global auth table, not tenant data — `prismaUnsafe` is
 * correct here and carries no workspace scope by design.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — a working day
export const SESSION_IDLE_REFRESH_MS = 15 * 60 * 1000; // throttle lastSeenAt writes

export interface SessionUser {
  sessionId: string;
  userId: string;
  workspaceId: string | null;
}

/** Hash used for storage and lookup. Tokens are high-entropy, so a plain
 *  SHA-256 is right — no salt/stretching needed, and lookup stays indexable. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Create a session row and return the raw token (shown to the client once). */
export async function createSession(input: {
  userId: string;
  workspaceId: string | null;
  ip?: string | null;
  userAgent?: string | null;
  nowMs?: number;
}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const now = input.nowMs ?? Date.now();
  const token = generateSessionToken();
  const expiresAt = new Date(now + SESSION_TTL_MS);
  const row = await prismaUnsafe.session.create({
    data: {
      userId: input.userId,
      token: hashToken(token),
      workspaceId: input.workspaceId,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
      expiresAt,
    },
    select: { id: true },
  });
  return { token, sessionId: row.id, expiresAt };
}

/**
 * Resolve a raw token to a live session, or null.
 *
 * Rejects expired and revoked rows. Refreshes `lastSeenAt` at most every
 * SESSION_IDLE_REFRESH_MS so an active session does not write on every request.
 */
export async function resolveSession(
  token: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await prismaUnsafe.session.findUnique({
    where: { token: hashToken(token) },
    select: {
      id: true,
      userId: true,
      workspaceId: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      token: true,
    },
  });
  if (!row) return null;
  // Belt and braces against a hypothetical index/collision oddity.
  if (!constantTimeEquals(row.token, hashToken(token))) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= nowMs) return null;

  if (nowMs - row.lastSeenAt.getTime() > SESSION_IDLE_REFRESH_MS) {
    await prismaUnsafe.session
      .update({ where: { id: row.id }, data: { lastSeenAt: new Date(nowMs) } })
      .catch(() => {
        /* liveness bookkeeping only — never fail a request over it */
      });
  }
  return { sessionId: row.id, userId: row.userId, workspaceId: row.workspaceId };
}

/** Persist the active workspace on the session (server-side, untamperable). */
export async function setSessionWorkspace(
  sessionId: string,
  workspaceId: string,
): Promise<void> {
  await prismaUnsafe.session.update({
    where: { id: sessionId },
    data: { workspaceId },
  });
}

export async function revokeSession(sessionId: string, nowMs = Date.now()): Promise<void> {
  await prismaUnsafe.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(nowMs) },
  });
}

/** Revoke every session for a user — password change, 2FA change, or lockout. */
export async function revokeAllUserSessions(
  userId: string,
  opts: { exceptSessionId?: string; nowMs?: number } = {},
): Promise<number> {
  const { count } = await prismaUnsafe.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(opts.exceptSessionId ? { id: { not: opts.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(opts.nowMs ?? Date.now()) },
  });
  return count;
}

/** Housekeeping: drop rows that can never authenticate again. */
export async function pruneExpiredSessions(nowMs = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - 7 * 86_400_000);
  const { count } = await prismaUnsafe.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date(nowMs) } }, { revokedAt: { lt: cutoff } }] },
  });
  return count;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
