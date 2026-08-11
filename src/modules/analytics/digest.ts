import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import { getMailProvider } from "../mail/provider";
import { resolveSendingIdentity } from "../mail/identity";
import { callClaude } from "../../lib/ai/call-claude";
import {
  WINLOSS_DIGEST_SYSTEM,
  winlossDigestSchema,
  buildDigestMessage,
  type WinLossDigest,
} from "../../lib/ai/prompts/winloss-digest";
import { getOutcomeFacts } from "./data";
import { buildWhatCloses } from "./aggregate";

/** Start-of-quarter (UTC) containing `ms`. */
function quarterStart(ms: number): number {
  const d = new Date(ms);
  const qMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  return Date.UTC(d.getUTCFullYear(), qMonth, 1);
}

function prevQuarterRange(nowMs: number): { sinceMs: number; untilMs: number; label: string } {
  const thisQ = quarterStart(nowMs);
  const sinceMs = quarterStart(thisQ - 1); // start of the quarter before this one
  const d = new Date(sinceMs);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return { sinceMs, untilMs: thisQ, label: `Q${q} ${d.getUTCFullYear()}` };
}

function renderHtml(label: string, digest: WinLossDigest | null, totalsLine: string): string {
  if (!digest) {
    return `<h2>Venture OS — ${label} win/loss digest</h2><p>${totalsLine}</p>`;
  }
  const works = digest.whatWorks.map((s) => `<li>${s}</li>`).join("");
  const drags = digest.whatDrags.map((s) => `<li>${s}</li>`).join("");
  return (
    `<h2>Venture OS — ${label} win/loss digest</h2>` +
    `<p><b>${digest.headline}</b></p>` +
    `<p>${totalsLine}</p>` +
    `<h3>What works</h3><ul>${works}</ul>` +
    (drags ? `<h3>What drags</h3><ul>${drags}</ul>` : "") +
    `<p><b>Next quarter:</b> ${digest.recommendation}</p>`
  );
}

/**
 * Quarterly win/loss digest (spec §4.20). One email per workspace to its
 * Owner(s), summarising the just-ended quarter. Haiku, aggregates only — no
 * lead-level data leaves the DB. Returns the number of workspaces mailed.
 */
export async function processQuarterlyWinLoss(nowMs: number = Date.now()): Promise<number> {
  const { sinceMs, untilMs, label } = prevQuarterRange(nowMs);
  const workspaces = await prismaUnsafe.workspace.findMany({ select: { id: true, mailgunConfig: true } });

  let sent = 0;
  for (const ws of workspaces) {
    const db = getWorkspaceClient(ws.id);
    const { facts, totals } = await getOutcomeFacts(db, { sinceMs, untilMs });
    if (totals.deals === 0) continue; // nothing closed this quarter

    const whatCloses = buildWhatCloses(facts);
    const totalsLine =
      `${totals.deals} deals — ${totals.won} won, ${totals.lost} lost, ${totals.postponed} postponed. ` +
      `Revenue ${totals.revenue.toLocaleString("en-US")} HUF.`;

    let digest: WinLossDigest | null = null;
    try {
      const { data } = await callClaude<WinLossDigest>({
        useCase: "winloss_digest",
        workspaceId: ws.id,
        system: WINLOSS_DIGEST_SYSTEM,
        schema: winlossDigestSchema,
        messages: [{ role: "user", content: buildDigestMessage(totals, whatCloses) }],
      });
      digest = data as WinLossDigest;
    } catch (e) {
      // Budget/AI failure — still send the numeric digest.
      // eslint-disable-next-line no-console
      console.error(`[digest] win/loss AI failed for ${ws.id}`, e);
    }

    const identity = resolveSendingIdentity(ws.mailgunConfig);
    const owners = await prismaUnsafe.membership.findMany({
      where: { workspaceId: ws.id, role: "OWNER" },
      include: { user: { select: { email: true } } },
    });
    const html = renderHtml(label, digest, totalsLine);
    const subject = `Venture OS — ${label} win/loss digest`;
    for (const owner of owners) {
      const { id } = await getMailProvider().send({
        domain: identity.domain,
        to: owner.user.email,
        from: identity.from,
        replyTo: identity.replyTo || undefined,
        subject,
        html,
      });
      await db.emailLog.create({
        data: { workspaceId: ws.id, to: owner.user.email, subject, mailgunId: id, status: "QUEUED" },
      });
    }
    sent += 1;
  }
  return sent;
}
