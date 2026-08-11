"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { moveLeadStage } from "@/modules/leads/actions";
import { getCalendarProvider, type CalendarCredentials } from "./calendar";
import { calendarFailureActivity, type BriefStatus } from "./logic";
import { enqueueMeetingBrief } from "./enqueue";

// ---- views (plain data for the client) ------------------------------------

export interface MeetingRow {
  id: string;
  leadId: string | null;
  leadName: string;
  company: string;
  scheduledAt: string;
  durationMin: number;
  type: string | null;
  briefStatus: BriefStatus;
  hasEvent: boolean;
  outcome: string | null;
}

export interface MeetingDetail extends MeetingRow {
  brief: string | null;
  briefPdfPath: string | null;
  eventUrl: string | null;
}

function leadName(lead: { contactName: string | null; company: { name: string } | null } | null): string {
  return lead?.contactName ?? lead?.company?.name ?? "Unknown lead";
}

// ---- 4.8 Booking -----------------------------------------------------------

const bookSchema = z.object({
  leadId: z.string().min(1),
  scheduledAt: z.string().min(1), // ISO
  durationMin: z.coerce.number().int().min(15).max(240).default(30),
  type: z.string().optional(),
});

export async function bookMeeting(
  raw: unknown,
): Promise<{ ok: true; meetingId: string; calendarOk: boolean } | { ok: false; error: string }> {
  const input = bookSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    include: { company: true },
  });
  if (!lead) return { ok: false, error: "Lead not found" };

  const start = new Date(input.scheduledAt);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Invalid date/time" };
  const end = new Date(start.getTime() + input.durationMin * 60_000);

  const meeting = await db.meeting.create({
    data: {
      workspaceId,
      leadId: lead.id,
      hostUserId: userId,
      scheduledAt: start,
      durationMin: input.durationMin,
      type: input.type,
      briefStatus: "none",
    },
  });

  // Create the event on the host's calendar with lead context attached.
  const cal = getCalendarProvider();
  let calendarOk = true;
  try {
    const cred = await prismaUnsafe.googleCredential.findUnique({ where: { userId } });
    if (cal.name === "google" && !cred) throw new Error("google_calendar_not_connected");
    const creds: CalendarCredentials = cred
      ? {
          accessToken: cred.accessToken,
          refreshToken: cred.refreshToken,
          expiryDate: cred.expiryDate,
          calendarId: cred.calendarId,
        }
      : { accessToken: "", refreshToken: null, expiryDate: null, calendarId: null };

    const who = leadName(lead);
    const context = [
      `Prospect: ${who}${lead.title ? `, ${lead.title}` : ""}`,
      lead.company?.name && `Company: ${lead.company.name}`,
      lead.company?.website && `Website: ${lead.company.website}`,
      lead.email && `Email: ${lead.email}`,
      lead.phone && `Phone: ${lead.phone}`,
      `Venture brief follows once generated.`,
    ]
      .filter(Boolean)
      .join("\n");

    const { result, refreshed } = await cal.createEvent(creds, {
      summary: `Venture · ${who}`,
      description: context,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      attendees: lead.email ? [lead.email] : [],
    });
    await db.meeting.update({
      where: { id: meeting.id },
      data: { googleEventId: result.eventId, eventUrl: result.htmlLink },
    });
    if (refreshed && cred) {
      await prismaUnsafe.googleCredential.update({ where: { userId }, data: refreshed });
    }
  } catch (e) {
    calendarOk = false;
    // Calendar failures land in the Today Queue (spec §4.8).
    const act = calendarFailureActivity({
      meetingId: meeting.id,
      leadId: lead.id,
      error: (e as Error).message,
    });
    await db.activity.create({
      data: { workspaceId, leadId: lead.id, type: act.type, payload: act.payload },
    });
  }

  // Advance the pipeline — this is what triggers automatic brief generation.
  await moveLeadStage(lead.id, "MEETING_BOOKED");

  revalidatePath("/meetings");
  revalidatePath("/pipeline");
  return { ok: true, meetingId: meeting.id, calendarOk };
}

// ---- 4.8 One-click brief (manual trigger; still one call per booking) ------

export async function generateMeetingBrief(
  meetingId: string,
): Promise<{ ok: true; queued: boolean } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const meeting = await db.meeting.findUnique({
    where: { id: meetingId },
    select: { briefStatus: true },
  });
  if (!meeting) return { ok: false, error: "Meeting not found" };

  const status = meeting.briefStatus as BriefStatus;
  if (status === "generating" || status === "done") {
    return { ok: true, queued: false }; // already handled — idempotent
  }
  if (status === "error") {
    // Allow a manual retry by resetting the claim.
    await db.meeting.updateMany({
      where: { id: meetingId, briefStatus: "error" },
      data: { briefStatus: "none" },
    });
  }
  await enqueueMeetingBrief({ meetingId, workspaceId });
  revalidatePath("/meetings");
  return { ok: true, queued: true };
}

// ---- 4.8 Edit the brief ----------------------------------------------------

export async function updateBrief(meetingId: string, text: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.meeting.update({ where: { id: meetingId }, data: { brief: text } });
  revalidatePath("/meetings");
  return { ok: true };
}

// ---- 4.8 Post-meeting outcome (handoff) ------------------------------------

const outcomeSchema = z.object({
  meetingId: z.string().min(1),
  result: z.enum(["WON", "LOST", "POSTPONED"]),
  reason: z.string().optional(),
  value: z.coerce.number().int().min(0).optional(),
  competitor: z.string().optional(),
});

export async function logMeetingOutcome(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const input = outcomeSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const meeting = await db.meeting.findUnique({
    where: { id: input.meetingId },
    select: { leadId: true },
  });
  if (!meeting) return { ok: false, error: "Meeting not found" };

  await db.meeting.update({
    where: { id: input.meetingId },
    data: { outcome: input.result },
  });

  if (meeting.leadId) {
    await db.dealOutcome.create({
      data: {
        workspaceId,
        leadId: meeting.leadId,
        result: input.result,
        reason: input.reason,
        value: input.value,
        competitor: input.competitor,
      },
    });
    await db.activity.create({
      data: {
        workspaceId,
        leadId: meeting.leadId,
        type: "meeting_outcome",
        byUserId: userId,
        payload: { result: input.result, value: input.value ?? null },
      },
    });
    // The handoff point — advance to Handed off.
    await moveLeadStage(meeting.leadId, "HANDED_OFF");
  }

  revalidatePath("/meetings");
  revalidatePath("/pipeline");
  return { ok: true };
}

// ---- reads -----------------------------------------------------------------

export async function listMeetings(): Promise<MeetingRow[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.meeting.findMany({
    orderBy: { scheduledAt: "desc" },
    take: 200,
    include: { lead: { include: { company: true } } },
  });
  return rows.map((m) => ({
    id: m.id,
    leadId: m.leadId,
    leadName: leadName(m.lead),
    company: m.lead?.company?.name ?? "",
    scheduledAt: m.scheduledAt.toISOString(),
    durationMin: m.durationMin,
    type: m.type,
    briefStatus: m.briefStatus as BriefStatus,
    hasEvent: !!m.googleEventId,
    outcome: m.outcome,
  }));
}

export async function getMeeting(meetingId: string): Promise<MeetingDetail | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const m = await db.meeting.findUnique({
    where: { id: meetingId },
    include: { lead: { include: { company: true } } },
  });
  if (!m) return null;
  return {
    id: m.id,
    leadId: m.leadId,
    leadName: leadName(m.lead),
    company: m.lead?.company?.name ?? "",
    scheduledAt: m.scheduledAt.toISOString(),
    durationMin: m.durationMin,
    type: m.type,
    briefStatus: m.briefStatus as BriefStatus,
    hasEvent: !!m.googleEventId,
    outcome: m.outcome,
    brief: m.brief,
    briefPdfPath: m.briefPdfPath,
    eventUrl: m.eventUrl,
  };
}
