import { headers } from "next/headers";
import { takeRateLimit } from "./rate-limit";
import {
  RATE_LIMITS,
  clientIp,
  tooManyRequests,
  type RateLimitName,
} from "./rate-limit-policy";

/**
 * Applying the rate-limit policy (playbook-v2 P6/2).
 *
 * NOT in middleware, deliberately. Middleware runs in the edge runtime, which
 * has no TCP socket and therefore no Redis — a limiter there would either be
 * per-instance memory (useless, see the booking limiter it replaced) or a
 * second network hop on every asset request. Route handlers and server actions
 * run in Node, where the shared window actually works.
 */

/**
 * Guard a route handler. Returns a 429 Response to return immediately, or null
 * to carry on.
 *
 * A limiter that fails OPEN is the right call here: Redis being down must not
 * take the product down with it, and the alternative — refusing every request
 * because the counter is unreachable — turns a cache outage into an outage.
 */
export async function guardRoute(
  name: RateLimitName,
  opts?: { key?: string },
): Promise<Response | null> {
  const policy = RATE_LIMITS[name];
  const h = await headers();
  const key = opts?.key ?? clientIp(h);
  try {
    const rate = await takeRateLimit(`${policy.bucket}:${key}`, policy);
    return rate.allowed ? null : tooManyRequests(rate.resetAtMs);
  } catch {
    return null;
  }
}

/**
 * Guard a server component or a server action, where a Response cannot be
 * returned. `true` means the caller is over the limit and should render (or
 * answer with) a refusal.
 */
export async function isRateLimited(
  name: RateLimitName,
  opts?: { key?: string },
): Promise<boolean> {
  const policy = RATE_LIMITS[name];
  const h = await headers();
  const key = opts?.key ?? clientIp(h);
  try {
    const rate = await takeRateLimit(`${policy.bucket}:${key}`, policy);
    return !rate.allowed;
  } catch {
    return false;
  }
}
