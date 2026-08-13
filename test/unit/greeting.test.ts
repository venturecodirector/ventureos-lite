import { describe, it, expect } from "vitest";
import {
  greetingBandFor,
  greetingFor,
  msUntilNextBand,
  GREETING_LABEL,
} from "@/lib/greeting";

/**
 * The shell greeted everyone with "good morning" at every hour of the day.
 * These pin the bands, and especially the boundaries — an off-by-one here is
 * invisible in review and obvious to a user at 10:00.
 */
describe("greetingBandFor", () => {
  it("greets the morning from 05:00 to 09:59", () => {
    expect(greetingBandFor(5)).toBe("morning");
    expect(greetingBandFor(7)).toBe("morning");
    expect(greetingBandFor(9)).toBe("morning");
  });

  it("switches to day at exactly 10:00", () => {
    expect(greetingBandFor(9)).toBe("morning");
    expect(greetingBandFor(10)).toBe("day");
  });

  it("stays day until 17:59", () => {
    expect(greetingBandFor(12)).toBe("day");
    expect(greetingBandFor(17)).toBe("day");
  });

  it("switches to evening at exactly 18:00", () => {
    expect(greetingBandFor(17)).toBe("day");
    expect(greetingBandFor(18)).toBe("evening");
  });

  it("keeps the evening across midnight until 04:59", () => {
    expect(greetingBandFor(20)).toBe("evening");
    expect(greetingBandFor(23)).toBe("evening");
    expect(greetingBandFor(0)).toBe("evening");
    expect(greetingBandFor(3)).toBe("evening");
    expect(greetingBandFor(4)).toBe("evening");
  });

  it("switches back to morning at exactly 05:00", () => {
    expect(greetingBandFor(4)).toBe("evening");
    expect(greetingBandFor(5)).toBe("morning");
  });

  it("covers all 24 hours with no gap", () => {
    for (let h = 0; h < 24; h += 1) {
      expect(["morning", "day", "evening"]).toContain(greetingBandFor(h));
    }
  });

  it("does not throw on nonsense rather than breaking a page header", () => {
    expect(greetingBandFor(NaN)).toBe("day");
    // Out-of-range hours wrap: 25 is 01:00, which is still the night band.
    expect(greetingBandFor(25)).toBe("evening");
    expect(greetingBandFor(30)).toBe("morning"); // 06:00
    expect(greetingBandFor(-1)).toBe("evening"); // 23:00
    expect(greetingBandFor(7.5)).toBe("morning"); // fractional hours floor
  });
});

describe("greetingFor", () => {
  it("renders the words the design uses, lowercase", () => {
    expect(greetingFor(7)).toBe("good morning");
    expect(greetingFor(13)).toBe("good day");
    expect(greetingFor(21)).toBe("good evening");
    expect(Object.values(GREETING_LABEL).every((l) => l === l.toLowerCase())).toBe(true);
  });
});

describe("msUntilNextBand", () => {
  const at = (h: number, m = 0) => new Date(2026, 7, 14, h, m, 0, 0);

  it("counts to the next boundary, not a fixed interval", () => {
    expect(msUntilNextBand(at(9, 30))).toBe(30 * 60 * 1000);
    expect(msUntilNextBand(at(17, 0))).toBe(60 * 60 * 1000);
    expect(msUntilNextBand(at(3, 0))).toBe(2 * 60 * 60 * 1000);
  });

  it("rolls over to tomorrow morning from the evening", () => {
    // 20:00 → 05:00 next day is nine hours.
    expect(msUntilNextBand(at(20, 0))).toBe(9 * 60 * 60 * 1000);
  });

  it("never returns zero, so a timer cannot spin", () => {
    expect(msUntilNextBand(at(10, 0))).toBeGreaterThan(0);
    expect(msUntilNextBand(at(18, 0))).toBeGreaterThan(0);
    expect(msUntilNextBand(at(5, 0))).toBeGreaterThan(0);
  });
});
