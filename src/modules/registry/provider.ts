import { normalizeTaxId } from "./dedupe";

/**
 * Company registry enrichment (spec §4.19). Behind a provider adapter so the
 * real provider (Opten or Céginformáció) is chosen at build time on price. The
 * Mock provider powers dev; the Opten adapter is a stub until wired.
 */
export const REGISTRY_STATUS = {
  ACTIVE: "active",
  UNDER_LIQUIDATION: "under_liquidation",
  UNDER_ENFORCEMENT: "under_enforcement",
  UNDER_PROCEEDINGS: "under_proceedings",
} as const;

export interface RegistryCandidate {
  legalName: string;
  taxId: string; // normalized (digits)
  regNumber: string | null;
  headcountBand: string | null;
  revenueBand: string | null;
  statusFlags: string[];
}

export interface RegistryQuery {
  name?: string;
  taxId?: string;
}

export interface RegistryProvider {
  readonly name: string;
  lookup(query: RegistryQuery): Promise<RegistryCandidate[]>;
}

// ---- Mock provider (dev) ---------------------------------------------------

const MOCK_FIXTURES: RegistryCandidate[] = [
  {
    legalName: "Aventa Logistics Kft.",
    taxId: normalizeTaxId("12345678-1-42")!,
    regNumber: "01-09-123456",
    headcountBand: "50-99",
    revenueBand: "1-5 Mrd HUF",
    statusFlags: [REGISTRY_STATUS.ACTIVE],
  },
  {
    legalName: "Danubia Manufacturing Kft.",
    taxId: normalizeTaxId("23456789-2-41")!,
    regNumber: "01-09-234567",
    headcountBand: "20-49",
    revenueBand: "500M-1 Mrd HUF",
    statusFlags: [REGISTRY_STATUS.ACTIVE],
  },
  {
    legalName: "Csődör Trade Kft. „f.a.”",
    taxId: normalizeTaxId("99999999-9-99")!,
    regNumber: "01-09-999999",
    headcountBand: "10-19",
    revenueBand: "100-500M HUF",
    statusFlags: [REGISTRY_STATUS.UNDER_LIQUIDATION],
  },
];

export class MockProvider implements RegistryProvider {
  readonly name = "mock";

  async lookup(query: RegistryQuery): Promise<RegistryCandidate[]> {
    const taxId = normalizeTaxId(query.taxId);
    const name = query.name?.trim().toLowerCase();
    if (!taxId && !name) return [];
    return MOCK_FIXTURES.filter((c) => {
      if (taxId && c.taxId === taxId) return true;
      if (name && c.legalName.toLowerCase().includes(name)) return true;
      return false;
    });
  }
}

// ---- Opten adapter (stub) --------------------------------------------------

export class OptenProvider implements RegistryProvider {
  readonly name = "opten";

  async lookup(_query: RegistryQuery): Promise<RegistryCandidate[]> {
    // Real integration is chosen at build time on price (Opten ↔ Céginformáció).
    throw new Error(
      "OptenProvider is not implemented yet — set REGISTRY_PROVIDER=mock for dev.",
    );
  }
}

// ---- factory ---------------------------------------------------------------

export function getRegistryProvider(): RegistryProvider {
  const which = (process.env.REGISTRY_PROVIDER ?? "mock").toLowerCase();
  return which === "opten" ? new OptenProvider() : new MockProvider();
}
