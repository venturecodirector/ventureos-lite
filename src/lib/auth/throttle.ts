/**
 * Login throttling policy (CLAUDE.md → Auth: "rate-limited login").
 *
 * Pure decision logic over a window of recorded attempts — no I/O, so the
 * policy is unit-testable and the same numbers govern both the account limb
 * and the IP limb.
 *
 * Two independent limbs, because they stop different attacks:
 *   - per ACCOUNT: someone guessing one user's password. Escalates to a
 *     temporary lock so the account is not brute-forceable even from a botnet.
 *   - per IP: someone spraying one password across many accounts. An account
 *     lock cannot see this pattern; only the source can.
 */
export const ACCOUNT_WINDOW_MS = 15 * 60_000;
export const ACCOUNT_MAX_FAILURES = 5;
export const ACCOUNT_LOCK_MS = 15 * 60_000;

/**
 * Escalating lockout (playbook-v2 P6/2 — "lockout with backoff").
 *
 * A flat fifteen minutes is a speed bump: an attacker who is willing to wait
 * gets five guesses every quarter of an hour, for ever. Each consecutive lock
 * doubles the wait, up to a day, so a persistent attack becomes uneconomic
 * while an honest person who mistyped twice is barely inconvenienced.
 *
 * The count resets once a login SUCCEEDS, not on a timer: the point is to
 * punish a run of failures, and the run is over when someone gets in.
 */
export const LOCK_BACKOFF_MS = [
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  4 * 3_600_000,
  24 * 3_600_000,
] as const;

export function lockDurationFor(consecutiveLocks: number): number {
  const index = Math.min(Math.max(0, consecutiveLocks), LOCK_BACKOFF_MS.length - 1);
  return LOCK_BACKOFF_MS[index]!;
}

export const IP_WINDOW_MS = 15 * 60_000;
export const IP_MAX_FAILURES = 20;

export interface AttemptRecord {
  ok: boolean;
  createdAt: Date;
}

export type ThrottleVerdict =
  | { allowed: true }
  | { allowed: false; reason: "account" | "ip"; retryAfterMs: number };

function recentFailures(attempts: AttemptRecord[], nowMs: number, windowMs: number): AttemptRecord[] {
  return attempts.filter((a) => !a.ok && nowMs - a.createdAt.getTime() < windowMs);
}

/**
 * Decide whether a login attempt may proceed.
 *
 * `lockedUntil` is the persisted account lock; it wins immediately so a lock
 * survives the attempt window rolling forward.
 */
export function evaluateThrottle(input: {
  nowMs: number;
  lockedUntil: Date | null;
  accountAttempts: AttemptRecord[];
  ipAttempts: AttemptRecord[];
}): ThrottleVerdict {
  const { nowMs, lockedUntil, accountAttempts, ipAttempts } = input;

  if (lockedUntil && lockedUntil.getTime() > nowMs) {
    return { allowed: false, reason: "account", retryAfterMs: lockedUntil.getTime() - nowMs };
  }

  const accountFails = recentFailures(accountAttempts, nowMs, ACCOUNT_WINDOW_MS);
  if (accountFails.length >= ACCOUNT_MAX_FAILURES) {
    return { allowed: false, reason: "account", retryAfterMs: ACCOUNT_LOCK_MS };
  }

  const ipFails = recentFailures(ipAttempts, nowMs, IP_WINDOW_MS);
  if (ipFails.length >= IP_MAX_FAILURES) {
    const oldest = ipFails.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
    const retryAfterMs = Math.max(0, IP_WINDOW_MS - (nowMs - oldest.createdAt.getTime()));
    return { allowed: false, reason: "ip", retryAfterMs };
  }

  return { allowed: true };
}

/**
 * After a failure: the new `lockedUntil`, or null if the account stays open.
 *
 * `priorLocks` is how many times this account has already been locked in the
 * current run of failures; it selects the backoff step.
 */
export function lockAfterFailure(
  accountAttempts: AttemptRecord[],
  nowMs: number,
  priorLocks = 0,
): Date | null {
  // +1 for the failure being recorded by this very attempt.
  const fails = recentFailures(accountAttempts, nowMs, ACCOUNT_WINDOW_MS).length + 1;
  return fails >= ACCOUNT_MAX_FAILURES
    ? new Date(nowMs + lockDurationFor(priorLocks))
    : null;
}

/** "try again in 4 minutes" — user-facing, never leaks which limb tripped. */
export function retryAfterLabel(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "in a minute";
  return `in ${minutes} minutes`;
}
