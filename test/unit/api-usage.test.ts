import { describe, it, expect } from "vitest";
import {
  buildProviderUsage,
  startOfUtcDay,
  startOfUtcMonth,
  PROVIDER_META,
  API_PROVIDERS,
} from "@/lib/api-usage";

/**
 * External API cost tracking.
 *
 * The judgement this encodes: PageSpeed and CrUX are FREE, so a dollar column
 * for them would read $0.00 for ever while the thing that can actually run out
 * — Google's per-project quota — went unwatched.
 */
describe("provider metadata", () => {
  it("marks the free Google APIs as unbilled", () => {
    expect(PROVIDER_META.pagespeed.billed).toBe(false);
    expect(PROVIDER_META.crux.billed).toBe(false);
  });

  it("marks the ones that actually cost money as billed", () => {
    expect(PROVIDER_META.dataforseo.billed).toBe(true);
    expect(PROVIDER_META.places.billed).toBe(true);
  });

  it("describes every provider it lists", () => {
    for (const p of API_PROVIDERS) {
      expect(PROVIDER_META[p].label.length).toBeGreaterThan(0);
      expect(PROVIDER_META[p].note.length).toBeGreaterThan(0);
    }
  });
});

describe("buildProviderUsage", () => {
  it("carries today and month figures through", () => {
    const u = buildProviderUsage(
      "dataforseo",
      { calls: 10, cost: 0.02 },
      { calls: 43, cost: 0.086 },
    );
    expect(u.label).toBe("DataForSEO");
    expect(u.callsToday).toBe(10);
    expect(u.costMonthUsd).toBeCloseTo(0.086, 4);
    // No daily quota to measure against, so none is claimed.
    expect(u.quotaPct).toBeNull();
  });

  it("reports quota headroom for a free API that has one", () => {
    const u = buildProviderUsage("pagespeed", { calls: 2500, cost: 0 }, { calls: 9000, cost: 0 });
    expect(u.billed).toBe(false);
    expect(u.quotaPct).toBe(10); // 2500 of 25,000
  });

  it("clamps a quota overshoot rather than reporting 140%", () => {
    const u = buildProviderUsage("pagespeed", { calls: 35_000, cost: 0 }, { calls: 0, cost: 0 });
    expect(u.quotaPct).toBe(100);
  });

  it("does not invent metadata for an unknown provider", () => {
    const u = buildProviderUsage("something-new", { calls: 1, cost: 1 }, { calls: 1, cost: 1 });
    expect(u.label).toBe("something-new");
    expect(u.quotaPct).toBeNull();
    // Unknown providers are assumed to cost money — the safe assumption when
    // the alternative is hiding a bill.
    expect(u.billed).toBe(true);
  });
});

describe("period boundaries", () => {
  it("uses UTC days, matching the Claude budget reset", () => {
    const d = startOfUtcDay(new Date("2026-08-14T23:30:00Z"));
    expect(d.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("starts the month on the first, in UTC", () => {
    const m = startOfUtcMonth(new Date("2026-08-14T23:30:00Z"));
    expect(m.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("does not slip a day for a late-evening local time", () => {
    // 00:30 on the 15th in Budapest is still the 14th in UTC.
    const d = startOfUtcDay(new Date("2026-08-14T22:30:00Z"));
    expect(d.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });
});
