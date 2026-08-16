import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspaceClient, prismaUnsafe } from "../../lib/db";
import { appLink } from "../../lib/public-links";
import { renderHtmlToPdf } from "../../lib/pdf";
import { callClaude } from "../../lib/ai/call-claude";
import {
  MEETING_BRIEF_SYSTEM,
  meetingBriefSchema,
  buildBriefMessage,
  briefToText,
  type MeetingBrief,
} from "../../lib/ai/prompts/meeting-brief";
import { buildBriefPdfHtml } from "./brief-pdf";
import { getCalendarProvider } from "./calendar";
import { getWriteAccount, saveRefreshedTokens } from "./credentials";
import type { BriefJobData } from "./enqueue";
import { brandFrom } from "@/modules/workspaces/brand";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

function summariseAudit(audit: {
  score: number;
  verdict: string;
  flags: unknown;
  pitchSummary: string | null;
} | null): string {
  if (!audit) return "";
  const flags = Array.isArray(audit.flags) ? (audit.flags as string[]) : [];
  return [
    `Score ${audit.score}/100 (${audit.verdict}).`,
    flags.length ? `Flags: ${flags.join(", ")}.` : "",
    audit.pitchSummary ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Worker: generate the meeting brief with ONE Sonnet call, render its branded
 * PDF, and attach a note to the calendar event.
 *
 * Idempotency (spec §4.8): a DB-level atomic claim flips brief_status
 * none -> generating in a single updateMany; if it claims 0 rows another run
 * already owns this booking, so we return without calling Claude. This is what
 * bounds the ONE permitted non-manual Claude trigger to one call per booking.
 */
export async function processMeetingBrief(data: BriefJobData): Promise<void> {
  const db = getWorkspaceClient(data.workspaceId);

  const claim = await db.meeting.updateMany({
    where: { id: data.meetingId, briefStatus: "none" },
    data: { briefStatus: "generating" },
  });
  if (claim.count === 0) return; // already generating / done — do not re-call Claude

  try {
    const meeting = await db.meeting.findUnique({
      where: { id: data.meetingId },
      include: { lead: { include: { company: true } } },
    });
    if (!meeting) return;

    const lead = meeting.lead;
    const company = lead?.company ?? null;

    const audit = company
      ? await db.auditResult.findFirst({
          where: { companyId: company.id, status: "done" },
          orderBy: { createdAt: "desc" },
          select: { score: true, verdict: true, flags: true, pitchSummary: true },
        })
      : null;

    const messages = lead
      ? await db.message.findMany({
          where: { leadId: lead.id },
          orderBy: { createdAt: "asc" },
          select: { direction: true, body: true },
        })
      : [];
    const conversation = messages
      .map((m) => `${m.direction === "OUTBOUND" ? "US" : "THEM"}: ${m.body}`)
      .join("\n");

    const companyMeta = [company?.industry, company?.sizeBand, company?.city, company?.website]
      .filter(Boolean)
      .join(" · ");
    const contactMeta = [lead?.title, lead?.linkedinUrl].filter(Boolean).join(" · ");

    const { data: result } = await callClaude<MeetingBrief>({
      useCase: "meeting_brief",
      workspaceId: data.workspaceId,
      system: MEETING_BRIEF_SYSTEM,
      schema: meetingBriefSchema,
      messages: [
        {
          role: "user",
          content: buildBriefMessage({
            companyName: company?.name ?? lead?.contactName ?? "the prospect",
            companyMeta,
            contactName: lead?.contactName ?? "",
            contactMeta,
            auditSummary: summariseAudit(audit),
            conversation,
          }),
        },
      ],
    });
    const brief = result as MeetingBrief;

    // Render branded PDF via the shared pipeline — per workspace (item 6).
    const brandRow = await prismaUnsafe.workspace.findUnique({
      where: { id: data.workspaceId },
      select: { brand: true },
    });
    const whenLabel = meeting.scheduledAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const html = buildBriefPdfHtml(
      {
        companyName: company?.name ?? lead?.contactName ?? "Prospect",
        contactName: lead?.contactName ?? "",
        whenLabel,
      },
      brief,
      brandFrom(brandRow?.brand),
    );
    const pdf = await renderHtmlToPdf(html);
    const rel = `briefs/${data.meetingId}.pdf`;
    await mkdir(join(FILES_DIR, "briefs"), { recursive: true });
    await writeFile(join(FILES_DIR, rel), pdf);

    await db.meeting.update({
      where: { id: data.meetingId },
      data: { brief: briefToText(brief), briefPdfPath: rel, briefStatus: "done" },
    });

    // Best-effort: attach the discovery questions to the host's calendar event.
    if (meeting.googleEventId && meeting.hostUserId) {
      try {
        // The event lives on the write calendar, so update it there.
        const acct = await getWriteAccount(meeting.hostUserId);
        if (acct) {
          const note =
            `Venture meeting brief\n\n${briefToText(brief)}\n\n` +
            `Full brief: ${appLink(`/meetings/${data.meetingId}`)}`;
          const cal = getCalendarProvider();
          const { refreshed } = await cal.updateEventDescription(
            acct.creds,
            meeting.googleEventId,
            note,
          );
          if (refreshed) await saveRefreshedTokens(acct.id, refreshed);
        }
      } catch (err) {
        // Attaching to the calendar is non-critical; the brief itself is saved.
        // eslint-disable-next-line no-console
        console.error(`[worker] brief calendar attach failed for ${data.meetingId}`, err);
      }
    }
  } catch (err) {
    // Generation failed after the claim — mark error so a manual retry can reset.
    await db.meeting.update({
      where: { id: data.meetingId },
      data: { briefStatus: "error" },
    });
    throw err;
  }
}
