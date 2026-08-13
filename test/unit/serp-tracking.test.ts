import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  NullSerpProvider,
  DataForSeoProvider,
  serpProviderFor,
  positionOf,
  shareOfTopTen,
  monthlyCostUsd,
  droppedOutOfTopTen,
  DATAFORSEO_COST_PER_QUERY_USD,
} from "@/modules/serp/provider";

/**
 * P2/7 — rank tracking. The load-bearing facts: it is dormant without a key,
 * it never scrapes, and "not ranking" is null rather than a big number.
 */
describe("provider selection", () => {
  // serpProviderFor falls back to SERP_CREDENTIAL, so a developer machine with
  // a real credential in .env would otherwise make the "no provider" cases
  // pass a live provider and fail for the wrong reason.
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.SERP_CREDENTIAL;
    delete process.env.SERP_CREDENTIAL;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.SERP_CREDENTIAL = saved;
  });

  it("defaults to the null provider, which is not configured", async () => {
    const p = serpProviderFor(null);
    expect(p.configured).toBe(false);
    expect(p.id).toBe("null");
    expect((await p.search({ keyword: "x", locale: "hu-HU" })).results).toEqual([]);
    expect(p.costPerQueryUsd).toBe(0);
  });

  it("refuses a credential that is not login:password", () => {
    expect(serpProviderFor("just-a-token").configured).toBe(false);
    expect(serpProviderFor("user:pass").id).toBe("dataforseo");
  });

  it("uses the env credential when a workspace has none of its own", () => {
    process.env.SERP_CREDENTIAL = "env-login:env-pass";
    expect(serpProviderFor(null).configured).toBe(true);
    // A workspace's own value still wins over the deployment default.
    expect(serpProviderFor("just-a-token").configured).toBe(false);
  });

  it("prices a real provider per query", () => {
    expect(serpProviderFor("user:pass").costPerQueryUsd).toBe(DATAFORSEO_COST_PER_QUERY_USD);
  });
});

describe("DataForSeoProvider", () => {
  const body = {
    tasks: [
      {
        result: [
          {
            items: [
              { type: "paid", rank_group: 1, url: "https://ad.hu", domain: "ad.hu", title: "Ad" },
              {
                type: "organic",
                rank_group: 3,
                url: "https://pelda.hu/arak",
                domain: "pelda.hu",
                title: "Árak",
              },
              {
                type: "organic",
                rank_group: 4,
                url: "https://rival.hu",
                domain: "rival.hu",
                title: "Rival",
              },
            ],
          },
        ],
      },
    ],
  };

  const fake = (status = 200) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  it("keeps organic results and drops the ads", async () => {
    const p = new DataForSeoProvider("user:pass", fake());
    const res = await p.search({ keyword: "fogászat budapest", locale: "hu-HU" });
    expect(res.results.map((r) => r.domain)).toEqual(["pelda.hu", "rival.hu"]);
    expect(res.costUsd).toBe(DATAFORSEO_COST_PER_QUERY_USD);
  });

  it("sends the locale's language and a location for local intent", async () => {
    const sent: string[] = [];
    const capture = (async (_u: unknown, init?: RequestInit) => {
      sent.push(String(init?.body));
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    await new DataForSeoProvider("user:pass", capture).search({
      keyword: "fogászat",
      locale: "hu-HU",
      location: "Budapest,Hungary",
    });
    const payload = JSON.parse(sent[0]!)[0];
    expect(payload.language_code).toBe("hu");
    expect(payload.location_name).toBe("Budapest,Hungary");
  });

  it("throws on an API error rather than reporting no rankings", async () => {
    const p = new DataForSeoProvider("user:pass", fake(500));
    await expect(p.search({ keyword: "x", locale: "hu-HU" })).rejects.toThrow();
  });
});

describe("positionOf", () => {
  const results = [
    { position: 3, url: "https://pelda.hu/a", domain: "pelda.hu", title: "" },
    { position: 7, url: "https://www.masik.hu", domain: "www.masik.hu", title: "" },
  ];

  it("finds the domain's rank", () => {
    expect(positionOf(results, "pelda.hu")).toBe(3);
  });

  it("ignores www on either side", () => {
    expect(positionOf(results, "masik.hu")).toBe(7);
    expect(positionOf(results, "www.pelda.hu")).toBe(3);
  });

  it("returns null — not a large number — when the domain is absent", () => {
    expect(positionOf(results, "sehol.hu")).toBeNull();
  });
});

describe("summary numbers", () => {
  it("counts share of top ten, treating unranked as out", () => {
    expect(shareOfTopTen([1, 4, 30, null])).toBe(50);
    expect(shareOfTopTen([])).toBe(0);
    expect(shareOfTopTen([null, null])).toBe(0);
  });

  it("projects the monthly bill on 4.34 weeks, not 4", () => {
    const ten = monthlyCostUsd(10, 0.002);
    expect(ten).toBeCloseTo(0.0868, 4);
    // Rounding down to 4 weeks would under-quote by 8%.
    expect(ten).toBeGreaterThan(10 * 0.002 * 4);
  });
});

describe("droppedOutOfTopTen", () => {
  it("fires when a top-ten term falls out", () => {
    expect(droppedOutOfTopTen(8, 12)).toBe(true);
    expect(droppedOutOfTopTen(8, null)).toBe(true);
  });

  it("stays quiet for movement inside or below the top ten", () => {
    expect(droppedOutOfTopTen(3, 9)).toBe(false);
    expect(droppedOutOfTopTen(20, 40)).toBe(false);
    expect(droppedOutOfTopTen(null, 40)).toBe(false);
    // No history yet is not a drop.
    expect(droppedOutOfTopTen(null, null)).toBe(false);
  });
});
