import type { WorkspaceClient } from "@/lib/db";
import { getVerifier } from "./provider";
import { verifyAddress } from "./verify";
import { isStale, type VerifyResult, type VerifyStatus } from "./types";

/**
 * Verification against the database (playbook-v3 P9/2).
 *
 * The cache IS the point. A paid verifier charges per address; a DNS lookup is
 * free but not instant. An address checked six weeks ago for one campaign must
 * not be checked again for the next, so the verdict is stored on the lead with
 * its date and only re-taken when it has gone stale.
 */

export interface CachedVerification {
  status: VerifyStatus;
  reason: string;
  address: string | null;
  fromCache: boolean;
}

/** Verify one lead's address, reusing a fresh verdict if there is one. */
export async function verifyLead(
  db: WorkspaceClient,
  workspaceId: string,
  leadId: string,
  opts: { force?: boolean; now?: Date } = {},
): Promise<CachedVerification | null> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { email: true, emailStatus: true, emailReason: true, emailCheckedAt: true },
  });
  if (!lead) return null;

  if (
    !opts.force &&
    lead.emailStatus &&
    !isStale(lead.emailCheckedAt, opts.now)
  ) {
    return {
      status: lead.emailStatus as VerifyStatus,
      reason: lead.emailReason ?? "ok",
      address: lead.email,
      fromCache: true,
    };
  }

  const provider = await getVerifier(workspaceId);
  const result = await verifyAddress(lead.email, { provider, now: opts.now });
  await db.lead.update({
    where: { id: leadId },
    data: {
      emailStatus: result.status,
      emailReason: result.reason,
      emailCheckedAt: result.checkedAt,
    },
  });
  return { status: result.status, reason: result.reason, address: result.address, fromCache: false };
}

/**
 * Addresses verified in one server action before the rest goes to the worker.
 *
 * DNS-only checks run in tens of milliseconds, so a hundred is well inside a
 * request. A paid provider is nearer 300ms each, where a hundred is already
 * half a minute — hence the handover rather than a timeout.
 */
export const VERIFY_INLINE_MAX = 100;

/**
 * Minimum gap between calls to a paid verifier.
 *
 * The loop is sequential anyway, so this is not about concurrency — it is about
 * not arriving at a vendor's API as fast as a for-loop can go with a few
 * hundred addresses. Zero when no provider is configured: DNS resolvers are
 * ours to hammer and MX lookups are cached by the resolver.
 */
const PROVIDER_MIN_INTERVAL_MS = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AudienceBreakdown {
  total: number;
  valid: number;
  risky: number;
  invalid: number;
  unknown: number;
  suppressed: number;
  /** Risky addresses still waiting for a human to accept them, by name. */
  awaitingConfirmation: Array<{ id: string; email: string; reason: string }>;
  /** Invalid addresses excluded automatically. */
  excluded: Array<{ id: string; email: string; reason: string }>;
  providerName: string;
  estimatedCostUsd: number;
  /**
   * Recipients this pass did not reach, handed to the worker. NEVER silently:
   * the campaign cannot be armed while this is above zero, and the panel says
   * so — a cap the operator cannot see is a cap that reads as "all verified".
   */
  pending: number;
}

/**
 * Verify a whole campaign audience, and say what it found.
 *
 * Writes the verdict onto each recipient as a SNAPSHOT — what the campaign was
 * armed on is what an audit needs, even after the lead's address is re-verified
 * later. Invalid addresses are suppressed on the spot; risky ones are left for
 * the operator, one decision per address.
 */
export async function verifyAudience(
  db: WorkspaceClient,
  workspaceId: string,
  campaignId: string,
  opts: { force?: boolean; now?: Date; max?: number } = {},
): Promise<AudienceBreakdown> {
  const provider = await getVerifier(workspaceId);
  const recipients = await db.campaignRecipient.findMany({
    where: { campaignId },
    select: {
      id: true,
      email: true,
      leadId: true,
      suppressed: true,
      verifyStatus: true,
      verifyReason: true,
      riskAcceptedAt: true,
    },
  });

  const breakdown: AudienceBreakdown = {
    total: recipients.length,
    valid: 0,
    risky: 0,
    invalid: 0,
    unknown: 0,
    suppressed: 0,
    awaitingConfirmation: [],
    excluded: [],
    providerName: provider.name,
    estimatedCostUsd: 0,
    pending: 0,
  };

  // One verdict per DISTINCT address: a campaign can carry the same address on
  // two leads, and a paid verifier would charge for both.
  const seen = new Map<string, VerifyResult>();
  const limit = opts.max ?? VERIFY_INLINE_MAX;
  let checked = 0;
  let lastProviderCallAt = 0;

  for (const r of recipients) {
    if (r.suppressed) {
      breakdown.suppressed += 1;
      continue;
    }


    let result = seen.get(r.email);
    if (!result) {
      // The lead's own cached verdict counts, when it is fresh.
      const cached = r.leadId
        ? await db.lead.findUnique({
            where: { id: r.leadId },
            select: { emailStatus: true, emailReason: true, emailCheckedAt: true, email: true },
          })
        : null;

      const usable =
        !opts.force &&
        cached?.emailStatus &&
        cached.email === r.email &&
        !isStale(cached.emailCheckedAt, opts.now);

      /**
       * The budget applies to FRESH checks only.
       *
       * Counting a cached verdict against it was a real bug: the recipients
       * come back in no particular order, so a second pass could spend its
       * whole allowance re-serving addresses it already knew and report the
       * ones it had actually just verified as still pending — a backlog that
       * never cleared. A cached answer costs nothing and is always served.
       */
      if (!usable && checked >= limit) {
        breakdown.pending += 1;
        continue;
      }

      if (usable) {
        result = {
          status: cached!.emailStatus as VerifyStatus,
          reason: (cached!.emailReason ?? "ok") as VerifyResult["reason"],
          address: r.email,
          checkedAt: cached!.emailCheckedAt!,
        };
      } else {
        if (provider.name !== "none") {
          const wait = PROVIDER_MIN_INTERVAL_MS - (Date.now() - lastProviderCallAt);
          if (wait > 0) await sleep(wait);
          lastProviderCallAt = Date.now();
        }
        result = await verifyAddress(r.email, { provider, now: opts.now });
        checked += 1;
        breakdown.estimatedCostUsd += provider.costPerCheckUsd;
        if (r.leadId) {
          await db.lead.update({
            where: { id: r.leadId },
            data: {
              emailStatus: result.status,
              emailReason: result.reason,
              emailCheckedAt: result.checkedAt,
            },
          });
        }
      }
      seen.set(r.email, result);
    }

    breakdown[result.status] += 1;

    await db.campaignRecipient.update({
      where: { id: r.id },
      data: {
        verifyStatus: result.status,
        verifyReason: result.reason,
        // An invalid address is excluded here and now: nothing downstream needs
        // to remember to check, and the send loop already skips suppressed.
        ...(result.status === "invalid" ? { suppressed: true } : {}),
      },
    });

    if (result.status === "invalid") {
      breakdown.excluded.push({ id: r.id, email: r.email, reason: result.reason });
    } else if (result.status === "risky" && !r.riskAcceptedAt) {
      breakdown.awaitingConfirmation.push({ id: r.id, email: r.email, reason: result.reason });
    }
  }

  return breakdown;
}
