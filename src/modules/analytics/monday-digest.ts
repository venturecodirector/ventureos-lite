import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import { getMailProvider } from "../mail/provider";
import { resolveSendingIdentity } from "../mail/identity";
import { callClaude } from "../../lib/ai/call-claude";
import {
  MONDAY_DIGEST_SYSTEM,
  mondayDigestSchema,
  buildMondayDigestMessage,
  type MondayDigestIntro,
} from "../../lib/ai/prompts/monday-digest";
import { collectDigestData } from "./digest-data";
import { buildDigestModel } from "./reports";

/**
 * Monday 07:30 per-user, per-workspace digest (spec §4.22). Each membership
 * gets one email built from ITS workspace's data (scoping enforced by the
 * guarded client) with one Haiku call for the intro. Returns emails sent.
 */
export async function processMondayDigests(nowMs: number = Date.now()): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({
    select: { id: true, mailgunConfig: true },
  });

  let sent = 0;
  for (const ws of workspaces) {
    const db = getWorkspaceClient(ws.id);
    const identity = resolveSendingIdentity(ws.mailgunConfig);
    const members = await prismaUnsafe.membership.findMany({
      where: { workspaceId: ws.id },
      include: { user: { select: { name: true, email: true } } },
    });

    for (const m of members) {
      const isOwner = m.role === "OWNER";
      // userId + role so the digest can carry this person's unread
      // notifications (P6/1) — the email channel is this line, not per-event mail.
      const input = await collectDigestData(db, {
        isOwner,
        nowMs,
        userId: m.userId,
        role: m.role,
        workspaceId: ws.id,
      });
      const model = buildDigestModel(input);

      let intro = "Here's your week at a glance.";
      try {
        const { data } = await callClaude<MondayDigestIntro>({
          useCase: "monday_digest",
          workspaceId: ws.id,
          system: MONDAY_DIGEST_SYSTEM,
          schema: mondayDigestSchema,
          messages: [{ role: "user", content: buildMondayDigestMessage(m.user.name ?? "there", model) }],
        });
        intro = (data as MondayDigestIntro).intro;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[digest] intro failed for ${m.user.email}`, e);
      }

      const rows = model.sections.map((s) => `<li><b>${s.label}:</b> ${s.value}</li>`).join("");
      const subject = "Venture OS — your Monday digest";
      const html = `<h2>${subject}</h2><p>${intro}</p><ul>${rows}</ul>`;
      const { id } = await getMailProvider().send({
        domain: identity.domain,
        to: m.user.email,
        from: identity.from,
        replyTo: identity.replyTo || undefined,
        subject,
        html,
      });
      await db.emailLog.create({
        data: { workspaceId: ws.id, to: m.user.email, subject, mailgunId: id, status: "QUEUED" },
      });
      sent += 1;
    }
  }
  return sent;
}
