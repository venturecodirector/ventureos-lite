import { AppShell } from "@/components/app-shell";
import { LeadEngine, type LeadRow } from "@/components/lead-engine";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { gateThresholdFromConfig } from "@/modules/leads/scoring";
import { companyUnderProceedings, riskLabel } from "@/modules/registry/risk";

// Reads tenant data per request — never statically cached.
export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const leads = await db.lead.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      company: {
        select: {
          name: true,
          industry: true,
          sizeBand: true,
          registry: { select: { statusFlags: true } },
        },
      },
    },
  });
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { icpConfig: true },
  });
  const threshold = gateThresholdFromConfig(ws?.icpConfig);

  const rows: LeadRow[] = leads.map((l) => {
    const statusFlags = Array.isArray(l.company?.registry?.statusFlags)
      ? (l.company.registry.statusFlags as string[])
      : null;
    return {
      id: l.id,
      companyId: l.companyId,
      contactName: l.contactName,
      avatarPath: l.avatarPath,
      title: l.title,
      company: l.company?.name ?? "—",
      industry: l.company?.industry ?? null,
      sizeBand: l.company?.sizeBand ?? null,
      icpScore: l.icpScore,
      stage: l.stage,
      signals: Array.isArray(l.signals) ? (l.signals as string[]) : [],
      riskLabel: companyUnderProceedings(statusFlags) ? riskLabel(statusFlags) : null,
    };
  });

  return (
    <AppShell activePath="/leads">
      <LeadEngine leads={rows} threshold={threshold} />
    </AppShell>
  );
}
