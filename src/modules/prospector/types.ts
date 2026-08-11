import type { WebsitePresence } from "./website";

export interface ProspectRow {
  name: string;
  address: string | null;
  category: string | null;
  rating: number | null;
  reviews: number | null;
  phone: string | null;
  websiteUri: string | null;
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
