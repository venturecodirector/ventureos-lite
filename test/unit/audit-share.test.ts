import { describe, it, expect } from "vitest";
import {
  generateSlug,
  shareExpiryFrom,
  isShareExpired,
  shareUrl,
  SHARE_TTL_DAYS,
} from "../../src/modules/audit/share";
import { buildAuditPdfHtml } from "../../src/modules/audit/pdf-template";
import type { AuditView } from "../../src/modules/audit/types";

const view: AuditView = {
  id: "aud1",
  url: "https://budaivizszereles.hu",
  status: "done",
  score: 86,
  verdict: "STRONG",
  checks: [
    { key: "https", label: "HTTPS valid", pass: true },
    { key: "viewport", label: "Mobile viewport", pass: false },
    { key: "copyright", label: "Copyright year", pass: false, detail: "2019" },
  ],
  flags: ["no mobile", "outdated website"],
  screenshots: {},
  crawl: null,
  pitchSummary: "A 4.9-star business losing mobile visitors to a slow site.",
  pdfPath: null,
};

describe("share slug + expiry", () => {
  it("generates unlisted, url-safe slugs that differ each time", () => {
    const a = generateSlug();
    const b = generateSlug();
    expect(a).toMatch(/^[A-Za-z0-9_-]{10,}$/);
    expect(a).not.toBe(b);
  });

  it("expires 60 days out", () => {
    expect(SHARE_TTL_DAYS).toBe(60);
    const now = new Date("2026-08-11T00:00:00Z");
    const exp = shareExpiryFrom(now);
    expect(exp.toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });

  it("reports expiry correctly", () => {
    const exp = new Date("2026-10-10T00:00:00Z");
    expect(isShareExpired(exp, new Date("2026-09-01T00:00:00Z"))).toBe(false);
    expect(isShareExpired(exp, new Date("2026-10-10T00:00:00Z"))).toBe(true);
    expect(isShareExpired(exp, new Date("2026-11-01T00:00:00Z"))).toBe(true);
  });

  it("builds the public share URL on the audit subdomain", () => {
    process.env.APP_URL = "https://ventureco.agency";
    process.env.PUBLIC_AUDIT_URL = "https://audit.ventureco.agency";
    expect(shareUrl("abc123")).toBe("https://audit.ventureco.agency/r/abc123");
  });
});

describe("buildAuditPdfHtml (branded letterhead)", () => {
  it("renders a self-contained HTML doc with the Venture letterhead and audit data", () => {
    const html = buildAuditPdfHtml(view, { generatedAt: new Date("2026-08-11T00:00:00Z") });
    expect(html).toContain("<!doctype html>");
    expect(html.toLowerCase()).toContain("venture");
    expect(html).toContain("86"); // score
    expect(html).toContain("Strong prospect"); // verdict label
    expect(html).toContain("no mobile"); // a flag
    expect(html).toContain("budaivizszereles.hu"); // audited url
    // no external assets — inline only (headless-Chrome print, no network)
    expect(html).not.toMatch(/https?:\/\/fonts\.googleapis/);
  });
});
