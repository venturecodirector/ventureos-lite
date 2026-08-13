import { AppShell } from "@/components/app-shell";
import { Meetings } from "@/components/meetings";
import { listMeetings } from "@/modules/meetings/actions";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

const GOOGLE_NOTICE: Record<string, string> = {
  connected: "Google Calendar connected — new bookings will post events to your calendar.",
  denied: "Google Calendar connection was cancelled.",
  error: "Google Calendar connection failed. Please try again.",
};

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams: Promise<{ google?: string }>;
}) {
  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const { google } = await searchParams;

  const [meetings, leadRows, cred] = await Promise.all([
    listMeetings(),
    db.lead.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, contactName: true, company: { select: { name: true } } },
    }),
    prismaUnsafe.googleCredential.findUnique({
      where: { userId },
      select: { id: true, scope: true },
    }),
  ]);

  const leads = leadRows.map((l) => ({
    id: l.id,
    name: l.contactName ?? l.company?.name ?? "Unnamed lead",
  }));

  return (
    <AppShell activePath="/meetings">
      <Meetings
        meetings={meetings}
        leads={leads}
        googleConnected={!!cred}
        // A token minted before calendar.readonly was requested still works
        // for writing events but cannot read busy periods, so availability is
        // silently wrong until the host reconnects. Surface that rather than
        // showing an unqualified green tick.
        googleCanReadBusy={!!cred?.scope?.includes("calendar.readonly")}
        googleNotice={google ? GOOGLE_NOTICE[google] ?? null : null}
      />
    </AppShell>
  );
}
