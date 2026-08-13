import { describe, it, expect } from "vitest";
import { auditReportBody, buildAuditPdfHtml } from "@/modules/audit/pdf-template";
import type { AuditView } from "@/modules/audit/types";

/**
 * P1/3b — the internal/public split.
 *
 * The sales PDF is for us and keeps the pitch angle. The public report is for
 * the prospect and must contain facts only. This pins the PDF side; an e2e
 * pins the rendered public page, because that is where the leak actually was.
 */
const PITCH = "Their site is ancient — lead with the mobile failure and push a rebuild.";

const view: AuditView = {
  id: "aud1",
  url: "https://pelda.hu",
  status: "done",
  score: 72,
  verdict: "STRONG",
  checks: [
    { key: "https", label: "HTTPS", pass: true, detail: null },
    { key: "mobile", label: "Mobile layout", pass: false, detail: "no viewport tag" },
  ],
  flags: ["no mobile layout"],
  screenshots: { desktop: "audits/aud1-desktop.png", mobile: "audits/aud1-mobile.png" },
  pitchSummary: PITCH,
  pdfPath: null,
} as unknown as AuditView;

describe("sales PDF keeps everything", () => {
  it("includes the pitch angle", () => {
    expect(buildAuditPdfHtml(view)).toContain("Pitch angle");
    expect(buildAuditPdfHtml(view)).toContain("ancient");
  });

  it("embeds screenshots as data URIs, not app URLs", () => {
    const html = buildAuditPdfHtml(view, {
      shots: { desktop: "data:image/png;base64,AAAA", mobile: "data:image/png;base64,BBBB" },
    });
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("data:image/png;base64,BBBB");
    // Headless Chrome in the worker has no session; an app URL would render
    // as a broken box.
    expect(html).not.toContain("/api/files/");
  });

  it("renders without screenshots rather than emitting empty images", () => {
    const html = buildAuditPdfHtml(view);
    expect(html).not.toContain("<img");
    expect(html).toContain("HTTPS");
  });

  it("escapes a hostile URL rather than injecting markup", () => {
    const nasty = { ...view, url: '"><script>alert(1)</script>' } as AuditView;
    expect(buildAuditPdfHtml(nasty)).not.toContain("<script>alert(1)</script>");
  });
});

describe("report body", () => {
  it("shows the findings", () => {
    const body = auditReportBody(view);
    expect(body).toContain("HTTPS");
    expect(body).toContain("Mobile layout");
  });
});
