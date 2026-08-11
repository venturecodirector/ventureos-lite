import { describe, it, expect } from "vitest";
import {
  pseudonymizeLead,
  isAnonymized,
  shouldAnonymize,
  type AnonymizableLead,
} from "../../src/modules/gdpr/anonymize";

const NOW = Date.UTC(2026, 7, 12);

function lead(over: Partial<AnonymizableLead> = {}): AnonymizableLead {
  return {
    id: "clead000abc123def456",
    contactName: "Kelemen Márta",
    email: "marta@fortuna.hu",
    phone: "+36301234567",
    linkedinUrl: "https://linkedin.com/in/marta",
    notes: "Met at expo; interested in allergen audit.",
    anonymizedAt: null,
    ...over,
  };
}

describe("pseudonymizeLead scrubs person fields, keeps a stable pseudonym", () => {
  it("nulls PII and sets a deterministic pseudonym + timestamp", () => {
    const p = pseudonymizeLead(lead(), NOW);
    expect(p.email).toBeNull();
    expect(p.phone).toBeNull();
    expect(p.linkedinUrl).toBeNull();
    expect(p.notes).toBeNull();
    expect(p.contactName).toBe("Anonymized-def456");
    expect(p.anonymizedAt).toEqual(new Date(NOW));
  });
});

describe("anonymization is idempotent (spec §10)", () => {
  it("re-running yields identical output and preserves the original timestamp", () => {
    const first = pseudonymizeLead(lead(), NOW);
    // Feed the already-anonymized state back in, at a LATER time.
    const already = lead({
      contactName: first.contactName,
      email: first.email,
      phone: first.phone,
      linkedinUrl: first.linkedinUrl,
      notes: first.notes,
      anonymizedAt: first.anonymizedAt,
    });
    const second = pseudonymizeLead(already, NOW + 999_999_999);
    expect(second).toEqual(first); // no drift, timestamp preserved
    expect(second.anonymizedAt).toEqual(new Date(NOW));
  });

  it("isAnonymized reflects the flag", () => {
    expect(isAnonymized(lead())).toBe(false);
    expect(isAnonymized(lead({ anonymizedAt: new Date(NOW) }))).toBe(true);
  });
});

describe("shouldAnonymize gates on inactivity + not-yet-anonymized", () => {
  const cutoff = NOW; // anonymize anything last active before this instant
  it("selects inactive, un-anonymized leads only", () => {
    expect(shouldAnonymize({ lastActivityAt: new Date(NOW - 1), anonymizedAt: null }, cutoff)).toBe(true);
    // active recently → skip
    expect(shouldAnonymize({ lastActivityAt: new Date(NOW + 1), anonymizedAt: null }, cutoff)).toBe(false);
    // already anonymized → skip (idempotent at the sweep level)
    expect(shouldAnonymize({ lastActivityAt: new Date(NOW - 1), anonymizedAt: new Date(NOW) }, cutoff)).toBe(false);
  });

  it("falls back to createdAt when lastActivityAt is null", () => {
    expect(shouldAnonymize({ lastActivityAt: null, createdAt: new Date(NOW - 1), anonymizedAt: null }, cutoff)).toBe(true);
    expect(shouldAnonymize({ lastActivityAt: null, createdAt: new Date(NOW + 1), anonymizedAt: null }, cutoff)).toBe(false);
  });
});
