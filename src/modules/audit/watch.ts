/**
 * Audit watches (P2/5) — the rules, without the database.
 *
 * A watch is a standing instruction to re-audit a company's site every N days.
 * The cap and the load projection live here because "how much work am I
 * signing up for" is the question that decides whether this feature is safe to
 * leave on: 200 watched companies at 30 days is 47 audits a week, and each one
 * costs a browser, a PageSpeed call and 30 seconds of worker.
 */
export const WATCH_FREQUENCIES = [30, 90, 180] as const;
export type WatchFrequency = (typeof WATCH_FREQUENCIES)[number];

/** Default ceiling on live watches per workspace; Owner-configurable. */
export const DEFAULT_MAX_WATCHES = 50;

export function isWatchFrequency(v: unknown): v is WatchFrequency {
  return typeof v === "number" && (WATCH_FREQUENCIES as readonly number[]).includes(v);
}

/** Read the cap from Workspace.auditConfig, falling back to the default. */
export function maxWatchesFrom(config: unknown): number {
  if (config && typeof config === "object" && "maxWatches" in config) {
    const v = (config as { maxWatches?: unknown }).maxWatches;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  }
  return DEFAULT_MAX_WATCHES;
}

/**
 * Audits per week the current watch list implies.
 *
 * Rounded up, because a projection that rounds down is the one that surprises
 * you. Shown in Settings beside the cap.
 */
export function projectedWeeklyLoad(watches: Array<{ frequencyDays: number; enabled: boolean }>): number {
  const perWeek = watches
    .filter((w) => w.enabled && w.frequencyDays > 0)
    .reduce((sum, w) => sum + 7 / w.frequencyDays, 0);
  return Math.ceil(perWeek);
}

/**
 * Refusing a watch past the cap.
 *
 * A class, so a caller can tell "you are over your limit" apart from "this
 * company has no website" — and it lives here rather than beside the action
 * because a "use server" module may only export async functions.
 */
export class WatchLimitReached extends Error {
  constructor(max: number) {
    super(`This workspace already watches ${max} companies — the configured maximum.`);
    this.name = "WatchLimitReached";
  }
}

export function nextRunFrom(now: Date, frequencyDays: number): Date {
  return new Date(now.getTime() + frequencyDays * 86_400_000);
}

/**
 * Which stages get watched automatically.
 *
 * A lead we are actively working is worth knowing about; a lead we have not
 * qualified is noise, and watching every prospect in the database is how you
 * turn a useful signal into a background hum nobody reads.
 */
export const AUTO_WATCH_STAGES = ["QUALIFIED", "MEETING_BOOKED", "HANDED_OFF"] as const;

export function shouldAutoWatch(stage: string): boolean {
  return (AUTO_WATCH_STAGES as readonly string[]).includes(stage);
}
