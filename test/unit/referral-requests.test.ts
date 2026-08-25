import { describe, it, expect } from "vitest";
import {
  buildReferralDraft,
  cooldownPassed,
  ripe,
  conversion,
  REFERRAL_DELAY_DAYS,
  REFERRAL_COOLDOWN_DAYS,
} from "../../src/modules/referrals/request";
import { referralSettingsFrom } from "../../src/modules/referrals/jobs";

/**
 * Referral activation (playbook-v4 P13/3).
 *
 * Timing is the whole feature — fourteen days after a client confirms the work
 * is the satisfaction peak, and a month later the identical message reads as a
 * favour being extracted. So the two clocks are what these tests pin.
 */
const day = 86_400_000;
const NOW = new Date("2026-08-25T09:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * day);

describe("the clocks", () => {
  it("waits the full fourteen days, and not a day less", () => {
    expect(REFERRAL_DELAY_DAYS).toBe(14);
    expect(ripe(ago(13), NOW)).toBe(false);
    expect(ripe(ago(14), NOW)).toBe(true);
    expect(ripe(ago(40), NOW)).toBe(true);
  });

  it("asks a client at most once every six months", () => {
    expect(REFERRAL_COOLDOWN_DAYS).toBeGreaterThanOrEqual(180);
    expect(cooldownPassed(null, NOW)).toBe(true);
    expect(cooldownPassed(ago(100), NOW)).toBe(false);
    expect(cooldownPassed(ago(200), NOW)).toBe(true);
  });
});

describe("the draft", () => {
  const draft = buildReferralDraft({
    contactName: "Kovács Anna",
    companyName: "Példa Kft.",
    scope: "Weboldal újraépítése és keresőoptimalizálás",
    industry: "Fogászat",
  });

  /**
   * A concrete ask beats a general one. "Ismer valakit?" gets "majd szólok";
   * naming the industry gives them somebody specific to picture.
   */
  it("names the work and the kind of company being asked for", () => {
    expect(draft.body).toContain("Weboldal újraépítése és keresőoptimalizálás");
    expect(draft.body).toContain("fogászat");
    expect(draft.body).toContain("Anna");
  });

  it("gives them an easy way to say no", () => {
    expect(draft.body).toMatch(/nincs ilyen, az is teljesen rendben/);
  });

  it("still writes something usable when nothing is known", () => {
    const bare = buildReferralDraft({
      contactName: null,
      companyName: null,
      scope: null,
      industry: null,
    });
    expect(bare.subject.length).toBeGreaterThan(10);
    expect(bare.body).toContain("Kedves Partnerünk");
    expect(bare.body).toContain("hasonló vállalkozást");
    expect(bare.body).not.toContain("null");
    expect(bare.body).not.toContain("undefined");
  });

  it("does not let a runaway scope field become the whole email", () => {
    const long = buildReferralDraft({
      contactName: null,
      companyName: null,
      scope: "x".repeat(5000),
      industry: null,
    });
    expect(long.body.length).toBeLessThan(1200);
  });
});

describe("conversion", () => {
  const rows = (statuses: string[]) => statuses.map((status) => ({ status }));

  it("counts a produced referral as a response too", () => {
    const c = conversion(rows(["drafted", "sent", "responded", "produced", "produced"]));
    expect(c.requested).toBe(5);
    expect(c.responded).toBe(3);
    expect(c.produced).toBe(2);
  });

  it("says nothing rather than a number below a usable sample", () => {
    expect(conversion(rows(["produced", "produced"])).rate).toBeNull();
    expect(conversion(rows(["produced", "sent", "sent", "sent", "sent"])).rate).toBe(0.2);
  });

  it("survives having asked nobody", () => {
    expect(conversion([])).toMatchObject({ requested: 0, rate: null });
  });
});

describe("the per-workspace switch", () => {
  it("is on unless somebody turned it off", () => {
    expect(referralSettingsFrom(undefined).enabled).toBe(true);
    expect(referralSettingsFrom({}).enabled).toBe(true);
    expect(referralSettingsFrom({ enabled: false }).enabled).toBe(false);
  });

  it("ignores nonsense in the column rather than trusting it", () => {
    expect(referralSettingsFrom({ enabled: "yes" }).enabled).toBe(true);
    expect(referralSettingsFrom(42).enabled).toBe(true);
  });
});
