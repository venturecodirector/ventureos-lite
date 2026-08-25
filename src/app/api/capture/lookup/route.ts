import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { takeRateLimit } from "@/lib/rate-limit";
import { RATE_LIMITS, tooManyRequests } from "@/lib/rate-limit-policy";
import { resolveCaptureToken } from "@/modules/capture/tokens";
import { STAGE_LABELS } from "@/modules/pipeline/transitions";

/**
 * "Do we already know this person?" — asked by the extension's on-profile panel.
 *
 * The single highest-value thing the panel can say is DUPLICATE PROTECTION: a BDR
 * about to write to someone a colleague messaged last week needs to know before
 * they type, not after. So the shape of this response is built around that: the
 * contacted history is not a footnote, it is the thing that gets a warning.
 *
 * READ-ONLY, and cheap. It runs automatically on every profile page the operator
 * opens, which makes it the highest-frequency endpoint in the product — so it
 * takes one indexed lookup on `linkedinUrl`, adds two small reads only when there
 * is a hit, and never writes anything. Nothing here may grow a side effect: an
 * endpoint that fires on page view must not create, log or enqueue.
 */
export const dynamic = "force-dynamic";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** The same canonicalisation the capture uses, so a lookup and a save agree. */
function canonicalProfileUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    const m = /^\/in\/([^/]+)/.exec(u.pathname);
    if (!m) return null;
    return `https://www.linkedin.com/in/${decodeURIComponent(m[1]!).toLowerCase()}`;
  } catch {
    return null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(req: Request): Promise<Response> {
  const identity = await resolveCaptureToken(req.headers.get("authorization"));
  if (!identity) return json({ error: "unauthorized" }, 401);

  // Its own bucket, and a generous one: this fires on page view, so it must not
  // consume the capture budget a deliberate save depends on.
  const rate = await takeRateLimit(
    `${RATE_LIMITS.capture.bucket}:lookup:${identity.tokenId}`,
    { windowMs: 60_000, max: 120 },
  );
  if (!rate.allowed) return tooManyRequests(rate.resetAtMs, "Too many lookups.");

  const raw = new URL(req.url).searchParams.get("url") ?? "";
  const url = canonicalProfileUrl(raw);
  if (!url) return json({ error: "not_a_profile_url" }, 400);

  const db = getWorkspaceClient(identity.workspaceId);

  // Tenant-guarded: a lead in another workspace does not exist, it is not hidden.
  const lead = await db.lead.findFirst({
    where: { linkedinUrl: url },
    select: {
      id: true,
      contactName: true,
      title: true,
      stage: true,
      stageEnteredAt: true,
      icpScore: true,
      ownerId: true,
      companyId: true,
      company: { select: { name: true } },
    },
  });

  if (!lead) return json({ known: false }, 200);

  // Only now, and only two reads. The panel shows these; nothing else needs them.
  const [sent, audit] = await Promise.all([
    db.message.findMany({
      where: { leadId: lead.id, sentAt: { not: null } },
      // No sender column exists on Message — only the Activity log records who
      // acted. Rather than invent an attribution, the warning reports WHEN and on
      // WHICH channel, and the responsible person is the lead's owner, shown
      // separately. "Someone already wrote to them, 6 days ago, on LinkedIn" is
      // the fact that changes the operator's next move; the name does not.
      select: { sentAt: true, channel: true },
      orderBy: { sentAt: "desc" },
      take: 5,
    }),
    lead.companyId
      ? db.auditResult.findFirst({
          where: { companyId: lead.companyId, status: "done" },
          select: { score: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve(null),
  ]);

  /**
   * Owner and senders are GLOBAL rows.
   *
   * Read through `prismaUnsafe` and filtered to this workspace explicitly: the
   * tenant guard passes memberships through untouched, so the guarded client
   * added nothing here — and under row-level security it would return nothing
   * at all, because the membership policy is keyed on a user variable that the
   * workspace-scoped connection deliberately does not set.
   */
  const userIds = [...new Set([lead.ownerId].filter(Boolean))];
  const members = userIds.length
    ? await prismaUnsafe.membership.findMany({
        where: { workspaceId: identity.workspaceId, userId: { in: userIds as string[] } },
        select: { userId: true, user: { select: { name: true } } },
      })
    : [];
  const nameOf = (id: string | null) =>
    id ? (members.find((m) => m.userId === id)?.user.name ?? null) : null;

  const lastSent = sent[0]?.sentAt ?? null;

  return json(
    {
      known: true,
      leadId: lead.id,
      contactName: lead.contactName,
      title: lead.title,
      company: lead.company?.name ?? null,
      stage: lead.stage,
      stageLabel: STAGE_LABELS[lead.stage] ?? lead.stage,
      owner: nameOf(lead.ownerId),
      icpScore: lead.icpScore,
      // Days since the stage last moved — the closest thing to "last touch" that
      // does not require another table.
      daysSinceTouch: Math.floor((Date.now() - lead.stageEnteredAt.getTime()) / DAY_MS),
      auditScore: audit?.score ?? null,
      auditAt: audit?.createdAt?.toISOString() ?? null,
      /**
       * The warning. Someone has already written to this person — which is the
       * one fact that changes what the operator does next, so it is reported
       * with who and when rather than as a boolean.
       */
      contacted:
        sent.length > 0
          ? {
              count: sent.length,
              lastAt: lastSent?.toISOString() ?? null,
              daysAgo: lastSent ? Math.floor((Date.now() - lastSent.getTime()) / DAY_MS) : null,
              // The lead's owner, not a per-message sender — see the select above.
              ownedBy: nameOf(lead.ownerId),
              channel: sent[0]?.channel ?? null,
            }
          : null,
    },
    200,
  );
}
