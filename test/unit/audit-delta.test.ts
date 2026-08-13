import { describe, it, expect } from "vitest";
import { computeDelta, signalFor, SIGNIFICANT_SCORE_DELTA } from "@/modules/audit/delta";
import {
  projectedWeeklyLoad,
  maxWatchesFrom,
  nextRunFrom,
  shouldAutoWatch,
  isWatchFrequency,
  DEFAULT_MAX_WATCHES,
} from "@/modules/audit/watch";
import type { AuditCheck } from "@/modules/audit/types";

/** P2/5 — deltas and watches. */
const check = (key: string, pass: boolean): AuditCheck => ({ key, label: key, pass });
const at = new Date("2026-05-01T10:00:00Z");

const prev = (score: number, checks: AuditCheck[]) => ({
  id: "old",
  createdAt: at,
  score,
  checks,
});

describe("computeDelta", () => {
  it("reports a rising opportunity score as the site getting worse", () => {
    const d = computeDelta(prev(30, []), { score: 55, checks: [] });
    expect(d.scoreDelta).toBe(25);
    expect(d.significance).toBe("worse");
  });

  it("reports a falling score as the site improving", () => {
    const d = computeDelta(prev(60, []), { score: 40, checks: [] });
    expect(d.significance).toBe("better");
  });

  it("calls a small move stable rather than crying wolf", () => {
    const d = computeDelta(prev(50, []), { score: 50 + SIGNIFICANT_SCORE_DELTA - 1, checks: [] });
    expect(d.significance).toBe("stable");
    expect(signalFor(d, "pelda.hu")).toBeNull();
  });

  it("fires on a single category collapsing even when the total barely moves", () => {
    // Legal goes from clean to entirely failing; overall stays put.
    const before = [check("impresszum", true), check("privacyPolicy", true)];
    const after = [check("impresszum", false), check("privacyPolicy", false)];
    const d = computeDelta(prev(50, before), { score: 52, checks: after });
    expect(d.significance).toBe("worse");
    const legal = d.categories.find((c) => c.category === "legal")!;
    expect(legal.from).toBe(0);
    expect(legal.to).toBe(100);
  });

  it("lists what newly broke and what got fixed", () => {
    const before = [check("https", true), check("impresszum", false)];
    const after = [check("https", false), check("impresszum", true)];
    const d = computeDelta(prev(50, before), { score: 50, checks: after });
    expect(d.broken).toEqual(["https"]);
    expect(d.resolved).toEqual(["impresszum"]);
  });

  it("ignores a check that did not run last time — that is not a change", () => {
    const d = computeDelta(prev(50, [check("https", true)]), {
      score: 50,
      checks: [check("https", true), check("dmarc", false)],
    });
    expect(d.broken).toEqual([]);
    expect(d.resolved).toEqual([]);
  });

  it("keeps the previous audit's identity for the trend strip", () => {
    const d = computeDelta(prev(50, []), { score: 60, checks: [] });
    expect(d.previousAuditId).toBe("old");
    expect(d.previousAt).toBe(at.toISOString());
  });
});

describe("signalFor", () => {
  it("turns a worsening site into a reason to call", () => {
    const d = computeDelta(prev(30, [check("https", true)]), {
      score: 60,
      checks: [check("https", false)],
    });
    const s = signalFor(d, "pelda.hu")!;
    expect(s.type).toBe("audit_worsened");
    expect(s.headlineHu).toContain("Romlott");
    expect(s.suggestedTaskHu).toContain("időszerű megkeresés");
    expect(s.flag).toBe("site got worse");
  });

  it("treats an improving site as a competitive warning, not good news", () => {
    const d = computeDelta(prev(70, [check("https", false)]), {
      score: 30,
      checks: [check("https", true)],
    });
    const s = signalFor(d, "pelda.hu")!;
    expect(s.type).toBe("audit_improved");
    expect(s.suggestedTaskHu).toContain("szerződtek valakivel");
  });
});

describe("watch bookkeeping", () => {
  it("projects the weekly audit load, rounding up", () => {
    expect(projectedWeeklyLoad([{ frequencyDays: 30, enabled: true }])).toBe(1);
    expect(
      projectedWeeklyLoad([
        { frequencyDays: 30, enabled: true },
        { frequencyDays: 30, enabled: true },
        { frequencyDays: 30, enabled: true },
        { frequencyDays: 30, enabled: true },
      ]),
    ).toBe(1);
    // 50 companies every 30 days is about 12 audits a week.
    const many = Array.from({ length: 50 }, () => ({ frequencyDays: 30, enabled: true }));
    expect(projectedWeeklyLoad(many)).toBe(12);
  });

  it("counts only the enabled ones", () => {
    expect(
      projectedWeeklyLoad([
        { frequencyDays: 30, enabled: false },
        { frequencyDays: 30, enabled: true },
      ]),
    ).toBe(1);
  });

  it("reads the cap from the workspace config", () => {
    expect(maxWatchesFrom(null)).toBe(DEFAULT_MAX_WATCHES);
    expect(maxWatchesFrom({ maxWatches: 5 })).toBe(5);
    expect(maxWatchesFrom({ maxWatches: "many" })).toBe(DEFAULT_MAX_WATCHES);
    expect(maxWatchesFrom({ maxWatches: 0 })).toBe(0);
  });

  it("schedules the next run one interval out", () => {
    expect(nextRunFrom(new Date("2026-01-01T00:00:00Z"), 30).toISOString()).toBe(
      "2026-01-31T00:00:00.000Z",
    );
  });

  it("auto-watches the stages worth working, and no others", () => {
    expect(shouldAutoWatch("QUALIFIED")).toBe(true);
    expect(shouldAutoWatch("MEETING_BOOKED")).toBe(true);
    expect(shouldAutoWatch("HANDED_OFF")).toBe(true);
    expect(shouldAutoWatch("RESEARCHED")).toBe(false);
    expect(shouldAutoWatch("NOT_NOW")).toBe(false);
  });

  it("accepts only the three documented frequencies", () => {
    expect(isWatchFrequency(30)).toBe(true);
    expect(isWatchFrequency(45)).toBe(false);
    expect(isWatchFrequency("30")).toBe(false);
  });
});
