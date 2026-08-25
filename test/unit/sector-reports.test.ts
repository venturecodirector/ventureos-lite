import { describe, it, expect } from "vitest";
import {
  aggregate,
  median,
  findIdentifiers,
  MIN_PUBLISHABLE,
  HEADLINE_CHECKS,
  type AuditInput,
} from "../../src/modules/sector-reports/stats";
import { renderSectorReportHtml } from "../../src/modules/sector-reports/pdf";
import { buildTeasers } from "../../src/modules/sector-reports/teasers";
import { VENTURE_BRAND } from "../../src/modules/workspaces/brand";

/**
 * Sector reports (playbook-v4 P12/2).
 *
 * The playbook's verification line is the one that matters most: "the sector
 * builder produces an aggregate PDF where no company name appears (test
 * asserts)". A report that identifies the businesses it measured is not a
 * report, it is a list, and publishing one would end the goodwill the whole
 * exercise exists to build.
 */
const audit = (over: Partial<AuditInput> = {}): AuditInput => ({
  score: 50,
  categories: { seo: 40, legal: 80 },
  checks: { isHttps: true, impresszum: false, dmarc: false, hasViewport: true },
  loadMs: 2000,
  ...over,
});

describe("median", () => {
  it("takes the middle, and averages the middle pair", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
  });
  it("says nothing rather than zero for an empty sample", () => {
    expect(median([])).toBeNull();
    expect(median([Number.NaN])).toBeNull();
  });
});

describe("aggregate", () => {
  const batch = [
    audit({ score: 80 }),
    audit({ score: 70 }),
    audit({ score: 40 }),
    audit({ score: 20, checks: { isHttps: true, impresszum: true, dmarc: true, hasViewport: true } }),
  ];

  it("bands the scores the way a reader pictures them", () => {
    const s = aggregate(batch, 10);
    expect(s.audited).toBe(4);
    expect(s.found).toBe(10);
    expect(s.scoreBands).toEqual({ weak: 2, middling: 1, strong: 1 });
  });

  it("reports a failure share out of what was MEASURED, not out of the batch", () => {
    const s = aggregate(
      [
        audit({ checks: { impresszum: false } }),
        audit({ checks: { impresszum: true } }),
        // Not measured at all — must not count as a pass.
        audit({ checks: {} }),
      ],
      3,
    );
    const impresszum = s.failing.find((f) => f.key === "impresszum")!;
    expect(impresszum.of).toBe(2);
    expect(impresszum.share).toBe(0.5);
  });

  it("leaves out a check nothing measured rather than printing 0%", () => {
    const s = aggregate([audit({ checks: { isHttps: true } })], 1);
    expect(s.failing.map((f) => f.key)).not.toContain("dmarc");
  });

  it("orders the gaps by how common they are", () => {
    const s = aggregate(batch, 10);
    const shares = s.failing.map((f) => f.share);
    expect([...shares].sort((a, b) => b - a)).toEqual(shares);
  });

  it("survives an empty batch without dividing by zero", () => {
    const s = aggregate([], 0);
    expect(s).toMatchObject({ audited: 0, scoreMedian: 0, loadMsMedian: null });
  });

  it("keeps a publishable minimum worth defending", () => {
    expect(MIN_PUBLISHABLE).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------

const stats = aggregate(
  Array.from({ length: 20 }, (_, i) => audit({ score: 30 + i * 2 })),
  35,
);

const narrative = {
  summary: "A megmért oldalak fele elavult.",
  methodologyNote: "Nyilvános adatokból, automatizált vizsgálattal.",
  findings: [
    { heading: "Hiányzó impresszum", body: "A legtöbb oldalon nincs." },
    { heading: "Levélhitelesítés", body: "Alig van beállítva." },
    { heading: "Mobil", body: "Sok oldal széteshet." },
  ],
  closing: "Kezdje az impresszummal.",
};

function render(): string {
  return renderSectorReportHtml({
    title: "A debreceni fogászatok digitális állapota 2026",
    sector: "fogorvos",
    location: "Debrecen",
    brand: VENTURE_BRAND,
    stats,
    narrative,
    ctaUrl: "ventureco.agency",
    generatedOn: "2026-08-25",
  });
}

describe("the rendered report names nobody", () => {
  /** The playbook's own verification line, executed. */
  it("contains no domain, URL or email address", () => {
    expect(findIdentifiers(render())).toEqual([]);
  });

  it("would CATCH one if it got in — the check is not vacuous", () => {
    const leaked = render().replace("A megmért oldalak", "A mathefogaszat.hu és a többi oldal");
    expect(findIdentifiers(leaked)).toContain("mathefogaszat.hu");
  });

  it("catches an email address and a bare URL too", () => {
    expect(findIdentifiers("írjon a info@pelda.hu címre")).toContain("info@pelda.hu");
    expect(findIdentifiers("lásd https://pelda.hu/x")).toContain("https://pelda.hu/x");
  });

  it("still prints the numbers it is for", () => {
    const html = render();
    expect(html).toContain(`${stats.audited}`);
    expect(html).toContain("medián");
    expect(html).toContain("Hiányzó");
  });

  /**
   * The PDF renders in a headless browser with no network. A chart that needs
   * a CDN renders as a blank box, and a font that does prints in Times.
   */
  it("loads nothing from anywhere", () => {
    const html = render();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/@import|fonts\.googleapis/i);
  });
});

describe("the teasers", () => {
  it("write three angles from the numbers, not three rewrites", () => {
    const posts = buildTeasers({
      title: "T",
      sector: "fogorvos",
      location: "Debrecen",
      stats,
      url: "https://audit.ventureco.agency/reports/abc",
    });
    expect(posts).toHaveLength(3);
    expect(new Set(posts).size).toBe(3);
    for (const p of posts) expect(p).toContain("https://audit.ventureco.agency/reports/abc");
  });

  it("says out loud that nobody is named", () => {
    const posts = buildTeasers({
      title: "T",
      sector: "fogorvos",
      location: "Debrecen",
      stats,
      url: "u",
    });
    expect(posts.join(" ")).toMatch(/egyetlen céget sem nevezünk meg|cégnevek nélkül/);
  });

  it("writes nothing at all from an empty batch", () => {
    expect(buildTeasers({ title: "T", sector: "s", location: "l", stats: null, url: "u" })).toEqual([]);
  });
});

describe("the headline checks", () => {
  it("are phrased as a business owner would hear them", () => {
    for (const c of HEADLINE_CHECKS) {
      expect(c.label).toMatch(/^[a-záéíóöőúüű]/);
      expect(c.label.length).toBeGreaterThan(6);
    }
  });
});
