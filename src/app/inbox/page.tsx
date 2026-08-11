import { AppShell } from "@/components/app-shell";
import { Inbox } from "@/components/inbox";
import { listThreads } from "@/modules/inbox/actions";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const [threads, leadRows] = await Promise.all([
    listThreads(),
    db.lead.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, contactName: true, company: { select: { name: true } } },
    }),
  ]);
  const leads = leadRows.map((l) => ({
    id: l.id,
    name: l.contactName ?? l.company?.name ?? "Unnamed lead",
  }));

  return (
    <AppShell activePath="/inbox">
      <Inbox threads={threads} leads={leads} />
    </AppShell>
  );
}
