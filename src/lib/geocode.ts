import type { LatLng } from "./geo";

/**
 * Turn "Debrecen" into coordinates, so the Prospector's radius can mean
 * something.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The Radius field has been in the search bar since the Prospector shipped and
 * has never reached Google. It was accepted, stored, made part of the cache key
 * — and dropped before the request was built. Changing it from 15 km to 50 km
 * therefore changed nothing about the results while forcing a cache miss, so
 * the one visible effect of the control was paying for the same search twice.
 *
 * Text Search takes an area, not a place name, so a coordinate has to come from
 * somewhere. The Geocoding API is the purpose-built and cheapest way to get one
 * and is already enabled on this key.
 */

/**
 * Its own small cache rather than lib/ttl-cache.
 *
 * That module's contract is "values where being 60 seconds stale is fine", and
 * a town's coordinates are stable in a way that would make a 60-second TTL
 * absurd. Keyed by workspace as well as by text: a workspace may hold its own
 * Google key (Settings → Integrations), and serving it an answer another
 * workspace paid for would quietly move a cost across a billing boundary.
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const cache = new Map<string, { value: LatLng | null; expiresAtMs: number }>();

export function clearGeocodeCache(): void {
  cache.clear();
}

interface GeocodeResponse {
  status?: string;
  results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
}

/**
 * Never throws: a search must still run when geocoding is unavailable — it just
 * runs without the radius, and the caller says so out loud rather than
 * pretending the radius was applied.
 */
export async function geocodeLocation(
  query: string,
  apiKey: string | null,
  workspaceId: string,
): Promise<LatLng | null> {
  const q = query.trim();
  if (!q) return null;

  const key = `${workspaceId}|${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAtMs > Date.now()) return hit.value;

  const token = apiKey?.trim() || process.env.GOOGLE_PLACES_API_KEY;
  if (!token) return null;

  let value: LatLng | null = null;
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", q);
    // Hungarian bias, matching the Places request — "Szeged" should resolve to
    // the Hungarian one, not to a namesake somewhere else.
    url.searchParams.set("region", "hu");
    url.searchParams.set("language", "hu");
    url.searchParams.set("key", token);

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = (await res.json()) as GeocodeResponse;
      const loc = data.status === "OK" ? data.results?.[0]?.geometry?.location : undefined;
      if (typeof loc?.lat === "number" && typeof loc?.lng === "number") {
        value = { lat: loc.lat, lng: loc.lng };
      }
    }
  } catch {
    /* unreachable or timed out — the search runs without a radius */
  }

  // A miss is cached too, so a mistyped town does not re-ask on every keystroke
  // of a retried search.
  cache.set(key, { value, expiresAtMs: Date.now() + CACHE_TTL_MS });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return value;
}
