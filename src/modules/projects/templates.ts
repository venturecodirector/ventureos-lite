/**
 * Milestone templates (playbook-v3 P11/2a, 2d).
 *
 * The seeded ones are the two shapes this agency actually delivers. They exist
 * so a first project can be started in one click rather than after an hour in
 * a template editor — the editor is there for when they stop fitting.
 */
export interface TemplateMilestone {
  title: string;
  /** Days from project start. The due date is derived, never stored twice. */
  dayOffset: number;
  kind: "generic" | "certificate";
}

export interface SeedTemplate {
  name: string;
  milestones: TemplateMilestone[];
}

/**
 * Every template ends in a certificate milestone, deliberately.
 *
 * That is the line that closes the document chain and unblocks the invoice, and
 * it is the one that gets forgotten — so it is not optional scaffolding a
 * template author has to remember to add.
 */
export const SEED_TEMPLATES: SeedTemplate[] = [
  {
    name: "Weboldal projekt",
    milestones: [
      { title: "Kickoff meeting", dayOffset: 3, kind: "generic" },
      { title: "Tartalom beérkezett", dayOffset: 14, kind: "generic" },
      { title: "Design jóváhagyva", dayOffset: 24, kind: "generic" },
      { title: "Fejlesztés kész", dayOffset: 45, kind: "generic" },
      { title: "Átadás", dayOffset: 52, kind: "generic" },
      { title: "Teljesítésigazolás", dayOffset: 55, kind: "certificate" },
    ],
  },
  {
    name: "Kisebb fejlesztés",
    milestones: [
      { title: "Egyeztetés", dayOffset: 2, kind: "generic" },
      { title: "Fejlesztés kész", dayOffset: 14, kind: "generic" },
      { title: "Átadás", dayOffset: 18, kind: "generic" },
      { title: "Teljesítésigazolás", dayOffset: 20, kind: "certificate" },
    ],
  },
];

/** Due date for a milestone, from the project's start. Pure. */
export function milestoneDueAt(startedAt: Date, dayOffset: number): Date {
  const d = new Date(startedAt);
  d.setDate(d.getDate() + Math.max(0, Math.round(dayOffset)));
  // End of the working day rather than midnight: a milestone due "on the 14th"
  // is not overdue at 00:01 on the 14th.
  d.setHours(17, 0, 0, 0);
  return d;
}

/** Read a stored template's JSON without trusting its shape. */
export function parseMilestones(raw: unknown): TemplateMilestone[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplateMilestone[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = typeof row.title === "string" ? row.title.trim().slice(0, 200) : "";
    if (!title) continue;
    const dayOffset = Number.isFinite(Number(row.dayOffset))
      ? Math.max(0, Math.round(Number(row.dayOffset)))
      : 0;
    const kind = row.kind === "certificate" ? "certificate" : "generic";
    out.push({ title, dayOffset, kind });
  }
  return out;
}

/**
 * Progress as a fraction, and what is next.
 *
 * Pure so the board can be tested without a database — and because "next due"
 * is the one number an agency owner actually looks at on a project list.
 */
export function projectProgress(
  milestones: Array<{ title: string; dueAt: Date | null; doneAt: Date | null }>,
): {
  done: number;
  total: number;
  pct: number;
  next: { title: string; dueAt: Date | null } | null;
  overdue: number;
} {
  const total = milestones.length;
  const done = milestones.filter((m) => m.doneAt).length;
  const open = milestones.filter((m) => !m.doneAt);
  const now = Date.now();
  const overdue = open.filter((m) => m.dueAt && m.dueAt.getTime() < now).length;
  // The earliest open one with a date; a dateless milestone is not "next".
  const withDates = open.filter((m) => m.dueAt).sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime());
  const next = withDates[0] ?? open[0] ?? null;
  return {
    done,
    total,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
    next: next ? { title: next.title, dueAt: next.dueAt } : null,
    overdue,
  };
}
