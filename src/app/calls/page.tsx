import { AppShell } from "@/components/app-shell";
import { Calls } from "@/components/calls";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { listDueCallbacks, listRecentCalls } from "@/modules/calls/actions";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const leadRows = await db.lead.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, contactName: true, company: { select: { name: true } } },
  });
  const leads = leadRows.map((l) => ({
    id: l.id,
    name: l.contactName ?? l.company?.name ?? "Unnamed lead",
  }));

  const [due, recent] = await Promise.all([listDueCallbacks(), listRecentCalls()]);

  return (
    <AppShell activePath="/calls">
      <Calls leads={leads} initialDue={due} initialRecent={recent} />
    </AppShell>
  );
}
