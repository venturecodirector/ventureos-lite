import { AppShell } from "@/components/app-shell";
import { Meetings } from "@/components/meetings";
import { listMeetings } from "@/modules/meetings/actions";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { listCalendarAccounts } from "@/modules/meetings/credentials";
import { DEFAULT_SLOT_CONFIG, parseSlotConfig } from "@/modules/meetings/booking-config";

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

  const [meetings, leadRows, calendars, bookingPage] = await Promise.all([
    listMeetings(),
    db.lead.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, contactName: true, company: { select: { name: true } } },
    }),
    listCalendarAccounts(userId),
    db.bookingPage.findFirst({ select: { config: true } }),
  ]);

  /**
   * The zone the meetings are actually IN.
   *
   * The list used to print the raw ISO string with " UTC" glued on, so a call
   * at 10:00 Budapest read "08:00 UTC" — correct, and useless: the operator had
   * to do summer-time arithmetic to compare it with their own calendar. Taken
   * from the booking page's own config rather than the browser, so the server
   * and the client render the same string and hydration cannot disagree.
   */
  const timezone = bookingPage
    ? parseSlotConfig(bookingPage.config).timezone
    : DEFAULT_SLOT_CONFIG.timezone;

  const leads = leadRows.map((l) => ({
    id: l.id,
    name: l.contactName ?? l.company?.name ?? "Unnamed lead",
  }));

  return (
    <AppShell activePath="/meetings">
      <Meetings
        meetings={meetings}
        leads={leads}
        calendars={calendars.map((c) => ({
          id: c.id,
          accountEmail: c.accountEmail,
          purpose: c.purpose,
          canReadBusy: !!c.scope?.includes("calendar.readonly"),
        }))}
        timezone={timezone}
        googleNotice={google ? GOOGLE_NOTICE[google] ?? null : null}
      />
    </AppShell>
  );
}
