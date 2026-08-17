/**
 * A tiny in-process TTL cache for expensive aggregates (playbook-v2 P6/3).
 *
 * WHY IN PROCESS AND NOT REDIS. This caches DERIVED numbers — a funnel, a
 * weekly report, a what-closes breakdown — computed from rows the same process
 * just read. A Redis round trip to avoid a 40ms aggregation is not obviously a
 * win, and it adds a serialisation format, an invalidation story and a
 * dependency to a deployment that runs one app container. If the deployment
 * ever grows past that, the interface here does not change.
 *
 * DELIBERATELY NOT A GENERAL CACHE. It is keyed by caller-supplied string,
 * bounded, and TTL-only: there is no invalidation, so it must only ever hold
 * values where being up to 60 seconds stale is fine. A funnel count is; a
 * permission check is not.
 *
 * The key MUST include the workspace id. A cache shared across tenants is a
 * tenancy hole with a performance justification, which is the worst kind.
 */

interface Entry {
  value: unknown;
  expiresAtMs: number;
}

/** Bounded so a workspace-keyed cache cannot grow without limit. */
const MAX_ENTRIES = 500;

const store = new Map<string, Entry>();

export const DEFAULT_TTL_MS = 60_000;

/** Drop the oldest entries once the map is over its bound. */
function evict(): void {
  if (store.size <= MAX_ENTRIES) return;
  const excess = store.size - MAX_ENTRIES;
  let removed = 0;
  for (const key of store.keys()) {
    store.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}

/**
 * Return the cached value, or compute and cache it.
 *
 * In-flight requests are NOT deduplicated: two simultaneous misses both
 * compute. That is a deliberate simplification — the values here take tens of
 * milliseconds, so the duplicate work is cheaper than the promise bookkeeping
 * and the failure modes that come with sharing a rejected promise.
 */
export async function cached<T>(
  key: string,
  compute: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
  nowMs: number = Date.now(),
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expiresAtMs > nowMs) return hit.value as T;

  const value = await compute();
  store.set(key, { value, expiresAtMs: nowMs + ttlMs });
  evict();
  return value;
}

/** Forget one key, or every key with a prefix — for a mutation that must show. */
export function invalidate(prefix: string): number {
  let removed = 0;
  for (const key of [...store.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}:`)) {
      store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** Test seam. */
export function clearCache(): void {
  store.clear();
}

export function cacheSize(): number {
  return store.size;
}
