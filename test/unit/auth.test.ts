import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  validatePassword,
  NO_PASSWORD,
  MIN_PASSWORD_LENGTH,
  BCRYPT_COST,
} from "../../src/lib/auth/password";
import {
  evaluateThrottle,
  lockAfterFailure,
  retryAfterLabel,
  ACCOUNT_MAX_FAILURES,
  IP_MAX_FAILURES,
  ACCOUNT_WINDOW_MS,
} from "../../src/lib/auth/throttle";
import {
  generateTotpSecret,
  codeForStep,
  verifyTotp,
  totpStep,
  totpUri,
  TOTP_STEP_SECONDS,
} from "../../src/lib/auth/totp";
import { hashToken, generateSessionToken } from "../../src/lib/auth/sessions";

describe("password hashing", () => {
  it("round-trips a password and rejects a wrong one", async () => {
    const hash = await hashPassword("a-good-long-password");
    expect(hash).not.toContain("a-good-long-password");
    expect(await verifyPassword("a-good-long-password", hash)).toBe(true);
    expect(await verifyPassword("a-good-long-passworD", hash)).toBe(false);
  });

  it("produces a different hash each time (salted)", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password-x"), hashPassword("same-password-x")]);
    expect(a).not.toBe(b);
  });

  it("never authenticates the no-password placeholder", async () => {
    expect(await verifyPassword(NO_PASSWORD, NO_PASSWORD)).toBe(false);
    expect(await verifyPassword("", NO_PASSWORD)).toBe(false);
    expect(await verifyPassword("anything", NO_PASSWORD)).toBe(false);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    expect(await verifyPassword("x", "not-a-bcrypt-hash")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });

  it("flags hashes weaker than the current cost for upgrade", async () => {
    expect(needsRehash(`$2a$0${Math.max(4, BCRYPT_COST - 4)}$abcdefghijklmnopqrstuv`)).toBe(true);
    expect(needsRehash(await hashPassword("current-cost-password"))).toBe(false);
    expect(needsRehash("garbage")).toBe(true);
  });
});

describe("password policy", () => {
  it("requires real length", () => {
    expect(validatePassword("short")).not.toEqual([]);
    expect(validatePassword("x".repeat(MIN_PASSWORD_LENGTH - 1))).not.toEqual([]);
    expect(validatePassword("a-perfectly-fine-passphrase")).toEqual([]);
  });

  it("rejects repeated characters and common choices", () => {
    expect(validatePassword("a".repeat(20))).not.toEqual([]);
    expect(validatePassword("password1")).not.toEqual([]);
    expect(validatePassword("VentureOS")).not.toEqual([]);
  });

  it("rejects absurdly long input rather than letting bcrypt truncate it", () => {
    expect(validatePassword("x".repeat(300))).not.toEqual([]);
  });
});

describe("login throttling", () => {
  const now = 1_786_493_000_000;
  const fails = (n: number, msAgo = 1000) =>
    Array.from({ length: n }, () => ({ ok: false, createdAt: new Date(now - msAgo) }));

  it("allows a clean attempt", () => {
    expect(evaluateThrottle({ nowMs: now, lockedUntil: null, accountAttempts: [], ipAttempts: [] }))
      .toEqual({ allowed: true });
  });

  it("blocks the account after the failure budget is spent", () => {
    const v = evaluateThrottle({
      nowMs: now,
      lockedUntil: null,
      accountAttempts: fails(ACCOUNT_MAX_FAILURES),
      ipAttempts: [],
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("account");
  });

  it("honours a persisted lock, and releases it when it expires", () => {
    const locked = new Date(now + 60_000);
    expect(
      evaluateThrottle({ nowMs: now, lockedUntil: locked, accountAttempts: [], ipAttempts: [] })
        .allowed,
    ).toBe(false);
    expect(
      evaluateThrottle({
        nowMs: now + 120_000,
        lockedUntil: locked,
        accountAttempts: [],
        ipAttempts: [],
      }).allowed,
    ).toBe(true);
  });

  it("ignores failures that have aged out of the window", () => {
    const old = Array.from({ length: ACCOUNT_MAX_FAILURES }, () => ({
      ok: false,
      createdAt: new Date(now - ACCOUNT_WINDOW_MS - 1000),
    }));
    expect(
      evaluateThrottle({ nowMs: now, lockedUntil: null, accountAttempts: old, ipAttempts: [] })
        .allowed,
    ).toBe(true);
  });

  it("blocks a spraying IP even when no single account is over its budget", () => {
    const v = evaluateThrottle({
      nowMs: now,
      lockedUntil: null,
      accountAttempts: fails(1),
      ipAttempts: fails(IP_MAX_FAILURES),
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("ip");
  });

  it("does not count successes toward either limb", () => {
    const successes = Array.from({ length: 50 }, () => ({ ok: true, createdAt: new Date(now) }));
    expect(
      evaluateThrottle({
        nowMs: now,
        lockedUntil: null,
        accountAttempts: successes,
        ipAttempts: successes,
      }).allowed,
    ).toBe(true);
  });

  it("locks on the failure that reaches the threshold, not one later", () => {
    expect(lockAfterFailure(fails(ACCOUNT_MAX_FAILURES - 2), now)).toBeNull();
    expect(lockAfterFailure(fails(ACCOUNT_MAX_FAILURES - 1), now)).toBeInstanceOf(Date);
  });

  it("phrases the retry delay for a human", () => {
    expect(retryAfterLabel(30_000)).toBe("in a minute");
    expect(retryAfterLabel(4 * 60_000)).toBe("in 4 minutes");
  });
});

describe("TOTP", () => {
  const secret = generateTotpSecret();
  const now = 1_786_493_000_000;
  const step = totpStep(now);

  it("accepts the current code", () => {
    expect(verifyTotp(codeForStep(secret, step), secret, now, null)).toEqual({ ok: true, step });
  });

  it("tolerates one step of clock drift, but not two", () => {
    expect(verifyTotp(codeForStep(secret, step - 1), secret, now, null).ok).toBe(true);
    expect(verifyTotp(codeForStep(secret, step + 1), secret, now, null).ok).toBe(true);
    expect(verifyTotp(codeForStep(secret, step - 2), secret, now, null).ok).toBe(false);
    expect(verifyTotp(codeForStep(secret, step + 2), secret, now, null).ok).toBe(false);
  });

  it("refuses to spend the same code twice", () => {
    const code = codeForStep(secret, step);
    expect(verifyTotp(code, secret, now, null)).toEqual({ ok: true, step });
    expect(verifyTotp(code, secret, now, step)).toEqual({ ok: false, reason: "replayed" });
    // ...and an older code stays spent too.
    expect(verifyTotp(codeForStep(secret, step - 1), secret, now, step).ok).toBe(false);
  });

  it("accepts the next code after one is burned", () => {
    const later = now + TOTP_STEP_SECONDS * 1000;
    const next = codeForStep(secret, totpStep(later));
    expect(verifyTotp(next, secret, later, step).ok).toBe(true);
  });

  it("rejects malformed input without consulting the secret", () => {
    expect(verifyTotp("12345", secret, now, null)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTotp("abcdef", secret, now, null)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTotp("", secret, now, null)).toEqual({ ok: false, reason: "malformed" });
  });

  it("tolerates spaces and dashes the user may paste", () => {
    const code = codeForStep(secret, step);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(spaced, secret, now, null).ok).toBe(true);
  });

  it("builds an otpauth URI carrying the right secret and issuer", () => {
    const uri = totpUri("tamas@ventureco.group", secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);

    const parsed = new URL(uri);
    expect(parsed.searchParams.get("secret")).toBe(secret);
    expect(parsed.searchParams.get("issuer")).toBe("Venture OS");
    expect(decodeURIComponent(parsed.pathname)).toContain("tamas@ventureco.group");

    // period/digits are omitted because they match the otpauth defaults, which
    // is what every authenticator app assumes — so assert the DEFAULTS are what
    // we actually verify against, rather than that the URI spells them out.
    expect(TOTP_STEP_SECONDS).toBe(30);
    expect(parsed.searchParams.get("period")).toBeNull();
    expect(parsed.searchParams.get("digits")).toBeNull();
  });

  it("gives different secrets to different enrollments", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });
});

describe("session tokens", () => {
  it("are unguessable and unique", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    // 32 random bytes, base64url — no padding, url-safe.
    expect(a).toMatch(/^[A-Za-z0-9_-]{42,}$/);
  });

  it("hash deterministically, and the hash does not reveal the token", () => {
    const token = generateSessionToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });
});
