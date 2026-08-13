import { describe, it, expect } from "vitest";
import {
  buildPriorityMatrix,
  priorityMapFrom,
  quadrantFor,
  DEFAULT_CHECK_PRIORITY,
  FALLBACK_PRIORITY,
} from "@/modules/audit/priority";
import {
  buildQuoteSkeleton,
  serviceMapFrom,
  isSeededMap,
  DEFAULT_SERVICE_MAP,
} from "@/modules/audit/service-map";
import { buildAuditPdfHtml } from "@/modules/audit/pdf-template";
import type { AuditCheck, AuditView } from "@/modules/audit/types";

/** P2/4 — prioritisation and the quote skeleton. Both are lookups, no AI. */
const fail = (key: string, label = key): AuditCheck => ({ key, label, pass: false });
const pass = (key: string, label = key): AuditCheck => ({ key, label, pass: true });

describe("quadrantFor", () => {
  it("splits on impact and effort", () => {
    expect(quadrantFor({ impact: "high", effort: "quick" })).toBe("quick-wins");
    expect(quadrantFor({ impact: "high", effort: "project" })).toBe("projects");
    expect(quadrantFor({ impact: "high", effort: "day" })).toBe("projects");
    expect(quadrantFor({ impact: "low", effort: "quick" })).toBe("fill-ins");
    expect(quadrantFor({ impact: "low", effort: "project" })).toBe("later");
  });
});

describe("buildPriorityMatrix", () => {
  it("ignores checks that passed — a plan is not an inventory", () => {
    const m = buildPriorityMatrix([pass("impresszum"), fail("clickToCall")]);
    expect(m.ordered.map((f) => f.key)).toEqual(["clickToCall"]);
  });

  it("sorts by impact, then by the cheapest fix", () => {
    const m = buildPriorityMatrix([
      fail("csp"), // low / day
      fail("impresszum"), // high / quick
      fail("viewport"), // high / project
    ]);
    expect(m.ordered.map((f) => f.key)).toEqual(["impresszum", "viewport", "csp"]);
  });

  it("puts a legal gap in quick wins and a rebuild in projects", () => {
    const m = buildPriorityMatrix([fail("impresszum"), fail("viewport")]);
    const quick = m.quadrants.find((q) => q.id === "quick-wins")!;
    const projects = m.quadrants.find((q) => q.id === "projects")!;
    expect(quick.findings.map((f) => f.key)).toEqual(["impresszum"]);
    expect(projects.findings.map((f) => f.key)).toEqual(["viewport"]);
  });

  it("carries the category through for the quote mapping", () => {
    const m = buildPriorityMatrix([fail("impresszum")]);
    expect(m.ordered[0]!.category).toBe("legal");
  });

  it("gives an unregistered check the fallback rather than dropping it", () => {
    const m = buildPriorityMatrix([fail("brand_new_check")]);
    expect(m.ordered).toHaveLength(1);
    expect(m.ordered[0]!.impact).toBe(FALLBACK_PRIORITY.impact);
    expect(m.ordered[0]!.category).toBeNull();
  });
});

describe("owner overrides", () => {
  it("merges per property, leaving the other one alone", () => {
    const map = priorityMapFrom({ checkPriority: { hsts: { impact: "high" } } });
    expect(map.hsts!.impact).toBe("high");
    expect(map.hsts!.effort).toBe(DEFAULT_CHECK_PRIORITY.hsts!.effort);
  });

  it("ignores nonsense instead of corrupting the registry", () => {
    const map = priorityMapFrom({ checkPriority: { hsts: { impact: "enormous", effort: 7 } } });
    expect(map.hsts).toEqual(DEFAULT_CHECK_PRIORITY.hsts);
    expect(priorityMapFrom(null).https).toEqual(DEFAULT_CHECK_PRIORITY.https);
    expect(priorityMapFrom({ checkPriority: "nope" }).https).toEqual(DEFAULT_CHECK_PRIORITY.https);
  });

  it("moves a finding to another quadrant when retuned", () => {
    const map = priorityMapFrom({ checkPriority: { hsts: { impact: "high" } } });
    const m = buildPriorityMatrix([fail("hsts")], map);
    expect(m.quadrants.find((q) => q.id === "quick-wins")!.findings).toHaveLength(1);
  });
});

describe("quote skeleton", () => {
  const findings = [
    { key: "impresszum", label: "Impresszum", category: "legal" },
    { key: "privacyPolicy", label: "Adatkezelési tájékoztató", category: "legal" },
    { key: "viewport", label: "Mobile viewport", category: "performance" },
  ];

  it("makes one line per category, not one per finding", () => {
    const lines = buildQuoteSkeleton(findings);
    expect(lines).toHaveLength(2);
    const legal = lines.find((l) => l.description === DEFAULT_SERVICE_MAP.legal.item)!;
    expect(legal.findings).toEqual(["Impresszum", "Adatkezelési tájékoztató"]);
  });

  it("starts at the band midpoint, in whole thousands of forints", () => {
    const legal = buildQuoteSkeleton(findings)[0]!;
    const { minHuf, maxHuf } = DEFAULT_SERVICE_MAP.legal;
    expect(legal.baseNet).toBe(Math.round((minHuf + maxHuf) / 2 / 1000) * 1000);
    expect(Number.isInteger(legal.baseNet)).toBe(true);
  });

  it("skips findings with no category to map", () => {
    expect(buildQuoteSkeleton([{ key: "x", label: "X", category: null }])).toEqual([]);
  });

  it("uses the workspace's own catalogue when it has one", () => {
    const map = serviceMapFrom({
      serviceMap: { legal: { item: "Jogi csomag", minHuf: 200_000, maxHuf: 300_000 } },
    });
    const lines = buildQuoteSkeleton(findings, map);
    const legal = lines.find((l) => l.description === "Jogi csomag")!;
    expect(legal.baseNet).toBe(250_000);
    // Untouched categories keep their seeds.
    expect(map.performance).toEqual(DEFAULT_SERVICE_MAP.performance);
  });

  it("knows when the prices are still the placeholders", () => {
    expect(isSeededMap(null)).toBe(true);
    expect(isSeededMap({ serviceMap: {} })).toBe(true);
    expect(isSeededMap({ serviceMap: { legal: { item: "x" } } })).toBe(false);
  });
});

describe("the PDF's closing page", () => {
  const view = {
    id: "a",
    url: "https://pelda.hu",
    status: "done",
    score: 60,
    verdict: "STRONG",
    checks: [fail("impresszum", "Impresszum"), fail("viewport", "Mobile viewport")],
    flags: [],
    screenshots: {},
    crawl: null,
    crux: null,
    pitchSummary: null,
    pdfPath: null,
  } as unknown as AuditView;

  it("prints the recommended order, grouped", () => {
    const html = buildAuditPdfHtml(view);
    expect(html).toContain("Javasolt sorrend");
    expect(html).toContain("Gyors győzelmek");
    expect(html).toContain("Impresszum");
  });

  it("prints nothing when every check passed", () => {
    const clean = { ...view, checks: [pass("impresszum")] } as AuditView;
    expect(buildAuditPdfHtml(clean)).not.toContain("Javasolt sorrend");
  });
});
