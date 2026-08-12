"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Lang } from "@prisma/client";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { callClaude } from "@/lib/ai/call-claude";
import { BudgetExceededError } from "@/lib/ai/budget";
import {
  OUTREACH_DRAFT_SYSTEM,
  outreachDraftSchema,
  buildDraftMessage,
  OUTREACH_CRITIQUE_SYSTEM,
  outreachCritiqueSchema,
  buildCritiqueMessage,
  type OutreachDraft,
  type OutreachCritique,
} from "@/lib/ai/prompts/outreach-draft";
import { canEnterContacted } from "@/lib/scoring";
import {
  OUTREACH_STEPS,
  STEP_LABEL,
  auditHooks,
  evaluateSendGate,
  isHumanEdited,
  isOutreachStep,
  maxCharsFor,
  nextStep,
  shouldParkAsNotNow,
  type AuditHook,
  type OutreachStep,
} from "./sequence";

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export interface OutreachMessageView {
  id: string;
  step: OutreachStep;
  label: string;
  body: string;
  status: "DRAFT" | "SENT" | "FAILED";
  aiDrafted: boolean;
  /** The exact Claude output, so the client can run the same edit comparison. */
  aiDraftBody: string | null;
  /** Live comparison against the stored draft — never a trusted stored flag. */
  humanEdited: boolean;
  critique: OutreachCritique | null;
  maxChars: number | null;
  sentAt: string | null;
}

export interface OutreachLeadView {
  id: string;
  contactName: string;
  title: string;
  companyName: string;
  city: string;
  linkedinUrl: string | null;
  stage: string;
  icpScore: number | null;
  /** False when the score gate (hard rule #5) blocks Contacted. */
  canContact: boolean;
  signals: string[];
  hooks: AuditHook[];
  messages: OutreachMessageView[];
  nextStep: OutreachStep | null;
  hasReply: boolean;
}

function parseCritique(raw: unknown): OutreachCritique | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = outreachCritiqueSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Leads worth working the sequence on: researched/contacted, not closed out. */
export async function listOutreachLeads(): Promise<
  Array<{ id: string; name: string; company: string; stage: string; pending: string | null }>
> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const leads = await db.lead.findMany({
    where: { stage: { in: ["RESEARCHED", "CONTACTED", "ACCEPTED", "REPLIED"] } },
    orderBy: [{ stageEnteredAt: "desc" }],
    take: 60,
    include: {
      company: { select: { name: true } },
      messages: {
        where: { direction: "OUTBOUND" },
        select: { kind: true, status: true },
      },
    },
  });
  return leads.map((l) => {
    const sent = l.messages.filter((m) => m.status === "SENT").map((m) => m.kind ?? "");
    const next = nextStep(sent);
    return {
      id: l.id,
      name: l.contactName ?? "(no name)",
      company: l.company?.name ?? "",
      stage: l.stage,
      pending: next ? STEP_LABEL[next] : null,
    };
  });
}

export async function getOutreachLead(leadId: string): Promise<OutreachLeadView | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: {
      company: {
        select: {
          name: true,
          city: true,
          audits: {
            where: { status: "done" },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { score: true, flags: true },
          },
        },
      },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!lead) return null;

  const audit = lead.company?.audits[0] ?? null;
  const flags = Array.isArray(audit?.flags) ? (audit.flags as string[]) : [];
  const signals = Array.isArray(lead.signals) ? (lead.signals as string[]) : [];

  const outbound = lead.messages.filter((m) => m.direction === "OUTBOUND" && isOutreachStep(m.kind ?? ""));
  const messages: OutreachMessageView[] = outbound.map((m) => {
    const step = m.kind as OutreachStep;
    return {
      id: m.id,
      step,
      label: STEP_LABEL[step],
      body: m.body,
      status: m.status,
      aiDrafted: m.aiDrafted,
      aiDraftBody: m.aiDraftBody,
      humanEdited: m.aiDrafted ? isHumanEdited(m.aiDraftBody, m.body) : true,
      critique: parseCritique(m.critique),
      maxChars: maxCharsFor(step),
      sentAt: m.sentAt?.toISOString() ?? null,
    };
  });

  const sentSteps = outbound.filter((m) => m.status === "SENT").map((m) => m.kind ?? "");

  return {
    id: lead.id,
    contactName: lead.contactName ?? "",
    title: lead.title ?? "",
    companyName: lead.company?.name ?? "",
    city: lead.company?.city ?? "",
    linkedinUrl: lead.linkedinUrl,
    stage: lead.stage,
    icpScore: lead.icpScore,
    canContact: canEnterContacted(lead.icpScore ?? 0),
    signals,
    hooks: auditHooks({
      companyName: lead.company?.name ?? "",
      score: audit?.score ?? null,
      flags,
    }),
    messages,
    nextStep: nextStep(sentSteps),
    hasReply: lead.messages.some((m) => m.direction === "INBOUND"),
  };
}

// ---------------------------------------------------------------------------
// draft (Claude — manual trigger only)
// ---------------------------------------------------------------------------

const draftSchema = z.object({
  leadId: z.string().min(1),
  step: z.enum(OUTREACH_STEPS),
  language: z.enum(["HU", "EN"]).default("HU"),
});

export type DraftResult =
  | { ok: true; messageId: string; body: string; rationale: string }
  | { ok: false; error: string };

/**
 * Draft one step with Claude (Sonnet). Manual trigger only — never on page load
 * or save (CLAUDE.md hard rule #3). The result is stored in BOTH `body` and
 * `aiDraftBody`; the copy in `aiDraftBody` is what the send gate later compares
 * against to prove a human actually changed it.
 */
export async function draftOutreach(raw: unknown): Promise<DraftResult> {
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick a lead and a step." };
  const { leadId, step, language } = parsed.data;

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: {
      company: {
        select: {
          name: true,
          city: true,
          audits: {
            where: { status: "done" },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { score: true, flags: true },
          },
        },
      },
      messages: { where: { direction: "OUTBOUND", status: "SENT" }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!lead) return { ok: false, error: "Lead not found." };

  const audit = lead.company?.audits[0] ?? null;
  let draft: OutreachDraft;
  try {
    const { data } = await callClaude({
      useCase: "outreach_draft",
      workspaceId,
      system: OUTREACH_DRAFT_SYSTEM,
      messages: [
        {
          role: "user",
          content: buildDraftMessage({
            step,
            language,
            maxChars: maxCharsFor(step),
            contactName: lead.contactName ?? "",
            title: lead.title ?? "",
            companyName: lead.company?.name ?? "",
            city: lead.company?.city ?? "",
            signals: Array.isArray(lead.signals) ? (lead.signals as string[]) : [],
            auditScore: audit?.score ?? null,
            auditFlags: Array.isArray(audit?.flags) ? (audit.flags as string[]) : [],
            previous: lead.messages.map((m) => ({ step: m.kind ?? "", body: m.body })),
          }),
        },
      ],
      schema: outreachDraftSchema,
    });
    draft = data as OutreachDraft;
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      return {
        ok: false,
        error: `${e.message} You can still write and send this message yourself.`,
      };
    }
    return { ok: false, error: "Claude could not draft this. Write it yourself, or retry." };
  }

  // One draft row per step: re-drafting replaces the previous unsent attempt.
  const existing = await db.message.findFirst({
    where: { leadId, direction: "OUTBOUND", kind: step, status: "DRAFT" },
    select: { id: true },
  });

  const data = {
    body: draft.body,
    aiDrafted: true,
    aiDraftBody: draft.body,
    // Recomputed on read; stored only so the column reflects the last known state.
    humanEdited: false,
    critique: null,
    status: "DRAFT" as const,
  };

  const saved = existing
    ? await db.message.update({ where: { id: existing.id }, data })
    : await db.message.create({
        data: {
          workspaceId,
          leadId,
          direction: "OUTBOUND",
          channel: "LINKEDIN",
          kind: step,
          ...data,
        },
      });

  revalidatePath("/outreach");
  return { ok: true, messageId: saved.id, body: draft.body, rationale: draft.rationale };
}

// ---------------------------------------------------------------------------
// critique
// ---------------------------------------------------------------------------

const critiqueSchema = z.object({ messageId: z.string().min(1) });

export async function critiqueOutreach(
  raw: unknown,
): Promise<{ ok: true; critique: OutreachCritique } | { ok: false; error: string }> {
  const parsed = critiqueSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Nothing to review." };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const msg = await db.message.findUnique({
    where: { id: parsed.data.messageId },
    include: {
      lead: {
        include: {
          company: {
            select: {
              name: true,
              audits: {
                where: { status: "done" },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { flags: true },
              },
            },
          },
        },
      },
    },
  });
  if (!msg) return { ok: false, error: "Message not found." };
  if (!msg.body.trim()) return { ok: false, error: "Write the message first." };

  const step = isOutreachStep(msg.kind ?? "") ? (msg.kind as OutreachStep) : "fu1";
  const audit = msg.lead?.company?.audits[0] ?? null;

  try {
    const { data } = await callClaude({
      useCase: "outreach_draft",
      workspaceId,
      system: OUTREACH_CRITIQUE_SYSTEM,
      messages: [
        {
          role: "user",
          content: buildCritiqueMessage({
            step: STEP_LABEL[step],
            body: msg.body,
            maxChars: maxCharsFor(step),
            companyName: msg.lead?.company?.name ?? "",
            auditFlags: Array.isArray(audit?.flags) ? (audit.flags as string[]) : [],
          }),
        },
      ],
      schema: outreachCritiqueSchema,
    });
    const critique = data as OutreachCritique;
    await db.message.update({
      where: { id: msg.id },
      data: { critique: JSON.stringify(critique) },
    });
    revalidatePath("/outreach");
    return { ok: true, critique };
  } catch (e) {
    if (e instanceof BudgetExceededError) return { ok: false, error: e.message };
    return { ok: false, error: "Claude could not review this. Try again later." };
  }
}

// ---------------------------------------------------------------------------
// save + send
// ---------------------------------------------------------------------------

const saveSchema = z.object({ messageId: z.string().min(1), body: z.string().max(8000) });

/** Persist an edit. `humanEdited` is DERIVED here, never taken from the client. */
export async function saveOutreachDraft(
  raw: unknown,
): Promise<{ ok: true; humanEdited: boolean } | { ok: false; error: string }> {
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Could not save that." };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const msg = await db.message.findUnique({
    where: { id: parsed.data.messageId },
    select: { id: true, status: true, aiDrafted: true, aiDraftBody: true },
  });
  if (!msg) return { ok: false, error: "Message not found." };
  if (msg.status === "SENT") return { ok: false, error: "This message was already sent." };

  const humanEdited = msg.aiDrafted ? isHumanEdited(msg.aiDraftBody, parsed.data.body) : true;
  await db.message.update({
    where: { id: msg.id },
    data: { body: parsed.data.body, humanEdited },
  });
  revalidatePath("/outreach");
  return { ok: true, humanEdited };
}

const markSentSchema = z.object({ messageId: z.string().min(1), body: z.string().max(8000) });

export type MarkSentResult =
  | { ok: true; parked: boolean }
  | { ok: false; error: string; reason?: "unedited" | "empty" | "too_long" | "gate" };

/**
 * Mark a message Sent — the human sends it themselves in LinkedIn; this only
 * records that they did (CLAUDE.md hard rule #2: the system never sends
 * outreach on its own).
 *
 * Two gates, both enforced HERE rather than in the UI:
 *   - hard rule #6: a Claude-drafted message must have been changed by a human.
 *   - hard rule #5: a lead under the ICP threshold cannot enter Contacted.
 */
export async function markOutreachSent(raw: unknown): Promise<MarkSentResult> {
  const parsed = markSentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Could not send that." };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const msg = await db.message.findUnique({
    where: { id: parsed.data.messageId },
    include: { lead: { select: { id: true, icpScore: true, stage: true } } },
  });
  if (!msg || !msg.lead) return { ok: false, error: "Message not found." };
  if (msg.status === "SENT") return { ok: false, error: "This message was already sent." };

  const step = isOutreachStep(msg.kind ?? "") ? (msg.kind as OutreachStep) : "fu1";

  // Persist the latest text first, so the gate judges exactly what is on screen.
  const body = parsed.data.body;
  const gate = evaluateSendGate({
    step,
    body,
    aiDrafted: msg.aiDrafted,
    aiDraftBody: msg.aiDraftBody,
  });
  if (!gate.allowed) {
    return { ok: false, error: gate.message, reason: gate.reason };
  }

  // Score gate (hard rule #5) — enforced in the API layer, not just the UI.
  if (msg.lead.stage === "RESEARCHED" && !canEnterContacted(msg.lead.icpScore ?? 0)) {
    return {
      ok: false,
      reason: "gate",
      error: "This lead scores below the ICP threshold and cannot enter Contacted.",
    };
  }

  const now = new Date();
  await db.message.update({
    where: { id: msg.id },
    data: { body, humanEdited: true, status: "SENT", sentAt: now },
  });

  // Advance the lead on its first outbound touch.
  if (msg.lead.stage === "RESEARCHED") {
    await db.lead.update({
      where: { id: msg.lead.id },
      data: { stage: "CONTACTED", stageEnteredAt: now, lastActivityAt: now },
    });
  } else {
    await db.lead.update({ where: { id: msg.lead.id }, data: { lastActivityAt: now } });
  }

  await db.activity.create({
    data: {
      workspaceId,
      leadId: msg.lead.id,
      type: "outreach_sent",
      payload: { step, aiDrafted: msg.aiDrafted },
    },
  });

  // Both follow-ups out with no reply → park as Not now (spec §4.6).
  const sentSteps = (
    await db.message.findMany({
      where: { leadId: msg.lead.id, direction: "OUTBOUND", status: "SENT" },
      select: { kind: true },
    })
  ).map((m) => m.kind ?? "");
  const hasReply =
    (await db.message.count({ where: { leadId: msg.lead.id, direction: "INBOUND" } })) > 0;

  let parked = false;
  if (shouldParkAsNotNow({ sentSteps, hasReply })) {
    await db.lead.update({
      where: { id: msg.lead.id },
      data: {
        stage: "NOT_NOW",
        stageEnteredAt: now,
        stageReason: "No reply after two follow-ups",
        // Surface it again in a month rather than losing it.
        wakeUpAt: new Date(now.getTime() + 30 * 86_400_000),
      },
    });
    parked = true;
  }

  revalidatePath("/outreach");
  revalidatePath("/pipeline");
  return { ok: true, parked };
}

/** Start a step by hand, with no AI involved at all (spec §4.2 / hard rule #3). */
export async function startBlankDraft(
  raw: unknown,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const parsed = z.object({ leadId: z.string().min(1), step: z.enum(OUTREACH_STEPS) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick a lead and a step." };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const existing = await db.message.findFirst({
    where: { leadId: parsed.data.leadId, direction: "OUTBOUND", kind: parsed.data.step, status: "DRAFT" },
    select: { id: true },
  });
  if (existing) return { ok: true, messageId: existing.id };

  const created = await db.message.create({
    data: {
      workspaceId,
      leadId: parsed.data.leadId,
      direction: "OUTBOUND",
      channel: "LINKEDIN",
      kind: parsed.data.step,
      body: "",
      // Not AI-drafted, so the human-edit gate does not apply to it.
      aiDrafted: false,
      aiDraftBody: null,
      humanEdited: true,
      status: "DRAFT",
    },
  });
  revalidatePath("/outreach");
  return { ok: true, messageId: created.id };
}

export type { Lang };
