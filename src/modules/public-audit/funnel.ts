import type { WorkspaceClient } from "@/lib/db";

/**
 * The self-serve funnel (playbook-v4 P12/1d).
 *
 * visits → audits run → emails captured → consented.
 *
 * Three of the four were already in the database from the day P12 shipped, and
 * the first was not — so every conversion rate on this page was unmeasurable,
 * including the only one that decides whether the whole inbound idea works:
 * how many arrivals turn into an address we are allowed to write to.
 *
 * Pure counting. No sampling, no estimates, no AI.
 */
export interface AuditFunnel {
  /** Distinct reading sessions on the landing, in the window. */
  visits: number;
  /** Submissions that were accepted and actually ran. */
  auditsRun: number;
  /** Submissions refused by the guard — rate limit, bot, own/client domain. */
  blocked: number;
  /** People who asked for the full report, i.e. gave an address. */
  emailsCaptured: number;
  /** …of whom these also ticked the separate marketing box. */
  consented: number;
}

export interface AuditFunnelRates {
  /** visits → audits run. */
  runRate: number | null;
  /** audits run → address given. */
  captureRate: number | null;
  /** address given → marketing consent. */
  consentRate: number | null;
}

export async function collectAuditFunnel(
  db: WorkspaceClient,
  since: Date,
  until: Date,
): Promise<AuditFunnel> {
  const window = { gte: since, lt: until };
  const [visits, auditsRun, blocked, emailsCaptured, consented] = await Promise.all([
    db.pageVisit.count({ where: { pageType: "audit_landing", startedAt: window } }),
    db.publicAudit.count({
      where: { createdAt: window, status: { in: ["queued", "running", "done"] } },
    }),
    db.publicAudit.count({ where: { createdAt: window, status: "blocked" } }),
    db.publicAuditConsent.count({ where: { createdAt: window } }),
    db.publicAuditConsent.count({ where: { createdAt: window, marketingConsent: true } }),
  ]);
  return { visits, auditsRun, blocked, emailsCaptured, consented };
}

/**
 * Rates, with null where the denominator is zero.
 *
 * Null rather than 0: "nobody visited" and "everybody who visited bounced" are
 * different facts, and a report that prints 0% for the first one is lying in a
 * way that reads as a problem to fix.
 */
export function auditFunnelRates(f: AuditFunnel): AuditFunnelRates {
  const rate = (num: number, den: number) => (den > 0 ? num / den : null);
  return {
    runRate: rate(f.auditsRun, f.visits),
    captureRate: rate(f.emailsCaptured, f.auditsRun),
    consentRate: rate(f.consented, f.emailsCaptured),
  };
}
