import { boundingRectangle, haversineKm, type LatLng } from "./geo";

/**
 * Google Places API v1 client (spec §4.3). Text Search returns the `websiteUri`
 * directly via the field mask, so website presence comes back with the search;
 * a Place Details call is only a fallback for missing fields. Deterministic and
 * cheap — Claude is never used to find businesses.
 */
export interface PlaceResult {
  /** Where it is — needed to trim the search rectangle back to a true circle. */
  lat: number | null;
  lng: number | null;
  /** Google's own stable id for the place — the only exact dedupe key there is. */
  placeId: string | null;
  name: string;
  address: string | null;
  /** The town, read out of addressComponents rather than parsed out of prose. */
  city: string | null;
  postalCode: string | null;
  category: string | null;
  rating: number | null;
  reviews: number | null;
  phone: string | null;
  websiteUri: string | null;
  /** OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY. */
  businessStatus: string | null;
  mapsUri: string | null;
}

export interface PlacesSearchResponse {
  results: PlaceResult[];
  requestCount: number;
}

export interface PlacesSearchArea {
  center: LatLng;
  radiusM: number;
}

export interface PlacesClient {
  textSearch(q: {
    keyword: string;
    location: string;
    radius?: string;
    /** When set, results are bounded to this circle — see `area` below. */
    area?: PlacesSearchArea | null;
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

export interface ApiAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

export interface ApiPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: ApiAddressComponent[];
  primaryTypeDisplayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  businessStatus?: string;
  googleMapsUri?: string;
}

/**
 * Pull one component out by type.
 *
 * `locality` is the town almost everywhere in Hungary. `postal_town` covers the
 * places that use it, and the county is the last resort — better than nothing
 * in the field the operator reads as "where is this".
 */
function component(
  components: ApiAddressComponent[] | undefined,
  types: string[],
): string | null {
  for (const want of types) {
    const hit = components?.find((c) => c.types?.includes(want));
    if (hit?.longText) return hit.longText;
  }
  return null;
}

/**
 * Floor and unit markers Google sometimes files as if they were a town.
 *
 * Not hypothetical: a real Debrecen clinic comes back with
 * `locality: "Fszt"` — földszint, the ground floor — while the actual city sits
 * in a component carrying NO types at all. Reading `locality` faithfully put
 * "Fszt" in the City field of the lead.
 */
const NOT_A_TOWN =
  /^(fszt|f\.szt|földszint|mfszt|magasföldszint|alagsor|emelet|em|szint|ajtó|pf|postafiók|[ivxlc]+|\d+\.?|[a-z]?\/?\d+)\.?$/i;

/** Structural parts of an address — never the name of a town. */
const STRUCTURAL = [
  "street_number",
  "route",
  "postal_code",
  "postal_code_suffix",
  "country",
  "subpremise",
  "premise",
  "floor",
  "room",
  "plus_code",
];

function plausibleTown(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  return t.length > 1 && !NOT_A_TOWN.test(t);
}

/**
 * The town, defended against Google's own bad rows.
 *
 * Takes `locality` when it looks like a place name, then the usual fallbacks,
 * and only then sweeps the remaining components for something that is not a
 * street, a number or a floor. The sweep exists solely because the city is
 * sometimes present with no type on it, and leaving the field empty when the
 * answer is sitting right there is the worse failure.
 */
function readTown(components: ApiAddressComponent[] | undefined): string | null {
  for (const want of ["locality", "postal_town", "administrative_area_level_1"]) {
    const hit = components?.find((c) => c.types?.includes(want));
    if (hit?.longText && plausibleTown(hit.longText)) return hit.longText;
  }
  const loose = components?.find(
    (c) => !(c.types ?? []).some((t) => STRUCTURAL.includes(t)) && plausibleTown(c.longText),
  );
  return loose?.longText ?? null;
}

/**
 * ── LANGUAGE IS NOT COSMETIC HERE ──────────────────────────────────────────
 *
 * Without these, Google answers in English, and it does not merely translate
 * the CATEGORY — it returns a different NAME. "Máthé Fogászat Debrecen" came
 * back as "Mathe Dentistry", and that anglicised string is what got written to
 * company.name, from where it flows into quotes, contracts and outreach. The
 * production data shows the same thing: prospected Hungarian bakeries filed
 * under the industry "Bakery" and cafés under "Cafe".
 *
 * The workspace sells to Hungarian businesses (CLAUDE.md), so Hungarian is the
 * right answer, and it also improves ranking for Hungarian-language queries.
 */
const LANGUAGE_CODE = "hu";
const REGION_CODE = "HU";

/**
 * Everything the search can tell us about a business, in one request.
 *
 * The mask already carried `rating`, `userRatingCount`, `websiteUri` and
 * `nationalPhoneNumber`, which put it in the top Text Search billing tier. The
 * fields added here (`id`, `addressComponents`, `businessStatus`,
 * `googleMapsUri`) sit in lower tiers, so asking for them costs NOTHING extra —
 * they were simply never requested, and the data was thrown away before it was
 * ever fetched.
 */
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.primaryTypeDisplayName",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.businessStatus",
  "places.googleMapsUri",
].join(",");

/**
 * One API place → one row.
 *
 * Exported because this mapping is where the Prospector was losing data: the
 * city, the place id and the business status were all in the response and none
 * of them were read. Pure, so a fixture can prove what comes out.
 */
export function mapApiPlace(p: ApiPlace): PlaceResult {
  return {
    placeId: p.id ?? null,
    lat: typeof p.location?.latitude === "number" ? p.location.latitude : null,
    lng: typeof p.location?.longitude === "number" ? p.location.longitude : null,
    name: p.displayName?.text ?? "Unknown",
    address: p.formattedAddress ?? null,
    city: readTown(p.addressComponents),
    postalCode: component(p.addressComponents, ["postal_code"]),
    category: p.primaryTypeDisplayName?.text ?? null,
    rating: p.rating ?? null,
    reviews: p.userRatingCount ?? null,
    phone: p.nationalPhoneNumber ?? null,
    websiteUri: p.websiteUri ?? null,
    businessStatus: p.businessStatus ?? null,
    mapsUri: p.googleMapsUri ?? null,
  };
}

/** The language and region the request asks for — see LANGUAGE_CODE above. */
export const PLACES_REQUEST_LOCALE = { languageCode: LANGUAGE_CODE, regionCode: REGION_CODE };

class GooglePlacesClient implements PlacesClient {
  /** Workspace key, resolved by the caller; null means fall back to env. */
  constructor(private readonly apiKey: string | null = null) {}

  async textSearch(q: {
    keyword: string;
    location: string;
    radius?: string;
    area?: PlacesSearchArea | null;
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
        ...PLACES_REQUEST_LOCALE,
      };
      /**
       * The radius, at last.
       *
       * `locationRestriction` takes a RECTANGLE here, not a circle, and it is a
       * hard bound rather than a preference — which is what a prospector wants:
       * a `locationBias` circle re-ranks everything towards the centre and
       * under-covers the outer ring, measured at 1.5 km of spread inside a 3 km
       * bias against 2.9 km with the restriction.
       */
      if (q.area) body.locationRestriction = { rectangle: boundingRectangle(q.area.center, q.area.radiusM) };
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
        const row = mapApiPlace(p);
        // Trim the rectangle's corners back to the circle the operator asked
        // for. A place with no coordinates is kept: Google put it in the area,
        // and dropping it for missing a field we only use to double-check would
        // lose a real business.
        if (q.area && row.lat != null && row.lng != null) {
          const km = haversineKm(q.area.center, { lat: row.lat, lng: row.lng });
          if (km > q.area.radiusM / 1000) continue;
        }
        results.push(row);
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
