import { describe, it, expect } from "vitest";
import { buildDocumentPdfHtml } from "../../src/modules/documents/pdf-template";
import { brandEmail } from "../../src/modules/mail/layout";
import { VENTURE_BRAND, brandFrom, brandCssVars } from "../../src/modules/workspaces/brand";

/**
 * What a rendered artefact must and must not contain (audit-v2 item 6).
 *
 * The pixel comparison against the pre-change build lives outside the suite —
 * it needs a git worktree of the old commit — so these pin the two properties
 * that comparison established, in a form that runs on every commit.
 */

const STUDIO = brandFrom({
  name: "Studio Kft",
  markBold: "studio",
  markLight: "kft",
  color: "#0B5FFF",
  canvas: "#FFFFFF",
  ink: "#111827",
  muted: "#4B5563",
  fontBody: "Georgia",
  footerIdentity: "Studio Kft · Debrecen",
});

const MAIL = { preheader: "p", heading: "H", paragraphs: ["one"] };

describe("the seed renders exactly as it always did", () => {
  it("emits the historical font chain with nothing prepended", () => {
    // Prepending "Inter" looked harmless and was not: where Inter IS installed
    // it beats -apple-system and changes the typeface of every existing PDF.
    const vars = brandCssVars(VENTURE_BRAND);
    expect(vars["--brand-font-body"]).toBe(
      `-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
    );
    expect(vars["--brand-font-body"]).not.toContain("Inter");
  });

  it("keeps the hand-picked softened values rather than a mix", () => {
    const vars = brandCssVars(VENTURE_BRAND);
    expect(vars["--brand-ink-soft"]).toBe("#C9CEE3");
    expect(vars["--brand-accent-ink"]).toBe("#E4D3FF");
  });

  it("escapes the root style, so a quoted font cannot break the attribute", () => {
    // An unescaped `"Segoe UI"` terminated the style attribute and threw away
    // every variable after it — the PDFs rendered in the browser default serif.
    const html = buildDocumentPdfHtml("<p>x</p>", false, VENTURE_BRAND);
    const style = /<body style="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(style).toContain("--brand-font-body");
    expect(style).toContain("&quot;");
    expect(style).not.toMatch(/[^&]"/);
  });

  it("puts no footer on a document that never had one", () => {
    const html = buildDocumentPdfHtml("<p>x</p>", false, VENTURE_BRAND);
    expect(html).not.toContain("brand-footer\">");
  });
});

describe("a second workspace's artefacts carry no trace of the seed", () => {
  const artefacts = {
    document: buildDocumentPdfHtml("<p>Weboldal</p>", true, STUDIO),
    email: brandEmail({ ...MAIL, brand: STUDIO }),
  };

  for (const [name, html] of Object.entries(artefacts)) {
    it(`${name}: no seed wordmark or name`, () => {
      expect(html).not.toMatch(/venture/i);
      expect(html).not.toMatch(/co\.group/i);
    });

    it(`${name}: none of the seed's colours`, () => {
      for (const token of [VENTURE_BRAND.canvas, VENTURE_BRAND.ink, VENTURE_BRAND.color]) {
        expect(html, `${name} still contains ${token}`).not.toContain(token);
      }
    });

    it(`${name}: carries its own identity instead`, () => {
      expect(html).toMatch(/studio/i);
    });
  }

  it("the email derives its panel rather than reusing the seed's", () => {
    // The seed's panel/border are hand-picked flattenings over navy; a light
    // workspace must not inherit them or the panel is a near-black box.
    expect(artefacts.email).not.toContain("#0A0F26");
    expect(artefacts.email).not.toContain("#1B2138");
  });
});
