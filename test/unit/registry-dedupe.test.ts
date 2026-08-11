import { describe, it, expect } from "vitest";
import { normalizeTaxId, findByTaxId } from "../../src/modules/registry/dedupe";

describe("normalizeTaxId (adószám)", () => {
  it("strips formatting to digits", () => {
    expect(normalizeTaxId("12345678-1-42")).toBe("12345678142");
    expect(normalizeTaxId("12345678142")).toBe("12345678142");
    expect(normalizeTaxId(" 1234 5678-1-42 ")).toBe("12345678142");
  });
  it("rejects empty / too-short / non-numeric", () => {
    expect(normalizeTaxId("")).toBeNull();
    expect(normalizeTaxId(null)).toBeNull();
    expect(normalizeTaxId("abc")).toBeNull();
    expect(normalizeTaxId("123")).toBeNull(); // < 8 digits
  });
});

describe("findByTaxId (adószám blocks duplicates, spec §4.19)", () => {
  const existing = [
    { id: "A", taxId: "12345678-1-42" },
    { id: "B", taxId: null },
  ];

  it("matches across formats", () => {
    expect(findByTaxId("12345678142", existing)?.id).toBe("A");
    expect(findByTaxId("12345678-1-42", existing)?.id).toBe("A");
  });
  it("returns null when nothing matches", () => {
    expect(findByTaxId("99999999-9-99", existing)).toBeNull();
  });
  it("excludes the company itself", () => {
    expect(findByTaxId("12345678-1-42", existing, "A")).toBeNull();
  });
  it("a null/blank candidate tax id never matches", () => {
    expect(findByTaxId(null, existing)).toBeNull();
    expect(findByTaxId("", existing)).toBeNull();
  });
});
