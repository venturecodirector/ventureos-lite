import { describe, it, expect } from "vitest";
import {
  buildComparison,
  anonymizeComparison,
  comparisonAuditIds,
  peerColumnLabelHu,
  type ComparisonSubject,
} from "@/modules/audit/comparison";
import { buildAuditPdfHtml } from "@/modules/audit/pdf-template";
import type { AuditCheck, AuditView } from "@/modules/audit/types";

/**
 * P2/3 — the comparison, and the rule that a prospect's report never names a
 * third party.
 */
const pass = (key: string): AuditCheck => ({ key, label: key, pass: true });
const fail = (key: string): AuditCheck => ({ key, label: key, pass: false });

function subject(
  over: Partial<ComparisonSubject> & { auditId: string },
): ComparisonSubject {
  return {
    url: `https://${over.auditId}.hu`,
    name: null,
    score: 50,
    checks: [],
    ...over,
  };
}

const row = (t: ReturnType<typeof buildComparison>, key: string) =>
  t.rows.find((r) => r.key === key)!;

describe("buildComparison", () => {
  it("puts the prospect first and keeps competitor order", () => {
    const t = buildComparison([
      subject({ auditId: "mine", score: 40 }),
      subject({ auditId: "a", score: 60 }),
      subject({ auditId: "b", score: 20 }),
    ]);
    expect(t.subjects.map((s) => s.auditId)).toEqual(["mine", "a", "b"]);
    expect(row(t, "overall").values).toEqual([40, 60, 20]);
  });

  it("reads a LOWER opportunity score as the better site", () => {
    const better = buildComparison([
      subject({ auditId: "mine", score: 20 }),
      subject({ auditId: "a", score: 70 }),
    ]);
    expect(row(better, "overall").direction).toBe("better");

    const worse = buildComparison([
      subject({ auditId: "mine", score: 80 }),
      subject({ auditId: "a", score: 30 }),
    ]);
    expect(row(worse, "overall").direction).toBe("worse");
  });

  it("calls a small gap a tie rather than ranking noise", () => {
    const t = buildComparison([
      subject({ auditId: "mine", score: 50 }),
      subject({ auditId: "a", score: 53 }),
    ]);
    expect(row(t, "overall").direction).toBe("same");
    expect(row(t, "overall").takeawayHu).toContain("azonos");
  });

  it("compares against the average of two competitors", () => {
    const t = buildComparison([
      subject({ auditId: "mine", score: 50 }),
      subject({ auditId: "a", score: 20 }),
      subject({ auditId: "b", score: 40 }),
    ]);
    // Average 30, so 50 is 20 points worse.
    expect(row(t, "overall").direction).toBe("worse");
    expect(row(t, "overall").takeawayHu).toContain("20 ponttal gyengébb");
  });

  it("scores mobile, SEO and legal from the same checks the audit produced", () => {
    const t = buildComparison([
      subject({
        auditId: "mine",
        checks: [pass("viewport"), pass("title"), fail("metaDescription"), pass("impresszum")],
      }),
      subject({
        auditId: "a",
        checks: [fail("viewport"), fail("title"), fail("metaDescription"), fail("impresszum")],
      }),
    ]);
    expect(row(t, "mobile").values).toEqual([100, 0]);
    expect(row(t, "seo").values).toEqual([50, 0]);
    expect(row(t, "legal").values).toEqual([100, 0]);
    // On a pass-rate row, higher is the better site.
    expect(row(t, "mobile").direction).toBe("better");
  });

  it("reports an unmeasured row as null, never as zero", () => {
    const t = buildComparison([
      subject({ auditId: "mine", checks: [] }),
      subject({ auditId: "a", checks: [] }),
    ]);
    expect(row(t, "legal").values).toEqual([null, null]);
    expect(row(t, "legal").direction).toBe("same");
    expect(row(t, "legal").takeawayHu).toContain("nincs összehasonlítható mérés");
  });
});

describe("anonymizeComparison", () => {
  const named = buildComparison([
    subject({ auditId: "mine", url: "https://prospect.hu", name: "Prospect Kft", score: 60 }),
    subject({ auditId: "a", url: "https://rival-one.hu", name: "Rival One Kft", score: 20 }),
    subject({ auditId: "b", url: "https://rival-two.hu", name: "Rival Two Bt", score: 40 }),
  ]);

  it("keeps the reader's number and one averaged column", () => {
    const anon = anonymizeComparison(named);
    expect(anon.competitorCount).toBe(2);
    const overall = anon.rows.find((r) => r.hu === "Összesített pontszám")!;
    expect(overall.mine).toBe(60);
    expect(overall.peerAverage).toBe(30);
  });

  it("carries no competitor name or URL anywhere in its output", () => {
    const serialized = JSON.stringify(anonymizeComparison(named));
    for (const secret of ["Rival One", "Rival Two", "rival-one.hu", "rival-two.hu", "a", "b"]) {
      if (secret.length <= 1) continue;
      expect(serialized).not.toContain(secret);
    }
  });

  it("labels the anonymous column by count", () => {
    expect(peerColumnLabelHu(1)).toBe("Egy helyi versenytárs");
    expect(peerColumnLabelHu(2)).toContain("2 helyi versenytárs átlaga");
  });
});

describe("the sales PDF, which is ours", () => {
  const view = {
    id: "aud1",
    url: "https://prospect.hu",
    status: "done",
    score: 60,
    verdict: "STRONG",
    checks: [pass("https")],
    flags: [],
    screenshots: {},
    crawl: null,
    crux: null,
    pitchSummary: null,
    pdfPath: null,
  } as unknown as AuditView;

  it("names the competitors", () => {
    const table = buildComparison([
      subject({ auditId: "mine", url: "https://prospect.hu", name: "Prospect Kft", score: 60 }),
      subject({ auditId: "a", url: "https://rival-one.hu", name: "Rival One Kft", score: 20 }),
    ]);
    const html = buildAuditPdfHtml(view, { comparison: table });
    expect(html).toContain("Versenytárs-összehasonlítás");
    expect(html).toContain("Rival One Kft");
  });

  it("omits the section entirely when no comparison was run", () => {
    expect(buildAuditPdfHtml(view)).not.toContain("Versenytárs-összehasonlítás");
  });

  it("falls back to the domain when a competitor has no company name", () => {
    const table = buildComparison([
      subject({ auditId: "mine", url: "https://prospect.hu", score: 60 }),
      subject({ auditId: "a", url: "https://rival-one.hu/", name: null, score: 20 }),
    ]);
    expect(buildAuditPdfHtml(view, { comparison: table })).toContain("rival-one.hu");
  });
});

describe("comparisonAuditIds", () => {
  it("reads the stored shape and shrugs off anything else", () => {
    expect(comparisonAuditIds({ auditIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(comparisonAuditIds({ auditIds: ["a", 3, null] })).toEqual(["a"]);
    expect(comparisonAuditIds(null)).toEqual([]);
    expect(comparisonAuditIds("nonsense")).toEqual([]);
    expect(comparisonAuditIds({})).toEqual([]);
  });
});
