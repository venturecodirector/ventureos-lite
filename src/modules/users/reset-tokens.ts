"use server";

import { createHash } from "node:crypto";
import { z } from "zod";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { hashPassword, validatePassword } from "@/lib/auth/password";
import { revokeAllUserSessions } from "@/lib/auth/sessions";

/**
 * Consuming a one-time password-reset link.
 *
 * Deliberately separate from ./actions: this path runs for someone who is NOT
 * signed in, so it must not pull in `requireOwner` and the session stack behind
 * it. Keeping it standalone also means it can be tested directly.
 */

export interface ResetTokenState {
  valid: boolean;
  email: string | null;
  reason: "ok" | "unknown" | "used" | "expired";
}

export async function inspectResetToken(token: string): Promise<ResetTokenState> {
  const row = await prismaUnsafe.passwordResetToken.findUnique({
    where: { token: createHash("sha256").update(token).digest("hex") },
    include: { user: { select: { email: true } } },
  });
  if (!row) return { valid: false, email: null, reason: "unknown" };
  if (row.usedAt) return { valid: false, email: row.user.email, reason: "used" };
  if (row.expiresAt.getTime() <= Date.now()) {
    return { valid: false, email: row.user.email, reason: "expired" };
  }
  return { valid: true, email: row.user.email, reason: "ok" };
}

const consumeSchema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(1).max(200),
});

/**
 * Set a new password from a reset link. Unauthenticated by design — the token
 * is the credential — so it is single-use, short-lived, and revokes every
 * existing session on success.
 */
export async function consumeResetToken(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = consumeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the password." };

  const hash = createHash("sha256").update(parsed.data.token).digest("hex");
  const row = await prismaUnsafe.passwordResetToken.findUnique({
    where: { token: hash },
    select: { id: true, userId: true, usedAt: true, expiresAt: true },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "This link is no longer valid. Ask an Owner for a new one." };
  }

  const problems = validatePassword(parsed.data.password);
  if (problems.length > 0) {
    return { ok: false, error: `Password ${problems.map((p) => p.message).join("; ")}.` };
  }

  // Mark used FIRST: if anything below fails the link is still spent, which is
  // the safe direction for a single-use credential.
  const claimed = await prismaUnsafe.passwordResetToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    return { ok: false, error: "This link has already been used." };
  }

  await prismaUnsafe.user.update({
    where: { id: row.userId },
    data: {
      passwordHash: await hashPassword(parsed.data.password),
      mustChangePassword: false,
      lockedUntil: null,
    },
  });
  await revokeAllUserSessions(row.userId);

  const membership = await prismaUnsafe.membership.findFirst({
    where: { userId: row.userId },
    select: { workspaceId: true },
  });
  if (membership) {
    await getWorkspaceClient(membership.workspaceId).auditLog.create({
      data: {
        workspaceId: membership.workspaceId,
        actorUserId: row.userId,
        action: "user.password_reset_via_link",
        entityType: "User",
        entityId: row.userId,
      },
    });
  }
  return { ok: true };
}
