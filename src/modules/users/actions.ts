"use server";

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireOwner } from "@/lib/authz";
import { hashPassword, validatePassword, NO_PASSWORD } from "@/lib/auth/password";
import { revokeAllUserSessions } from "@/lib/auth/sessions";
import { appLink } from "@/lib/public-links";

/**
 * Owner-side user administration (Settings → Users).
 *
 * Every mutation here:
 *   - is Owner-only, checked server-side on entry (CLAUDE.md hard rule #7);
 *   - only ever touches a user who is a MEMBER OF THE ACTIVE WORKSPACE, so an
 *     Owner of workspace A cannot rename or reset someone who only belongs to
 *     workspace B (hard rule #1 applied to a global table);
 *   - is audit-logged with actor, subject, action and time (hard rule #8);
 *   - revokes the subject's sessions when it changes how they authenticate.
 */

const RESET_LINK_TTL_MINUTES = 60;

export interface ManagedUser {
  userId: string;
  name: string;
  email: string;
  role: string;
  totpEnabled: boolean;
  mustEnrollTotp: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  activeSessions: number;
  isSelf: boolean;
}

/** Members of the active workspace. Never the whole user table. */
export async function listWorkspaceUsers(): Promise<ManagedUser[]> {
  await requireOwner();
  const { workspaceId, userId: actorId } = await getActiveContext();
  const now = new Date();

  const memberships = await prismaUnsafe.membership.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          passwordHash: true,
          totpEnabled: true,
          mustEnrollTotp: true,
          mustChangePassword: true,
          lockedUntil: true,
          lastLoginAt: true,
          sessions: {
            where: { revokedAt: null, expiresAt: { gt: now } },
            select: { id: true },
          },
        },
      },
    },
  });

  return memberships.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    totpEnabled: m.user.totpEnabled,
    mustEnrollTotp: m.user.mustEnrollTotp,
    mustChangePassword: m.user.mustChangePassword,
    hasPassword: m.user.passwordHash !== NO_PASSWORD && m.user.passwordHash.length > 1,
    lockedUntil: m.user.lockedUntil?.toISOString() ?? null,
    lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
    activeSessions: m.user.sessions.length,
    isSelf: m.user.id === actorId,
  }));
}

/**
 * Resolve a target user, refusing anyone outside the active workspace.
 * This is the tenancy check for a table that has no workspace_id of its own.
 */
async function requireMember(userId: string, workspaceId: string) {
  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  return membership?.user ?? null;
}

async function audit(input: {
  workspaceId: string;
  actorUserId: string;
  action: string;
  subjectId: string;
  /** Prisma's Json input type — plain serialisable values only. */
  meta?: Prisma.InputJsonValue;
}): Promise<void> {
  // audit_logs is a tenant table — guarded client, not the raw one.
  await getWorkspaceClient(input.workspaceId).auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: "User",
      entityId: input.subjectId,
      meta: input.meta ?? {},
    },
  });
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

const identitySchema = z.object({
  userId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
});

export async function updateUserIdentity(
  raw: unknown,
): Promise<{ ok: true; emailChanged: boolean } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can edit users." };
  }
  const parsed = identitySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter a valid name and email address." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  const emailChanged = target.email !== parsed.data.email;
  if (emailChanged) {
    const clash = await prismaUnsafe.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });
    if (clash && clash.id !== target.id) {
      return { ok: false, error: "Another account already uses that email address." };
    }
  }

  await prismaUnsafe.user.update({
    where: { id: target.id },
    data: { name: parsed.data.name, email: parsed.data.email },
  });

  // The email IS the login identifier — an open session would keep working
  // under the old identity, so it goes.
  if (emailChanged) await revokeAllUserSessions(target.id);

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.identity_updated",
    subjectId: target.id,
    meta: {
      from: { name: target.name, email: target.email },
      to: { name: parsed.data.name, email: parsed.data.email },
    },
  });
  revalidatePath("/settings");
  return { ok: true, emailChanged };
}

// ---------------------------------------------------------------------------
// password
// ---------------------------------------------------------------------------

const setPasswordSchema = z.object({
  userId: z.string().min(1),
  password: z.string().min(1).max(200),
  requireChange: z.boolean().default(true),
});

/** Set a password directly. Use when handing it over in person. */
export async function setUserPassword(
  raw: unknown,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can set passwords." };
  }
  const parsed = setPasswordSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the password." };

  const problems = validatePassword(parsed.data.password);
  if (problems.length > 0) {
    return { ok: false, error: `Password ${problems.map((p) => p.message).join("; ")}.` };
  }

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  await prismaUnsafe.user.update({
    where: { id: target.id },
    data: {
      passwordHash: await hashPassword(parsed.data.password),
      mustChangePassword: parsed.data.requireChange,
      lockedUntil: null,
    },
  });
  const revoked = await revokeAllUserSessions(target.id);

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.password_set",
    subjectId: target.id,
    // Never the password, obviously — only that it happened.
    meta: { email: target.email, requireChange: parsed.data.requireChange, revokedSessions: revoked },
  });
  revalidatePath("/settings");
  return { ok: true, revoked };
}

/**
 * Issue a single-use reset link instead of choosing a password for someone.
 * The raw token is returned ONCE, here, and never stored — only its hash is.
 */
export async function createPasswordResetLink(
  raw: unknown,
): Promise<{ ok: true; url: string; expiresAt: string } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can issue reset links." };
  }
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  // Any earlier unused link for this user stops working the moment a new one
  // is issued, so only the most recent link is ever live.
  await prismaUnsafe.passwordResetToken.updateMany({
    where: { userId: target.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MINUTES * 60_000);
  await prismaUnsafe.passwordResetToken.create({
    data: {
      userId: target.id,
      token: createHash("sha256").update(token).digest("hex"),
      expiresAt,
      createdByUserId: actorId,
    },
  });

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.reset_link_issued",
    subjectId: target.id,
    meta: { email: target.email, expiresAt: expiresAt.toISOString() },
  });
  revalidatePath("/settings");
  return { ok: true, url: appLink(`/reset/${token}`), expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// two-factor
// ---------------------------------------------------------------------------

/**
 * Reset someone's second factor: delete the secret and require a fresh
 * enrollment before they can use the app again. This is the lost-phone path.
 */
export async function resetUserTotp(
  raw: unknown,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can reset two-factor authentication." };
  }
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  await prismaUnsafe.user.update({
    where: { id: target.id },
    data: {
      totpSecret: null,
      totpEnabled: false,
      totpLastStep: null,
      // They cannot get back in without scanning a new QR.
      mustEnrollTotp: true,
    },
  });
  const revoked = await revokeAllUserSessions(target.id);

  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.totp_reset",
    subjectId: target.id,
    meta: { email: target.email, revokedSessions: revoked },
  });
  revalidatePath("/settings");
  return { ok: true, revoked };
}

/** Clear a lockout without touching the password. */
export async function unlockUser(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can unlock accounts." };
  }
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  await prismaUnsafe.user.update({ where: { id: target.id }, data: { lockedUntil: null } });
  await prismaUnsafe.loginAttempt.deleteMany({ where: { email: target.email } });
  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.unlocked",
    subjectId: target.id,
    meta: { email: target.email },
  });
  revalidatePath("/settings");
  return { ok: true };
}

/** Sign a user out of every device. */
export async function revokeUserSessions(
  raw: unknown,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can sign other users out." };
  }
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown user." };

  const { workspaceId, userId: actorId } = await getActiveContext();
  const target = await requireMember(parsed.data.userId, workspaceId);
  if (!target) return { ok: false, error: "That user is not a member of this workspace." };

  const revoked = await revokeAllUserSessions(target.id);
  await audit({
    workspaceId,
    actorUserId: actorId,
    action: "user.sessions_revoked",
    subjectId: target.id,
    meta: { email: target.email, count: revoked },
  });
  revalidatePath("/settings");
  return { ok: true, revoked };
}

// Reset-link consumption lives in ./reset-tokens — it is reached WITHOUT a
// session (the token is the credential), so it must not import the auth stack.
// Import it from there directly; a "use server" module cannot re-export.
