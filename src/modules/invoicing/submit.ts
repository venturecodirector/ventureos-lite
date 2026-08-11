import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceClient } from "../../lib/db";
import { composeFromCertificate } from "./data";
import { assertConfirmed, buildInvoiceXml, invoiceFailureActivity } from "./logic";
import { getSzamlaProvider, type SzamlaProvider } from "./provider";

export interface SubmitInput {
  workspaceId: string;
  certificateId: string;
  confirmedHash: string;
  agentKey: string;
  actorUserId: string | null;
  now: Date;
  provider?: SzamlaProvider;
}

export interface SubmitResult {
  ok: boolean;
  invoiceNumber?: string;
  error?: string;
  kind?: "validation" | "network" | "rejected";
}

/**
 * Submit an invoice to the Számla Agent (spec §4.23). CONFIRM-GATE: throws
 * ConfirmationError unless the caller passes the hash of the exact payload shown
 * on the confirmation screen — so nothing ever leaves the system unconfirmed.
 * Every failure (validation, network, rejected payload) lands in the Today Queue
 * with the raw response attached and the Invoice marked FAILED.
 */
export async function runInvoiceSubmit(
  db: WorkspaceClient,
  input: SubmitInput,
): Promise<SubmitResult> {
  const composed = await composeFromCertificate(db, input.certificateId, input.now);
  if (!composed.ok) {
    await queueFailure(db, input, null, { kind: "validation", error: composed.error, raw: composed.error });
    return { ok: false, error: composed.error, kind: "validation" };
  }
  const { payload, leadId } = composed.value;

  // Confirm-gate — throws if the payload wasn't confirmed exactly as shown.
  assertConfirmed(payload, input.confirmedHash);

  if (!input.agentKey) {
    await queueFailure(db, input, leadId, { kind: "validation", error: "No Számla Agent key configured.", raw: "missing agent key" });
    return { ok: false, error: "No Számla Agent key configured for this workspace.", kind: "validation" };
  }

  const provider = input.provider ?? getSzamlaProvider();
  const xml = buildInvoiceXml(payload, input.agentKey);

  let created;
  try {
    created = await provider.createInvoice(input.agentKey, xml);
  } catch (e) {
    const raw = (e as Error).message;
    await queueFailure(db, input, leadId, { kind: "network", error: raw, raw });
    await upsertInvoice(db, input.workspaceId, input.certificateId, { status: "FAILED" });
    return { ok: false, error: "Network error contacting Számlázz.hu.", kind: "network" };
  }

  if (!created.result.ok) {
    await queueFailure(db, input, leadId, {
      kind: "rejected",
      code: created.result.errorCode,
      error: created.result.error,
      raw: created.raw,
    });
    await upsertInvoice(db, input.workspaceId, input.certificateId, { status: "FAILED" });
    return { ok: false, error: created.result.error ?? "Számlázz.hu rejected the invoice.", kind: "rejected" };
  }

  // Success — store PDF + invoice number on the chain.
  let pdfUrl: string | null = null;
  if (created.pdf) {
    const filesDir = process.env.FILES_DIR ?? "/data/files";
    const rel = `invoices/${input.certificateId}.pdf`;
    await mkdir(join(filesDir, "invoices"), { recursive: true });
    await writeFile(join(filesDir, rel), created.pdf);
    pdfUrl = rel;
  }
  await upsertInvoice(db, input.workspaceId, input.certificateId, {
    status: "ISSUED",
    number: created.result.invoiceNumber ?? null,
    szamlazzId: created.result.invoiceNumber ?? null,
    pdfUrl,
  });
  return { ok: true, invoiceNumber: created.result.invoiceNumber };
}

async function upsertInvoice(
  db: WorkspaceClient,
  workspaceId: string,
  documentId: string,
  data: { status: "PREPARED" | "SUBMITTED" | "ISSUED" | "PAID" | "FAILED"; number?: string | null; szamlazzId?: string | null; pdfUrl?: string | null },
) {
  const existing = await db.invoice.findFirst({ where: { documentId } });
  if (existing) {
    await db.invoice.update({ where: { id: existing.id }, data });
    return existing.id;
  }
  const created = await db.invoice.create({ data: { workspaceId, documentId, ...data } });
  return created.id;
}

async function queueFailure(
  db: WorkspaceClient,
  input: SubmitInput,
  leadId: string | null,
  f: { kind: "validation" | "network" | "rejected"; code?: string; error?: string; raw: string },
) {
  const act = invoiceFailureActivity({ documentId: input.certificateId, leadId, kind: f.kind, code: f.code, error: f.error, raw: f.raw });
  if (act.leadId) {
    await db.activity.create({
      data: { workspaceId: input.workspaceId, leadId: act.leadId, type: act.type, byUserId: input.actorUserId ?? undefined, payload: act.payload },
    });
  }
}
