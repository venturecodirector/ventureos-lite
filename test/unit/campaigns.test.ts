import { describe, it, expect } from "vitest";
import {
  coldEmailAllowed,
  parseColdConfig,
  partitionRecipients,
  bounceRate,
  circuitBreakerTripped,
  warmupDailyCap,
  renderPersonalized,
  withUnsubscribeFooter,
  buildRecipientSends,
  type ColdStep,
} from "../../src/modules/campaigns/logic";

describe("compliance gate — cold email blocked without counsel sign-off (spec §4.16)", () => {
  it("is OFF by default (no flags)", () => {
    expect(coldEmailAllowed({})).toBe(false);
    expect(coldEmailAllowed(null)).toBe(false);
    expect(coldEmailAllowed({ coldEmail: {} })).toBe(false);
  });

  it("stays blocked with an incomplete sign-off record", () => {
    expect(coldEmailAllowed({ coldEmail: { signoff: { approvedBy: "Dr. Kiss", date: "", scopeNote: "" } } })).toBe(false);
    expect(coldEmailAllowed({ coldEmail: { signoff: { approvedBy: "", date: "2026-08-01", scopeNote: "B2B only" } } })).toBe(false);
  });

  it("activates ONLY with a complete sign-off (who / when / scope)", () => {
    const flags = { coldEmail: { signoff: { approvedBy: "Dr. Kiss", date: "2026-08-01", scopeNote: "B2B, legitimate interest" } } };
    expect(coldEmailAllowed(flags)).toBe(true);
    expect(parseColdConfig(flags).signoff?.approvedBy).toBe("Dr. Kiss");
  });
});

describe("shared suppression — unsubscribe suppresses across ALL campaigns", () => {
  it("blocks a suppressed address for every campaign drawing from the workspace list", () => {
    const suppressed = ["Unsub@Example.com"]; // workspace-level
    const campaign1 = partitionRecipients([{ address: "keep@x.hu" }, { address: "unsub@example.com" }], suppressed);
    const campaign2 = partitionRecipients([{ address: "unsub@example.com" }, { address: "other@y.hu" }], suppressed);
    expect(campaign1.sendable.map((r) => r.address)).toEqual(["keep@x.hu"]);
    expect(campaign1.blocked.map((r) => r.address)).toEqual(["unsub@example.com"]);
    // Same address is blocked in a DIFFERENT campaign — the list is shared.
    expect(campaign2.blocked.map((r) => r.address)).toEqual(["unsub@example.com"]);
    expect(campaign2.sendable.map((r) => r.address)).toEqual(["other@y.hu"]);
  });
});

describe("bounce-rate circuit breaker", () => {
  it("does not trip below the minimum sample", () => {
    expect(circuitBreakerTripped(5, 5, 0.05, 20)).toBe(false); // too few sends
  });
  it("trips at/above threshold once there's enough signal", () => {
    expect(bounceRate(100, 6)).toBeCloseTo(0.06, 5);
    expect(circuitBreakerTripped(100, 6, 0.05, 20)).toBe(true);
    expect(circuitBreakerTripped(100, 4, 0.05, 20)).toBe(false);
  });
});

describe("warm-up ramp", () => {
  it("ramps daily volume up over the first weeks, capping at the configured cap", () => {
    expect(warmupDailyCap(0, 100)).toBe(25);
    expect(warmupDailyCap(1, 100)).toBe(50);
    expect(warmupDailyCap(2, 100)).toBe(75);
    expect(warmupDailyCap(3, 100)).toBe(100);
    expect(warmupDailyCap(9, 100)).toBe(100); // fully warmed
  });
});

describe("personalization + mandatory unsubscribe — pure, no per-recipient AI", () => {
  it("fills slots from DATA and blanks unknown slots", () => {
    const out = renderPersonalized("Szia {{company}}, {{audit_link}} — score {{audit_score}}", {
      company: "AquaFix",
      audit_link: "https://audit/abc",
      audit_score: "72",
    });
    expect(out).toBe("Szia AquaFix, https://audit/abc — score 72");
    expect(renderPersonalized("hi {{missing}}", {})).toBe("hi ");
  });

  it("injects the unsubscribe footer on every step", () => {
    const body = withUnsubscribeFooter("Hello there", "https://x/unsub/tok");
    expect(body).toContain("Hello there");
    expect(body.toLowerCase()).toContain("unsubscribe");
    expect(body).toContain("https://x/unsub/tok");
  });

  it("renders sends for N recipients with the pre-drafted frame — zero AI calls per recipient", () => {
    const steps: ColdStep[] = [{ stepNumber: 1, subject: "s1 {{company}}", body: "Body {{audit_link}}" }];
    const recipients = [
      { address: "a@x.hu", slots: { company: "Alpha", audit_link: "L1" }, unsubUrl: "U1" },
      { address: "b@y.hu", slots: { company: "Bravo", audit_link: "L2" }, unsubUrl: "U2" },
    ];
    const sends = buildRecipientSends(steps[0], recipients);
    expect(sends).toHaveLength(2);
    expect(sends[0].subject).toBe("s1 Alpha");
    expect(sends[0].body).toContain("Body L1");
    expect(sends[0].body.toLowerCase()).toContain("unsubscribe");
    expect(sends[1].subject).toBe("s1 Bravo");
    // buildRecipientSends takes no AI dependency — personalization is pure template fill.
  });
});
