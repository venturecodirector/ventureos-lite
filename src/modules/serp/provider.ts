/**
 * SERP provider adapter (P2/7).
 *
 * Rank tracking needs somebody's index. Scraping Google is against its terms
 * and is not something this product will do, so every position comes from a
 * paid API behind this interface — and the DEFAULT implementation returns
 * nothing at all, so the feature lies dormant until a workspace configures a
 * key and accepts the cost.
 *
 * Deliberately small: known terms only. No keyword research, no search-volume
 * database, no suggestion engine. Those are a different product, and pretending
 * otherwise would mean shipping numbers we cannot stand behind.
 */
export interface SerpQuery {
  keyword: string;
  /** BCP-47-ish locale, e.g. "hu-HU". */
  locale: string;
  /** City or region for local intent, e.g. "Budapest,Hungary". */
  location?: string | null;
}

export interface SerpResult {
  /** 1-based position in the organic results. */
  position: number;
  url: string;
  domain: string;
  title: string;
}

export interface SerpResponse {
  results: SerpResult[];
  /** What this query cost, in USD, as the provider reports or prices it. */
  costUsd: number;
}

export interface SerpProvider {
  readonly id: string;
  /** False for the null provider, so callers can explain why nothing happens. */
  readonly configured: boolean;
  /** Price of one position check, for the projection shown before enabling. */
  readonly costPerQueryUsd: number;
  search(query: SerpQuery): Promise<SerpResponse>;
}

/**
 * The default. Configured=false, so the UI can say "no provider" rather than
 * showing an empty table that looks like "you rank nowhere".
 */
export class NullSerpProvider implements SerpProvider {
  readonly id = "null";
  readonly configured = false;
  readonly costPerQueryUsd = 0;
  async search(): Promise<SerpResponse> {
    return { results: [], costUsd: 0 };
  }
}

/** DataForSEO's live advanced endpoint. Priced per task, billed on request. */
export const DATAFORSEO_COST_PER_QUERY_USD = 0.002;

interface DfsItem {
  type?: string;
  rank_absolute?: number;
  rank_group?: number;
  url?: string;
  domain?: string;
  title?: string;
}

export class DataForSeoProvider implements SerpProvider {
  readonly id = "dataforseo";
  readonly configured = true;
  readonly costPerQueryUsd = DATAFORSEO_COST_PER_QUERY_USD;

  constructor(
    /** "login:password", base64-encoded by us — the API wants Basic auth. */
    private readonly credential: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async search(query: SerpQuery): Promise<SerpResponse> {
    const [language] = query.locale.split("-");
    const res = await this.doFetch(
      "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(this.credential).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify([
          {
            keyword: query.keyword,
            language_code: language || "hu",
            location_name: query.location || "Hungary",
            depth: 100,
          },
        ]),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) throw new Error(`SERP provider returned ${res.status}`);
    const body = (await res.json()) as {
      tasks?: Array<{ result?: Array<{ items?: DfsItem[] }> }>;
    };
    const items = body.tasks?.[0]?.result?.[0]?.items ?? [];

    return {
      results: items
        .filter((i) => i.type === "organic" && typeof i.url === "string")
        .map((i) => ({
          position: i.rank_group ?? i.rank_absolute ?? 0,
          url: i.url!,
          domain: (i.domain ?? "").toLowerCase(),
          title: i.title ?? "",
        }))
        .filter((r) => r.position > 0),
      costUsd: this.costPerQueryUsd,
    };
  }
}

/** The provider a workspace's configured credential implies. */
export function serpProviderFor(
  credential: string | null,
  doFetch: typeof fetch = fetch,
): SerpProvider {
  // A workspace's own credential wins; the env one is the deployment-wide
  // fallback, exactly as the other integrations resolve.
  const resolved = credential ?? process.env.SERP_CREDENTIAL ?? null;
  if (!resolved || !resolved.includes(":")) return new NullSerpProvider();
  return new DataForSeoProvider(resolved, doFetch);
}

// ---------------------------------------------------------------------------
// Positions, and what they mean
// ---------------------------------------------------------------------------

/** Where a domain sits in a result set; null when it is not there at all. */
export function positionOf(results: SerpResult[], domain: string): number | null {
  const want = domain.replace(/^www\./, "").toLowerCase();
  const hit = results.find((r) => r.domain.replace(/^www\./, "") === want);
  return hit?.position ?? null;
}

/** Share of tracked keywords ranking in the top ten. */
export function shareOfTopTen(positions: Array<number | null>): number {
  if (positions.length === 0) return 0;
  const inTop = positions.filter((p) => p !== null && p <= 10).length;
  return Math.round((inTop / positions.length) * 100);
}

/**
 * Monthly cost of a tracking list, checked weekly.
 *
 * 4.34 weeks a month, not 4: the difference is 8%, and a projection that
 * undershoots the bill is worse than no projection.
 */
export const WEEKS_PER_MONTH = 4.34;

export function monthlyCostUsd(keywordCount: number, costPerQueryUsd: number): number {
  return keywordCount * costPerQueryUsd * WEEKS_PER_MONTH;
}

/** Default ceiling on tracked keywords per company. */
export const DEFAULT_KEYWORD_CAP = 10;

/** A client dropping out of the top ten is a retention trigger (P2/7). */
export function droppedOutOfTopTen(
  previous: number | null,
  current: number | null,
): boolean {
  return previous !== null && previous <= 10 && (current === null || current > 10);
}
