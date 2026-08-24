import type { WebsitePresence } from "./website";

export interface ProspectRow {
  /**
   * Google's stable place id. Optional because rows cached before it was ever
   * requested do not carry one — see the cache check in actions.ts.
   */
  placeId?: string | null;
  name: string;
  address: string | null;
  city?: string | null;
  postalCode?: string | null;
  category: string | null;
  rating: number | null;
  reviews: number | null;
  phone: string | null;
  websiteUri: string | null;
  businessStatus?: string | null;
  mapsUri?: string | null;
  presence: WebsitePresence;
  classification?: {
    fit: "strong" | "possible" | "skip";
    priority: number;
  } | null;
}

export interface ProspectSearchResult {
  fromCache: boolean;
  searchId: string;
  results: ProspectRow[];
  summary: string;
  costUsd: number;
  /**
   * Anything the operator has to know about how the search was actually run —
   * above all, a radius that could NOT be applied. Silently ignoring it is the
   * bug this field exists to prevent from coming back.
   */
  notice?: string | null;
}

export interface SavedSearch {
  id: string;
  keyword: string;
  location: string;
}
