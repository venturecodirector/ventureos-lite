import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getMailProvider } from "@/modules/mail/provider";
import { resolveSendingIdentity } from "@/modules/mail/identity";
import { brandEmail, brandEmailText } from "@/modules/mail/layout";
import { isRecipientSuppressed } from "@/modules/mail/suppression";
import { brandFrom } from "@/modules/workspaces/brand";
import { processPdfRender } from "@/modules/audit/jobs";
import type { ReportEmailJobData } from "./enqueue";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

/**
 * Deliver the full audit report to someone who asked for it (P12/1b).
 *
 * TRANSACTIONAL, never cold: this is a delivery the recipient requested
 * seconds ago, and routing it through the cold domain would both break the
 * reputation separation and misrepresent what the message is.
 *
 * The PDF is rendered here rather than assumed: the public audit path never
 * generates one (nobody has asked for it until now), so the first request is
 * also the render. A second request finds the file already on disk.
 */
export async function processPublicAuditReport(data: ReportEmailJobData): Promise<void> {
  const consent = await prismaUnsafe.publicAuditConsent.findUnique({
    where: { id: data.consentId },
  });
  if (!consent || consent.reportSentAt) return;

  const db = getWorkspaceClient(data.workspaceId);
  const audit = await db.auditResult.findUnique({
    where: { id: data.auditId },
    select: { id: true, url: true, score: true, pdfPath: true },
  });
  if (!audit) return;

  // Render on demand, once.
  let pdfPath = audit.pdfPath;
  if (!pdfPath) {
    await processPdfRender({ auditId: audit.id, workspaceId: data.workspaceId });
    pdfPath =
      (
        await db.auditResult.findUnique({
          where: { id: audit.id },
          select: { pdfPath: true },
        })
      )?.pdfPath ?? null;
  }

  const suppressions = await db.suppression.findMany({ select: { address: true } });
  if (isRecipientSuppressed(consent.email, suppressions.map((s) => s.address))) {
    // They asked us to stop writing to them. That outranks a form they just
    // filled in — and the audit is still visible on the page they used.
    await prismaUnsafe.publicAuditConsent.update({
      where: { id: consent.id },
      data: { reportSentAt: new Date() },
    });
    return;
  }

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: data.workspaceId },
    select: { mailgunConfig: true, brand: true },
  });
  const brand = brandFrom(ws?.brand);
  const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);
  const site = audit.url.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const hu = data.locale === "hu";
  const subject = hu
    ? `Az átvilágítás eredménye — ${site}`
    : `Your website audit — ${site}`;
  const heading = hu ? "Itt a részletes riport" : "Here is your detailed report";
  const paragraphs = hu
    ? [
        `Köszönjük, hogy lefuttatta az átvilágítást a(z) ${site} oldalra.`,
        "A csatolt PDF minden mérést tartalmaz kategóriánként, képernyőképekkel és javasolt sorrenddel — azzal kezdve, ami a legtöbbet javít a legkevesebb munkából.",
        consent.marketingConsent
          ? "Ha szeretné, átnézzük együtt: válaszoljon erre a levélre, és egyeztetünk egy időpontot."
          : "Ha kérdése van az eredményről, válaszoljon erre a levélre.",
      ]
    : [
        `Thanks for running the audit on ${site}.`,
        "The attached PDF covers every measurement by category, with screenshots and a suggested order of work — starting with what improves the most for the least effort.",
        consent.marketingConsent
          ? "Happy to go through it with you: reply to this email and we will find a time."
          : "If you have a question about the result, just reply to this email.",
      ];

  const attachments = [];
  if (pdfPath) {
    try {
      attachments.push({
        filename: hu ? `atvilagitas-${site}.pdf` : `audit-${site}.pdf`,
        content: await readFile(join(FILES_DIR, pdfPath)),
        contentType: "application/pdf",
      });
    } catch {
      // Send the mail anyway: a message explaining the result beats silence,
      // and the score is in the body.
    }
  }

  const options = {
    brand,
    preheader: hu
      ? `${site} — a részletes átvilágítási riport`
      : `${site} — your detailed website audit`,
    heading,
    paragraphs,
    rows: [
      {
        label: hu ? "Oldal" : "Website",
        value: site,
      },
      {
        label: hu ? "Javítanivaló pontszám" : "Opportunity score",
        value: String(audit.score),
      },
    ],
    footNote: attachments.length
      ? undefined
      : hu
        ? "A riport PDF-je nem készült el időben — válaszoljon erre a levélre, és elküldjük."
        : "The PDF did not finish rendering in time — reply and we will send it.",
    brandName: brand.name,
    brandMarkBold: brand.markBold,
    brandMarkLight: brand.markLight,
    brandFooter: brand.footerIdentity,
  };

  await getMailProvider().send({
    domain: identity.domain,
    to: consent.email,
    from: identity.from,
    replyTo: identity.replyTo,
    subject,
    html: brandEmail(options),
    text: brandEmailText(options),
    attachments,
  });

  await prismaUnsafe.publicAuditConsent.update({
    where: { id: consent.id },
    data: { reportSentAt: new Date() },
  });

  // Copy of the delivery on the lead's timeline, so the operator opening a warm
  // inbound lead can see what the person already has.
  if (consent.leadId) {
    await db.activity.create({
      data: {
        workspaceId: data.workspaceId,
        leadId: consent.leadId,
        type: "self_serve_report_sent",
        payload: { url: audit.url, score: audit.score, email: consent.email },
      },
    });
  }
}
