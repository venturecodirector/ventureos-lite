import type { WorkspaceClient } from "@/lib/db";
import { prismaUnsafe } from "@/lib/db";
import { callClaude } from "@/lib/ai/call-claude";
import { BudgetExceededError } from "@/lib/ai/budget";
import {
  MEETING_FOLLOWUP_SYSTEM,
  meetingFollowupSchema,
  buildFollowupMessage,
  type MeetingFollowup,
} from "@/lib/ai/prompts/meeting-followup";
import { serviceMapFrom } from "@/modules/audit/service-map";
import { AUDIT_CATEGORIES, type AuditCategory } from "@/modules/audit/categories";
import { createTaskFromSignal } from "@/modules/tasks/from-signal";

/**
 * The post-meeting follow-up kit (playbook-v4 P13/2).
 *
 * ── THE GAP IT CLOSES ──────────────────────────────────────────────────────
 *
 * An outcome was logged, the lead moved to Handed off, and everything that
 * should have happened next depended on somebody remembering all four things
 * while the meeting was still fresh: the thank-you, the audit PDF worth
 * attaching, the quote lines that were actually discussed, and a reminder to
 * chase. The playbook's target is "from outcome logged to email sent in under
 * ten minutes", and the reason that is hard is not writing — it is assembling.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 *
 * An outbox. Every part of the kit is a suggestion: the email is a DRAFT the
 * composer opens, the quote is a set of LINES a person turns into a quote
 * through the existing grant-checked action, and the task is a task. Nothing
 * here sends, finalises or bills anything.
 */

export interface KitQuoteLine {
  /** The service-map key it came from, so the picker and the kit agree. */
  category: AuditCategory;
  description: string;
  /** Mid-point of the band. A starting number to edit, never a price. */
  suggestedNet: number;
}

export interface FollowupKit {
  builtAt: string;
  /** Null when the draft could not be written — the rest of the kit still stands. */
  draftMessageId: string | null;
  draftError: string | null;
  /** Files worth attaching, resolved at build time. */
  attachments: Array<{ label: string; path: string }>;
  quoteLines: KitQuoteLine[];
  taskId: string | null;
}

/** Turn the picked categories into quote lines, from the workspace's own catalogue. */
export function quoteLinesFor(
  categories: string[],
  auditConfig: unknown,
): KitQuoteLine[] {
  const map = serviceMapFrom(auditConfig);
  const seen = new Set<string>();
  const out: KitQuoteLine[] = [];
  for (const raw of categories) {
    if (!(AUDIT_CATEGORIES as readonly string[]).includes(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const category = raw as AuditCategory;
    const m = map[category];
    out.push({
      category,
      description: m.item,
      // The mid-point, rounded to the nearest ten thousand forints: a starting
      // number that looks like a decision rather than an average.
      suggestedNet: Math.round((m.minHuf + m.maxHuf) / 2 / 10_000) * 10_000,
    });
  }
  return out;
}

export interface BuildKitInput {
  meetingId: string;
  leadId: string | null;
  outcome: string;
  reason?: string | null;
  value?: number | null;
  notes?: string | null;
  discussed: string[];
}

/**
 * Assemble the kit. Never throws: a meeting outcome is a fact that has already
 * happened, and losing it because a draft could not be written would be a much
 * worse trade than a kit with one part missing.
 */
export async function buildFollowupKit(
  db: WorkspaceClient,
  workspaceId: string,
  input: BuildKitInput,
): Promise<FollowupKit> {
  const kit: FollowupKit = {
    builtAt: new Date().toISOString(),
    draftMessageId: null,
    draftError: null,
    attachments: [],
    quoteLines: [],
    taskId: null,
  };

  const lead = input.leadId
    ? await db.lead.findUnique({
        where: { id: input.leadId },
        select: {
          contactName: true,
          companyId: true,
          company: { select: { name: true } },
        },
      })
    : null;

  // ---- (c) the quote skeleton, deterministic --------------------------------
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { auditConfig: true },
  });
  kit.quoteLines = quoteLinesFor(input.discussed, ws?.auditConfig);

  // ---- (b) attachments worth suggesting -------------------------------------
  if (lead?.companyId) {
    const audit = await db.auditResult.findFirst({
      where: { companyId: lead.companyId, status: "done", pdfPath: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { pdfPath: true, score: true },
    });
    if (audit?.pdfPath) {
      kit.attachments.push({
        label: `Átvilágítási riport${audit.score != null ? ` (${audit.score}/100)` : ""}`,
        path: audit.pdfPath,
      });
    }
  }
  /**
   * The playbook also names "relevant sector report if exists". Sector reports
   * are P12/2 and are not built yet, so there is nothing to look up — stated
   * here rather than stubbed, so the gap is visible when P12/2 lands.
   */

  // ---- (a) the thank-you draft, one Sonnet call -----------------------------
  if (input.leadId) {
    try {
      const { data } = await callClaude({
        useCase: "meeting_followup",
        workspaceId,
        system: MEETING_FOLLOWUP_SYSTEM,
        schema: meetingFollowupSchema,
        messages: [
          {
            role: "user",
            content: buildFollowupMessage({
              contactName: lead?.contactName,
              companyName: lead?.company?.name,
              outcome: input.outcome,
              reason: input.reason,
              value: input.value,
              notes: input.notes,
              discussedItems: kit.quoteLines.map((l) => l.description),
            }),
          },
        ],
      });
      const draft = data as MeetingFollowup;
      const message = await db.message.create({
        data: {
          workspaceId,
          leadId: input.leadId,
          direction: "OUTBOUND",
          channel: "EMAIL",
          kind: "meeting_followup",
          body: `${draft.subject}\n\n${draft.body}`,
          status: "DRAFT",
          // Claude wrote it, so the human-edit guardrail applies: it cannot be
          // marked Sent until a person has changed it.
          aiDrafted: true,
          aiDraftBody: `${draft.subject}\n\n${draft.body}`,
        },
        select: { id: true },
      });
      kit.draftMessageId = message.id;
    } catch (e) {
      kit.draftError =
        e instanceof BudgetExceededError
          ? "A napi Claude-keret elfogyott — a levelet kézzel kell megírni."
          : "A levél piszkozata nem készült el. A csomag többi része megvan.";
    }

    // ---- (d) chase it in three days ----------------------------------------
    kit.taskId = await createTaskFromSignal(db, {
      workspaceId,
      title: `Nincs válasz a találkozó utáni levélre — ${lead?.company?.name ?? lead?.contactName ?? "lead"}`,
      note: "Ha időközben válaszoltak, zárd le ezt a teendőt.",
      type: "follow_up",
      entityType: "lead",
      entityId: input.leadId,
      source: "meeting_followup",
      dueInDays: 3,
    });
  }

  return kit;
}

export function kitFrom(raw: unknown): FollowupKit | null {
  if (!raw || typeof raw !== "object") return null;
  const k = raw as Partial<FollowupKit>;
  if (typeof k.builtAt !== "string") return null;
  return {
    builtAt: k.builtAt,
    draftMessageId: typeof k.draftMessageId === "string" ? k.draftMessageId : null,
    draftError: typeof k.draftError === "string" ? k.draftError : null,
    attachments: Array.isArray(k.attachments) ? k.attachments : [],
    quoteLines: Array.isArray(k.quoteLines) ? k.quoteLines : [],
    taskId: typeof k.taskId === "string" ? k.taskId : null,
  };
}
