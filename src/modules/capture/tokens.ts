import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prismaUnsafe } from "@/lib/db";

/**
 * Personal capture tokens (P1/1e).
 *
 * The extension runs on linkedin.com, so it cannot present the app's session
 * cookie — cross-site cookies are exactly what SameSite exists to stop. A
 * per-user bearer token is the credential instead: created in Settings, shown
 * once, hashed at rest, revocable, and carrying the workspace it belongs to.
 *
 * Hashed rather than stored: a leaked database dump must not hand someone the
 * ability to write leads into a workspace.
 */
const PREFIX = "vos_cap_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Generate a token. The plaintext is returned once and never stored. */
export async function createCaptureToken(
  userId: string,
  workspaceId: string,
  label?: string,
): Promise<{ token: string; id: string }> {
  const token = `${PREFIX}${randomBytes(24).toString("base64url")}`;
  const row = await prismaUnsafe.captureToken.create({
    data: { userId, workspaceId, tokenHash: hashToken(token), label: label ?? null },
  });
  return { token, id: row.id };
}

export interface CaptureIdentity {
  userId: string;
  workspaceId: string;
  tokenId: string;
}

/**
 * Resolve a bearer token. Returns null for anything unusable — unknown,
 * revoked, or malformed — without saying which, so the endpoint cannot be used
 * to probe for valid tokens.
 */
export async function resolveCaptureToken(
  raw: string | null | undefined,
): Promise<CaptureIdentity | null> {
  const token = (raw ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith(PREFIX) || token.length < PREFIX.length + 20) return null;

  const row = await prismaUnsafe.captureToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, workspaceId: true, revokedAt: true, tokenHash: true },
  });
  if (!row || row.revokedAt) return null;

  // The lookup is already by hash, so this is belt-and-braces against a
  // theoretical hash collision, done in constant time out of habit.
  const a = Buffer.from(row.tokenHash, "hex");
  const b = Buffer.from(hashToken(token), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Fire-and-forget: a last-used stamp must not slow the capture down.
  void prismaUnsafe.captureToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { userId: row.userId, workspaceId: row.workspaceId, tokenId: row.id };
}
