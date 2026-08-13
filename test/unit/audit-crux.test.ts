import { describe, it, expect } from "vitest";
import {
  fetchCrux,
  parseCruxResponse,
  toMetric,
  verdictFor,
  formatMetric,
  fieldSummaryHu,
  fieldSummaryEn,
  type CruxData,
} from "@/modules/audit/crux";

/**
 * P2/2 — field data. The two things that matter here are that the histogram is
 * read correctly, and that "not enough traffic" reads as exactly that rather
 * than as a zero, an error, or an implied clean bill of health.
 */
const record = (over: Record<string, unknown> = {}) => ({
  record: {
    metrics: {
      largest_contentful_paint: {
        histogram: [{ density: 0.62 }, { density: 0.25 }, { density: 0.13 }],
        percentiles: { p75: 3400 },
      },
      interaction_to_next_paint: {
        histogram: [{ density: 0.9 }, { density: 0.08 }, { density: 0.02 }],
        percentiles: { p75: 180 },
      },
      cumulative_layout_shift: {
        histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }],
        percentiles: { p75: "0.14" },
      },
    },
    collectionPeriod: {
      firstDate: { year: 2026, month: 7, day: 17 },
      lastDate: { year: 2026, month: 8, day: 13 },
    },
    ...over,
  },
});

describe("toMetric", () => {
  it("reads the three density buckets and the p75", () => {
    const m = toMetric({
      histogram: [{ density: 0.5 }, { density: 0.3 }, { density: 0.2 }],
      percentiles: { p75: 2600 },
    })!;
    expect(m.good).toBe(0.5);
    expect(m.needsImprovement).toBe(0.3);
    expect(m.poor).toBe(0.2);
    expect(m.p75).toBe(2600);
  });

  it("accepts the numeric strings the API sometimes returns", () => {
    expect(toMetric({ histogram: [{}, {}, {}], percentiles: { p75: "0.14" } })!.p75).toBe(0.14);
  });

  it("treats a missing bucket as zero rather than crashing", () => {
    const m = toMetric({ histogram: [{ density: 0.8 }, {}, { density: 0.2 }] })!;
    expect(m.needsImprovement).toBe(0);
    expect(m.p75).toBeNull();
  });

  it("returns null for a metric with no histogram", () => {
    expect(toMetric(undefined)).toBeNull();
    expect(toMetric({ histogram: [{ density: 1 }] })).toBeNull();
  });
});

describe("parseCruxResponse", () => {
  it("maps a full record", () => {
    const d = parseCruxResponse(record(), "PHONE")!;
    expect(d.formFactor).toBe("PHONE");
    expect(d.lcp!.p75).toBe(3400);
    expect(d.inp!.p75).toBe(180);
    expect(d.cls!.p75).toBe(0.14);
    expect(d.period).toBe("2026-07-17 – 2026-08-13");
  });

  it("returns null when the record carries none of the three vitals", () => {
    expect(parseCruxResponse({ record: { metrics: {} } }, "ALL")).toBeNull();
    expect(parseCruxResponse({}, "ALL")).toBeNull();
  });

  it("keeps a partial record — some origins report only LCP", () => {
    const partial = {
      record: {
        metrics: {
          largest_contentful_paint: {
            histogram: [{ density: 0.4 }, { density: 0.4 }, { density: 0.2 }],
            percentiles: { p75: 3000 },
          },
        },
      },
    };
    const d = parseCruxResponse(partial, "PHONE")!;
    expect(d.lcp).not.toBeNull();
    expect(d.inp).toBeNull();
    expect(d.period).toBeNull();
  });
});

describe("fetchCrux", () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("asks for phone data first and uses it when it exists", async () => {
    const calls: string[] = [];
    const fake = (async (_u: unknown, init?: RequestInit) => {
      calls.push(String(init?.body));
      return ok(record());
    }) as unknown as typeof fetch;

    const d = await fetchCrux("https://nagy.hu/valami", "KEY", fake);
    expect(d!.formFactor).toBe("PHONE");
    expect(calls).toHaveLength(1);
    // Origin level, not page level: a small site has no per-URL coverage.
    expect(JSON.parse(calls[0]!)).toEqual({ origin: "https://nagy.hu", formFactor: "PHONE" });
  });

  it("falls back to all form factors when phone data is missing", async () => {
    const bodies: string[] = [];
    const fake = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return bodies.length === 1 ? new Response("", { status: 404 }) : ok(record());
    }) as unknown as typeof fetch;

    const d = await fetchCrux("https://nagy.hu/", "KEY", fake);
    expect(d!.formFactor).toBe("ALL");
    expect(JSON.parse(bodies[1]!)).toEqual({ origin: "https://nagy.hu" });
  });

  it("returns null for a site below the traffic threshold", async () => {
    const fake = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchCrux("https://apro-fogaszat.hu/", "KEY", fake)).toBeNull();
  });

  it("returns null rather than throwing when the API is unreachable", async () => {
    const fake = (async () => {
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof fetch;
    expect(await fetchCrux("https://nagy.hu/", "KEY", fake)).toBeNull();
  });

  it("does nothing without a key", async () => {
    let called = false;
    const fake = (async () => {
      called = true;
      return ok(record());
    }) as unknown as typeof fetch;
    const prevCrux = process.env.CRUX_API_KEY;
    const prevPsi = process.env.PAGESPEED_API_KEY;
    delete process.env.CRUX_API_KEY;
    delete process.env.PAGESPEED_API_KEY;
    try {
      expect(await fetchCrux("https://nagy.hu/", null, fake)).toBeNull();
      expect(called).toBe(false);
    } finally {
      if (prevCrux) process.env.CRUX_API_KEY = prevCrux;
      if (prevPsi) process.env.PAGESPEED_API_KEY = prevPsi;
    }
  });
});

describe("plain language", () => {
  const data = parseCruxResponse(record(), "PHONE") as CruxData;

  it("grades against Google's own thresholds", () => {
    expect(verdictFor("lcp", 2400)).toBe("good");
    expect(verdictFor("lcp", 3400)).toBe("needs-improvement");
    expect(verdictFor("lcp", 4200)).toBe("poor");
    expect(verdictFor("cls", 0.05)).toBe("good");
    expect(verdictFor("inp", 600)).toBe("poor");
    expect(verdictFor("lcp", null)).toBeNull();
  });

  it("formats seconds, milliseconds and the unitless CLS", () => {
    expect(formatMetric("lcp", 3400)).toBe("3.4 s");
    expect(formatMetric("inp", 180)).toBe("180 ms");
    expect(formatMetric("cls", 0.14)).toBe("0.14");
    expect(formatMetric("lcp", null)).toBe("—");
  });

  it("says what share of real visitors found the site slow", () => {
    // 25% needs-improvement + 13% poor.
    expect(fieldSummaryHu(data)).toContain("38%");
    expect(fieldSummaryHu(data)).toContain("mobilos látogatóinak");
    expect(fieldSummaryEn(data)).toContain("38%");
  });

  it("says there is not enough data instead of implying the site is fine", () => {
    expect(fieldSummaryHu(null)).toContain("Nincs elegendő forgalmi adat");
    expect(fieldSummaryHu(null)).not.toMatch(/gyors/i);
    expect(fieldSummaryEn(null)).toContain("No field data");
  });
});
