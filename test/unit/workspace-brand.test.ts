import { describe, it, expect } from "vitest";
import {
  brandFrom,
  brandGradient,
  isDefaultBrand,
  VENTURE_BRAND,
} from "@/modules/workspaces/brand";
import { buildAuditPdfHtml } from "@/modules/audit/pdf-template";
import type { AuditView } from "@/modules/audit/types";

/**
 * P2/6 — white-label. The test that matters is the last one: a second
 * workspace's PDF must not carry the first workspace's name or colours
 * anywhere, which is the failure mode that would actually embarrass someone.
 */
describe("brandFrom", () => {
  it("returns the Venture seed for an unconfigured workspace", () => {
    expect(brandFrom(null)).toEqual(VENTURE_BRAND);
    expect(brandFrom({})).toEqual(VENTURE_BRAND);
    expect(brandFrom("nonsense")).toEqual(VENTURE_BRAND);
  });

  it("falls back per field, not per object", () => {
    const b = brandFrom({ color: "#FF0055" });
    expect(b.color).toBe("#FF0055");
    // A workspace that set only a colour keeps a usable identity.
    expect(b.name).toBe(VENTURE_BRAND.name);
    expect(b.markBold).toBe(VENTURE_BRAND.markBold);
  });

  it("uses a workspace's own name as its wordmark once it has one", () => {
    const b = brandFrom({ name: "Studio Kft" });
    expect(b.markBold).toBe("Studio Kft");
    expect(b.markLight).toBe("");
    expect(b.footerIdentity).toBe("Studio Kft");
    expect(b.senderName).toBe("Studio Kft");
  });

  it("takes the gradient from the primary colour when only one is set", () => {
    const b = brandFrom({ color: "#00A3FF" });
    expect(b.gradientFrom).toBe("#00A3FF");
    expect(b.gradientTo).toBe("#00A3FF");
    expect(brandGradient(b)).toBe("linear-gradient(135deg,#00A3FF,#00A3FF)");
  });

  it("refuses a colour that is not a hex value", () => {
    expect(brandFrom({ color: "red; background:url(x)" }).color).toBe(VENTURE_BRAND.color);
    expect(brandFrom({ color: 42 }).color).toBe(VENTURE_BRAND.color);
  });

  it("sanitises the public slug prefix", () => {
    expect(brandFrom({ slugPrefix: "../etc" }).slugPrefix).toBe("etc");
    expect(brandFrom({ slugPrefix: "!!!" }).slugPrefix).toBe(VENTURE_BRAND.slugPrefix);
  });

  it("only accepts a sender address that looks like one", () => {
    expect(brandFrom({ senderEmail: "hello@studio.hu" }).senderEmail).toBe("hello@studio.hu");
    expect(brandFrom({ senderEmail: "not-an-address" }).senderEmail).toBeNull();
  });

  it("knows when nothing has been customised", () => {
    expect(isDefaultBrand(brandFrom(null))).toBe(true);
    expect(isDefaultBrand(brandFrom({ color: "#FF0055" }))).toBe(false);
  });
});

describe("a second workspace's PDF", () => {
  const view = {
    id: "a",
    url: "https://pelda.hu",
    status: "done",
    score: 60,
    verdict: "STRONG",
    checks: [{ key: "https", label: "HTTPS", pass: false }],
    flags: ["no mobile"],
    screenshots: {},
    crawl: null,
    crux: null,
    delta: null,
    pitchSummary: null,
    pdfPath: null,
  } as unknown as AuditView;

  const other = brandFrom({
    name: "Studio Kft",
    color: "#00A3FF",
    gradientFrom: "#003A5C",
    gradientTo: "#00A3FF",
    footerIdentity: "Studio Kft · Debrecen",
  });

  it("carries no trace of the seed brand", () => {
    const html = buildAuditPdfHtml(view, { brand: other });
    expect(html).toContain("Studio Kft");
    expect(html).toContain("#00A3FF");
    expect(html.toLowerCase()).not.toContain("venture");
    expect(html).not.toContain("#7427C6");
    expect(html).not.toContain("#310B59");
  });

  it("still renders Venture for an unconfigured workspace", () => {
    const html = buildAuditPdfHtml(view);
    expect(html).toContain("venture");
    expect(html).toContain("#7427C6");
  });

  it("uses a logo in place of the wordmark when there is one", () => {
    const withLogo = brandFrom({ name: "Studio Kft", logoUrl: "data:image/png;base64,AAAA" });
    const html = buildAuditPdfHtml(view, { brand: withLogo });
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).not.toContain("<b>Studio Kft</b>");
  });
});
