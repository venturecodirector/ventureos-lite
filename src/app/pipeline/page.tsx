import { AppShell } from "@/components/app-shell";
import { PipelineBoard, type PipelineCard } from "@/components/pipeline-board";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { daysInStage } from "@/modules/pipeline/schedule";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const leads = await db.lead.findMany({
    orderBy: { stageEnteredAt: "asc" },
    include: { company: { select: { name: true } } },
  });

  // Document-chain state per lead (spec §4.9 — chain state on the pipeline card).
  const docs = await db.document.findMany({
    where: { leadId: { in: leads.map((l) => l.id) } },
    select: { id: true, leadId: true, type: true },
  });
  const chainByLead = new Map<string, string[]>();
  const docToLead = new Map<string, string>();
  for (const d of docs) {
    if (!d.leadId) continue;
    docToLead.set(d.id, d.leadId);
    const arr = chainByLead.get(d.leadId) ?? [];
    if (!arr.includes(d.type)) arr.push(d.type);
    chainByLead.set(d.leadId, arr);
  }

  // Invoice status per lead (spec §4.23 — payment status on the pipeline card).
  const invoices = await db.invoice.findMany({
    where: { documentId: { in: docs.map((d) => d.id) } },
    orderBy: { at: "desc" },
    select: { documentId: true, status: true },
  });
  const invoiceByLead = new Map<string, string>();
  for (const inv of invoices) {
    const leadOfDoc = inv.documentId ? docToLead.get(inv.documentId) : undefined;
    if (leadOfDoc && !invoiceByLead.has(leadOfDoc)) invoiceByLead.set(leadOfDoc, inv.status);
  }

  // Latest win/loss outcome per lead (spec §4.20 — closed chip on Handed off).
  const outcomes = await db.dealOutcome.findMany({
    where: { leadId: { in: leads.map((l) => l.id) } },
    orderBy: { at: "desc" },
    select: { leadId: true, result: true },
  });
  const outcomeByLead = new Map<string, string>();
  for (const o of outcomes) if (!outcomeByLead.has(o.leadId)) outcomeByLead.set(o.leadId, o.result);

  const now = new Date();
  const cards: PipelineCard[] = leads.map((l) => ({
    id: l.id,
    name: l.contactName ?? "Unnamed contact",
    company: l.company?.name ?? "—",
    icpScore: l.icpScore,
    stage: l.stage,
    daysInStage: daysInStage(l.stageEnteredAt, now),
    wakeUpAt: l.wakeUpAt ? l.wakeUpAt.toISOString().slice(0, 10) : null,
    reason: l.stageReason,
    chainTypes: chainByLead.get(l.id) ?? [],
    closedResult: outcomeByLead.get(l.id) ?? null,
    invoiceStatus: invoiceByLead.get(l.id) ?? null,
  }));

  return (
    <AppShell activePath="/pipeline">
      <PipelineBoard cards={cards} />
    </AppShell>
  );
}
