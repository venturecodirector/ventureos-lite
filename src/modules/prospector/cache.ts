/**
 * Search caching (spec §4.3): the same area isn't re-purchased from the Places
 * API — runs are cached 30 days keyed on the normalized query + location.
 */
export const CACHE_TTL_DAYS = 30;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function searchCacheKey(
  keyword: string,
  location: string,
  radius?: string | null,
): string {
  return [norm(keyword), norm(location), radius ? norm(radius) : ""].join("|");
}

export function isCacheFresh(
  ranAt: Date,
  now: Date,
  ttlDays = CACHE_TTL_DAYS,
): boolean {
  return now.getTime() - ranAt.getTime() < ttlDays * 86_400_000;
}
