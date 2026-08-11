import { notFound } from "next/navigation";
import { getBookingHost, getAvailability } from "@/modules/meetings/public-booking";
import { BookingWidget } from "@/components/booking-widget";

/**
 * Public booking page (spec §4.21): meet.{domain}/{slug} → /book/{slug} (see
 * middleware). Prospect-facing, Venture letterhead, no product chrome.
 */
export const dynamic = "force-dynamic";

export default async function BookPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const host = await getBookingHost(slug);
  if (!host) notFound();

  const initial = await getAvailability(host, host.meetingTypes[0].id, Date.now());
  const subtitle = `${host.meetingTypes[0].label} · ${host.config.timezone}`;

  return (
    <main className="relative z-10 min-h-screen">
      <div className="mx-auto max-w-[460px] px-5 py-14">
        <div className="mb-6 font-display text-[16px]">
          <b className="font-extrabold">venture</b>{" "}
          <span className="font-light text-muted">co.group</span>
        </div>

        <div className="rounded-card border border-line bg-[radial-gradient(500px_300px_at_90%_-10%,rgba(116,39,198,0.18),transparent_60%),rgba(239,241,248,0.02)] p-7">
          <h1 className="mb-1.5 font-display text-[22px] font-extrabold lowercase leading-[1.15] tracking-display">
            {host.title}
          </h1>
          <div className="mb-[18px] text-[12px] leading-relaxed text-muted">{subtitle}</div>

          <BookingWidget
            slug={host.slug}
            hostTimezone={host.config.timezone}
            meetingTypes={host.meetingTypes}
            initial={initial}
          />
        </div>
      </div>
    </main>
  );
}
