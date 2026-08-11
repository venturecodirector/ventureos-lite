/**
 * Qualification checklist (spec §4.7). Four items; "Qualified" unlocks at 3 of 4
 * answered — enforced server-side, not just the UI.
 */
export const QUAL_ITEMS = ["authority", "history", "budget", "timeline"] as const;
export type QualItem = (typeof QUAL_ITEMS)[number];
export type Qualification = Record<QualItem, boolean>;

export const EMPTY_QUALIFICATION: Qualification = {
  authority: false,
  history: false,
  budget: false,
  timeline: false,
};

export const QUALIFY_THRESHOLD = 3;

export const QUAL_LABEL: Record<QualItem, string> = {
  authority: "Authority — decision-maker",
  history: "History — prior vendor",
  budget: "Budget",
  timeline: "Timeline",
};

/** Qualification questions — the set suggestions are drawn from (Hungarian). */
export const QUAL_QUESTIONS: Record<QualItem, string> = {
  authority:
    "Te hozod meg a döntést a weboldal-fejlesztésről, vagy van más döntéshozó is a folyamatban?",
  history: "Dolgoztatok már korábban ügynökséggel hasonló projekten?",
  budget: "Van már erre az évre elkülönített keretetek erre a fejlesztésre?",
  timeline: "Mikorra szeretnétek élesíteni a projektet?",
};

export function answeredCount(q?: Partial<Qualification> | null): number {
  if (!q) return 0;
  return QUAL_ITEMS.reduce((n, k) => n + (q[k] ? 1 : 0), 0);
}

export function canQualify(q?: Partial<Qualification> | null): boolean {
  return answeredCount(q) >= QUALIFY_THRESHOLD;
}
