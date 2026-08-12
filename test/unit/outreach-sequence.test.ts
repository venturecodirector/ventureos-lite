import { describe, it, expect } from "vitest";
import {
  OUTREACH_STEPS,
  CONNECTION_MAX_CHARS,
  MAX_FOLLOW_UPS,
  nextStep,
  maxCharsFor,
  isOverLimit,
  shouldParkAsNotNow,
  normalizeForComparison,
  isHumanEdited,
  evaluateSendGate,
  auditHooks,
  isOutreachStep,
} from "../../src/modules/outreach/sequence";

describe("sequence shape", () => {
  it("is connection → fu1 → fu2 and nothing more", () => {
    expect([...OUTREACH_STEPS]).toEqual(["connection", "fu1", "fu2"]);
    expect(MAX_FOLLOW_UPS).toBe(2);
  });

  it("walks to the next unsent step, then reports done", () => {
    expect(nextStep([])).toBe("connection");
    expect(nextStep(["connection"])).toBe("fu1");
    expect(nextStep(["connection", "fu1"])).toBe("fu2");
    expect(nextStep(["connection", "fu1", "fu2"])).toBeNull();
  });

  it("caps only the connection note, at LinkedIn's 300 characters", () => {
    expect(CONNECTION_MAX_CHARS).toBe(300);
    expect(maxCharsFor("connection")).toBe(300);
    expect(maxCharsFor("fu1")).toBeNull();
    expect(isOverLimit("connection", "x".repeat(301))).toBe(true);
    expect(isOverLimit("connection", "x".repeat(300))).toBe(false);
    expect(isOverLimit("fu2", "x".repeat(5000))).toBe(false);
  });

  it("recognises its own step names", () => {
    expect(isOutreachStep("fu1")).toBe(true);
    expect(isOutreachStep("reply")).toBe(false);
  });
});

describe("auto Not-now after two follow-ups", () => {
  it("parks a silent lead once both follow-ups are out", () => {
    expect(shouldParkAsNotNow({ sentSteps: ["connection", "fu1", "fu2"], hasReply: false })).toBe(true);
  });

  it("does not park before the second follow-up", () => {
    expect(shouldParkAsNotNow({ sentSteps: ["connection"], hasReply: false })).toBe(false);
    expect(shouldParkAsNotNow({ sentSteps: ["connection", "fu1"], hasReply: false })).toBe(false);
  });

  it("never parks a lead that replied", () => {
    expect(shouldParkAsNotNow({ sentSteps: ["connection", "fu1", "fu2"], hasReply: true })).toBe(false);
  });
});

describe("human-edit guardrail (CLAUDE.md hard rule #6)", () => {
  const draft = "I ran a check on your site and it scores 62/100.";

  it("treats an untouched draft as not edited", () => {
    expect(isHumanEdited(draft, draft)).toBe(false);
  });

  it("ignores whitespace-only churn, which is not an edit", () => {
    expect(isHumanEdited(draft, `  ${draft}  `)).toBe(false);
    expect(isHumanEdited(draft, draft.replace(/ /g, "  "))).toBe(false);
    expect(isHumanEdited(draft, draft.replace("\n", "\r\n"))).toBe(false);
    expect(normalizeForComparison("a  b\r\n c ")).toBe("a b c");
  });

  it("counts a real wording change as an edit", () => {
    expect(isHumanEdited(draft, draft.replace("62", "64"))).toBe(true);
    expect(isHumanEdited(draft, `${draft} Worth a quick look?`)).toBe(true);
    expect(isHumanEdited(draft, "Completely different text.")).toBe(true);
  });

  it("treats text that was never AI-drafted as the operator's own", () => {
    expect(isHumanEdited(null, "anything")).toBe(true);
    expect(isHumanEdited("", "anything")).toBe(true);
  });

  it("blocks sending an unedited Claude draft", () => {
    const gate = evaluateSendGate({
      step: "fu1",
      body: draft,
      aiDrafted: true,
      aiDraftBody: draft,
    });
    expect(gate.allowed).toBe(false);
    if (gate.allowed) return;
    expect(gate.reason).toBe("unedited");
    expect(gate.message).toMatch(/edit/i);
  });

  it("allows sending once it has actually been changed", () => {
    expect(
      evaluateSendGate({
        step: "fu1",
        body: `${draft} Worth a look?`,
        aiDrafted: true,
        aiDraftBody: draft,
      }),
    ).toEqual({ allowed: true });
  });

  it("allows a hand-written message with no AI involved", () => {
    expect(
      evaluateSendGate({ step: "fu1", body: "My own words.", aiDrafted: false, aiDraftBody: null }),
    ).toEqual({ allowed: true });
  });

  it("cannot be defeated by whitespace padding", () => {
    const gate = evaluateSendGate({
      step: "fu1",
      body: `${draft}   `,
      aiDrafted: true,
      aiDraftBody: draft,
    });
    expect(gate.allowed).toBe(false);
  });

  it("refuses an empty or over-length message", () => {
    const empty = evaluateSendGate({ step: "fu1", body: "   ", aiDrafted: false, aiDraftBody: null });
    expect(empty.allowed).toBe(false);
    if (!empty.allowed) expect(empty.reason).toBe("empty");

    const long = evaluateSendGate({
      step: "connection",
      body: "x".repeat(320),
      aiDrafted: false,
      aiDraftBody: null,
    });
    expect(long.allowed).toBe(false);
    if (!long.allowed) {
      expect(long.reason).toBe("too_long");
      expect(long.message).toContain("20"); // how many characters to trim
    }
  });
});

describe("audit hooks", () => {
  it("builds insertable lines from audit data only", () => {
    const hooks = auditHooks({
      companyName: "Aventa Kft.",
      score: 48,
      flags: ["no mobile", "outdated website"],
    });
    expect(hooks.map((h) => h.label)).toEqual(["Score 48", "no mobile", "outdated website"]);
    expect(hooks[0].line).toContain("Aventa Kft.");
    expect(hooks[0].line).toContain("48");
  });

  it("skips flags it has no wording for, and caps the list", () => {
    const hooks = auditHooks({
      companyName: "X",
      score: null,
      flags: ["no mobile", "some unknown flag", "no https", "slow", "outdated website"],
    });
    expect(hooks.every((h) => h.label !== "some unknown flag")).toBe(true);
    expect(hooks.length).toBeLessThanOrEqual(4);
  });

  it("degrades gracefully with no company name or audit", () => {
    const hooks = auditHooks({ companyName: "", score: null, flags: [] });
    expect(hooks).toEqual([]);
  });
});
