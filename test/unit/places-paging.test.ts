import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { getPlacesClient, PLACES_PAGE_SIZE, PLACES_MAX_RESULTS } from "@/lib/places";

/**
 * Text Search paging.
 *
 * The Prospector returned exactly 20 results however large the area, because
 * the client issued a single request and Google pages at 20. These cover the
 * paging that fixed it — including the cases that cost money if they go wrong:
 * over-fetching past Google's 3-page ceiling, and throwing away pages already
 * paid for when a later one fails.
 */

function place(name: string) {
  return { displayName: { text: name }, formattedAddress: "Budapest", websiteUri: undefined };
}

/** A fetch stub returning `pages` pages, each with a token except the last. */
function stubPages(pages: number, perPage = PLACES_PAGE_SIZE) {
  let call = 0;
  // Typed args so the assertions below can read the request body back out.
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    call += 1;
    const last = call >= pages;
    return {
      ok: true,
      json: async () => ({
        places: Array.from({ length: perPage }, (_, i) => place(`p${call}-${i}`)),
        ...(last ? {} : { nextPageToken: `token-${call}` }),
      }),
    } as unknown as Response;
  });
}

const KEY = "test-key";
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("places text search paging", () => {
  it("makes a single request when 20 results are wanted", async () => {
    const f = stubPages(3);
    globalThis.fetch = f;

    const res = await getPlacesClient(KEY).textSearch({
      keyword: "plumber",
      location: "Budapest",
      maxResults: 20,
    });

    expect(f).toHaveBeenCalledTimes(1);
    expect(res.results).toHaveLength(20);
    expect(res.requestCount).toBe(1);
  });

  it("follows nextPageToken to reach 60 and bills each page", async () => {
    const f = stubPages(3);
    globalThis.fetch = f;

    const res = await getPlacesClient(KEY).textSearch({
      keyword: "plumber",
      location: "Budapest",
      maxResults: 60,
    });

    expect(f).toHaveBeenCalledTimes(3);
    expect(res.results).toHaveLength(60);
    // requestCount drives the cost figure shown to the user.
    expect(res.requestCount).toBe(3);

    // The second call must carry the token handed back by the first.
    const secondBody = JSON.parse(String(f.mock.calls[1]![1]!.body));
    expect(secondBody.pageToken).toBe("token-1");
  });

  it("never asks for more than Google's ceiling", async () => {
    const f = stubPages(10);
    globalThis.fetch = f;

    const res = await getPlacesClient(KEY).textSearch({
      keyword: "plumber",
      location: "Budapest",
      maxResults: 500,
    });

    expect(res.results).toHaveLength(PLACES_MAX_RESULTS);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("stops when Google runs out of pages, without erroring", async () => {
    // Only one page exists even though 60 were requested.
    const f = stubPages(1, 7);
    globalThis.fetch = f;

    const res = await getPlacesClient(KEY).textSearch({
      keyword: "plumber",
      location: "Budapest",
      maxResults: 60,
    });

    expect(res.results).toHaveLength(7);
    expect(res.requestCount).toBe(1);
  });

  it("keeps the pages already fetched when a later page fails", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            places: Array.from({ length: 20 }, (_, i) => place(`a${i}`)),
            nextPageToken: "token-1",
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 429, text: async () => "rate limited" } as unknown as Response;
    });

    const res = await getPlacesClient(KEY).textSearch({
      keyword: "plumber",
      location: "Budapest",
      maxResults: 60,
    });

    expect(res.results).toHaveLength(20);
    expect(res.requestCount).toBe(1);
  });

  it("still throws when the very first page fails", async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: false, status: 403, text: async () => "denied" }) as unknown as Response,
    );

    await expect(
      getPlacesClient(KEY).textSearch({ keyword: "x", location: "y", maxResults: 60 }),
    ).rejects.toThrow(/403/);
  });

  it("defaults to one page when no depth is given", async () => {
    const f = stubPages(3);
    globalThis.fetch = f;

    const res = await getPlacesClient(KEY).textSearch({ keyword: "x", location: "y" });

    expect(f).toHaveBeenCalledTimes(1);
    expect(res.results).toHaveLength(PLACES_PAGE_SIZE);
  });
});
