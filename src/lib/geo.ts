/**
 * The arithmetic behind the Prospector's radius. Pure, so it is testable
 * without a network and without a key.
 */

/** Google's ceiling for a search area, and a floor that still means something. */
export const MAX_RADIUS_M = 50_000;
export const MIN_RADIUS_M = 250;

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Read "15 km" — or "15", "15km", "1.5 km", "2000 m" — as metres.
 *
 * The field is free text and always has been, so it has to cope with what a
 * person types. A bare number means kilometres, because the placeholder says
 * "15 km" and that is what everyone has been typing into it. Returns null when
 * there is no number in there at all, which means "no radius", not "zero".
 */
export function parseRadiusMeters(raw: string | null | undefined): number | null {
  const s = (raw ?? "").trim().toLowerCase().replace(",", ".");
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(km|m|méter|meter|kilométer|kilometer)?/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2];
  const metres = unit === "m" || unit === "méter" || unit === "meter" ? value : value * 1000;
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(metres)));
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Rectangle {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
}

/**
 * The smallest rectangle containing the circle.
 *
 * Text Search accepts a RECTANGLE for locationRestriction, not a circle, so the
 * circle is circumscribed and the corners are then trimmed off by an exact
 * distance check on each result. Without that trim "15 km" would quietly mean
 * "up to 21 km diagonally", which is the kind of almost-right that makes a
 * number in a form untrustworthy.
 */
export function boundingRectangle(center: LatLng, radiusM: number): Rectangle {
  const dLat = radiusM / 111_320;
  // Longitude degrees shrink towards the poles; clamped so a near-polar centre
  // cannot divide by ~zero and produce a rectangle spanning the globe.
  const cos = Math.max(0.01, Math.cos((center.lat * Math.PI) / 180));
  const dLng = radiusM / (111_320 * cos);
  return {
    low: {
      latitude: Math.max(-90, center.lat - dLat),
      longitude: Math.max(-180, center.lng - dLng),
    },
    high: {
      latitude: Math.min(90, center.lat + dLat),
      longitude: Math.min(180, center.lng + dLng),
    },
  };
}
