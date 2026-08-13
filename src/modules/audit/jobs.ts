import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspaceClient, prismaUnsafe } from "../../lib/db";
import { callClaude } from "../../lib/ai/call-claude";
import { renderHtmlToPdf } from "../../lib/pdf";
import { buildAuditPdfHtml, type InlineShots } from "./pdf-template";
import { auditRowToView } from "./view";
import { AUDIT_SCHEMA_VERSION } from "./categories";
import {
  AUDIT_PITCH_SYSTEM,
  buildAuditPitchMessage,
} from "../../lib/ai/prompts/audit-pitch";
import { computeIcpScore, type IcpBreakdown } from "../leads/scoring";
import { probeSite, captureScreenshots, probePagesDeep } from "./probe";
import { crawlSite } from "./crawl";
import { analyzeStructure } from "./structure";
import { fetchPsi } from "./psi";
import { fetchCrux } from "./crux";
import { resolveIntegration } from "@/modules/integrations/resolve";
import { analyzeAudit } from "./analyze";
import { auditThresholdsFromConfig } from "./config";
import type { AuditJobData, PdfJobData } from "./enqueue";
import type { AuditCheck } from "./types";

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

    // Stage 1b — multi-page crawl (P2/1), internal runs only.
    //
    // Its checks are appended to the single-page ones and its two flags join
    // the lead's trigger signals, but it deliberately does NOT move the score:
    // a crawled and an uncrawled audit of the same site must stay comparable,
    // or the re-audit delta would report a site "getting worse" when all that
    // changed was the toggle.
    let structureChecks: AuditCheck[] = [];
    let structureFlags: string[] = [];
    if (data.crawl) {
      try {
        const crawl = await crawlSite(data.url, { cap: data.crawl.cap });

        // The deep checks are the expensive half, so they run on the homepage
        // (already probed above) plus the two heaviest crawled pages only.
        const heaviest = crawl.pages
          .filter((p) => p.status !== null && p.status < 400 && p.url !== crawl.startUrl)
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 2)
          .map((p) => p.url);
        if (heaviest.length > 0) {
          // 10s each, so the two of them cannot push the audit past its budget.
          const deep = await probePagesDeep(heaviest, 10_000);
          for (const page of crawl.pages) {
            if (deep[page.url]) page.deep = deep[page.url];
          }
        }

        const structure = analyzeStructure(crawl);
        structureChecks = structure.checks;
        structureFlags = structure.flags;
        await db.auditResult.update({
          where: { id: data.auditId },
          data: {
            crawl: crawl as unknown as object,
            checks: [...analysis.checks, ...structureChecks],
            flags: [...new Set([...analysis.flags, ...structureFlags])],
          },
        });
      } catch {
        // A crawl that dies must not cost the audit its single-page result.
      }
    }

    // Stage 2 — PageSpeed Insights (lab) and Chrome UX Report (field).
    //
    // Both are Google, both are free, and they answer different questions:
    // PSI is one synthetic load, CrUX is what real Chrome users lived through.
    // They run together because neither depends on the other, and CrUX is
    // stored separately because it does not feed the score (see crux.ts).
    try {
      const psiKey = await resolveIntegration(data.workspaceId, "google.pagespeedApiKey");
      // The CrUX key is optional: the same project usually serves both, so an
      // unset override falls back to the PageSpeed key rather than disabling
      // the feature.
      const cruxKey =
        (await resolveIntegration(data.workspaceId, "google.cruxApiKey")) ?? psiKey;

      // Guarded independently: a PageSpeed outage must not also cost us the
      // field data, and vice versa.
      const [psi, crux] = await Promise.all([
        fetchPsi(probe.finalUrl, psiKey).catch(() => null),
        fetchCrux(probe.finalUrl, cruxKey).catch(() => null),
      ]);
      probe.psi = psi;
      if (crux) {
        await db.auditResult.update({
          where: { id: data.auditId },
          data: { crux: crux as unknown as object },
        });
      }
      analysis = analyzeAudit(probe, thresholds);
      await db.auditResult.update({
        where: { id: data.auditId },
        data: {
          score: analysis.score,
          verdict: analysis.verdict,
          // Re-scoring from the probe rebuilds the check list from scratch, so
          // the crawl's findings have to be folded back in or the PSI stage
          // would quietly erase the whole Site structure category.
          checks: [...analysis.checks, ...structureChecks],
          flags: [...new Set([...analysis.flags, ...structureFlags])],
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
    if (data.leadId) {
      await attachFlagsToLead(db, data.leadId, [
        ...new Set([...analysis.flags, ...structureFlags]),
      ]);
    }

    await db.auditResult.update({
      where: { id: data.auditId },
      // Stamp the check set this run was scored under, so the report can
      // render an older cached audit the way it was actually scored (P1/3d).
      data: { status: "done", schemaVersion: AUDIT_SCHEMA_VERSION },
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

  // Inline the screenshots: headless Chrome renders this HTML with no session,
  // so an /api/files URL would come out as two broken boxes (P1/3a).
  const view = auditRowToView(a);
  const shots: InlineShots = {};
  for (const kind of ["desktop", "mobile"] as const) {
    const rel = view.screenshots[kind];
    if (!rel) continue;
    try {
      const bytes = await readFile(join(FILES_DIR, rel));
      shots[kind] = `data:image/png;base64,${bytes.toString("base64")}`;
    } catch {
      // A missing capture must not fail the whole PDF.
    }
  }
  const html = buildAuditPdfHtml(view, { shots });
  const pdf = await renderHtmlToPdf(html);

  const rel = `audits/${data.auditId}.pdf`;
  await mkdir(join(FILES_DIR, "audits"), { recursive: true });
  await writeFile(join(FILES_DIR, rel), pdf);

  await db.auditResult.update({
    where: { id: data.auditId },
    data: { pdfPath: rel },
  });
}
