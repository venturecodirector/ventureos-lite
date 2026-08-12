import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { attemptLogin } from "../../src/lib/auth/login";
import { hashPassword, NO_PASSWORD } from "../../src/lib/auth/password";
import {
  resolveSession,
  revokeSession,
  revokeAllUserSessions,
  setSessionWorkspace,
  hashToken,
  SESSION_TTL_MS,
} from "../../src/lib/auth/sessions";
import { codeForStep, generateTotpSecret, totpStep } from "../../src/lib/auth/totp";
import { ACCOUNT_MAX_FAILURES } from "../../src/lib/auth/throttle";

/**
 * End-to-end authentication against the real database (CLAUDE.md → Auth).
 * These are the guarantees the whole app rests on, so they are tested against
 * Postgres rather than a mock.
 */
const EMAIL = "auth-test@ventureco.test";
const PASSWORD = "correct-horse-battery";
const WS_NAME = "Auth Test Workspace";

let userId = "";
let workspaceId = "";

async function clean(): Promise<void> {
  await prismaUnsafe.loginAttempt.deleteMany({ where: { email: EMAIL } });
  const u = await prismaUnsafe.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (u) {
    await prismaUnsafe.session.deleteMany({ where: { userId: u.id } });
    await prismaUnsafe.membership.deleteMany({ where: { userId: u.id } });
    await prismaUnsafe.user.delete({ where: { id: u.id } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { name: WS_NAME } });
}

beforeEach(async () => {
  await clean();
  const ws = await prismaUnsafe.workspace.create({ data: { name: WS_NAME } });
  workspaceId = ws.id;
  const user = await prismaUnsafe.user.create({
    data: { email: EMAIL, name: "Auth Test", passwordHash: await hashPassword(PASSWORD) },
  });
  userId = user.id;
  await prismaUnsafe.membership.create({
    data: { userId, workspaceId, role: "OWNER", grants: [] },
  });
});

afterAll(async () => {
  await clean();
  await prismaUnsafe.$disconnect();
});

describe("password login", () => {
  it("issues a resolvable session for correct credentials", async () => {
    const res = await attemptLogin({ email: EMAIL, password: PASSWORD, ip: "1.2.3.4" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.workspaceId).toBe(workspaceId);
    const session = await resolveSession(res.token);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe(userId);
    expect(session?.workspaceId).toBe(workspaceId);
  });

  it("stores only a hash of the token, never the token", async () => {
    const res = await attemptLogin({ email: EMAIL, password: PASSWORD });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const raw = await prismaUnsafe.session.findFirst({ where: { userId }, select: { token: true } });
    expect(raw?.token).toBe(hashToken(res.token));
    expect(raw?.token).not.toBe(res.token);
  });

  it("rejects a wrong password, and an unknown email, identically", async () => {
    const bad = await attemptLogin({ email: EMAIL, password: "wrong-password-here" });
    const missing = await attemptLogin({ email: "nobody@ventureco.test", password: PASSWORD });
    expect(bad.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (bad.ok || missing.ok) return;
    // Same message: the form must not reveal whether an account exists.
    expect(bad.code).toBe("invalid");
    expect(missing.code).toBe("invalid");
    expect((bad as { message: string }).message).toBe((missing as { message: string }).message);
  });

  it("refuses an account whose password was never set", async () => {
    await prismaUnsafe.user.update({ where: { id: userId }, data: { passwordHash: NO_PASSWORD } });
    const res = await attemptLogin({ email: EMAIL, password: NO_PASSWORD });
    expect(res.ok).toBe(false);
  });

  it("refuses a user with no workspace instead of issuing a dangling session", async () => {
    await prismaUnsafe.membership.deleteMany({ where: { userId } });
    const res = await attemptLogin({ email: EMAIL, password: PASSWORD });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("no_workspace");
    expect(await prismaUnsafe.session.count({ where: { userId } })).toBe(0);
  });
});

describe("TOTP second factor", () => {
  async function enableTotp(): Promise<string> {
    const secret = generateTotpSecret();
    await prismaUnsafe.user.update({
      where: { id: userId },
      data: { totpSecret: secret, totpEnabled: true, totpLastStep: null },
    });
    return secret;
  }

  it("asks for a code once enrolled, without counting it as a failure", async () => {
    await enableTotp();
    const res = await attemptLogin({ email: EMAIL, password: PASSWORD });
    expect(res).toEqual({ ok: false, code: "totp_required" });
    // Crucially: no failed attempt recorded, or two-step logins would self-lock.
    const failures = await prismaUnsafe.loginAttempt.count({ where: { email: EMAIL, ok: false } });
    expect(failures).toBe(0);
  });

  it("accepts a valid code and burns it against replay", async () => {
    const secret = await enableTotp();
    const now = Date.now();
    const code = codeForStep(secret, totpStep(now));

    const first = await attemptLogin({ email: EMAIL, password: PASSWORD, totpCode: code, nowMs: now });
    expect(first.ok).toBe(true);

    // Same code, same 30s window — must not work a second time.
    const replay = await attemptLogin({ email: EMAIL, password: PASSWORD, totpCode: code, nowMs: now });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe("invalid");
  });

  it("rejects a wrong code even with the right password", async () => {
    await enableTotp();
    const res = await attemptLogin({ email: EMAIL, password: PASSWORD, totpCode: "000000" });
    expect(res.ok).toBe(false);
    expect(await prismaUnsafe.session.count({ where: { userId } })).toBe(0);
  });
});

describe("rate limiting", () => {
  it("locks the account after repeated failures and blocks the correct password", async () => {
    for (let i = 0; i < ACCOUNT_MAX_FAILURES; i += 1) {
      await attemptLogin({ email: EMAIL, password: "wrong-password-here", ip: "9.9.9.9" });
    }
    const res = await attemptLogin({ email: EMAIL, password: PASSWORD, ip: "9.9.9.9" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("throttled");

    const user = await prismaUnsafe.user.findUnique({
      where: { id: userId },
      select: { lockedUntil: true },
    });
    expect(user?.lockedUntil).not.toBeNull();
  });

  it("lets the correct password through once the lock expires", async () => {
    for (let i = 0; i < ACCOUNT_MAX_FAILURES; i += 1) {
      await attemptLogin({ email: EMAIL, password: "wrong-password-here", ip: "9.9.9.8" });
    }
    // Jump past both the lock and the attempt window.
    const later = Date.now() + 31 * 60_000;
    const res = await attemptLogin({ email: EMAIL, password: PASSWORD, ip: "9.9.9.8", nowMs: later });
    expect(res.ok).toBe(true);
  });
});

describe("session lifecycle", () => {
  it("stops resolving once revoked", async () => {
    const res = await attemptLogin({ email: EMAIL, password: PASSWORD });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const live = await resolveSession(res.token);
    expect(live).not.toBeNull();
    await revokeSession(live!.sessionId);
    expect(await resolveSession(res.token)).toBeNull();
  });

  it("stops resolving once expired", async () => {
    const res = await attemptLogin({ email: EMAIL, password: PASSWORD });
    if (!res.ok) return;
    const future = Date.now() + SESSION_TTL_MS + 1000;
    expect(await resolveSession(res.token, future)).toBeNull();
  });

  it("revokes every other session on demand, keeping the current one", async () => {
    const a = await attemptLogin({ email: EMAIL, password: PASSWORD });
    const b = await attemptLogin({ email: EMAIL, password: PASSWORD });
    const c = await attemptLogin({ email: EMAIL, password: PASSWORD });
    if (!a.ok || !b.ok || !c.ok) throw new Error("setup failed");

    const keep = await resolveSession(c.token);
    const revoked = await revokeAllUserSessions(userId, { exceptSessionId: keep!.sessionId });
    expect(revoked).toBe(2);
    expect(await resolveSession(a.token)).toBeNull();
    expect(await resolveSession(b.token)).toBeNull();
    expect(await resolveSession(c.token)).not.toBeNull();
  });

  it("keeps the active workspace on the session row, not the client", async () => {
    const other = await prismaUnsafe.workspace.create({ data: { name: WS_NAME } });
    await prismaUnsafe.membership.create({
      data: { userId, workspaceId: other.id, role: "OWNER", grants: [] },
    });
    const res = await attemptLogin({ email: EMAIL, password: PASSWORD });
    if (!res.ok) return;
    const session = await resolveSession(res.token);
    await setSessionWorkspace(session!.sessionId, other.id);
    expect((await resolveSession(res.token))?.workspaceId).toBe(other.id);
  });

  it("does not resolve a made-up token", async () => {
    expect(await resolveSession("not-a-real-token")).toBeNull();
    expect(await resolveSession("")).toBeNull();
    expect(await resolveSession(null)).toBeNull();
  });
});
