import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPsi } from "../../src/modules/audit/psi";
import { analyzeAudit } from "../../src/modules/audit/analyze";
import type { PageProbe } from "../../src/modules/audit/types";

const probe: PageProbe = {
  url: "https://example.hu",
  finalUrl: "https://example.hu",
  isHttps: true,
  statusOk: true,
  hasViewport: true,
  title: "Example",
  metaDescription: "Example",
  h1Count: 1,
  imgTotal: 2,
  imgWithAlt: 2,
  hasSitemap: true,
  hasRobots: true,
  copyrightYear: 2026,
  hasPhone: true,
  hasEmail: true,
  hasForm: true,
  hasBooking: true,
  hasCookieBanner: true,
  pageWeightBytes: 400_000,
  psi: null,
  screenshots: {},
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * Why this file exists.
 *
 * PageSpeed failure used to be a bare `null`, indistinguishable from "not
 * asked for". The audit then simply had no performance rows in it, and nothing
 * anywhere said why. On a deployment without a `PAGESPEED_API_KEY` that is not
 * an edge case: the endpoint bills against Google's shared anonymous project,
 * whose daily quota is routinely already spent, so PageSpeed silently never
 * worked and the product never mentioned it.
 */
describe("a PageSpeed measurement we could not take says so", () => {
  it("names the quota, and the fix, when Google answers 429 without a key", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 429 } }), { status: 429 }),
    ) as unknown as typeof fetch;

    const res = await fetchPsi("https://example.hu", null);
    expect(res.scores).toBeNull();
    expect(res.reason).toBe("quota");
    // The operator has to be able to act on it: the sentence names the key.
    expect(res.detail).toMatch(/API key/i);
  });

  it("distinguishes an exhausted personal key from the shared anonymous one", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;

    const res = await fetchPsi("https://example.hu", "a-real-key");
    expect(res.reason).toBe("quota");
    // Telling someone who HAS a key to set one would be nonsense.
    expect(res.detail).not.toMatch(/set a PageSpeed API key/i);
  });

  it("reports a timeout as a timeout rather than as a missing measurement", async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;

    const res = await fetchPsi("https://example.hu", null);
    expect(res.reason).toBe("timeout");
  });

  it("treats a 200 carrying no Lighthouse run as a failure, not four empty rows", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ lighthouseResult: { categories: {} } }), { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await fetchPsi("https://example.hu", null);
    expect(res.scores).toBeNull();
    expect(res.reason).toBe("malformed");
  });

  it("returns the scores, and no reason, on a good answer", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          lighthouseResult: {
            categories: {
              performance: { score: 0.42 },
              seo: { score: 0.9 },
              accessibility: { score: 0.8 },
              "best-practices": { score: 0.7 },
            },
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const res = await fetchPsi("https://example.hu", null);
    expect(res.reason).toBeNull();
    expect(res.scores).toEqual({
      performance: 42,
      seo: 90,
      accessibility: 80,
      bestPractices: 70,
    });
  });
});

describe("the report states the absence instead of staying quiet about it", () => {
  it("adds a failing, unscored row when PageSpeed could not be measured", () => {
    const withReason = analyzeAudit({
      ...probe,
      psiUnavailable: "PageSpeed quota exhausted.",
    });
    const row = withReason.checks.find((c) => c.key === "psiAvailable");
    expect(row).toBeDefined();
    expect(row!.pass).toBe(false);
    expect(row!.detail).toBe("PageSpeed quota exhausted.");
  });

  it("never lets our own outage move the prospect's opportunity score", () => {
    // The whole point of the row is that it is evidence about US. A site must
    // not score as a better prospect because Google would not answer.
    const silent = analyzeAudit(probe);
    const stated = analyzeAudit({ ...probe, psiUnavailable: "PageSpeed quota exhausted." });
    expect(stated.score).toBe(silent.score);
    expect(stated.verdict).toBe(silent.verdict);
  });

  it("says nothing when PageSpeed simply was not asked for", () => {
    expect(analyzeAudit(probe).checks.some((c) => c.key === "psiAvailable")).toBe(false);
  });
});
