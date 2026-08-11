"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireOwner } from "@/lib/authz";
import { callClaude } from "@/lib/ai/call-claude";
import {
  CAMPAIGN_FRAME_SYSTEM,
  campaignFrameSchema,
  buildFrameMessage,
  type CampaignFrame,
} from "@/lib/ai/prompts/campaign-frame";
import {
  coldEmailAllowed,
  parseColdConfig,
  bounceRate,
  warmupWeekIndex,
  type ColdSignoff,
} from "./logic";
import { previewSegment, describeSegment, type SegmentQuery } from "./segment";
import { suppressAddress, runCampaignSend, ColdGateError } from "./send";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

async function loadWs(workspaceId: string) {
  return prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true, mailgunConfig: true },
  });
}

// ---- compliance status + sign-off -----------------------------------------

export interface ColdStatus {
  allowed: boolean;
  signoff: ColdSignoff | null;
  coldDomain: string | null;
}

export async function getColdStatus(): Promise<ColdStatus> {
  const { workspaceId } = await getActiveContext();
  const ws = await loadWs(workspaceId);
  const cfg = parseColdConfig(ws?.featureFlags);
  return { allowed: coldEmailAllowed(ws?.featureFlags), signoff: cfg.signoff, coldDomain: cfg.coldDomain };
}

const signoffSchema = z.object({
  approvedBy: z.string().trim().min(1),
  date: z.string().trim().min(1),
  scopeNote: z.string().trim().min(1),
  coldDomain: z.string().trim().min(1),
});

/** Record counsel sign-off — the ONLY way to activate the module (spec §4.16). */
export async function recordSignoff(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can record counsel sign-off." };
  }
  const parsed = signoffSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "All fields (who, date, scope, cold domain) are required." };
  const { workspaceId, userId } = await getActiveContext();

  const ws = await loadWs(workspaceId);
  const flags =
    ws?.featureFlags && typeof ws.featureFlags === "object" && !Array.isArray(ws.featureFlags)
      ? (ws.featureFlags as Record<string, unknown>)
      : {};
  await prismaUnsafe.workspace.update({
    where: { id: workspaceId },
    data: {
      featureFlags: {
        ...flags,
        coldEmail: {
          coldDomain: parsed.data.coldDomain,
          signoff: {
            approvedBy: parsed.data.approvedBy,
            date: parsed.data.date,
            scopeNote: parsed.data.scopeNote,
          },
        },
      },
    },
  });
  const db = getWorkspaceClient(workspaceId);
  await db.auditLog.create({
    data: { workspaceId, actorUserId: userId, action: "cold_email.signoff", meta: parsed.data },
  });
  revalidatePath("/campaigns");
  revalidatePath("/settings");
  return { ok: true };
}

// ---- segment preview ------------------------------------------------------

export async function previewSegmentCount(
  segment: SegmentQuery,
): Promise<{ count: number; description: string }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const { count } = await previewSegment(db, segment);
  return { count, description: describeSegment(segment) };
}

// ---- campaign builder (ONE Sonnet call per campaign) ----------------------

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  goal: z.string().trim().max(300).default("Book an intro call from a website audit."),
  language: z.string().trim().max(30).default("Hungarian"),
  dailyCap: z.coerce.number().int().min(1).max(500).default(20),
  segment: z.object({
    city: z.string().optional(),
    source: z.string().optional(),
    hasWebsite: z.boolean().optional(),
    minAuditScore: z.coerce.number().int().optional(),
  }),
});

export async function createCampaign(
  raw: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const ws = await loadWs(workspaceId);
  if (!coldEmailAllowed(ws?.featureFlags)) {
    return { ok: false, error: "Cold email is locked — record counsel sign-off first." };
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the campaign details." };
  const input = parsed.data;
  const db = getWorkspaceClient(workspaceId);

  const { recipients } = await previewSegment(db, input.segment);

  // ONE Sonnet call — drafts the frame for the whole campaign, not per recipient.
  let frame: CampaignFrame;
  try {
    const { data } = await callClaude<CampaignFrame>({
      useCase: "campaign_frame",
      workspaceId,
      system: CAMPAIGN_FRAME_SYSTEM,
      schema: campaignFrameSchema,
      messages: [
        {
          role: "user",
          content: buildFrameMessage({
            name: input.name,
            segmentDescription: describeSegment(input.segment),
            language: input.language,
            goal: input.goal,
          }),
        },
      ],
    });
    frame = data as CampaignFrame;
  } catch {
    return { ok: false, error: "Could not draft the campaign frame. Try again." };
  }

  const frameRow = await db.frame.create({
    data: { workspaceId, name: frame.frameName, body: frame.steps.map((s) => s.body).join("\n\n---\n\n"), status: "DRAFT" },
  });
  const campaign = await db.campaign.create({
    data: {
      workspaceId,
      frameId: frameRow.id,
      name: input.name,
      segmentQuery: input.segment,
      dailyCap: input.dailyCap,
      status: "DRAFT",
      steps: {
        create: frame.steps.map((s) => ({
          workspaceId,
          stepNumber: s.stepNumber,
          delayDays: s.delayDays,
          subject: s.subject,
          body: s.body,
        })),
      },
    },
  });

  // Materialize recipients, skipping already-suppressed addresses (shared list).
  const suppressed = new Set(
    (await db.suppression.findMany({ select: { address: true } })).map((s) => s.address),
  );
  for (const r of recipients) {
    await db.campaignRecipient.create({
      data: {
        workspaceId,
        campaignId: campaign.id,
        leadId: r.leadId,
        email: r.email,
        suppressed: suppressed.has(r.email),
      },
    });
  }

  revalidatePath("/campaigns");
  return { ok: true, id: campaign.id };
}

// ---- lifecycle (all gated) ------------------------------------------------

export async function activateCampaign(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const ws = await loadWs(workspaceId);
  if (!coldEmailAllowed(ws?.featureFlags)) return { ok: false, error: "Cold email is locked." };
  const db = getWorkspaceClient(workspaceId);
  await db.campaign.update({ where: { id }, data: { status: "ACTIVE", startedAt: new Date() } });
  revalidatePath("/campaigns");
  return { ok: true };
}

export async function pauseCampaign(id: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.campaign.update({ where: { id }, data: { status: "PAUSED" } });
  revalidatePath("/campaigns");
  return { ok: true };
}

export async function sendNow(id: string): Promise<{ ok: true; sent: number } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const ws = await loadWs(workspaceId);
  const db = getWorkspaceClient(workspaceId);
  try {
    const res = await runCampaignSend(db, id, {
      workspaceId,
      featureFlags: ws?.featureFlags,
      mailgunConfig: ws?.mailgunConfig,
      appUrl: APP_URL,
      nowMs: Date.now(),
    });
    revalidatePath("/campaigns");
    return { ok: true, sent: res.sent };
  } catch (e) {
    if (e instanceof ColdGateError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function suppress(
  address: string,
  reason: string,
): Promise<{ ok: true; count: number }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const count = await suppressAddress(db, workspaceId, address, reason);
  revalidatePath("/campaigns");
  return { ok: true, count };
}

// ---- reads (campaign list + domain health) --------------------------------

export interface CampaignView {
  id: string;
  name: string;
  status: string;
  audience: number;
  sent: number;
  replied: number;
  unsubscribed: number;
  bounceRate: number;
  warmupWeek: number;
  coldDomain: string | null;
  steps: Array<{ stepNumber: number; subject: string | null; body: string }>;
}

export async function listCampaigns(): Promise<CampaignView[]> {
  const { workspaceId } = await getActiveContext();
  const ws = await loadWs(workspaceId);
  const coldDomain = parseColdConfig(ws?.featureFlags).coldDomain;
  const db = getWorkspaceClient(workspaceId);
  const campaigns = await db.campaign.findMany({
    orderBy: { createdAt: "desc" },
    include: { steps: { orderBy: { stepNumber: "asc" } }, recipients: true },
  });
  const now = Date.now();
  return campaigns.map((c) => {
    const audience = c.recipients.length;
    const sent = c.recipients.filter((r) => r.sentAt != null).length;
    const bounced = c.recipients.filter((r) => r.bounced).length;
    const replied = c.recipients.filter((r) => r.repliedAt != null).length;
    const unsubscribed = c.recipients.filter((r) => r.suppressed).length;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      audience,
      sent,
      replied,
      unsubscribed,
      bounceRate: bounceRate(sent, bounced),
      warmupWeek: warmupWeekIndex(c.startedAt ? c.startedAt.getTime() : null, now) + 1,
      coldDomain,
      steps: c.steps.map((s) => ({ stepNumber: s.stepNumber, subject: s.subject, body: s.body })),
    };
  });
}
