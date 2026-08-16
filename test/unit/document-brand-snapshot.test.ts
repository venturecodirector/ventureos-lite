import { describe, it, expect } from "vitest";
import { resolveDocumentBrand } from "../../src/modules/documents/brand-snapshot";
import { VENTURE_BRAND, brandFrom } from "../../src/modules/workspaces/brand";

/**
 * Brand pinning (audit-v2 item 6).
 *
 * The failure this prevents is specific and bad: a contract is signed under one
 * letterhead, the workspace rebrands, someone re-downloads the PDF, and it now
 * carries a different company's identity on a document somebody already signed.
 */

const STUDIO = { name: "Studio Kft", color: "#00A3FF", footerIdentity: "Studio Kft · Debrecen" };
const REBRANDED = { name: "Atelier Zrt", color: "#FF6B00", footerIdentity: "Atelier Zrt · Szeged" };

describe("the first render", () => {
  it("uses the workspace's live brand", () => {
    const pinned = resolveDocumentBrand(null, STUDIO);
    expect(pinned.brand.name).toBe("Studio Kft");
  });

  it("asks to be persisted, so the next render is pinned", () => {
    expect(resolveDocumentBrand(null, STUDIO).shouldPersist).toBe(true);
  });

  it("stamps the current brand version", () => {
    expect(resolveDocumentBrand(null, STUDIO).version).toBeGreaterThanOrEqual(1);
  });
});

describe("every render after that", () => {
  it("uses the SNAPSHOT even after the workspace rebranded", () => {
    const snapshot = brandFrom(STUDIO);
    const pinned = resolveDocumentBrand(snapshot, REBRANDED);
    expect(pinned.brand.name).toBe("Studio Kft");
    expect(pinned.brand.color).toBe("#00A3FF");
    expect(pinned.brand.footerIdentity).toBe("Studio Kft · Debrecen");
  });

  it("does not rewrite the snapshot", () => {
    expect(resolveDocumentBrand(brandFrom(STUDIO), REBRANDED).shouldPersist).toBe(false);
  });

  it("completes a snapshot written under an older shape rather than rendering blanks", () => {
    // A row from before a field existed must still resolve to a whole brand;
    // the missing parts fall back to the seed, not to undefined.
    const old = { name: "Studio Kft", color: "#00A3FF" };
    const pinned = resolveDocumentBrand(old, REBRANDED);
    expect(pinned.brand.canvas).toBe(VENTURE_BRAND.canvas);
    expect(pinned.brand.fontBody).toBe(VENTURE_BRAND.fontBody);
    expect(pinned.brand.name).toBe("Studio Kft");
  });
});

describe("an unconfigured workspace", () => {
  it("pins the seed, so its documents keep rendering as they always did", () => {
    const pinned = resolveDocumentBrand(null, null);
    expect(pinned.brand).toEqual(VENTURE_BRAND);
  });
});
