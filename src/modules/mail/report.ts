import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import { getMailProvider } from "./provider";
import { resolveSendingIdentity } from "./identity";
import { getTopReferrers } from "../referrals/data";

function huf(n: number): string {
  return `${n.toLocaleString("en-US").replace(/,/g, " ")} Ft`;
}

/**
 * Friday report delivery path (spec §4.14/§4.11). The analytics content is
 * filled by the Analytics module later; this is the send path — one email per
 * workspace to its Owner(s), via the same transactional provider.
 */
export async function sendFridayReport(workspaceId: string): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  const [leads, meetings, topReferrers] = await Promise.all([
    db.lead.count(),
    db.meeting.count(),
    getTopReferrers(db, 3),
  ]);

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { mailgunConfig: true },
  });
  const identity = resolveSendingIdentity(ws?.mailgunConfig);

  const owners = await prismaUnsafe.membership.findMany({
    where: { workspaceId, role: "OWNER" },
    include: { user: { select: { email: true } } },
  });

  // Top referrers — the network as a measurable channel (spec §4.18).
  const referrersHtml = topReferrers.length
    ? `<h3>Top referrers</h3><ul>${topReferrers
        .map((r) => `<li>${r.name} — ${huf(r.attributedRevenue)} (${r.won}/${r.referred} won)</li>`)
        .join("")}</ul>`
    : "";
  const html =
    `<h2>Venture OS — Friday report</h2>` +
    `<p>${leads} leads · ${meetings} meetings so far. Full analytics land with the Reports module.</p>` +
    referrersHtml;
  for (const owner of owners) {
    const { id } = await getMailProvider().send({
      domain: identity.domain,
      to: owner.user.email,
      from: identity.from,
      replyTo: identity.replyTo || undefined,
      subject: "Venture OS — Friday report",
      html,
    });
    await db.emailLog.create({
      data: { workspaceId, to: owner.user.email, subject: "Friday report", mailgunId: id, status: "QUEUED" },
    });
  }
}

/** Cross-workspace system job (Friday cron). */
export async function processFridayReports(): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({ select: { id: true } });
  for (const w of workspaces) await sendFridayReport(w.id);
  return workspaces.length;
}
