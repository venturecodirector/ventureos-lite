import { prismaUnsafe, getWorkspaceClient } from "../../lib/db";
import { getSzamlaProvider } from "./provider";

function agentKeyOf(featureFlags: unknown): string {
  const flags = featureFlags && typeof featureFlags === "object" && !Array.isArray(featureFlags) ? (featureFlags as Record<string, unknown>) : {};
  const sz = flags.szamlazz && typeof flags.szamlazz === "object" ? (flags.szamlazz as Record<string, unknown>) : {};
  return typeof sz.agentKey === "string" ? sz.agentKey : "";
}

/**
 * Daily payment-status poll (spec §4.23). For each issued invoice, ask the
 * Számla Agent whether it's paid and reflect it on the pipeline (an activity on
 * the lead + Invoice status → PAID). Returns the number marked paid.
 */
export async function processInvoicePolls(): Promise<number> {
  const workspaces = await prismaUnsafe.workspace.findMany({ select: { id: true, featureFlags: true } });
  const provider = getSzamlaProvider();

  let paidCount = 0;
  for (const ws of workspaces) {
    const agentKey = agentKeyOf(ws.featureFlags);
    if (!agentKey) continue;
    const db = getWorkspaceClient(ws.id);
    const open = await db.invoice.findMany({
      where: { status: { in: ["SUBMITTED", "ISSUED"] }, number: { not: null } },
      include: { document: { select: { leadId: true } } },
    });
    for (const inv of open) {
      try {
        const { paid } = await provider.queryPaid(agentKey, inv.number!);
        if (paid === true) {
          await db.invoice.update({ where: { id: inv.id }, data: { status: "PAID" } });
          if (inv.document?.leadId) {
            await db.activity.create({
              data: { workspaceId: ws.id, leadId: inv.document.leadId, type: "invoice_paid", payload: { number: inv.number } },
            });
          }
          paidCount += 1;
        }
      } catch {
        /* transient — retry next poll */
      }
    }
  }
  return paidCount;
}
