/**
 * Asking for a referral, at the moment it is easy to say yes (playbook-v4 P13/3).
 *
 * ── TIMING IS THE FEATURE ──────────────────────────────────────────────────
 *
 * Fourteen days after a client confirms the work is finished is the
 * satisfaction peak: the result is visible, the invoice is not yet a memory,
 * and the person still remembers who did it. A month later the identical
 * message reads as a favour being extracted. Most agencies never send it at
 * all — not because they decided against it, but because the moment passed
 * while they were busy.
 *
 * ── AND IT IS STILL ONLY A DRAFT ───────────────────────────────────────────
 *
 * The job writes and reminds. A person reads, edits and sends. Nothing here
 * goes out on its own (CLAUDE.md hard rule #2), and nothing here calls Claude —
 * the ask is a template with the client's own project in it, and a model would
 * add a chance of inventing a detail about work we did.
 */
export const REFERRAL_DELAY_DAYS = 14;

/** One ask per client per six months, however many jobs they give us. */
export const REFERRAL_COOLDOWN_DAYS = 182;

export interface ReferralDraftInput {
  contactName: string | null;
  companyName: string | null;
  /** What the certificate says was delivered. */
  scope: string | null;
  industry: string | null;
}

export interface ReferralDraft {
  subject: string;
  body: string;
}

/**
 * A concrete ask beats a general one.
 *
 * "Ismer valakit?" is a question people answer with "majd szólok". Naming the
 * industry and the problem we solved gives them a specific person to picture,
 * which is the difference between a polite nothing and an introduction.
 */
export function buildReferralDraft(input: ReferralDraftInput): ReferralDraft {
  const name = input.contactName?.split(" ").pop() ?? null;
  const greeting = name ? `Kedves ${name},` : "Kedves Partnerünk,";
  const work = input.scope?.trim()
    ? input.scope.trim().replace(/\s+/g, " ").slice(0, 160)
    : "a közös munkánk";
  const who = input.industry?.trim()
    ? `egy másik ${input.industry.trim().toLowerCase()} vállalkozást`
    : "egy hasonló vállalkozást";

  return {
    subject: "Egy kérés — ismer valakit, akinek ez most jól jönne?",
    body:
      `${greeting}\n\n` +
      `Két hete zártuk le nálatok ezt: ${work}. Remélem, azóta is jól működik — ` +
      `ha bármi felmerült, szólj nyugodtan.\n\n` +
      `Egy kérésem lenne. Ha ismersz ${who}, akinek ugyanez a probléma ismerős, ` +
      `megköszönném, ha összekötnél minket. Egy rövid bemutatkozó levél is elég — ` +
      `a többit elintézzük.\n\n` +
      `Ha most nincs ilyen, az is teljesen rendben van.`,
  };
}

/** True when this client may be asked again. */
export function cooldownPassed(lastAskedAt: Date | null, now: Date = new Date()): boolean {
  if (!lastAskedAt) return true;
  return now.getTime() - lastAskedAt.getTime() >= REFERRAL_COOLDOWN_DAYS * 86_400_000;
}

/** True when enough time has passed since the client confirmed the work. */
export function ripe(acknowledgedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - acknowledgedAt.getTime() >= REFERRAL_DELAY_DAYS * 86_400_000;
}

export interface ReferralConversion {
  requested: number;
  responded: number;
  produced: number;
  /** Share of asks that produced a referral. Null below a usable sample. */
  rate: number | null;
}

const MIN_SAMPLE = 5;

export function conversion(
  statuses: Array<{ status: string }>,
): ReferralConversion {
  const requested = statuses.length;
  const responded = statuses.filter((s) => s.status === "responded" || s.status === "produced").length;
  const produced = statuses.filter((s) => s.status === "produced").length;
  return {
    requested,
    responded,
    produced,
    // A rate from three asks is noise wearing a percentage sign.
    rate: requested >= MIN_SAMPLE ? produced / requested : null,
  };
}
