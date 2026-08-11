import { describe, it, expect } from "vitest";
import {
  callbackChipDate,
  isCallbackDue,
  CALLBACK_CHIPS,
} from "../../src/modules/calls/schedule";

const NOW = new Date("2026-08-11T08:00:00Z"); // a fixed reference time

describe("callbackChipDate (quick-chip smart defaults)", () => {
  it("Tomorrow 9:00 = next calendar day at 09:00", () => {
    expect(callbackChipDate("tomorrow_9", NOW).toISOString()).toBe(
      "2026-08-12T09:00:00.000Z",
    );
  });

  it("Thu 14:00 = the next Thursday at 14:00, strictly in the future", () => {
    const d = callbackChipDate("thu_14", NOW);
    expect(d.getUTCDay()).toBe(4); // Thursday
    expect(d.getUTCHours()).toBe(14);
    expect(d.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("Next Mon 9:00 = the next Monday at 09:00, strictly in the future", () => {
    const d = callbackChipDate("next_mon_9", NOW);
    expect(d.getUTCDay()).toBe(1); // Monday
    expect(d.getUTCHours()).toBe(9);
    expect(d.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("exposes the chips shown in the UI", () => {
    expect(CALLBACK_CHIPS.map((c) => c.key)).toEqual([
      "tomorrow_9",
      "thu_14",
      "next_mon_9",
    ]);
  });
});

describe("isCallbackDue", () => {
  it("is due when the callback time has arrived", () => {
    expect(isCallbackDue(new Date("2026-08-11T08:00:00Z"), NOW)).toBe(true);
    expect(isCallbackDue(new Date("2026-08-11T07:59:00Z"), NOW)).toBe(true);
  });
  it("is not due in the future", () => {
    expect(isCallbackDue(new Date("2026-08-11T09:00:00Z"), NOW)).toBe(false);
  });
});
