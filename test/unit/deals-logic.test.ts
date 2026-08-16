import { describe, it, expect } from "vitest";
import {
  buildForecast,
  daysInStage,
  effectiveProbability,
  isRotting,
  monthKeyOf,
  monthRange,
  probabilityProposals,
  weightedValue,
  DEFAULT_COMMIT_THRESHOLD,
  UNSCHEDULED,
  type DealLike,
} from "../../src/modules/deals/logic";
import {
  DEFAULT_PIPELINES,
  pipelineKeyForLead,
  pipelineSeed,
  stageForLeadStage,
} from "../../src/modules/deals/pipelines";

function deal(over: Partial<DealLike> = {}): DealLike {
  return {
    id: "d1",
    value: 1_000_000,
    probability: null,
    stageProbability: 40,
    expectedCloseAt: new Date("2026-09-15T10:00:00Z"),
    status: "OPEN",
    ...over,
  };
}

describe("effective probability", () => {
  it("takes the stage default when the deal has no opinion", () => {
    expect(effectiveProbability({ probability: null, stageProbability: 40 })).toBe(40);
  });

  it("lets a per-deal override win", () => {
    expect(effectiveProbability({ probability: 85, stageProbability: 40 })).toBe(85);
  });

  it("clamps nonsense into 0-100", () => {
    expect(effectiveProbability({ probability: 500, stageProbability: 0 })).toBe(100);
    expect(effectiveProbability({ probability: -20, stageProbability: 0 })).toBe(0);
  });

  it("treats a closed deal as a fact, not a forecast", () => {
    expect(effectiveProbability({ probability: 30, stageProbability: 40, status: "WON" })).toBe(100);
    expect(effectiveProbability({ probability: 90, stageProbability: 40, status: "LOST" })).toBe(0);
  });
});

describe("weighted value", () => {
  it("is value × probability in whole forints", () => {
    expect(weightedValue(deal({ value: 1_000_000, stageProbability: 40 }))).toBe(400_000);
  });

  it("rounds rather than producing fractional forints", () => {
    expect(weightedValue(deal({ value: 333_333, probability: 33 }))).toBe(110_000);
    expect(Number.isInteger(weightedValue(deal({ value: 7, probability: 33 })))).toBe(true);
  });
});

describe("rotting", () => {
  const now = new Date("2026-08-17T12:00:00Z");

  it("counts whole days in stage", () => {
    expect(daysInStage(new Date("2026-08-10T12:00:00Z"), now)).toBe(7);
  });

  it("flags an open card past its stage threshold", () => {
    expect(
      isRotting({
        status: "OPEN",
        stageEnteredAt: new Date("2026-08-01T12:00:00Z"),
        rottingDays: 10,
        now,
      }),
    ).toBe(true);
  });

  it("does not flag a card exactly at the threshold", () => {
    expect(
      isRotting({
        status: "OPEN",
        stageEnteredAt: new Date("2026-08-07T12:00:00Z"),
        rottingDays: 10,
        now,
      }),
    ).toBe(false);
  });

  it("never flags a closed deal", () => {
    expect(
      isRotting({
        status: "WON",
        stageEnteredAt: new Date("2025-01-01T00:00:00Z"),
        rottingDays: 7,
        now,
      }),
    ).toBe(false);
  });

  it("never flags a stage with no threshold", () => {
    expect(
      isRotting({
        status: "OPEN",
        stageEnteredAt: new Date("2020-01-01T00:00:00Z"),
        rottingDays: null,
        now,
      }),
    ).toBe(false);
  });
});

describe("forecast", () => {
  it("sums value × probability by expected close month", () => {
    const f = buildForecast([
      deal({ id: "a", value: 1_000_000, stageProbability: 40, expectedCloseAt: new Date(2026, 8, 10) }),
      deal({ id: "b", value: 2_000_000, probability: 75, expectedCloseAt: new Date(2026, 8, 25) }),
      deal({ id: "c", value: 500_000, probability: 20, expectedCloseAt: new Date(2026, 9, 3) }),
    ]);
    const sep = f.rows.find((r) => r.month === "2026-09")!;
    // hand-checked: 1,000,000×0.40 + 2,000,000×0.75 = 400,000 + 1,500,000
    expect(sep.weighted).toBe(1_900_000);
    expect(sep.total).toBe(3_000_000);
    expect(sep.count).toBe(2);
    const oct = f.rows.find((r) => r.month === "2026-10")!;
    expect(oct.weighted).toBe(100_000);
    expect(f.totals.weighted).toBe(2_000_000);
  });

  it("splits commit from upside at the threshold", () => {
    const f = buildForecast([
      deal({ id: "a", value: 1_000_000, probability: 75, expectedCloseAt: new Date(2026, 8, 10) }),
      deal({ id: "b", value: 1_000_000, probability: 40, expectedCloseAt: new Date(2026, 8, 10) }),
    ]);
    const sep = f.rows.find((r) => r.month === "2026-09")!;
    expect(f.commitThreshold).toBe(DEFAULT_COMMIT_THRESHOLD);
    expect(sep.commit).toBe(750_000);
    expect(sep.upside).toBe(400_000);
  });

  it("excludes won and lost deals — a forecast is not a revenue report", () => {
    const f = buildForecast([
      deal({ id: "a", value: 1_000_000, status: "WON", expectedCloseAt: new Date(2026, 8, 10) }),
      deal({ id: "b", value: 1_000_000, status: "LOST", expectedCloseAt: new Date(2026, 8, 10) }),
    ]);
    expect(f.totals.weighted).toBe(0);
    expect(f.totals.count).toBe(0);
  });

  it("keeps dateless deals visible in an unscheduled bucket, sorted last", () => {
    const f = buildForecast([
      deal({ id: "a", value: 1_000_000, probability: 50, expectedCloseAt: null }),
      deal({ id: "b", value: 1_000_000, probability: 50, expectedCloseAt: new Date(2026, 8, 10) }),
    ]);
    expect(f.rows.at(-1)!.month).toBe(UNSCHEDULED);
    expect(f.rows.at(-1)!.weighted).toBe(500_000);
    expect(f.totals.weighted).toBe(1_000_000);
  });

  it("shows requested months even when empty, so a gap reads as zero", () => {
    const f = buildForecast([], { months: ["2026-09", "2026-10"] });
    expect(f.rows.map((r) => r.month)).toEqual(["2026-09", "2026-10"]);
    expect(f.rows.every((r) => r.weighted === 0)).toBe(true);
  });

  it("names months in local time", () => {
    expect(monthKeyOf(new Date(2026, 0, 31))).toBe("2026-01");
    expect(monthRange(new Date(2026, 10, 1), 3)).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
});

describe("quarterly probability proposals", () => {
  const base = {
    stageId: "s1",
    stageName: "Qualified",
    pipelineName: "Web projects",
    currentProbability: 20,
  };

  it("stays silent below the minimum sample", () => {
    expect(probabilityProposals([{ ...base, won: 8, lost: 5 }])).toEqual([]);
  });

  it("stays silent when the observed rate is close enough", () => {
    expect(probabilityProposals([{ ...base, won: 5, lost: 20 }])).toEqual([]);
  });

  it("proposes the observed rate on a big enough divergence", () => {
    const [p] = probabilityProposals([{ ...base, won: 20, lost: 20 }]);
    expect(p.n).toBe(40);
    expect(p.observed).toBe(50);
    expect(p.suggested).toBe(50);
  });
});

describe("pipeline seeds", () => {
  it("every seeded pipeline has exactly one won and one lost stage", () => {
    for (const p of DEFAULT_PIPELINES) {
      expect(p.stages.filter((s) => s.kind === "won")).toHaveLength(1);
      expect(p.stages.filter((s) => s.kind === "lost")).toHaveLength(1);
    }
  });

  it("probabilities stay inside 0-100 and only won reaches 100", () => {
    for (const p of DEFAULT_PIPELINES) {
      for (const s of p.stages) {
        expect(s.probability).toBeGreaterThanOrEqual(0);
        expect(s.probability).toBeLessThanOrEqual(100);
        if (s.probability === 100) expect(s.kind).toBe("won");
      }
    }
  });

  it("maps each deal-owned lead stage onto a stage of the default pipeline", () => {
    const web = pipelineSeed("web-projects")!;
    expect(stageForLeadStage(web, "QUALIFIED").key).toBe("qualified");
    expect(stageForLeadStage(web, "MEETING_BOOKED").key).toBe("meeting");
    expect(stageForLeadStage(web, "HANDED_OFF").key).toBe("handed_off");
  });

  it("falls back to the first open stage rather than dropping a lead", () => {
    const grants = pipelineSeed("grants")!;
    // Grants models no "handed off"; the lead still has to land somewhere.
    expect(stageForLeadStage(grants, "HANDED_OFF").kind).toBe("open");
    expect(stageForLeadStage(grants, "HANDED_OFF").key).toBe("qualified");
  });

  it("routes grant work by the words people already used", () => {
    expect(
      pipelineKeyForLead({ signals: ["pályázat kiírás"], industry: null, companyName: null }),
    ).toBe("grants");
    expect(
      pipelineKeyForLead({ signals: [], industry: "EU grant advisory", companyName: null }),
    ).toBe("grants");
    expect(
      pipelineKeyForLead({ signals: ["hiring"], industry: "Retail", companyName: "Kis Bolt Kft." }),
    ).toBe("web-projects");
  });
});
