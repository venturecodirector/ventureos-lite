import { describe, it, expect } from "vitest";
import {
  milestoneDueAt,
  parseMilestones,
  projectProgress,
  SEED_TEMPLATES,
} from "../../src/modules/projects/templates";

/**
 * Post-sale delivery (playbook-v3 P11/2).
 *
 * The pure parts: when a milestone is due, what a stored template is allowed to
 * contain, and the two numbers a project list actually gets read for.
 */

describe("milestoneDueAt", () => {
  it("counts days from the project's start", () => {
    const start = new Date("2026-03-02T09:15:00Z");
    expect(milestoneDueAt(start, 0).toISOString().slice(0, 10)).toBe("2026-03-02");
    expect(milestoneDueAt(start, 14).toISOString().slice(0, 10)).toBe("2026-03-16");
  });

  /**
   * End of the working day, not midnight: a milestone due "on the 16th" is not
   * overdue at one minute past midnight ON the 16th, which is when a checklist
   * full of false alarms stops being read.
   */
  it("lands at the end of the day, not the start of it", () => {
    const due = milestoneDueAt(new Date("2026-03-02T09:15:00Z"), 1);
    expect(due.getHours()).toBe(17);
    expect(due.getMinutes()).toBe(0);
  });

  it("refuses to schedule backwards", () => {
    const start = new Date("2026-03-10T00:00:00Z");
    expect(milestoneDueAt(start, -30).toISOString().slice(0, 10)).toBe("2026-03-10");
  });
});

describe("parseMilestones", () => {
  it("reads a well-formed template", () => {
    expect(
      parseMilestones([{ title: "Kickoff", dayOffset: 3, kind: "certificate" }]),
    ).toEqual([{ title: "Kickoff", dayOffset: 3, kind: "certificate" }]);
  });

  it("drops what it cannot use rather than trusting stored JSON", () => {
    expect(
      parseMilestones([
        { title: "  ", dayOffset: 1, kind: "generic" },
        { dayOffset: 2 },
        "nope",
        null,
        { title: "Jó", dayOffset: "hét", kind: "vad" },
      ]),
    ).toEqual([{ title: "Jó", dayOffset: 0, kind: "generic" }]);
  });

  it("survives anything at all in the column", () => {
    for (const raw of [null, undefined, {}, 42, "[]"]) {
      expect(parseMilestones(raw)).toEqual([]);
    }
  });
});

describe("the seeded templates", () => {
  /**
   * Every template ends in a certificate. That line closes the document chain
   * and unblocks the invoice, and it is the one that gets forgotten — so it is
   * not scaffolding a template author has to remember to add.
   */
  it("all end in exactly one certificate milestone", () => {
    for (const t of SEED_TEMPLATES) {
      const certs = t.milestones.filter((m) => m.kind === "certificate");
      expect(certs, t.name).toHaveLength(1);
      expect(t.milestones[t.milestones.length - 1]!.kind, t.name).toBe("certificate");
    }
  });

  it("puts its milestones in date order", () => {
    for (const t of SEED_TEMPLATES) {
      const offsets = t.milestones.map((m) => m.dayOffset);
      expect([...offsets].sort((a, b) => a - b), t.name).toEqual(offsets);
    }
  });
});

const day = 24 * 60 * 60 * 1000;
const past = new Date(Date.now() - day);
const future = new Date(Date.now() + day);

describe("projectProgress", () => {
  it("counts what is done and what is next", () => {
    const p = projectProgress([
      { title: "A", dueAt: past, doneAt: past },
      { title: "B", dueAt: future, doneAt: null },
      { title: "C", dueAt: new Date(Date.now() + 5 * day), doneAt: null },
    ]);
    expect(p).toMatchObject({ done: 1, total: 3, pct: 33, overdue: 0 });
    expect(p.next!.title).toBe("B");
  });

  it("counts an open milestone past its date as overdue, and a done one as not", () => {
    const p = projectProgress([
      { title: "Late", dueAt: past, doneAt: null },
      { title: "Was late, finished", dueAt: past, doneAt: new Date() },
    ]);
    expect(p.overdue).toBe(1);
  });

  it("does not divide by zero on an empty checklist", () => {
    expect(projectProgress([])).toMatchObject({ done: 0, total: 0, pct: 0, next: null });
  });

  it("still names a next milestone when nothing has a date", () => {
    const p = projectProgress([{ title: "Someday", dueAt: null, doneAt: null }]);
    expect(p.next!.title).toBe("Someday");
    expect(p.overdue).toBe(0);
  });

  it("reports 100% and no next when everything is done", () => {
    const p = projectProgress([{ title: "A", dueAt: past, doneAt: past }]);
    expect(p.pct).toBe(100);
    expect(p.next).toBeNull();
  });
});
