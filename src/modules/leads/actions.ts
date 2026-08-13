"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Stage } from "@prisma/client";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireOwner } from "@/lib/authz";
import { eraseLeadData } from "@/modules/gdpr/erase";
import { callClaude } from "@/lib/ai/call-claude";
import {
  LEAD_RESEARCH_SYSTEM,
  leadCardSchema,
  buildResearchUserMessage,
  type LeadCard,
} from "@/lib/ai/prompts/lead-research";
import { computeIcpScore, MAX_ICP_SCORE, gateThresholdFromConfig, assessIcp } from "./scoring";
import { preParse, hasAnalyzableText } from "./preparse";
import { enrichCompanySite } from "./enrichment";
import { assertCanEnterStage, ScoreGateError, ResearchInputError } from "./gate";
import {
  requiresReason,
  schedulesFollowups,
  cancelsFollowups,
} from "../pipeline/transitions";
import { wakeUpDate } from "../pipeline/schedule";
import { scheduleFollowups, cancelFollowups } from "../pipeline/jobs";
import { canQualify, type Qualification } from "../inbox/qualification";
import { enqueueBriefForLead } from "../meetings/trigger";
import {
  findDuplicate,
  dedupePreview,
  normalizeDomain,
  type DedupeKeys,
  type ExistingLead,
  type DedupeResult,
} from "./dedupe";
import { findByTaxId, normalizeTaxId } from "../registry/dedupe";

// ---- input schemas (internal — a "use server" file may only export async fns)

const companyInput = z.object({
  name: z.string().min(1),
  domain: z.string().optional(),
  industry: z.string().optional(),
  sizeBand: z.string().optional(),
  taxId: z.string().optional(),
});

const manualLeadSchema = z.object({
  contactName: z.string().optional(),
  title: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  linkedinUrl: z.string().optional(),
  company: companyInput,
  notes: z.string().optional(),
  // Source + referrer assignment on capture (spec §4.18).
  source: z.enum(["PROSPECTOR", "LINKEDIN", "MANUAL", "REFERRAL", "COLD_EMAIL"]).default("MANUAL"),
  referrerId: z.string().optional(),
});

const linkedinSchema = z.object({
  url: z.string().min(1),
  pageText: z.string().default(""),
  contactName: z.string().optional(),
  companyName: z.string().optional(),
});

const candidateSchema = z.object({
  contactName: z.string().optional(),
  title: z.string().optional(),
  email: z.string().optional(),
  linkedinUrl: z.string().optional(),
  companyName: z.string().optional(),
  companyDomain: z.string().optional(),
});
type Candidate = z.infer<typeof candidateSchema>;

async function loadExistingLeadKeys(
  db: ReturnType<typeof getWorkspaceClient>,
): Promise<ExistingLead[]> {
  const rows = await db.lead.findMany({
    select: {
      id: true,
      email: true,
      linkedinUrl: true,
      company: { select: { domain: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    linkedinUrl: r.linkedinUrl,
    companyDomain: r.company?.domain ?? null,
  }));
}

async function findOrCreateCompany(
  db: ReturnType<typeof getWorkspaceClient>,
  workspaceId: string,
  c: z.infer<typeof companyInput>,
) {
  const domain = normalizeDomain(c.domain);
  if (domain) {
    const existing = await db.company.findFirst({ where: { domain } });
    if (existing) return existing;
  }
  return db.company.create({
    data: {
      workspaceId,
      name: c.name,
      domain: domain ?? undefined,
      industry: c.industry,
      sizeBand: c.sizeBand,
      taxId: normalizeTaxId(c.taxId) ?? undefined,
    },
  });
}

// ---- 4.2 Manual entry (no AI) --------------------------------------------

export async function createLeadManual(raw: unknown): Promise<
  { ok: true; leadId: string } | { ok: false; duplicateOf: string }
> {
  const input = manualLeadSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // adószám is the strongest dedupe key (spec §4.19) — check it first.
  if (input.company.taxId) {
    const companies = await db.company.findMany({ select: { id: true, taxId: true } });
    const taxClash = findByTaxId(input.company.taxId, companies);
    if (taxClash) return { ok: false, duplicateOf: taxClash.id };
  }

  const keys: DedupeKeys = {
    email: input.email || null,
    linkedinUrl: input.linkedinUrl || null,
    companyDomain: input.company.domain || null,
  };
  const dup = findDuplicate(keys, await loadExistingLeadKeys(db));
  if (dup) return { ok: false, duplicateOf: dup.id };

  const company = await findOrCreateCompany(db, workspaceId, input.company);
  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      contactName: input.contactName,
      title: input.title,
      email: input.email || undefined,
      phone: input.phone,
      linkedinUrl: input.linkedinUrl,
      source: input.source,
      referrerId: input.source === "REFERRAL" ? input.referrerId || undefined : undefined,
      stage: "RESEARCHED",
      notes: input.notes,
    },
  });
  revalidatePath("/leads");
  revalidatePath("/referrers");
  return { ok: true, leadId: lead.id };
}

// ---- 4.2 LinkedIn capture (assistive; no scraping, no AI auto-run) --------

export async function captureLinkedin(raw: unknown): Promise<{ leadId: string }> {
  const input = linkedinSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const company = await findOrCreateCompany(db, workspaceId, {
    name: input.companyName || "Unknown company",
  });
  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      contactName: input.contactName,
      linkedinUrl: input.url,
      source: "LINKEDIN",
      stage: "RESEARCHED",
      notes: input.pageText,
    },
  });
  revalidatePath("/leads");
  return { leadId: lead.id };
}

// ---- 4.2 CSV import: mapped rows in, dedupe preview / commit ---------------

export async function previewCsvImport(
  rawCandidates: unknown,
): Promise<Array<DedupeResult<Candidate>>> {
  const candidates = z.array(candidateSchema).parse(rawCandidates);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const existing = await loadExistingLeadKeys(db);
  return dedupePreview(candidates, existing);
}

export async function commitCsvImport(
  rawCandidates: unknown,
): Promise<{ created: number; skipped: number }> {
  const candidates = z.array(candidateSchema).parse(rawCandidates);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const preview = dedupePreview(candidates, await loadExistingLeadKeys(db));

  let created = 0;
  for (const row of preview) {
    if (row.status !== "new") continue;
    const c = candidates[row.index];
    const company = await findOrCreateCompany(db, workspaceId, {
      name: c.companyName || "Unknown company",
      domain: c.companyDomain,
    });
    await db.lead.create({
      data: {
        workspaceId,
        companyId: company.id,
        contactName: c.contactName,
        title: c.title,
        email: c.email || undefined,
        linkedinUrl: c.linkedinUrl,
        source: "MANUAL",
        stage: "RESEARCHED",
      },
    });
    created += 1;
  }
  revalidatePath("/leads");
  return { created, skipped: preview.length - created };
}

// ---- 4.2 Claude research run (Sonnet, structured) -------------------------

export async function runResearch(
  leadId: string,
): Promise<{ card: LeadCard; icpScore: number }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: { company: true },
  });
  if (!lead) throw new Error("Lead not found");

  // P1/1b — deterministic extraction first. These are real fields, found with
  // regexes, and they cost nothing. Persisting them before the call means a
  // paste yields something even if the research is never run.
  const parsed = preParse(lead.notes ?? "");
  const companyId = lead.companyId;
  if (parsed.emails[0] || parsed.phones[0] || parsed.city || parsed.domain) {
    await db.lead.update({
      where: { id: leadId },
      data: {
        email: lead.email ?? parsed.emails[0] ?? undefined,
        phone: lead.phone ?? parsed.phones[0] ?? undefined,
      },
    });
    if (companyId && (parsed.domain || parsed.city)) {
      await db.company.update({
        where: { id: companyId },
        data: {
          domain: lead.company?.domain ?? parsed.domain ?? undefined,
          city: lead.company?.city ?? parsed.city ?? undefined,
        },
      });
    }
  }

  // P1/1a — refuse to spend a Sonnet call on a paste with nothing in it.
  if (!hasAnalyzableText(lead.notes ?? "")) {
    throw new ResearchInputError(
      "There is no profile text to analyse yet. Paste the profile text alongside the URL, or capture the page with the browser extension.",
    );
  }

  // P1/1c — the company's own words, fetched once and cached for 30 days.
  const site = companyId ? await enrichCompanySite(companyId) : null;

  const profile = [
    lead.company?.name && `Company: ${lead.company.name}`,
    lead.company?.industry && `Industry: ${lead.company.industry}`,
    lead.contactName && `Contact: ${lead.contactName}${lead.title ? `, ${lead.title}` : ""}`,
    lead.linkedinUrl && `LinkedIn: ${lead.linkedinUrl}`,
    parsed.emails[0] && `Email: ${parsed.emails[0]}`,
    parsed.phones[0] && `Phone: ${parsed.phones[0]}`,
    parsed.city && `City: ${parsed.city}`,
    lead.notes && `Notes / pasted page:\n${lead.notes}`,
    site?.text && `Company website copy:\n${site.text}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { data } = await callClaude({
    useCase: "lead_research",
    workspaceId,
    system: LEAD_RESEARCH_SYSTEM,
    messages: [{ role: "user", content: buildResearchUserMessage(profile) }],
    schema: leadCardSchema,
  });
  const card = data as LeadCard;
  const icpScore = computeIcpScore(card.icp);
  // P1/1d — which criteria the model could not judge, kept separately so an
  // incomplete score is visibly incomplete rather than looking like a verdict.
  const assessment = assessIcp(card.icp as never);

  await db.lead.update({
    where: { id: leadId },
    data: {
      icpScore,
      scoreBreakdown: { ...card.icp, _unknown: assessment.unknown },
      signals: card.signals,
      contactName: lead.contactName ?? card.person.name,
      title: lead.title ?? card.person.title ?? undefined,
    },
  });
  revalidatePath("/leads");
  return { card, icpScore };
}

// ---- 4.5 Score override (audited) -----------------------------------------

export async function overrideScore(
  leadId: string,
  score: number,
  reason: string,
): Promise<{ icpScore: number }> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { icpScore: true },
  });
  if (!lead) throw new Error("Lead not found");

  const icpScore = Math.max(0, Math.min(MAX_ICP_SCORE, Math.round(score)));
  await db.lead.update({ where: { id: leadId }, data: { icpScore } });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "lead.score_override",
      entityType: "Lead",
      entityId: leadId,
      meta: { from: lead.icpScore, to: icpScore, reason },
    },
  });
  revalidatePath("/leads");
  return { icpScore };
}

// ---- 4.5 Stage move with server-side gate ---------------------------------

export async function moveLeadStage(
  leadId: string,
  toStage: Stage,
  opts?: { reason?: string; wakeUpAt?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { icpScore: true, stage: true, qualification: true },
  });
  if (!lead) throw new Error("Lead not found");

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { icpConfig: true },
  });
  const threshold = gateThresholdFromConfig(ws?.icpConfig);

  // Score gate — enforced in the API layer, not just the UI.
  try {
    assertCanEnterStage({ toStage, score: lead.icpScore, threshold, leadId });
  } catch (e) {
    if (e instanceof ScoreGateError) return { ok: false, error: e.message };
    throw e;
  }

  // Qualification gate — Qualified unlocks only at 3 of 4 answered (spec §4.7).
  if (toStage === "QUALIFIED" && !canQualify(lead.qualification as Partial<Qualification> | null)) {
    return {
      ok: false,
      error: "Answer at least 3 of 4 qualification questions before qualifying.",
    };
  }

  if (requiresReason(toStage) && !opts?.reason?.trim()) {
    return { ok: false, error: "A reason is required to disqualify a lead." };
  }

  const now = new Date();
  const wakeUpAt =
    toStage === "NOT_NOW"
      ? opts?.wakeUpAt
        ? new Date(opts.wakeUpAt)
        : wakeUpDate(now)
      : null;

  await db.lead.update({
    where: { id: leadId },
    data: {
      stage: toStage,
      stageEnteredAt: now,
      stageReason: opts?.reason ?? null,
      ...(toStage === "NOT_NOW" ? { wakeUpAt } : {}),
    },
  });

  // Stage transitions create Activity records (spec §4.5).
  await db.activity.create({
    data: {
      workspaceId,
      leadId,
      type: "stage_change",
      byUserId: userId,
      payload: { from: lead.stage, to: toStage, reason: opts?.reason ?? null },
    },
  });

  // Task-level automations (never messaging). Best-effort — never block the move.
  try {
    if (schedulesFollowups(toStage)) await scheduleFollowups(leadId, workspaceId);
    if (cancelsFollowups(toStage)) await cancelFollowups(leadId);
    // The one permitted non-manual Claude trigger (spec §4.8): entering
    // Meeting-booked queues the brief, bounded to one call per booking.
    if (toStage === "MEETING_BOOKED") await enqueueBriefForLead(workspaceId, leadId);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[pipeline] stage automation failed", e);
  }

  revalidatePath("/leads");
  revalidatePath("/pipeline");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// deletion
// ---------------------------------------------------------------------------

const deleteSchema = z.object({
  leadId: z.string().min(1),
  /**
   * Purge quotes/contracts/certificates and their PDFs too. Off by default:
   * issued legal documents are usually retained under a separate legal basis,
   * in which case eraseLeadData detaches them from the person instead.
   */
  eraseDocuments: z.boolean().default(false),
});

export type DeleteLeadResult =
  | { ok: true; deleted: Record<string, number>; filesRemoved: number }
  | { ok: false; error: string };

/**
 * Hard-delete a lead and everything derived from it (CLAUDE.md rule #9 —
 * erasure inside 72h, cascading to derived data, with backups expiring inside
 * the 14-day rotation).
 *
 * The erasure machinery already existed in modules/gdpr/erase.ts and was only
 * ever reachable from a background job, so there was no way to delete a lead
 * from the product at all. This is the operator-facing entry point.
 *
 * Owner-only: it removes rows across a dozen tables and unlinks files from
 * disk, and it cannot be undone from inside the app. Audited either way
 * (rule #8 — every delete is logged).
 */
export async function deleteLead(raw: unknown): Promise<DeleteLeadResult> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown lead." };

  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can delete a lead." };
  }

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // Read the identifying details BEFORE erasure so the audit entry still says
  // who was removed once the rows are gone.
  const lead = await db.lead.findUnique({
    where: { id: parsed.data.leadId },
    select: {
      id: true,
      contactName: true,
      email: true,
      company: { select: { name: true } },
    },
  });
  if (!lead) return { ok: false, error: "Lead not found." };

  const result = await eraseLeadData(db, lead.id, {
    eraseDocuments: parsed.data.eraseDocuments,
  });

  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "lead.deleted",
      entityType: "Lead",
      entityId: lead.id,
      meta: {
        contactName: lead.contactName,
        company: lead.company?.name ?? null,
        // The address is the point of a GDPR erasure request, so record that
        // it was this one that went — the log is the proof the request ran.
        email: lead.email,
        erasedDocuments: parsed.data.eraseDocuments,
        deleted: result.deleted,
        filesRemoved: result.filesRemoved,
      },
    },
  });

  revalidatePath("/leads");
  revalidatePath("/pipeline");
  revalidatePath("/public-pages");
  return { ok: true, deleted: result.deleted, filesRemoved: result.filesRemoved };
}
