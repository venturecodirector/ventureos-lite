import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  createSession,
  pruneExpiredSessions,
  resolveSession,
} from "../../src/lib/auth/sessions";
import { attemptLogin, setAuthEventHooks } from "../../src/lib/auth/login";
import { hashPassword } from "../../src/lib/auth/password";
import { LOCK_BACKOFF_MS } from "../../src/lib/auth/throttle";

/**
 * Session lifetime and lockout backoff against the real database
 * (playbook-v2 P6/2).
 */
const EMAIL = "session-security@iso.test";
const PASSWORD = "correct-horse-battery-staple-9";
const WS_NAME = "Session Security";
let userId = "";
let workspaceId = "";

async function clean() {
  await prismaUnsafe.session.deleteMany({ where: { user: { email: EMAIL } } });
  await prismaUnsafe.loginAttempt.deleteMany({ where: { email: EMAIL } });
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: WS_NAME },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.notification.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
}

beforeAll(async () => {
  await clean();
  const ws = await prismaUnsafe.workspace.create({ data: { name: WS_NAME } });
  workspaceId = ws.id;
  const user = await prismaUnsafe.user.create({
    data: { email: EMAIL, name: "Session Tester", passwordHash: await hashPassword(PASSWORD) },
  });
  userId = user.id;
  await prismaUnsafe.membership.create({ data: { userId, workspaceId, role: "OWNER" } });
});

afterAll(clean);

beforeEach(async () => {
  await prismaUnsafe.session.deleteMany({ where: { userId } });
  await prismaUnsafe.loginAttempt.deleteMany({ where: { email: EMAIL } });
  await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.notification.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.user.update({
    where: { id: userId },
    data: { lockedUntil: null, lockCount: 0 },
  });
  // Hooks are process-global; reset them so one test's spy cannot see another's.
  setAuthEventHooks({ onNewLogin: async () => {}, onLockout: async () => {} });
});

describe("session lifetime", () => {
  it("issues a session that lives for the absolute window", async () => {
    const now = Date.now();
    const { expiresAt } = await createSession({ userId, workspaceId, nowMs: now });
    expect(expiresAt.getTime() - now).toBe(SESSION_ABSOLUTE_TTL_MS);
  });

  it("stops resolving a session nobody has used for longer than the idle window", async () => {
    const now = Date.now();
    const { token, sessionId } = await createSession({ userId, workspaceId, nowMs: now });
    expect(await resolveSession(token, now)).not.toBeNull();

    // Backdate its last use past the idle limb; the absolute one is untouched.
    await prismaUnsafe.session.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date(now - SESSION_IDLE_TTL_MS - 60_000) },
    });
    expect(await resolveSession(token, now)).toBeNull();

    // And the row is still well inside its absolute expiry — proving it was the
    // idle limb that refused it, not the old 12-hour TTL.
    const row = await prismaUnsafe.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(now);
  });

  it("prunes idle-expired rows, which can never authenticate again", async () => {
    const now = Date.now();
    const { sessionId } = await createSession({ userId, workspaceId, nowMs: now });
    await prismaUnsafe.session.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date(now - SESSION_IDLE_TTL_MS - 60_000) },
    });

    await pruneExpiredSessions(now);
    expect(await prismaUnsafe.session.count({ where: { id: sessionId } })).toBe(0);
  });
});

describe("lockout", () => {
  async function failOnce(ip = "10.0.0.1") {
    return attemptLogin({ email: EMAIL, password: "wrong", ip });
  }

  it("escalates the lock on a repeat run of failures", async () => {
    for (let i = 0; i < 5; i += 1) await failOnce();
    const first = await prismaUnsafe.user.findUniqueOrThrow({ where: { id: userId } });
    expect(first.lockedUntil).not.toBeNull();
    expect(first.lockCount).toBe(1);
    const firstWait = first.lockedUntil!.getTime() - Date.now();
    expect(firstWait).toBeLessThanOrEqual(LOCK_BACKOFF_MS[0] + 5_000);

    // Clear the lock but not the counter — the run of failures continues.
    await prismaUnsafe.user.update({ where: { id: userId }, data: { lockedUntil: null } });
    await prismaUnsafe.loginAttempt.deleteMany({ where: { email: EMAIL } });
    for (let i = 0; i < 5; i += 1) await failOnce();

    const second = await prismaUnsafe.user.findUniqueOrThrow({ where: { id: userId } });
    expect(second.lockCount).toBe(2);
    expect(second.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(LOCK_BACKOFF_MS[0]);
  });

  it("resets the escalation once somebody actually signs in", async () => {
    for (let i = 0; i < 5; i += 1) await failOnce();
    await prismaUnsafe.user.update({ where: { id: userId }, data: { lockedUntil: null } });
    await prismaUnsafe.loginAttempt.deleteMany({ where: { email: EMAIL } });

    const ok = await attemptLogin({ email: EMAIL, password: PASSWORD, ip: "10.0.0.1" });
    expect(ok.ok).toBe(true);
    const after = await prismaUnsafe.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.lockCount).toBe(0);
  });

  it("fires the lockout hook so the event can be audited", async () => {
    const seen: Array<{ userId: string; email: string }> = [];
    setAuthEventHooks({
      onLockout: async (e) => {
        seen.push({ userId: e.userId, email: e.email });
      },
    });

    for (let i = 0; i < 5; i += 1) await failOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0].email).toBe(EMAIL);
  });

  it("fires the new-login hook on a successful sign-in, and never blocks on it", async () => {
    const seen: string[] = [];
    setAuthEventHooks({
      onNewLogin: async (e) => {
        seen.push(e.userId);
        throw new Error("notification exploded");
      },
    });

    const ok = await attemptLogin({
      email: EMAIL,
      password: PASSWORD,
      ip: "10.0.0.2",
      userAgent: "Mozilla/5.0 (Macintosh) Chrome/120 Safari/537",
    });
    // The hook threw and the login still succeeded.
    expect(ok.ok).toBe(true);
    expect(seen).toEqual([userId]);
  });
});
