import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspaceClient, prismaUnsafe } from "../../lib/db";
import { callClaude } from "../../lib/ai/call-claude";
import { renderHtmlToPdf } from "../../lib/pdf";
import { buildAuditPdfHtml } from "./pdf-template";
import { auditRowToView } from "./view";
import {
  AUDIT_PITCH_SYSTEM,
  buildAuditPitchMessage,
} from "../../lib/ai/prompts/audit-pitch";
import { computeIcpScore, type IcpBreakdown } from "../leads/scoring";
import { probeSite, captureScreenshots } from "./probe";
import { fetchPsi } from "./psi";
import { analyzeAudit } from "./analyze";
import { auditThresholdsFromConfig } from "./config";
import type { AuditJobData, PdfJobData } from "./enqueue";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

type WorkspaceDb = ReturnType<typeof getWorkspaceClient>;

/** Audit flags attach to the lead as trigger signals and feed the ICP score (§4.4). */
async function attachFlagsToLead(
  db: WorkspaceDb,
  leadId: string,
  flags: string[],
): Promise<void> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: { signals: true, scoreBreakdown: true },
  });
  if (!lead) return;

  const current = Array.isArray(lead.signals) ? (lead.signals as string[]) : [];
  const signals = Array.from(new Set([...current, ...flags]));
  const data: { signals: string[]; scoreBreakdown?: IcpBreakdown; icpScore?: number } = {
    signals,
  };

  if (
    flags.length &&
    lead.scoreBreakdown &&
    typeof lead.scoreBreakdown === "object" &&
    !Array.isArray(lead.scoreBreakdown)
  ) {
    const breakdown = {
      ...(lead.scoreBreakdown as unknown as IcpBreakdown),
      trigger_signal: 1 as const,
    };
    data.scoreBreakdown = breakdown;
    data.icpScore = computeIcpScore(breakdown);
  }

  await db.lead.update({ where: { id: leadId }, data });
}

/**
 * Worker processor: probe → analyze → persist in stages (progressive results),
 * PSI, screenshots, optional Haiku pitch, then attach flags to the lead.
 */
export async function processAudit(data: AuditJobData): Promise<void> {
  const db = getWorkspaceClient(data.workspaceId);
  try {
    await db.auditResult.update({
      where: { id: data.auditId },
      data: { status: "running" },
    });

    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: data.workspaceId },
      select: { auditConfig: true },
    });
    const thresholds = auditThresholdsFromConfig(ws?.auditConfig);

    // Stage 1 — deterministic checks (fast; write partial result).
    const probe = await probeSite(data.url);
    let analysis = analyzeAudit(probe, thresholds);
    await db.auditResult.update({
      where: { id: data.auditId },
      data: {
        status: "running",
        score: analysis.score,
        verdict: analysis.verdict,
        checks: analysis.checks,
        flags: analysis.flags,
      },
    });

    // Stage 2 — PageSpeed Insights (optional).
    try {
      probe.psi = await fetchPsi(probe.finalUrl);
      analysis = analyzeAudit(probe, thresholds);
      await db.auditResult.update({
        where: { id: data.auditId },
        data: {
          score: analysis.score,
          verdict: analysis.verdict,
          checks: analysis.checks,
          flags: analysis.flags,
        },
      });
    } catch {
      /* PSI is optional; keep deterministic result */
    }

    // Stage 3 — screenshots to the files volume.
    try {
      const screenshots = await captureScreenshots(data.url, data.auditId);
      await db.auditResult.update({
        where: { id: data.auditId },
        data: { screenshots },
      });
    } catch {
      /* screenshots best-effort */
    }

    // Stage 4 — optional Haiku pitch (behind the toggle).
    if (data.withPitch) {
      try {
        const { data: pitch } = await callClaude({
          useCase: "audit_summary",
          workspaceId: data.workspaceId,
          system: AUDIT_PITCH_SYSTEM,
          messages: [
            { role: "user", content: buildAuditPitchMessage(probe.finalUrl, analysis) },
          ],
        });
        await db.auditResult.update({
          where: { id: data.auditId },
          data: { pitchSummary: pitch as string },
        });
      } catch {
        /* pitch best-effort (budget cap etc.) */
      }
    }

    // Stage 5 — flags → lead trigger signals.
    if (data.leadId) await attachFlagsToLead(db, data.leadId, analysis.flags);

    await db.auditResult.update({
      where: { id: data.auditId },
      data: { status: "done" },
    });
  } catch (e) {
    await db.auditResult
      .update({ where: { id: data.auditId }, data: { status: "error" } })
      .catch(() => {});
    throw e;
  }
}

/** Worker processor: render the branded audit one-pager to PDF via headless Chrome. */
export async function processPdfRender(data: PdfJobData): Promise<void> {
  const db = getWorkspaceClient(data.workspaceId);
  const a = await db.auditResult.findUnique({ where: { id: data.auditId } });
  if (!a) return;

  const html = buildAuditPdfHtml(auditRowToView(a));
  const pdf = await renderHtmlToPdf(html);

  const rel = `audits/${data.auditId}.pdf`;
  await mkdir(join(FILES_DIR, "audits"), { recursive: true });
  await writeFile(join(FILES_DIR, rel), pdf);

  await db.auditResult.update({
    where: { id: data.auditId },
    data: { pdfPath: rel },
  });
}
