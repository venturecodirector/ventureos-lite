/**
 * Customer health (playbook-v3 P11/1c). Pure, deterministic, no AI.
 *
 * Four inputs, all of them already in the system: how late the client is
 * paying (from the Számlázz.hu poll), how long since anyone touched them, an
 * open support flag someone set by hand, and how long they have been a client.
 *
 * Every red carries a REASON. A traffic light with no explanation is a number
 * people learn to ignore, and the point of the list is that someone picks up
 * the phone — which needs to know what to say.
 */

export type HealthLevel = "green" | "amber" | "red";

export interface HealthRules {
  /** Days past due before a client is amber / red on payment. */
  paymentLateAmberDays: number;
  paymentLateRedDays: number;
  /** Months of silence before a client is amber / red. */
  quietAmberMonths: number;
  quietRedMonths: number;
  /**
   * Under this many months, a client is still new — and silence from a new
   * client means something worse than silence from an established one.
   */
  youngClientMonths: number;
}

export const DEFAULT_HEALTH_RULES: HealthRules = {
  paymentLateAmberDays: 15,
  paymentLateRedDays: 30,
  quietAmberMonths: 2,
  quietRedMonths: 3,
  youngClientMonths: 4,
};

export interface HealthInputs {
  companyName: string;
  /** Days the oldest unpaid issued invoice is past due. 0 when all is settled. */
  daysPaymentLate: number;
  monthsSinceTouchpoint: number;
  supportFlag: boolean;
  /** Months since this client's oldest live subscription started. */
  subscriptionAgeMonths: number;
}

export interface HealthResult {
  level: HealthLevel;
  reasons: string[];
}

const ORDER: Record<HealthLevel, number> = { green: 0, amber: 1, red: 2 };

function worst(a: HealthLevel, b: HealthLevel): HealthLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/**
 * Read the rules out of workspace settings, falling back per FIELD.
 *
 * A value that is not a positive number is ignored rather than accepted: a
 * threshold of zero would paint every client red for ever, which is the same as
 * having no health scoring at all but harder to notice.
 */
export function healthRulesFrom(raw: unknown): HealthRules {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (key: keyof HealthRules): number => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_HEALTH_RULES[key];
  };
  const rules: HealthRules = {
    paymentLateAmberDays: num("paymentLateAmberDays"),
    paymentLateRedDays: num("paymentLateRedDays"),
    quietAmberMonths: num("quietAmberMonths"),
    quietRedMonths: num("quietRedMonths"),
    youngClientMonths: num("youngClientMonths"),
  };
  // A red threshold below its amber one is incoherent: everything past amber
  // would be red and the middle band would silently disappear.
  rules.paymentLateRedDays = Math.max(rules.paymentLateRedDays, rules.paymentLateAmberDays);
  rules.quietRedMonths = Math.max(rules.quietRedMonths, rules.quietAmberMonths);
  return rules;
}

export function scoreClientHealth(input: HealthInputs, rules: HealthRules): HealthResult {
  let level: HealthLevel = "green";
  const reasons: string[] = [];

  if (input.daysPaymentLate >= rules.paymentLateAmberDays) {
    const red = input.daysPaymentLate >= rules.paymentLateRedDays;
    level = worst(level, red ? "red" : "amber");
    reasons.push(`Invoice ${input.daysPaymentLate} days past due`);
  }

  if (input.monthsSinceTouchpoint >= rules.quietAmberMonths) {
    const isYoung = input.subscriptionAgeMonths < rules.youngClientMonths;
    // Escalated for a new client: a client three months in who has gone quiet
    // is in trouble, while the same silence from a two-year client is a quiet
    // quarter. This is the only place subscription age is used, and it is used
    // to sharpen another signal rather than to raise one of its own — nobody
    // needs an alert that says "this client is new".
    const red = input.monthsSinceTouchpoint >= rules.quietRedMonths || isYoung;
    level = worst(level, red ? "red" : "amber");
    reasons.push(
      isYoung
        ? `No contact for ${input.monthsSinceTouchpoint} months — and still a new client`
        : `No contact for ${input.monthsSinceTouchpoint} months`,
    );
  }

  if (input.supportFlag) {
    level = worst(level, "amber");
    reasons.push("Support flag is open");
  }

  return { level, reasons };
}

export interface SuggestedTask {
  title: string;
  note: string;
}

/**
 * The task offered beside a red client.
 *
 * Reds only. An amber is a thing to watch; a task for every amber would bury
 * the Today Queue in work nobody asked for, and the queue is the one list that
 * has to stay believable.
 */
export function suggestedTaskFor(
  input: HealthInputs,
  health: HealthResult,
): SuggestedTask | null {
  if (health.level !== "red") return null;
  return {
    title: `Check in with ${input.companyName}`,
    note: health.reasons.join(". ") + ".",
  };
}
