import { describe, it, expect } from "vitest";
import {
  CHECKLIST,
  TOUR_STEPS,
  checklistComplete,
  checklistProgress,
  type ChecklistState,
} from "../../src/modules/onboarding/tour";

/**
 * The tour and the getting-started checklist (playbook-v2 P7/4).
 *
 * Small surface, but two things are worth pinning: the checklist must be
 * DERIVED (so it cannot claim a lead exists after the last one is deleted), and
 * every tour step must point somewhere real.
 */
const NONE: ChecklistState = {
  connect_email: false,
  first_lead: false,
  first_audit: false,
  first_meeting: false,
};
const ALL: ChecklistState = {
  connect_email: true,
  first_lead: true,
  first_audit: true,
  first_meeting: true,
};

describe("the tour", () => {
  it("is the 5-6 steps the playbook asks for", () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(5);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(6);
  });

  it("walks the daily loop in order, ending at Settings", () => {
    expect(TOUR_STEPS[0].href).toBe("/");
    expect(TOUR_STEPS.at(-1)!.href).toBe("/settings");
    expect(TOUR_STEPS.map((s) => s.href)).toContain("/pipeline");
  });

  it("has a lowercase headline on every step, matching the prototype's voice", () => {
    for (const step of TOUR_STEPS) {
      expect(step.title, step.id).toBe(step.title.toLowerCase());
      expect(step.body.length, step.id).toBeGreaterThan(40);
    }
  });

  it("gives every step a distinct id", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the checklist", () => {
  it("is the four the playbook names", () => {
    expect(CHECKLIST.map((i) => i.id)).toEqual([
      "connect_email",
      "first_lead",
      "first_audit",
      "first_meeting",
    ]);
  });

  it("counts progress, and is complete only when everything is", () => {
    expect(checklistProgress(NONE)).toEqual({ done: 0, total: 4 });
    expect(checklistComplete(NONE)).toBe(false);

    const partial = { ...NONE, first_lead: true, first_audit: true };
    expect(checklistProgress(partial)).toEqual({ done: 2, total: 4 });
    expect(checklistComplete(partial)).toBe(false);

    expect(checklistProgress(ALL)).toEqual({ done: 4, total: 4 });
    expect(checklistComplete(ALL)).toBe(true);
  });

  it("sends every item somewhere it can actually be done", () => {
    for (const item of CHECKLIST) {
      expect(item.href, item.id).toMatch(/^\//);
      expect(item.hint.length, item.id).toBeGreaterThan(10);
    }
  });
});
