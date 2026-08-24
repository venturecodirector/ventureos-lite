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
}

export interface SavedSearch {
  id: string;
  keyword: string;
  location: string;
}
