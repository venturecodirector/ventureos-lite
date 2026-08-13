import { getRedisConnection } from "./queue";

/**
 * Shared fixed-window rate limiter backed by Redis.
 *
 * The booking limiter (modules/meetings/ratelimit.ts) keeps its buckets in a
 * process-local Map, which is fine for a low-traffic authenticated-ish path but
 * useless as an abuse control on a public endpoint: it empties on every deploy
 * and is not shared across processes. Anything guarding the public audit form
 * uses this instead.
 *
 * Fixed window rather than sliding: one INCR plus a conditional EXPIRE, no Lua,
 * no clock skew between app and Redis. A visitor can in theory get 2n requests
 * across a window boundary; for "3 free audits a day" that is irrelevant.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Requests already counted in this window, including the current one. */
  count: number;
  remaining: number;
  /** Unix ms when the window resets. */
  resetAtMs: number;
}

export async function takeRateLimit(
  key: string,
  opts: { windowMs: number; max: number },
): Promise<RateLimitResult> {
  const redis = getRedisConnection();
  const windowSec = Math.max(1, Math.ceil(opts.windowMs / 1000));
  // Bucket the key by window so old windows expire on their own.
  const windowIndex = Math.floor(Date.now() / opts.windowMs);
  const redisKey = `rl:${key}:${windowIndex}`;

  const count = await redis.incr(redisKey);
  if (count === 1) {
    // Only the first hit sets the TTL, so the window does not slide forward.
    await redis.expire(redisKey, windowSec);
  }

  const resetAtMs = (windowIndex + 1) * opts.windowMs;
  return {
    allowed: count <= opts.max,
    count,
    remaining: Math.max(0, opts.max - count),
    resetAtMs,
  };
}

/**
 * Read the current count without consuming an attempt — for showing "2 of 3
 * used" without charging the visitor for looking at the page.
 */
export async function peekRateLimit(
  key: string,
  opts: { windowMs: number; max: number },
): Promise<RateLimitResult> {
  const redis = getRedisConnection();
  const windowIndex = Math.floor(Date.now() / opts.windowMs);
  const raw = await redis.get(`rl:${key}:${windowIndex}`);
  const count = raw ? Number(raw) : 0;
  return {
    allowed: count < opts.max,
    count,
    remaining: Math.max(0, opts.max - count),
    resetAtMs: (windowIndex + 1) * opts.windowMs,
  };
}
