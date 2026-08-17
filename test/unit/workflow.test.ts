import { describe, it, expect } from "vitest";
import {
  ACTION_DEFS,
  MAX_CHAIN_DEPTH,
  MAX_RULES,
  ROOT_CHAIN,
  canRun,
  conditionsMatch,
  descend,
  describeRule,
  evaluateCondition,
  ruleSchema,
  validateActions,
  type Condition,
  type WorkflowFacts,
} from "../../src/modules/workflow/types";

/**
 * Workflow-lite's pure half (playbook-v2 P7/5): the matcher and the cycle
 * protection. The two things worth being certain about are that a condition on
 * a field the trigger did not supply goes QUIET rather than throwing, and that
 * a pair of rules triggering each other cannot run for ever.
 */
const facts: WorkflowFacts = {
  stage: "CONTACTED",
  source: "REFERRAL",
  icpScore: 4,
  industry: "HoReCa",
  city: null,
  signals: ["hiring", "pályázat"],
  "cf:segment": "horeca",
};

const c = (over: Partial<Condition>): Condition => ({
  field: "stage",
  operator: "is",
  value: "CONTACTED",
  ...over,
});

describe("conditions", () => {
  it("compares strings accent- and case-insensitively", () => {
    expect(evaluateCondition(facts, c({ value: "contacted" }))).toBe(true);
    expect(evaluateCondition(facts, c({ field: "industry", value: "horeca" }))).toBe(true);
    expect(evaluateCondition(facts, c({ operator: "is_not", value: "REPLIED" }))).toBe(true);
    expect(evaluateCondition(facts, c({ field: "industry", operator: "contains", value: "reca" }))).toBe(
      true,
    );
  });

  it("compares numbers", () => {
    expect(evaluateCondition(facts, c({ field: "icpScore", operator: "gte", value: 3 }))).toBe(true);
    expect(evaluateCondition(facts, c({ field: "icpScore", operator: "gte", value: 5 }))).toBe(false);
    expect(evaluateCondition(facts, c({ field: "icpScore", operator: "lte", value: 4 }))).toBe(true);
  });

  it("answers is_set / is_not_set, treating blank as absent", () => {
    expect(evaluateCondition(facts, c({ field: "industry", operator: "is_set" }))).toBe(true);
    expect(evaluateCondition(facts, c({ field: "city", operator: "is_not_set" }))).toBe(true);
    expect(evaluateCondition({ ...facts, industry: "  " }, c({ field: "industry", operator: "is_set" }))).toBe(
      false,
    );
  });

  it("matches signals, accents and all", () => {
    expect(evaluateCondition(facts, c({ operator: "has_signal", value: "palyazat" }))).toBe(true);
    expect(evaluateCondition(facts, c({ operator: "not_has_signal", value: "funding" }))).toBe(true);
    expect(evaluateCondition(facts, c({ operator: "has_signal", value: "funding" }))).toBe(false);
  });

  it("reads a custom field by the same cf: reference the filters use", () => {
    expect(evaluateCondition(facts, c({ field: "cf:segment", value: "horeca" }))).toBe(true);
  });

  it("goes quiet on a field the trigger did not supply, rather than throwing", () => {
    // A rule written for one trigger and re-pointed at another must not explode
    // in a background job.
    expect(evaluateCondition(facts, c({ field: "dealValue", operator: "gte", value: 1 }))).toBe(
      false,
    );
    expect(evaluateCondition(facts, c({ field: "nonsense", operator: "is", value: "x" }))).toBe(
      false,
    );
    expect(evaluateCondition(facts, c({ field: "nonsense", operator: "is_not_set" }))).toBe(true);
  });

  it("ANDs the list, and an empty list means 'whenever it fires'", () => {
    expect(conditionsMatch(facts, [])).toBe(true);
    expect(conditionsMatch(facts, [c({}), c({ field: "icpScore", operator: "gte", value: 3 })])).toBe(
      true,
    );
    expect(conditionsMatch(facts, [c({}), c({ field: "icpScore", operator: "gte", value: 9 })])).toBe(
      false,
    );
  });
});

describe("cycle protection", () => {
  const rule = { id: "r1" };
  const other = { id: "r2" };

  it("lets a fresh rule run", () => {
    expect(canRun(rule, ROOT_CHAIN)).toEqual({ allowed: true });
  });

  it("refuses a rule that has already run for this event", () => {
    const chain = descend(rule, ROOT_CHAIN);
    expect(canRun(rule, chain)).toEqual({ allowed: false, reason: "self_trigger" });
    // A DIFFERENT rule is still fine at that depth.
    expect(canRun(other, chain)).toEqual({ allowed: true });
  });

  it("stops a mutually-triggering pair, which the self-check alone would not", () => {
    // r1 → r2 → r1 → r2 … each satisfies "not myself" every time.
    let chain = ROOT_CHAIN;
    const order = [rule, other, rule, other, rule];
    const verdicts = order.map((r) => {
      const verdict = canRun(r, chain);
      if (verdict.allowed) chain = descend(r, chain);
      return verdict.allowed;
    });
    // The depth limit is what ends it.
    expect(verdicts.filter(Boolean).length).toBeLessThanOrEqual(MAX_CHAIN_DEPTH);
    expect(verdicts.at(-1)).toBe(false);
  });

  it("reports the depth limit as the reason, not a self-trigger", () => {
    let chain = ROOT_CHAIN;
    for (const id of ["a", "b", "c"]) chain = descend({ id }, chain);
    expect(canRun({ id: "d" }, chain)).toEqual({ allowed: false, reason: "depth" });
  });
});

describe("the email action drafts and cannot send (CLAUDE.md hard rule #2)", () => {
  it("says so in the copy a person reads while choosing it", () => {
    const note = ACTION_DEFS.draft_email.note.toLowerCase();
    expect(ACTION_DEFS.draft_email.label).toMatch(/DRAFT/);
    expect(note).toContain("never sent");
    expect(note).toContain("sends it");
  });

  it("offers no send action at all", () => {
    const labels = Object.values(ACTION_DEFS).map((a) => a.label.toLowerCase());
    expect(labels.some((l) => /\bsend\b/.test(l))).toBe(false);
  });
});

describe("validation", () => {
  it("names what an action is missing", () => {
    expect(validateActions([{ type: "create_task" }])[0]).toMatch(/title/);
    expect(validateActions([{ type: "draft_email" }])[0]).toMatch(/subject or a template/);
    expect(validateActions([{ type: "add_signal" }])[0]).toMatch(/signal tag/);
    expect(validateActions([{ type: "notify_user" }])[0]).toMatch(/who to notify/);
    expect(validateActions([{ type: "move_not_now" }])).toEqual([]);
  });

  it("requires a name and at least one action", () => {
    expect(
      ruleSchema.safeParse({ name: "", trigger: "lead_created", actions: [] }).success,
    ).toBe(false);
    expect(
      ruleSchema.safeParse({
        name: "Rule",
        trigger: "lead_created",
        actions: [{ type: "move_not_now" }],
      }).success,
    ).toBe(true);
  });

  it("caps the rule set at twenty, which the UI also enforces", () => {
    expect(MAX_RULES).toBe(20);
  });
});

describe("the plain-English summary", () => {
  it("reads as a sentence, which is what a person checks before saving", () => {
    const text = describeRule({
      name: "Kick off",
      trigger: "quote_accepted",
      conditions: [{ field: "icpScore", operator: "gte", value: 4 }],
      actions: [{ type: "create_task", title: "Kick-off call" }],
    });
    expect(text).toBe("When a quote is accepted if icpScore is at least 4 → Create a task");
  });

  it("omits the if-clause when there are no conditions", () => {
    const text = describeRule({
      name: "Any",
      trigger: "lead_created",
      conditions: [],
      actions: [{ type: "move_not_now" }],
    });
    expect(text).not.toContain(" if ");
  });
});
