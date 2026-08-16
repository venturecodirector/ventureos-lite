"use server";

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { renderTemplate } from "@/modules/templates/render";
import { buildDocumentData } from "@/modules/documents/data";
import { allowedStatusTransition } from "@/modules/documents/chain";
import { getMailProvider, type MailAttachment } from "./provider";
import { resolveSendingIdentity } from "./identity";
import { isRecipientSuppressed } from "./suppression";
import { brandEmail } from "./layout";
import { quoteAcceptLink } from "@/lib/public-links";
import { brandFrom } from "@/modules/workspaces/brand";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export interface ComposerData {
  to: string;
  subject: string;
  body: string;
  hasPdf: boolean;
}

export async function getComposerData(documentId: string): Promise<ComposerData> {
  await requireGrant("documents.send");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const doc = await db.document.findUnique({
    where: { id: documentId },
    include: { lead: { include: { company: true } } },
  });
  if (!doc) throw new Error("Document not found");

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { legalName: true, brand: true },
  });
  const data = buildDocumentData(doc, ws);

  const tpl = await db.template.findFirst({
    where: { type: "EMAIL", lang: "HU", status: "ACTIVE" },
    orderBy: { version: "desc" },
    select: { body: true },
  });

  let subject = "";
  let body = "";
  if (tpl?.body) {
    const rendered = renderTemplate(tpl.body, data).output;
    const lines = rendered.split("\n");
    const m = lines[0]?.match(/^(Tárgy|Subject):\s*(.*)$/i);
    if (m) {
      subject = m[2];
      body = lines.slice(1).join("\n").trim();
    } else {
      body = rendered;
    }
  }
  return { to: doc.lead?.email ?? "", subject, body, hasPdf: !!doc.pdfUrl };
}

const sendSchema = z.object({
  documentId: z.string().min(1),
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export async function sendDocument(
  raw: unknown,
): Promise<{ ok: true; mailgunId: string } | { ok: false; error: string }> {
  const input = sendSchema.parse(raw);
  await requireGrant("documents.send");
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const doc = await db.document.findUnique({
    where: { id: input.documentId },
    select: {
      id: true,
      leadId: true,
      pdfUrl: true,
      type: true,
      status: true,
      payload: true,
      acceptSlug: true,
    },
  });
  if (!doc) throw new Error("Document not found");

  // Suppression list respected (spec §4.11).
  const supp = await db.suppression.findMany({ select: { address: true } });
  if (isRecipientSuppressed(input.to, supp.map((s) => s.address))) {
    return { ok: false, error: `${input.to} is on the suppression list.` };
  }

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { mailgunConfig: true, brand: true },
  });
  const brand = brandFrom(ws?.brand);
  const identity = resolveSendingIdentity(ws?.mailgunConfig, brand);

  const attachments: MailAttachment[] = [];
  if (doc.pdfUrl) {
    try {
      const content = await readFile(join(FILES_DIR, doc.pdfUrl));
      const p = (doc.payload ?? {}) as Record<string, unknown>;
      const number = String(p.quoteNumber ?? p.contractNumber ?? p.certNumber ?? doc.id);
      attachments.push({ filename: `${number}.pdf`, content, contentType: "application/pdf" });
    } catch {
      /* PDF not generated yet — send without attachment */
    }
  }

  try {
    const { id } = await getMailProvider().send({
      domain: identity.domain,
      to: input.to,
      from: identity.from,
      replyTo: identity.replyTo || undefined,
      subject: input.subject,
      // The operator writes plain text; wrap it in the brand shell rather than
      // shipping bare <br>-joined lines. A quote also gets a button straight to
      // its acceptance page, which previously only appeared as a bare URL in
      // the body if the sender remembered to paste one.
      html: brandEmail({
        brand,
        preheader: input.subject,
        heading: input.subject,
        paragraphs: input.body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
        button:
          doc.type === "QUOTE" && doc.acceptSlug
            ? { label: "Review and accept", url: quoteAcceptLink(doc.acceptSlug) }
            : undefined,
        footNote: doc.pdfUrl ? "The signed PDF is attached." : undefined,
      }),
      text: input.body,
      attachments,
    });
    await db.emailLog.create({
      data: {
        workspaceId,
        leadId: doc.leadId ?? undefined,
        documentId: doc.id,
        to: input.to,
        subject: input.subject,
        mailgunId: id,
        status: "QUEUED",
      },
    });
    if (doc.leadId) {
      await db.activity.create({
        data: {
          workspaceId,
          leadId: doc.leadId,
          type: "email_sent",
          byUserId: userId,
          payload: { to: input.to, subject: input.subject, documentId: doc.id },
        },
      });
    }
    if (allowedStatusTransition(doc.type, doc.status, "SENT")) {
      await db.document.update({ where: { id: doc.id }, data: { status: "SENT" } });
    }
    revalidatePath("/documents");
    revalidatePath("/pipeline");
    return { ok: true, mailgunId: id };
  } catch (e) {
    // Failed sends surface in the Today Queue (an Activity on the lead).
    await db.emailLog.create({
      data: {
        workspaceId,
        leadId: doc.leadId ?? undefined,
        documentId: doc.id,
        to: input.to,
        subject: input.subject,
        status: "FAILED",
      },
    });
    if (doc.leadId) {
      await db.activity.create({
        data: {
          workspaceId,
          leadId: doc.leadId,
          type: "email_failed",
          payload: { to: input.to, error: (e as Error).message },
        },
      });
    }
    return { ok: false, error: `Send failed: ${(e as Error).message}` };
  }
}
