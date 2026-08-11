import { describe, it, expect } from "vitest";
import {
  localWallToUtcMs,
  formatSlotLabel,
  generateDaySlots,
  generateDayStrip,
  type SlotConfig,
} from "../../src/modules/meetings/slots";
import { botVerdict } from "../../src/modules/meetings/botcheck";
import { hitRateLimit } from "../../src/modules/meetings/ratelimit";

const TZ = "Europe/Budapest";

const CONFIG: SlotConfig = {
  timezone: TZ,
  workingDays: [1, 2, 3, 4, 5], // Mon–Fri
  workStartMin: 9 * 60,
  workEndMin: 17 * 60,
  slotStepMin: 60,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 0,
};

describe("Europe/Budapest wall-clock ↔ UTC (DST-aware)", () => {
  it("summer is UTC+2", () => {
    // 2026-08-13 10:00 Budapest (CEST) == 08:00 UTC
    expect(localWallToUtcMs(2026, 7, 13, 10, 0, TZ)).toBe(Date.UTC(2026, 7, 13, 8, 0));
  });
  it("winter is UTC+1", () => {
    // 2026-01-13 10:00 Budapest (CET) == 09:00 UTC
    expect(localWallToUtcMs(2026, 0, 13, 10, 0, TZ)).toBe(Date.UTC(2026, 0, 13, 9, 0));
  });
  it("labels a UTC instant in the host timezone without leading zero", () => {
    expect(formatSlotLabel(Date.UTC(2026, 7, 13, 8, 0), TZ)).toBe("10:00");
    expect(formatSlotLabel(Date.UTC(2026, 7, 13, 12, 30), TZ)).toBe("14:30");
  });
});

describe("generateDaySlots", () => {
  it("emits hourly slots across working hours", () => {
    const slots = generateDaySlots({
      dayISO: "2026-08-13", // Thursday
      durationMin: 30,
      config: CONFIG,
      busy: [],
      nowMs: 0,
    });
    expect(slots.map((s) => s.label)).toEqual([
      "9:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00",
    ]);
  });

  it("removes slots that collide with a busy interval (with buffers)", () => {
    const busyStart = Date.UTC(2026, 7, 13, 8, 0); // 10:00 Budapest
    const slots = generateDaySlots({
      dayISO: "2026-08-13",
      durationMin: 30,
      config: { ...CONFIG, bufferBeforeMin: 15, bufferAfterMin: 15 },
      busy: [{ startMs: busyStart, endMs: busyStart + 30 * 60_000 }],
      nowMs: 0,
    });
    expect(slots.map((s) => s.label)).not.toContain("10:00");
    // the 9:00 slot (ends 9:30, +15m buffer = 9:45) stays clear of 10:00 busy
    expect(slots.map((s) => s.label)).toContain("9:00");
  });

  it("returns nothing on a non-working day", () => {
    const slots = generateDaySlots({
      dayISO: "2026-08-15", // Saturday
      durationMin: 30,
      config: CONFIG,
      busy: [],
      nowMs: 0,
    });
    expect(slots).toEqual([]);
  });

  it("hides slots inside the minimum-notice window", () => {
    // now = 2026-08-13 12:00 Budapest (10:00 UTC), 120m notice → first bookable 14:00
    const now = Date.UTC(2026, 7, 13, 10, 0);
    const slots = generateDaySlots({
      dayISO: "2026-08-13",
      durationMin: 30,
      config: { ...CONFIG, minNoticeMin: 120 },
      busy: [],
      nowMs: now,
    });
    expect(slots.map((s) => s.label)).toEqual(["14:00", "15:00", "16:00"]);
  });
});

describe("generateDayStrip", () => {
  it("lists the next N working days, skipping the weekend", () => {
    // Start Thursday 2026-08-13
    const strip = generateDayStrip({ fromMs: Date.UTC(2026, 7, 13, 6, 0), count: 5, config: CONFIG });
    expect(strip.map((d) => `${d.dayNum} ${d.weekday}`)).toEqual([
      "13 Thu", "14 Fri", "17 Mon", "18 Tue", "19 Wed",
    ]);
  });
});

describe("bot protection (honeypot + timing, no CAPTCHA)", () => {
  it("rejects a filled honeypot", () => {
    expect(botVerdict({ honeypot: "http://spam", elapsedMs: 9000, minElapsedMs: 2000 })).toEqual({
      ok: false,
      reason: "honeypot",
    });
  });
  it("rejects a too-fast submission", () => {
    expect(botVerdict({ honeypot: "", elapsedMs: 400, minElapsedMs: 2000 })).toEqual({
      ok: false,
      reason: "too_fast",
    });
  });
  it("accepts a clean, human-paced submission", () => {
    expect(botVerdict({ honeypot: "", elapsedMs: 8000, minElapsedMs: 2000 })).toEqual({ ok: true });
  });
});

describe("fixed-window rate limit", () => {
  it("allows up to the cap, then blocks within the window", () => {
    let bucket;
    let r;
    for (let i = 0; i < 5; i++) {
      r = hitRateLimit(bucket, 1000, 60_000, 5);
      bucket = r.bucket;
      expect(r.allowed).toBe(true);
    }
    r = hitRateLimit(bucket, 1500, 60_000, 5);
    expect(r.allowed).toBe(false);
  });
  it("resets after the window elapses", () => {
    let r = hitRateLimit({ count: 5, windowStartMs: 1000 }, 62_000, 60_000, 5);
    expect(r.allowed).toBe(true);
    expect(r.bucket.count).toBe(1);
  });
});
