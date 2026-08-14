import { describe, it, expect } from "vitest";
import {
  bucketOf,
  isOverdue,
  orderTasks,
  groupTasks,
  dueInDays,
  isTaskType,
  type TaskLike,
} from "@/modules/tasks/logic";

/**
 * playbook-v2 P3/3 — the rules that decide what a person sees first.
 *
 * The overdue definition is the one that has to be right: if "overdue" turns
 * red at 09:01 for a task due at 09:00, the count stops being trustworthy and
 * people learn to ignore it.
 */
const NOW = new Date("2026-08-15T11:00:00");

function task(over: Partial<TaskLike> & { id: string }): TaskLike {
  return { type: "todo", title: over.id, dueAt: null, doneAt: null, ...over };
}

const at = (iso: string) => new Date(iso);

describe("bucketOf", () => {
  it("calls a task due earlier today TODAY, not overdue", () => {
    // 09:00 seen at 11:00 is still today's work.
    expect(bucketOf(task({ id: "a", dueAt: at("2026-08-15T09:00:00") }), NOW)).toBe("today");
  });

  it("calls yesterday overdue", () => {
    expect(bucketOf(task({ id: "b", dueAt: at("2026-08-14T17:00:00") }), NOW)).toBe("overdue");
  });

  it("calls later today today, and tomorrow upcoming", () => {
    expect(bucketOf(task({ id: "c", dueAt: at("2026-08-15T23:00:00") }), NOW)).toBe("today");
    expect(bucketOf(task({ id: "d", dueAt: at("2026-08-16T09:00:00") }), NOW)).toBe("upcoming");
  });

  it("puts a task with no date in someday, NOT overdue", () => {
    // A reminder written without a date is not late, and treating it as late
    // teaches people to ignore the overdue count.
    expect(bucketOf(task({ id: "e", dueAt: null }), NOW)).toBe("someday");
    expect(isOverdue(task({ id: "e", dueAt: null }), NOW)).toBe(false);
  });

  it("puts a completed task in done whatever its date", () => {
    expect(
      bucketOf(
        task({ id: "f", dueAt: at("2026-01-01T09:00:00"), doneAt: at("2026-01-02T09:00:00") }),
        NOW,
      ),
    ).toBe("done");
  });
});

describe("orderTasks", () => {
  it("works overdue first, then today, then soonest", () => {
    const ordered = orderTasks(
      [
        task({ id: "upcoming", dueAt: at("2026-08-20T09:00:00") }),
        task({ id: "someday", dueAt: null }),
        task({ id: "overdue", dueAt: at("2026-08-10T09:00:00") }),
        task({ id: "today", dueAt: at("2026-08-15T15:00:00") }),
      ],
      NOW,
    );
    expect(ordered.map((t) => t.id)).toEqual(["overdue", "today", "upcoming", "someday"]);
  });

  it("puts the older overdue task first", () => {
    const ordered = orderTasks(
      [
        task({ id: "recent", dueAt: at("2026-08-14T09:00:00") }),
        task({ id: "ancient", dueAt: at("2026-07-01T09:00:00") }),
      ],
      NOW,
    );
    expect(ordered.map((t) => t.id)).toEqual(["ancient", "recent"]);
  });

  it("is stable on ties, so the list does not shuffle between renders", () => {
    const due = at("2026-08-15T09:00:00");
    const a = orderTasks(
      [task({ id: "b", title: "beta", dueAt: due }), task({ id: "a", title: "alpha", dueAt: due })],
      NOW,
    );
    const b = orderTasks(
      [task({ id: "a", title: "alpha", dueAt: due }), task({ id: "b", title: "beta", dueAt: due })],
      NOW,
    );
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });

  it("does not mutate its input", () => {
    const input = [task({ id: "z", dueAt: at("2026-08-20T09:00:00") }), task({ id: "a", dueAt: null })];
    const before = input.map((t) => t.id);
    orderTasks(input, NOW);
    expect(input.map((t) => t.id)).toEqual(before);
  });
});

describe("groupTasks", () => {
  const tasks = [
    task({ id: "overdue1", dueAt: at("2026-08-13T09:00:00") }),
    task({ id: "overdue2", dueAt: at("2026-08-14T09:00:00") }),
    task({ id: "today1", dueAt: at("2026-08-15T09:00:00") }),
    task({ id: "upcoming1", dueAt: at("2026-08-18T09:00:00") }),
    task({ id: "nodate", dueAt: null }),
    task({ id: "finished", dueAt: at("2026-08-13T09:00:00"), doneAt: at("2026-08-13T10:00:00") }),
  ];

  it("counts what the badge shows", () => {
    const g = groupTasks(tasks, NOW);
    expect(g.counts.overdue).toBe(2);
    expect(g.counts.today).toBe(1);
    // Open excludes the completed one.
    expect(g.counts.open).toBe(5);
  });

  it("leaves completed tasks out of every open bucket", () => {
    const g = groupTasks(tasks, NOW);
    const ids = [...g.overdue, ...g.today, ...g.upcoming, ...g.someday].map((t) => t.id);
    expect(ids).not.toContain("finished");
  });
});

describe("dueInDays", () => {
  it("lands at end of the working day, not at this exact time", () => {
    // "in 3 days" means that day, and an hour-precise deadline nobody chose
    // only creates false overdues.
    const due = dueInDays(3, NOW);
    expect(due.getHours()).toBe(17);
    expect(due.getMinutes()).toBe(0);
    expect(due.getDate()).toBe(18);
  });

  it("supports today", () => {
    expect(dueInDays(0, NOW).getDate()).toBe(15);
  });
});

describe("isTaskType", () => {
  it("accepts only the four types", () => {
    expect(isTaskType("call")).toBe(true);
    expect(isTaskType("follow_up")).toBe(true);
    expect(isTaskType("meeting")).toBe(false);
    expect(isTaskType(null)).toBe(false);
  });
});
