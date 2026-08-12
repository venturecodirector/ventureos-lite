"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prismaUnsafe } from "@/lib/db";
import { signIn, signOut } from "@/lib/auth";
import { attemptLogin } from "@/lib/auth/login";
import {
  hashPassword,
  validatePassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth/password";
import {
  revokeAllUserSessions,
  revokeSession,
  resolveSession,
} from "@/lib/auth/sessions";
import { currentSessionToken } from "@/lib/auth";
import { generateTotpSecret, totpQrDataUrl, verifyTotp } from "@/lib/auth/totp";
import { getActiveContext } from "@/lib/session";

// ---------------------------------------------------------------------------
// sign in / out
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
  totpCode: z.string().trim().max(10).optional().nullable(),
});

export type SignInResult =
  | { ok: true; mustChangePassword: boolean }
  | { ok: false; needsTotp: true }
  | { ok: false; needsTotp?: false; error: string };

/** Client IP as seen behind Caddy, which is the only proxy hop we trust. */
async function requestOrigin(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ip: forwarded || h.get("x-real-ip") || null,
    userAgent: h.get("user-agent"),
  };
}

/**
 * The login entry point. Authenticates once, then hands the minted session
 * token to Auth.js so it sets its cookie (see the note in src/lib/auth).
 */
export async function signInWithPassword(raw: unknown): Promise<SignInResult> {
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter your email and password." };

  const { ip, userAgent } = await requestOrigin();
  const outcome = await attemptLogin({
    email: parsed.data.email,
    password: parsed.data.password,
    totpCode: parsed.data.totpCode ?? null,
    ip,
    userAgent,
  });

  if (!outcome.ok) {
    if (outcome.code === "totp_required") return { ok: false, needsTotp: true };
    return { ok: false, error: outcome.message };
  }

  await signIn("credentials", { sessionToken: outcome.token, redirect: false });
  return { ok: true, mustChangePassword: outcome.mustChangePassword };
}

/** Sign out: revoke the server session first, then clear the cookie. */
export async function signOutEverywhere(): Promise<void> {
  const token = await currentSessionToken();
  const session = await resolveSession(token);
  if (session) await revokeSession(session.sessionId);
  await signOut({ redirect: false });
  redirect("/login");
}

// ---------------------------------------------------------------------------
// password
// ---------------------------------------------------------------------------

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

/**
 * Change your own password. Re-checks the current password (a hijacked session
 * must not be able to take the account over) and revokes every OTHER session,
 * so a stolen cookie dies the moment the owner notices and rotates.
 */
export async function changePassword(
  raw: unknown,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string }> {
  const { userId, sessionId, workspaceId } = await getActiveContext();
  const parsed = changePasswordSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Fill in both fields." };

  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user) return { ok: false, error: "Account not found." };

  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    return { ok: false, error: "Your current password is not correct." };
  }
  const problems = validatePassword(parsed.data.newPassword);
  if (problems.length > 0) {
    return { ok: false, error: `New password ${problems.map((p) => p.message).join("; ")}.` };
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return { ok: false, error: "The new password must differ from the current one." };
  }

  await prismaUnsafe.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(parsed.data.newPassword),
      mustChangePassword: false,
    },
  });
  const revoked = await revokeAllUserSessions(userId, { exceptSessionId: sessionId });

  await prismaUnsafe.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "auth.password_changed" },
  });
  revalidatePath("/settings");
  return { ok: true, revoked };
}

const changeEmailSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(200),
});

/**
 * Change your OWN email. Requires the current password: the email is the login
 * identifier, so taking it over is equivalent to taking over the account, and a
 * hijacked session must not be able to do it silently.
 */
export async function changeOwnEmail(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { userId, workspaceId } = await getActiveContext();
  const parsed = changeEmailSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter your password and a valid email." };

  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { email: true, passwordHash: true },
  });
  if (!user) return { ok: false, error: "Account not found." };
  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    return { ok: false, error: "Your current password is not correct." };
  }
  if (user.email === parsed.data.email) return { ok: true };

  const clash = await prismaUnsafe.user.findUnique({
    where: { email: parsed.data.email },
    select: { id: true },
  });
  if (clash) return { ok: false, error: "Another account already uses that email address." };

  await prismaUnsafe.user.update({ where: { id: userId }, data: { email: parsed.data.email } });
  await prismaUnsafe.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "auth.email_changed",
      entityType: "User",
      entityId: userId,
      meta: { from: user.email, to: parsed.data.email },
    },
  });
  revalidatePath("/settings");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// TOTP enrollment
// ---------------------------------------------------------------------------

export interface TotpEnrollment {
  secret: string;
  qrDataUrl: string;
}

/**
 * Begin enrollment: mint a secret and render its QR. The secret is stored but
 * `totpEnabled` stays false until a code proves the authenticator app actually
 * has it — enabling first would lock the user out of their own account.
 */
export async function beginTotpEnrollment(): Promise<TotpEnrollment> {
  const { userId } = await getActiveContext();
  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { email: true, totpEnabled: true },
  });
  if (!user) throw new Error("Account not found.");
  if (user.totpEnabled) throw new Error("Two-factor authentication is already on.");

  const secret = generateTotpSecret();
  await prismaUnsafe.user.update({
    where: { id: userId },
    data: { totpSecret: secret, totpLastStep: null },
  });
  return { secret, qrDataUrl: await totpQrDataUrl(user.email, secret) };
}

const codeSchema = z.object({ code: z.string().trim().min(6).max(10) });

/** Finish enrollment by proving the app holds the secret. */
export async function confirmTotpEnrollment(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { userId, workspaceId } = await getActiveContext();
  const parsed = codeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter the 6-digit code." };

  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { totpSecret: true, totpEnabled: true, totpLastStep: true },
  });
  if (!user?.totpSecret) return { ok: false, error: "Start the setup again." };
  if (user.totpEnabled) return { ok: false, error: "Two-factor is already on." };

  const result = verifyTotp(parsed.data.code, user.totpSecret, Date.now(), user.totpLastStep ?? null);
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "replayed"
          ? "That code was already used — wait for the next one."
          : "That code is not right. Check your phone's clock and try the current code.",
    };
  }

  await prismaUnsafe.user.update({
    where: { id: userId },
    // Enrolling satisfies a reset an Owner forced (mustEnrollTotp).
    data: { totpEnabled: true, totpLastStep: result.step, mustEnrollTotp: false },
  });
  await prismaUnsafe.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "auth.totp_enabled" },
  });
  revalidatePath("/settings");
  return { ok: true };
}

const disableSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().trim().min(6).max(10),
});

/**
 * Turn 2FA off. Requires BOTH the password and a current code: whoever is
 * removing the second factor must be able to satisfy it, or a hijacked session
 * could simply switch the protection off.
 */
export async function disableTotp(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { userId, workspaceId } = await getActiveContext();
  const parsed = disableSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter your password and a current code." };

  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, totpSecret: true, totpEnabled: true, totpLastStep: true },
  });
  if (!user?.totpEnabled || !user.totpSecret) {
    return { ok: false, error: "Two-factor is not on." };
  }
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return { ok: false, error: "Password is not correct." };
  }
  const result = verifyTotp(parsed.data.code, user.totpSecret, Date.now(), user.totpLastStep ?? null);
  if (!result.ok) return { ok: false, error: "That code is not right." };

  await prismaUnsafe.user.update({
    where: { id: userId },
    data: { totpEnabled: false, totpSecret: null, totpLastStep: null },
  });
  await prismaUnsafe.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "auth.totp_disabled" },
  });
  revalidatePath("/settings");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// account overview (Settings → security)
// ---------------------------------------------------------------------------

export interface SecurityStatus {
  email: string;
  name: string;
  totpEnabled: boolean;
  mustEnrollTotp: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  minPasswordLength: number;
  activeSessions: Array<{
    id: string;
    current: boolean;
    ip: string | null;
    userAgent: string | null;
    lastSeenAt: string;
    expiresAt: string;
  }>;
}

export async function getSecurityStatus(): Promise<SecurityStatus> {
  const { userId, sessionId } = await getActiveContext();
  const user = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      totpEnabled: true,
      mustEnrollTotp: true,
      mustChangePassword: true,
      lastLoginAt: true,
    },
  });
  if (!user) throw new Error("Account not found.");

  const sessions = await prismaUnsafe.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, ip: true, userAgent: true, lastSeenAt: true, expiresAt: true },
  });

  return {
    email: user.email,
    name: user.name,
    totpEnabled: user.totpEnabled,
    mustEnrollTotp: user.mustEnrollTotp,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    activeSessions: sessions.map((s) => ({
      id: s.id,
      current: s.id === sessionId,
      ip: s.ip,
      userAgent: s.userAgent,
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    })),
  };
}

/** Sign out every other device. */
export async function revokeOtherSessions(): Promise<{ ok: true; revoked: number }> {
  const { userId, sessionId, workspaceId } = await getActiveContext();
  const revoked = await revokeAllUserSessions(userId, { exceptSessionId: sessionId });
  await prismaUnsafe.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "auth.sessions_revoked",
      meta: { count: revoked },
    },
  });
  revalidatePath("/settings");
  return { ok: true, revoked };
}
