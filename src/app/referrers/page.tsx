import { AppShell } from "@/components/app-shell";
import { Referrers } from "@/components/referrers";
import { getLedger, listReferrers } from "@/modules/referrals/actions";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ReferrersPage() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const [ledger, referrers, leadRows, companies] = await Promise.all([
    getLedger(),
    listReferrers(),
    db.lead.findMany({
      orderBy: { createdAt: "desc" },
      take: 300,
      select: { id: true, contactName: true, source: true, referrerId: true, company: { select: { name: true } } },
    }),
    db.company.findMany({ orderBy: { name: "asc" }, take: 500, select: { id: true, name: true } }),
  ]);

  const leads = leadRows.map((l) => ({
    id: l.id,
    name: l.contactName ?? l.company?.name ?? "Unnamed lead",
    source: l.source as string,
    referrerId: l.referrerId,
  }));

  return (
    <AppShell activePath="/referrers">
      <Referrers ledger={ledger} referrers={referrers} leads={leads} companies={companies} />
    </AppShell>
  );
}
