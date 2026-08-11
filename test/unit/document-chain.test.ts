import { describe, it, expect } from "vitest";
import {
  nextInChain,
  canCreateContract,
  canCreateCertificate,
  allowedStatusTransition,
  buildChainStepper,
} from "../../src/modules/documents/chain";
import {
  contractScopeFromQuote,
  contractPayloadFromQuote,
  certificatePayloadFromContract,
} from "../../src/modules/documents/prefill";
import type { QuoteItem } from "../../src/modules/documents/quote-math";

describe("chain order + guards", () => {
  it("advances quote → contract → certificate", () => {
    expect(nextInChain("QUOTE")).toBe("CONTRACT");
    expect(nextInChain("CONTRACT")).toBe("CERTIFICATE");
    expect(nextInChain("CERTIFICATE")).toBeNull();
  });
  it("only an accepted quote unlocks a contract", () => {
    expect(canCreateContract("ACCEPTED")).toBe(true);
    expect(canCreateContract("SENT")).toBe(false);
    expect(canCreateContract("DRAFT")).toBe(false);
  });
  it("only a signed contract unlocks a certificate", () => {
    expect(canCreateCertificate("SIGNED")).toBe(true);
    expect(canCreateCertificate("SENT")).toBe(false);
  });
});

describe("allowedStatusTransition (per-type)", () => {
  it("quote: draft→sent→accepted", () => {
    expect(allowedStatusTransition("QUOTE", "DRAFT", "SENT")).toBe(true);
    expect(allowedStatusTransition("QUOTE", "SENT", "ACCEPTED")).toBe(true);
    expect(allowedStatusTransition("QUOTE", "DRAFT", "ACCEPTED")).toBe(false);
  });
  it("contract: sent→signed; certificate: sent→acknowledged", () => {
    expect(allowedStatusTransition("CONTRACT", "SENT", "SIGNED")).toBe(true);
    expect(allowedStatusTransition("CERTIFICATE", "SENT", "ACKNOWLEDGED")).toBe(true);
    expect(allowedStatusTransition("CONTRACT", "DRAFT", "SIGNED")).toBe(false);
  });
});

describe("buildChainStepper", () => {
  it("marks present steps + the active (latest) one", () => {
    const steps = buildChainStepper([
      { type: "QUOTE", status: "ACCEPTED" },
      { type: "CONTRACT", status: "DRAFT" },
    ]);
    expect(steps.map((s) => s.type)).toEqual(["QUOTE", "CONTRACT", "CERTIFICATE"]);
    expect(steps[0]).toMatchObject({ present: true, status: "ACCEPTED", active: false });
    expect(steps[1]).toMatchObject({ present: true, status: "DRAFT", active: true });
    expect(steps[2]).toMatchObject({ present: false, status: null, active: false });
  });
});

describe("pre-fill mappings (no AI)", () => {
  const items: QuoteItem[] = [
    { description: "Website development", baseNet: 1_400_000, preset: "production" },
    { description: "SEO setup", baseNet: 220_000, preset: "production" },
  ];

  it("contract scope is derived from the accepted quote's line items", () => {
    expect(contractScopeFromQuote(items)).toBe("• Website development\n• SEO setup");
  });

  it("contract payload carries parties + defaults", () => {
    const party = {
      clientLegalName: "Aventa Logistics Kft.",
      clientTaxId: "12345678142",
      contractorLegalName: "Venture CO Group Kft.",
    };
    const p = contractPayloadFromQuote(items, party, "SZ-2026-003");
    expect(p.parties).toEqual(party);
    expect(p.scope).toContain("Website development");
    expect(p.contractNumber).toBe("SZ-2026-003");
    expect(p.milestones.length).toBeGreaterThan(0);
  });

  it("certificate deliverables come from the contract scope", () => {
    const cert = certificatePayloadFromContract(
      { scope: "• Website development" },
      "2026-10-15",
      "TIG-2026-002",
    );
    expect(cert.deliverables).toBe("• Website development");
    expect(cert.date).toBe("2026-10-15");
    expect(cert.certNumber).toBe("TIG-2026-002");
  });
});
