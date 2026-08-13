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
    /**
     * Upper bound on results. Text Search returns at most 20 per page, so
     * anything above that is fetched by following `nextPageToken`. Google caps
     * Text Search at 3 pages (60 results) — asking for more returns 60.
     */
    maxResults?: number;
  }): Promise<PlacesSearchResponse>;
}

/** One Text Search page. Google's hard ceiling, not a preference. */
export const PLACES_PAGE_SIZE = 20;
/** Google returns at most three pages for a Text Search query. */
export const PLACES_MAX_RESULTS = 60;

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
    maxResults?: number;
  }): Promise<PlacesSearchResponse> {
    // Resolved per workspace by the caller (Settings → Integrations), falling
    // back to the env key.
    const key = this.apiKey ?? process.env.GOOGLE_PLACES_API_KEY;
    if (!key) {
      throw new Error("No Google Places API key configured — cannot run a Prospector search.");
    }

    const want = Math.min(
      Math.max(q.maxResults ?? PLACES_PAGE_SIZE, 1),
      PLACES_MAX_RESULTS,
    );
    const results: PlaceResult[] = [];
    let pageToken: string | undefined;
    let requestCount = 0;

    // Page until we have enough, Google stops handing out tokens, or we hit
    // its 3-page ceiling. Each page is a separately billed request, so
    // requestCount drives the cost figure the UI shows.
    do {
      const body: Record<string, unknown> = {
        textQuery: `${q.keyword} in ${q.location}`,
        pageSize: Math.min(PLACES_PAGE_SIZE, want - results.length),
      };
      if (pageToken) body.pageToken = pageToken;

      const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": `${FIELD_MASK},nextPageToken`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // A later page failing should not throw away the pages already in
        // hand — return what we have and let the caller report the count.
        if (requestCount > 0) break;
        throw new Error(`Places API ${res.status}: ${await res.text()}`);
      }
      requestCount += 1;

      const data = (await res.json()) as { places?: ApiPlace[]; nextPageToken?: string };
      for (const p of data.places ?? []) {
        results.push({
          name: p.displayName?.text ?? "Unknown",
          address: p.formattedAddress ?? null,
          category: p.primaryTypeDisplayName?.text ?? null,
          rating: p.rating ?? null,
          reviews: p.userRatingCount ?? null,
          phone: p.nationalPhoneNumber ?? null,
          websiteUri: p.websiteUri ?? null,
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken && results.length < want);

    return { results: results.slice(0, want), requestCount };
  }
}

let client: PlacesClient | null = null;
export function getPlacesClient(apiKey: string | null = null): PlacesClient {
  // A workspace-specific key gets its own client; the env-backed one is cached.
  if (apiKey) return new GooglePlacesClient(apiKey);
  if (!client) client = new GooglePlacesClient();
  return client;
}
