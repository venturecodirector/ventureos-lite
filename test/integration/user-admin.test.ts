import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { inspectResetToken, consumeResetToken } from "../../src/modules/users/reset-tokens";
import { attemptLogin } from "../../src/lib/auth/login";
import { hashPassword } from "../../src/lib/auth/password";
import { createHash, randomBytes } from "node:crypto";

/**
 * The reset-link path, which is the only Owner action reachable without a
 * request context — the rest are covered through the UI, since they call
 * `requireOwner()` and need a session.
 *
 * What matters here: a link is single-use, expires, and once spent it kills
 * every session the user had.
 */
const EMAIL = "reset-target@ventureco.test";
const OLD_PASSWORD = "old-password-for-test";
const NEW_PASSWORD = "brand-new-password-99";
const WS = "Reset Test Workspace";

let userId = "";

async function issueToken(opts: { expiresInMs?: number; used?: boolean } = {}): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await prismaUnsafe.passwordResetToken.create({
    data: {
      userId,
      token: createHash("sha256").update(raw).digest("hex"),
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)),
      usedAt: opts.used ? new Date() : null,
    },
  });
  return raw;
}

async function clean(): Promise<void> {
  const u = await prismaUnsafe.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (u) {
    await prismaUnsafe.passwordResetToken.deleteMany({ where: { userId: u.id } });
    await prismaUnsafe.session.deleteMany({ where: { userId: u.id } });
    await prismaUnsafe.membership.deleteMany({ where: { userId: u.id } });
    await prismaUnsafe.user.delete({ where: { id: u.id } });
  }
  await prismaUnsafe.loginAttempt.deleteMany({ where: { email: EMAIL } });
  await prismaUnsafe.workspace.deleteMany({ where: { name: WS } });
}

beforeEach(async () => {
  await clean();
  const ws = await prismaUnsafe.workspace.create({ data: { name: WS } });
  const user = await prismaUnsafe.user.create({
    data: { email: EMAIL, name: "Reset Target", passwordHash: await hashPassword(OLD_PASSWORD) },
  });
  userId = user.id;
  await prismaUnsafe.membership.create({
    data: { userId, workspaceId: ws.id, role: "BDR", grants: [] },
  });
});

afterAll(async () => {
  await clean();
  await prismaUnsafe.$disconnect();
});

describe("password reset links", () => {
  it("stores only a hash, never the token itself", async () => {
    const raw = await issueToken();
    const row = await prismaUnsafe.passwordResetToken.findFirst({ where: { userId } });
    expect(row?.token).not.toBe(raw);
    expect(row?.token).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("reports a live link as valid, and names the account", async () => {
    const raw = await issueToken();
    expect(await inspectResetToken(raw)).toEqual({ valid: true, email: EMAIL, reason: "ok" });
  });

  it("sets the new password and lets the user sign in with it", async () => {
    const raw = await issueToken();
    expect(await consumeResetToken({ token: raw, password: NEW_PASSWORD })).toEqual({ ok: true });

    expect((await attemptLogin({ email: EMAIL, password: NEW_PASSWORD })).ok).toBe(true);
    expect((await attemptLogin({ email: EMAIL, password: OLD_PASSWORD })).ok).toBe(false);
  });

  it("cannot be used twice", async () => {
    const raw = await issueToken();
    expect(await consumeResetToken({ token: raw, password: NEW_PASSWORD })).toEqual({ ok: true });

    const second = await consumeResetToken({ token: raw, password: "another-password-here" });
    expect(second.ok).toBe(false);
    // ...and the second attempt did NOT change the password.
    expect((await attemptLogin({ email: EMAIL, password: NEW_PASSWORD })).ok).toBe(true);
  });

  it("refuses an expired link", async () => {
    const raw = await issueToken({ expiresInMs: -1000 });
    expect((await inspectResetToken(raw)).reason).toBe("expired");
    expect((await consumeResetToken({ token: raw, password: NEW_PASSWORD })).ok).toBe(false);
  });

  it("refuses an already-used link", async () => {
    const raw = await issueToken({ used: true });
    expect((await inspectResetToken(raw)).reason).toBe("used");
  });

  it("refuses an unknown token without leaking whether an account exists", async () => {
    const state = await inspectResetToken("not-a-real-token-at-all");
    expect(state).toEqual({ valid: false, email: null, reason: "unknown" });
  });

  it("enforces the password policy", async () => {
    const raw = await issueToken();
    const res = await consumeResetToken({ token: raw, password: "short" });
    expect(res.ok).toBe(false);
    // The link survives a rejected attempt, so a typo does not burn it.
    expect((await inspectResetToken(raw)).valid).toBe(true);
  });

  it("signs the user out everywhere once the password is reset", async () => {
    const login = await attemptLogin({ email: EMAIL, password: OLD_PASSWORD });
    expect(login.ok).toBe(true);
    expect(
      await prismaUnsafe.session.count({ where: { userId, revokedAt: null } }),
    ).toBe(1);

    const raw = await issueToken();
    await consumeResetToken({ token: raw, password: NEW_PASSWORD });

    expect(await prismaUnsafe.session.count({ where: { userId, revokedAt: null } })).toBe(0);
  });
});
