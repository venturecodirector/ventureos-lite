/**
 * One place that says how hard each surface may be hit (playbook-v2 P6/2).
 *
 * The limits themselves were scattered: a process-local Map for booking, a
 * Redis window for the public audit form, a database ledger for login, and
 * nothing at all on quote acceptance or an audit share. Scattered limits are
 * limits nobody can audit, and three of the four public routes were unguarded.
 *
 * WHY THE LOGIN LIMB IS NOT HERE. Login keeps its DB-backed ledger
 * (`lib/auth/throttle.ts`): it needs an account limb as well as an IP limb, it
 * has to survive a Redis restart — losing the throttle is exactly when you need
 * it — and the ledger doubles as the evidence behind a lockout. This module
 * governs everything that has no such ledger.
 */

export interface RateLimitPolicy {
  windowMs: number;
  max: number;
  /** Prefix for the Redis key, so one surface cannot spend another's budget. */
  bucket: string;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const RATE_LIMITS = {
  /** Public booking page: a real person books once, maybe twice. */
  booking: { bucket: "book", windowMs: MINUTE, max: 8 },
  /** Accepting a quote is a once-ever action; the limit is purely anti-abuse. */
  quoteAcceptance: { bucket: "accept", windowMs: HOUR, max: 20 },
  /** A shared audit report is meant to be read, not scraped. */
  auditShare: { bucket: "share", windowMs: HOUR, max: 120 },
  /** The self-serve audit form costs us a Playwright run per submission. */
  publicAudit: { bucket: "public-audit", windowMs: DAY, max: 3 },
  /** The browser extension posts captures on a personal token. */
  capture: { bucket: "capture", windowMs: MINUTE, max: 30 },
  /**
   * The API-wide default. Deliberately loose: it is a backstop against a
   * runaway client or a crawler, not a quota. A person clicking through the
   * product never comes close.
   */
  api: { bucket: "api", windowMs: MINUTE, max: 300 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** Seconds, rounded up and never zero — a `Retry-After: 0` invites an instant retry. */
export function retryAfterSeconds(resetAtMs: number, nowMs: number = Date.now()): number {
  return Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
}

/**
 * The standard 429.
 *
 * `Retry-After` is not optional politeness: without it a well-behaved client
 * has no way to back off correctly, so it retries immediately and the limit
 * turns a burst into a hammering.
 */
export function tooManyRequests(resetAtMs: number, message?: string): Response {
  const seconds = retryAfterSeconds(resetAtMs);
  return new Response(
    JSON.stringify({
      error: message ?? "Too many requests. Try again shortly.",
      retryAfter: seconds,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(seconds),
        "x-ratelimit-reset": String(Math.ceil(resetAtMs / 1000)),
      },
    },
  );
}

/**
 * The client address, as seen behind Caddy — the only proxy hop we trust.
 *
 * Falls back to a constant rather than to null: an unattributable request
 * shares one bucket with every other unattributable request, which is the safe
 * direction to be wrong in.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip") || "unknown";
}
