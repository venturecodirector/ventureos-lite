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
  async textSearch(q: {
    keyword: string;
    location: string;
    radius?: string;
  }): Promise<PlacesSearchResponse> {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) {
      throw new Error("GOOGLE_PLACES_API_KEY is not set — cannot run a Prospector search.");
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
export function getPlacesClient(): PlacesClient {
  if (!client) client = new GooglePlacesClient();
  return client;
}
