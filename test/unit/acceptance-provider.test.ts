import { describe, it, expect } from "vitest";
import {
  AssentProvider,
  getAcceptanceProvider,
} from "../../src/modules/documents/acceptance-provider";

describe("AssentProvider (the swappable Accept interface, spec §4.9)", () => {
  const p = new AssentProvider();

  it("accepts a complete assent", () => {
    expect(p.accept({ name: "Horváth Judit", company: "Aventa Logistics Kft.", agreed: true })).toEqual({
      ok: true,
      method: "assent",
    });
  });

  it("requires name, company, and the checkbox", () => {
    expect(p.accept({ name: "", company: "Aventa", agreed: true }).ok).toBe(false);
    expect(p.accept({ name: "Judit", company: "  ", agreed: true }).ok).toBe(false);
    expect(p.accept({ name: "Judit", company: "Aventa", agreed: false }).ok).toBe(false);
  });

  it("reports 'assent' as the method (not a qualified e-signature)", () => {
    expect(p.accept({ name: "J", company: "A", agreed: true }).method).toBe("assent");
  });

  it("factory returns the assent provider by default", () => {
    expect(getAcceptanceProvider().name).toBe("assent");
  });
});
