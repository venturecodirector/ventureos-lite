/**
 * The recurring book's lifecycle (playbook-v3 P11/1a).
 *
 * Pure. Every change to a subscription has to become an APPEND-ONLY event
 * carrying a SIGNED MRR delta, because the movement chart sums those deltas
 * rather than reconstructing history from the current state. Reconstruction
 * cannot distinguish "raised from 100k to 150k in March" from "started at 150k
 * in March", and it loses anything that happened and was later undone.
 *
 * The property everything else leans on: sum(deltaNet) over a subscription's
 * whole life equals the MRR it currently contributes.
 */

export const SUBSCRIPTION_SOURCES = ["ventstudio", "hosting", "retainer", "other"] as const;
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCES)[number];

/**
 * The churn taxonomy. A closed list rather than free text so the breakdown on
 * the Revenue tab is countable — "too expensive" and "price" as separate rows
 * would tell nobody anything.
 */
export const CHURN_REASONS = [
  "price",
  "budget_cut",
  "in_house",
  "competitor",
  "project_ended",
  "unhappy",
  "went_quiet",
  "other",
] as const;
export type ChurnReason = (typeof CHURN_REASONS)[number];

export const SUBSCRIPTION_STATUSES = ["ACTIVE", "PAUSED", "CHURNED"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** The event kinds the movement chart splits by. */
export const EVENT_KINDS = [
  "new",
  "expansion",
  "contraction",
  "churn",
  "reactivation",
  "pause",
  "resume",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface SubscriptionState {
  monthlyNet: number;
  status: SubscriptionStatus;
}

export interface LifecycleEvent {
  kind: EventKind;
  /** Signed change to MRR, in integer forints. */
  deltaNet: number;
  /** What this subscription contributes after the change. */
  monthlyNetAfter: number;
}

export function isSubscriptionSource(v: unknown): v is SubscriptionSource {
  return typeof v === "string" && (SUBSCRIPTION_SOURCES as readonly string[]).includes(v);
}

export function isChurnReason(v: unknown): v is ChurnReason {
  return typeof v === "string" && (CHURN_REASONS as readonly string[]).includes(v);
}

/** `2026-08`. UTC, so a late-evening change does not land in the wrong month. */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Distance in CALENDAR months, signed. January to February is 1 whatever the
 * days are.
 *
 * Deliberately calendar distance rather than elapsed anniversaries, because
 * that is what "12 months counted from the first payment" means to the person
 * who wrote the contract: a window opened by a payment on 10 January covers
 * January through December, and a payment on 5 December is inside it. Counting
 * anniversaries instead would call that December payment month 11 and quietly
 * grant a thirteenth month at the far end.
 */
export function monthsBetween(from: Date, to: Date): number {
  const years = to.getUTCFullYear() - from.getUTCFullYear();
  const months = to.getUTCMonth() - from.getUTCMonth();
  return years * 12 + months;
}

/** Does this subscription currently contribute to MRR? */
function contributes(state: SubscriptionState): boolean {
  return state.status === "ACTIVE";
}

/**
 * Re-pricing an active subscription. Null when nothing moved — a zero-delta
 * row in an append-only log claims something happened when nothing did.
 */
export function eventForAmountChange(
  state: SubscriptionState,
  nextMonthlyNet: number,
): LifecycleEvent | null {
  // A paused or churned subscription contributes nothing, so re-pricing it
  // cannot move the chart. The new amount takes effect if it is ever resumed.
  if (!contributes(state)) return null;
  const delta = nextMonthlyNet - state.monthlyNet;
  if (delta === 0) return null;
  return {
    kind: delta > 0 ? "expansion" : "contraction",
    deltaNet: delta,
    monthlyNetAfter: nextMonthlyNet,
  };
}

export function eventForStatusChange(
  state: SubscriptionState,
  next: SubscriptionStatus,
): LifecycleEvent | null {
  if (state.status === next) return null;

  const was = contributes(state) ? state.monthlyNet : 0;
  const now = next === "ACTIVE" ? state.monthlyNet : 0;

  const kind: EventKind =
    next === "CHURNED"
      ? "churn"
      : next === "PAUSED"
        ? "pause"
        : state.status === "CHURNED"
          ? "reactivation"
          : "resume";

  // The delta can legitimately be zero here — churning something already
  // paused, for instance. The MRR left when it paused, and subtracting it again
  // would put a second churn on the chart for money that had already gone. The
  // EVENT still belongs in the log: the status genuinely changed.
  return { kind, deltaNet: now - was, monthlyNetAfter: now };
}
