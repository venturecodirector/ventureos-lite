/**
 * Fixed-window rate limiter for the public booking endpoint (spec §4.21).
 * The decision is pure (testable); a tiny in-memory store wraps it for the
 * single-node self-hosted deployment.
 */
export interface RateBucket {
  count: number;
  windowStartMs: number;
}

export function hitRateLimit(
  bucket: RateBucket | undefined,
  nowMs: number,
  windowMs: number,
  max: number,
): { allowed: boolean; bucket: RateBucket } {
  if (!bucket || nowMs - bucket.windowStartMs >= windowMs) {
    return { allowed: true, bucket: { count: 1, windowStartMs: nowMs } };
  }
  if (bucket.count >= max) {
    return { allowed: false, bucket };
  }
  return { allowed: true, bucket: { count: bucket.count + 1, windowStartMs: bucket.windowStartMs } };
}

// ---- process-local store (self-hosted single node) ------------------------

const store = new Map<string, RateBucket>();

/** Returns true when the hit is allowed. Keyed by e.g. IP. */
export function takeRateLimit(
  key: string,
  nowMs: number,
  windowMs = 60_000,
  max = 8,
): boolean {
  const r = hitRateLimit(store.get(key), nowMs, windowMs, max);
  store.set(key, r.bucket);
  return r.allowed;
}
