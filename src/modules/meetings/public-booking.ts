import { prismaUnsafe } from "@/lib/db";
import { getCalendarProvider, type CalendarCredentials, type BusyPeriod } from "./calendar";
import {
  parseSlotConfig,
  parseMeetingTypes,
  horizonDays,
  type MeetingType,
} from "./booking-config";
import {
  generateDayStrip,
  generateDaySlots,
  type SlotConfig,
} from "./slots";

/**
 * Public booking-page data (spec §4.21). Cross-tenant reads by slug via the
 * unguarded client — same pattern as the quote-acceptance / audit-share pages.
 * Free/busy comes from the host's Google Calendar; the mock returns nothing busy.
 */
export interface BookingHost {
  slug: string;
  workspaceId: string;
  hostUserId: string;
  hostName: string;
  hostEmail: string | null;
  title: string;
  config: SlotConfig;
  horizonDays: number;
  meetingTypes: MeetingType[];
  mailgunConfig: unknown;
}

export async function getBookingHost(slug: string): Promise<BookingHost | null> {
  const page = await prismaUnsafe.bookingPage.findUnique({ where: { slug } });
  if (!page || !page.active) return null;
  const host = await prismaUnsafe.user.findUnique({
    where: { id: page.hostUserId },
    select: { name: true, email: true },
  });
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: page.workspaceId },
    select: { mailgunConfig: true },
  });
  const config = parseSlotConfig(page.config);
  return {
    slug: page.slug,
    workspaceId: page.workspaceId,
    hostUserId: page.hostUserId,
    hostName: host?.name ?? "your host",
    hostEmail: host?.email ?? null,
    title: page.title ?? `book a call with ${host?.name ?? "us"}`.toLowerCase(),
    config,
    horizonDays: horizonDays(page.config),
    meetingTypes: parseMeetingTypes(page.meetingTypes),
    mailgunConfig: ws?.mailgunConfig ?? null,
  };
}

/** Read the host's busy periods over a range (fail-open on error). */
export async function getHostBusy(
  hostUserId: string,
  startMs: number,
  endMs: number,
): Promise<BusyPeriod[]> {
  const provider = getCalendarProvider();
  const cred = await prismaUnsafe.googleCredential.findUnique({ where: { userId: hostUserId } });
  if (provider.name === "google" && !cred) return [];
  const creds: CalendarCredentials = cred
    ? {
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken,
        expiryDate: cred.expiryDate,
        calendarId: cred.calendarId,
      }
    : { accessToken: "", refreshToken: null, expiryDate: null, calendarId: null };
  try {
    const { busy, refreshed } = await provider.freeBusy(creds, { startMs, endMs });
    if (refreshed && cred) {
      await prismaUnsafe.googleCredential.update({ where: { userId: hostUserId }, data: refreshed });
    }
    return busy;
  } catch (e) {
    // Deliberately fail OPEN: an empty busy list means every configured slot
    // is offered. Losing a prospect to a blank booking page is worse than a
    // double-booking the host can move. But it must never be silent — this
    // swallow is why a missing calendar.readonly scope went unnoticed while
    // availability was quietly wrong.
    // eslint-disable-next-line no-console
    console.error(
      `[booking] freeBusy failed for host ${hostUserId}; offering all slots unchecked:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

export interface AvailableSlot {
  startMs: number;
  startISO: string;
  label: string;
}

export interface AvailableDay {
  dateISO: string;
  dayNum: number;
  weekday: string;
  slots: AvailableSlot[];
}

export interface Availability {
  timezone: string;
  meetingType: MeetingType;
  days: AvailableDay[];
}

export async function getAvailability(
  host: BookingHost,
  meetingTypeId: string,
  nowMs: number,
): Promise<Availability> {
  const mt =
    host.meetingTypes.find((t) => t.id === meetingTypeId) ?? host.meetingTypes[0];
  const rangeStart = nowMs;
  const rangeEnd = nowMs + host.horizonDays * 24 * 60 * 60_000;
  const busy = await getHostBusy(host.hostUserId, rangeStart, rangeEnd);

  const strip = generateDayStrip({ fromMs: nowMs, count: 8, config: host.config }).filter(
    (d) => Date.parse(`${d.dateISO}T00:00:00Z`) <= rangeEnd,
  );

  const days: AvailableDay[] = strip.map((d) => {
    const slots = generateDaySlots({
      dayISO: d.dateISO,
      durationMin: mt.durationMin,
      config: host.config,
      busy,
      nowMs,
    });
    return {
      dateISO: d.dateISO,
      dayNum: d.dayNum,
      weekday: d.weekday,
      slots: slots.map((s) => ({
        startMs: s.startMs,
        startISO: new Date(s.startMs).toISOString(),
        label: s.label,
      })),
    };
  });

  return { timezone: host.config.timezone, meetingType: mt, days };
}
