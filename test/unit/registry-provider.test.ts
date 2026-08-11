import { describe, it, expect } from "vitest";
import {
  MockProvider,
  OptenProvider,
  getRegistryProvider,
  type RegistryProvider,
} from "../../src/modules/registry/provider";
import { companyUnderProceedings } from "../../src/modules/registry/risk";

const LIQUIDATION_TAXID = "99999999-9-99";

/**
 * The adapter contract: any RegistryProvider must satisfy this. Run against the
 * Mock now; a real Opten adapter must pass the same suite.
 */
function contract(label: string, make: () => RegistryProvider) {
  describe(`RegistryProvider contract: ${label}`, () => {
    const p = make();

    it("returns [] for an empty query", async () => {
      expect(await p.lookup({})).toEqual([]);
    });

    it("looks up by tax id and returns a normalized candidate", async () => {
      const r = await p.lookup({ taxId: "12345678-1-42" });
      expect(r.length).toBeGreaterThan(0);
      const c = r[0];
      expect(c.taxId).toBe("12345678142"); // normalized
      expect(typeof c.legalName).toBe("string");
      expect(Array.isArray(c.statusFlags)).toBe(true);
    });

    it("looks up by name (case-insensitive substring)", async () => {
      const r = await p.lookup({ name: "aventa" });
      expect(r.length).toBeGreaterThan(0);
      expect(r.some((c) => c.legalName.toLowerCase().includes("aventa"))).toBe(true);
    });

    it("surfaces a liquidation status flag", async () => {
      const r = await p.lookup({ taxId: LIQUIDATION_TAXID });
      expect(r.length).toBeGreaterThan(0);
      expect(companyUnderProceedings(r[0].statusFlags)).toBe(true);
    });
  });
}

contract("mock", () => new MockProvider());

describe("OptenProvider (stub)", () => {
  it("is not implemented yet — throws until wired", async () => {
    await expect(new OptenProvider().lookup({ taxId: "12345678-1-42" })).rejects.toThrow();
  });
});

describe("getRegistryProvider", () => {
  it("defaults to the mock provider in dev", () => {
    expect(getRegistryProvider().name).toBe("mock");
  });
});
