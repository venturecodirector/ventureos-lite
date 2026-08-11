import { describe, it, expect } from "vitest";
import {
  answeredCount,
  canQualify,
  QUALIFY_THRESHOLD,
  QUAL_ITEMS,
} from "../../src/modules/inbox/qualification";
import { detectMoneyTalk, escalationReason } from "../../src/modules/inbox/escalation";

describe("qualification unlock (3 of 4, spec §4.7)", () => {
  it("counts answered items", () => {
    expect(answeredCount(null)).toBe(0);
    expect(answeredCount({ authority: true, budget: true })).toBe(2);
    expect(
      answeredCount({ authority: true, history: true, budget: true, timeline: true }),
    ).toBe(4);
  });

  it("unlocks Qualified only at 3 of 4 answered", () => {
    expect(QUALIFY_THRESHOLD).toBe(3);
    expect(QUAL_ITEMS).toHaveLength(4);
    expect(canQualify({ authority: true, history: true })).toBe(false); // 2/4
    expect(canQualify({ authority: true, history: true, budget: true })).toBe(true); // 3/4
    expect(
      canQualify({ authority: true, history: true, budget: true, timeline: true }),
    ).toBe(true); // 4/4
    expect(canQualify(null)).toBe(false);
  });
});

describe("escalation flagging (price/proposal/contract, spec §4.7)", () => {
  it("flags money-talk in HU and EN", () => {
    expect(detectMoneyTalk("Mennyibe kerülne egy ilyen weboldal?")).toBe(true);
    expect(detectMoneyTalk("Can you send me the price?")).toBe(true);
    expect(detectMoneyTalk("Szükségünk lenne egy árajánlatra")).toBe(true);
    expect(detectMoneyTalk("Please share the proposal and the contract")).toBe(true);
    expect(detectMoneyTalk("Küldd át a szerződést")).toBe(true);
  });
  it("does not flag neutral replies", () => {
    expect(detectMoneyTalk("Köszönöm, ez érdekesen hangzik!")).toBe(false);
    expect(detectMoneyTalk("Sounds interesting, tell me more.")).toBe(false);
  });
  it("categorises the escalation reason", () => {
    expect(escalationReason("what is the price")).toBe("price");
    expect(escalationReason("send the proposal / árajánlat")).toBe("proposal");
    expect(escalationReason("we need a contract / szerződés")).toBe("contract");
    expect(escalationReason("hello there")).toBeNull();
  });
});
