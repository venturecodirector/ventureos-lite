import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SectorReports } from "@/components/sector-reports";
import { listSectorReports } from "@/modules/sector-reports/actions";
import { isOwner } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * The sector-report builder (playbook-v4 P12/2a) — Owner-gated at the page as
 * well as in every action, because it spends money and ends in something
 * published under the company's name.
 */
export default async function ReportsAdminPage() {
  if (!(await isOwner())) notFound();
  const reports = await listSectorReports();
  return (
    <AppShell activePath="/reports-admin">
      <SectorReports reports={reports} />
    </AppShell>
  );
}
