import { describe, it, expect } from "vitest";
import {
  RATE_LIMITS,
  clientIp,
  retryAfterSeconds,
  tooManyRequests,
} from "../../src/lib/rate-limit-policy";
import {
  LOCK_BACKOFF_MS,
  lockAfterFailure,
  lockDurationFor,
  ACCOUNT_MAX_FAILURES,
} from "../../src/lib/auth/throttle";
import { describeDevice, SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS } from "../../src/lib/auth/sessions";

describe("rate-limit policy", () => {
  it("gives every public surface a bucket of its own", () => {
    const buckets = Object.values(RATE_LIMITS).map((p) => p.bucket);
    expect(new Set(buckets).size).toBe(buckets.length);
  });

  it("keeps every window and ceiling positive", () => {
    for (const [name, policy] of Object.entries(RATE_LIMITS)) {
      expect(policy.windowMs, name).toBeGreaterThan(0);
      expect(policy.max, name).toBeGreaterThan(0);
    }
  });

  it("leaves the API backstop far looser than any public surface", () => {
    const perMinute = (p: { windowMs: number; max: number }) => (p.max / p.windowMs) * 60_000;
    expect(perMinute(RATE_LIMITS.api)).toBeGreaterThan(perMinute(RATE_LIMITS.booking));
    expect(perMinute(RATE_LIMITS.api)).toBeGreaterThan(perMinute(RATE_LIMITS.publicAudit));
  });

  it("never answers Retry-After: 0 — that is an invitation to retry instantly", () => {
    expect(retryAfterSeconds(Date.now() - 5_000)).toBe(1);
    expect(retryAfterSeconds(Date.now() + 4_200)).toBe(5);
  });

  it("sends Retry-After on the 429", () => {
    const res = tooManyRequests(Date.now() + 30_000);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("reads the client address from the proxy hop we trust, and shares one bucket otherwise", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("lockout backoff", () => {
  it("escalates, and stops escalating at the last step", () => {
    expect(lockDurationFor(0)).toBe(LOCK_BACKOFF_MS[0]);
    expect(lockDurationFor(1)).toBeGreaterThan(lockDurationFor(0));
    expect(lockDurationFor(99)).toBe(LOCK_BACKOFF_MS[LOCK_BACKOFF_MS.length - 1]);
    expect(lockDurationFor(-3)).toBe(LOCK_BACKOFF_MS[0]);
  });

  it("locks only once the failure count is reached", () => {
    const now = Date.now();
    const fails = (n: number) =>
      Array.from({ length: n }, () => ({ ok: false, createdAt: new Date(now - 1000) }));

    expect(lockAfterFailure(fails(ACCOUNT_MAX_FAILURES - 2), now)).toBeNull();
    expect(lockAfterFailure(fails(ACCOUNT_MAX_FAILURES - 1), now)).not.toBeNull();
  });

  it("uses a longer lock for a repeat offender", () => {
    const now = Date.now();
    const fails = Array.from({ length: ACCOUNT_MAX_FAILURES }, () => ({
      ok: false,
      createdAt: new Date(now - 1000),
    }));
    const first = lockAfterFailure(fails, now, 0)!;
    const third = lockAfterFailure(fails, now, 2)!;
    expect(third.getTime()).toBeGreaterThan(first.getTime());
  });
});

describe("session lifetime", () => {
  it("bounds an active session absolutely and an inactive one sooner", () => {
    expect(SESSION_ABSOLUTE_TTL_MS).toBe(30 * 86_400_000);
    expect(SESSION_IDLE_TTL_MS).toBe(7 * 86_400_000);
    expect(SESSION_IDLE_TTL_MS).toBeLessThan(SESSION_ABSOLUTE_TTL_MS);
  });
});

describe("device labels", () => {
  it("says something a person can recognise their own laptop by", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(
      describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/605"),
    ).toBe("Safari on iOS");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Firefox/121.0")).toBe("Firefox on Windows");
  });

  it("does not mistake Edge or Opera for Chrome", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120")).toBe(
      "Edge on Windows",
    );
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 OPR/106")).toBe(
      "Opera on Windows",
    );
  });

  it("degrades rather than guessing", () => {
    expect(describeDevice(null)).toBe("Unknown device");
    expect(describeDevice("curl/8.4.0")).toBe("Browser");
  });
});
