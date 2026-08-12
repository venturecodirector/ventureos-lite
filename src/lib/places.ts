/**
 * Google Places API v1 client (spec §4.3). Text Search returns the `websiteUri`
 * directly via the field mask, so website presence comes back with the search;
 * a Place Details call is only a fallback for missing fields. Deterministic and
 * cheap — Claude is never used to find businesses.
 */
export interface PlaceResult {
  name: string;
  address: string | null;
  category: string | null;
  rating: number | null;
  reviews: number | null;
  phone: string | null;
  websiteUri: string | null;
}

export interface PlacesSearchResponse {
  results: PlaceResult[];
  requestCount: number;
}

export interface PlacesClient {
  textSearch(q: {
    keyword: string;
    location: string;
    radius?: string;
  }): Promise<PlacesSearchResponse>;
}

interface ApiPlace {
  displayName?: { text?: string };
  formattedAddress?: string;
  primaryTypeDisplayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  nationalPhoneNumber?: string;
  websiteUri?: string;
}

const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.primaryTypeDisplayName",
  "places.rating",
  "places.userRatingCount",
  "places.nationalPhoneNumber",
  "places.websiteUri",
].join(",");

class GooglePlacesClient implements PlacesClient {
  /** Workspace key, resolved by the caller; null means fall back to env. */
  constructor(private readonly apiKey: string | null = null) {}

  async textSearch(q: {
    keyword: string;
    location: string;
    radius?: string;
  }): Promise<PlacesSearchResponse> {
    // Resolved per workspace by the caller (Settings → Integrations), falling
    // back to the env key.
    const key = this.apiKey ?? process.env.GOOGLE_PLACES_API_KEY;
    if (!key) {
      throw new Error("No Google Places API key configured — cannot run a Prospector search.");
    }
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: `${q.keyword} in ${q.location}` }),
    });
    if (!res.ok) {
      throw new Error(`Places API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { places?: ApiPlace[] };
    const results: PlaceResult[] = (data.places ?? []).map((p) => ({
      name: p.displayName?.text ?? "Unknown",
      address: p.formattedAddress ?? null,
      category: p.primaryTypeDisplayName?.text ?? null,
      rating: p.rating ?? null,
      reviews: p.userRatingCount ?? null,
      phone: p.nationalPhoneNumber ?? null,
      websiteUri: p.websiteUri ?? null,
    }));
    return { results, requestCount: 1 };
  }
}

let client: PlacesClient | null = null;
export function getPlacesClient(apiKey: string | null = null): PlacesClient {
  // A workspace-specific key gets its own client; the env-backed one is cached.
  if (apiKey) return new GooglePlacesClient(apiKey);
  if (!client) client = new GooglePlacesClient();
  return client;
}
