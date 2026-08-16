import { describe, it, expect } from "vitest";
import {
  VENTURE_BRAND,
  brandFrom,
  brandCssVars,
  brandFooterLine,
  brandFontStack,
  contrastRatio,
  relativeLuminance,
  validateBrandContrast,
  publicBaseFor,
  BRAND_VERSION,
} from "../../src/modules/workspaces/brand";

/**
 * The full white-label configuration (Audit Engine v2, item 6).
 *
 * Two properties matter above all others:
 *   1. an unconfigured workspace renders EXACTLY as before, token for token —
 *      this change must be invisible to the Venture workspace;
 *   2. a workspace cannot configure output nobody can read.
 */

describe("the Venture seed still is the design tokens", () => {
  it("carries the tokens from tailwind.config.ts verbatim", () => {
    // If any of these drift, the Venture workspace's output changes — which is
    // the one thing this whole change is not allowed to do.
    expect(VENTURE_BRAND.canvas).toBe("#00051D");
    expect(VENTURE_BRAND.ink).toBe("#EFF1F8");
    expect(VENTURE_BRAND.muted).toBe("#858CAE");
    expect(VENTURE_BRAND.color).toBe("#7427C6");
    expect(VENTURE_BRAND.gradientFrom).toBe("#310B59");
    expect(VENTURE_BRAND.gradientTo).toBe("#7427C6");
  });

  it("keeps Bricolage and Inter as the default fonts", () => {
    expect(VENTURE_BRAND.fontDisplay).toMatch(/Bricolage/i);
    expect(VENTURE_BRAND.fontBody).toMatch(/Inter/i);
  });

  it("gives an unconfigured workspace the seed, field for field", () => {
    expect(brandFrom(null)).toEqual(VENTURE_BRAND);
    expect(brandFrom({})).toEqual(VENTURE_BRAND);
    expect(brandFrom("nonsense")).toEqual(VENTURE_BRAND);
  });
});

describe("the new configuration fields", () => {
  it("takes a legal name, falling back to the display name", () => {
    expect(brandFrom({ name: "Studio Kft" }).legalName).toBe("Studio Kft");
    expect(brandFrom({ name: "Studio Kft", legalName: "Studio Korlátolt Kft." }).legalName).toBe(
      "Studio Korlátolt Kft.",
    );
  });

  it("takes canvas, ink and muted colours", () => {
    const brand = brandFrom({ canvas: "#FFFFFF", ink: "#111111", muted: "#666666" });
    expect(brand.canvas).toBe("#FFFFFF");
    expect(brand.ink).toBe("#111111");
    expect(brand.muted).toBe("#666666");
  });

  it("refuses a colour that is not a hex value and keeps the default", () => {
    expect(brandFrom({ canvas: "rebeccapurple" }).canvas).toBe(VENTURE_BRAND.canvas);
    expect(brandFrom({ ink: "javascript:alert(1)" }).ink).toBe(VENTURE_BRAND.ink);
  });

  it("takes font choices and falls back to the defaults", () => {
    const brand = brandFrom({ fontDisplay: "Georgia", fontBody: "Helvetica" });
    expect(brand.fontDisplay).toBe("Georgia");
    expect(brand.fontBody).toBe("Helvetica");
    expect(brandFrom({}).fontDisplay).toBe(VENTURE_BRAND.fontDisplay);
  });

  it("strips anything that could escape a CSS font-family declaration", () => {
    // A font name goes straight into a style attribute in the PDF templates.
    const brand = brandFrom({ fontDisplay: 'Georgia";}body{display:none}/*' });
    expect(brand.fontDisplay).not.toContain('"');
    expect(brand.fontDisplay).not.toContain("}");
    expect(brand.fontDisplay).not.toContain(";");
  });

  it("takes the structured footer identity", () => {
    const brand = brandFrom({
      footerAddress: "1052 Budapest, Váci utca 1.",
      footerRegistration: "Cg. 01-09-123456 · adószám 12345678-2-41",
      footerContact: "hello@studio.hu · +36 1 234 5678",
    });
    expect(brand.footerAddress).toBe("1052 Budapest, Váci utca 1.");
    expect(brand.footerRegistration).toContain("12345678");
    expect(brand.footerContact).toContain("hello@studio.hu");
  });

  it("takes a public host for building public URLs", () => {
    expect(brandFrom({ publicHost: "audit.studio.hu" }).publicHost).toBe("audit.studio.hu");
  });

  it("refuses a public host that is not a bare hostname", () => {
    // It goes into a URL; a scheme or a path there is either a mistake or an
    // attempt to point a client's report somewhere else entirely.
    expect(brandFrom({ publicHost: "https://evil.example.com/x" }).publicHost).toBeNull();
    expect(brandFrom({ publicHost: "not a host" }).publicHost).toBeNull();
  });
});

describe("the footer line", () => {
  it("joins whatever is configured, in reading order", () => {
    const brand = brandFrom({
      name: "Studio Kft",
      footerIdentity: "Studio Kft",
      footerAddress: "Debrecen",
      footerRegistration: "Cg. 09-09-000000",
      footerContact: "hello@studio.hu",
    });
    expect(brandFooterLine(brand)).toBe(
      "Studio Kft · Debrecen · Cg. 09-09-000000 · hello@studio.hu",
    );
  });

  it("omits the parts nobody filled in rather than leaving empty separators", () => {
    const brand = brandFrom({ name: "Studio Kft", footerIdentity: "Studio Kft" });
    expect(brandFooterLine(brand)).toBe("Studio Kft");
  });

  it("is unchanged for the Venture workspace", () => {
    expect(brandFooterLine(VENTURE_BRAND)).toBe(VENTURE_BRAND.footerIdentity);
  });
});

describe("contrast", () => {
  it("computes relative luminance the way WCAG defines it", () => {
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
  });

  it("computes the contrast ratio symmetrically", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("passes the Venture palette", () => {
    // The seed must never be rejected by its own validator.
    expect(validateBrandContrast(VENTURE_BRAND).ok).toBe(true);
  });

  it("rejects body text nobody can read", () => {
    const result = validateBrandContrast(brandFrom({ canvas: "#FFFFFF", ink: "#F5F5F5" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/text/i);
  });

  it("rejects an accent that vanishes into the canvas", () => {
    const result = validateBrandContrast(brandFrom({ canvas: "#7427C6", color: "#7A2ECB" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toMatch(/accent/i);
  });

  it("rejects muted text that has faded out entirely", () => {
    const result = validateBrandContrast(brandFrom({ canvas: "#00051D", muted: "#0A0F28" }));
    expect(result.ok).toBe(false);
  });

  it("accepts a legitimate light theme", () => {
    // White canvas, near-black text, a strong accent: unlike Venture, and fine.
    const result = validateBrandContrast(
      brandFrom({ canvas: "#FFFFFF", ink: "#111827", muted: "#4B5563", color: "#0B5FFF" }),
    );
    expect(result.ok).toBe(true);
  });

  it("names every problem at once rather than one at a time", () => {
    const result = validateBrandContrast(
      brandFrom({ canvas: "#FFFFFF", ink: "#FAFAFA", muted: "#FBFBFB", color: "#FCFCFC" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("CSS custom properties", () => {
  it("derives every surface colour as a variable", () => {
    const vars = brandCssVars(VENTURE_BRAND);
    expect(vars["--brand-canvas"]).toBe("#00051D");
    expect(vars["--brand-ink"]).toBe("#EFF1F8");
    expect(vars["--brand-muted"]).toBe("#858CAE");
    expect(vars["--brand-accent"]).toBe("#7427C6");
    expect(vars["--brand-gradient"]).toContain("linear-gradient");
  });

  it("carries the fonts as variables too", () => {
    const vars = brandCssVars(brandFrom({ fontDisplay: "Georgia", fontBody: "Helvetica" }));
    expect(vars["--brand-font-display"]).toContain("Georgia");
    expect(vars["--brand-font-body"]).toContain("Helvetica");
  });

  it("produces a font stack with a fallback, never a bare name", () => {
    // A PDF renders in headless Chrome with no font installed; a bare family
    // name would silently fall back to whatever the renderer felt like.
    expect(brandFontStack("Georgia")).toMatch(/Georgia.*(serif|sans-serif)/);
  });
});

describe("public URLs", () => {
  it("uses the workspace's own host when it has one", () => {
    expect(publicBaseFor(brandFrom({ publicHost: "audit.studio.hu" }), "https://fallback.test")).toBe(
      "https://audit.studio.hu",
    );
  });

  it("falls back to the configured app surface when it does not", () => {
    expect(publicBaseFor(VENTURE_BRAND, "https://audit.ventureco.agency")).toBe(
      "https://audit.ventureco.agency",
    );
  });
});

describe("the brand snapshot version", () => {
  it("is a number that can be compared", () => {
    expect(typeof BRAND_VERSION).toBe("number");
    expect(BRAND_VERSION).toBeGreaterThanOrEqual(1);
  });
});
