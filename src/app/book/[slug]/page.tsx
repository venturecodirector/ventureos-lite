import { notFound } from "next/navigation";
import { getBookingHost, getAvailability } from "@/modules/meetings/public-booking";
import { BookingWidget } from "@/components/booking-widget";
import { BrandFooter, BrandMark, brandPanelStyle, brandStyle } from "@/components/brand-mark";

/**
 * Public booking page (spec §4.21): meet.{domain}/{slug} → /book/{slug} (see
 * middleware). Prospect-facing, carrying the OWNING
 * workspace's letterhead, no product chrome (audit-v2 item 6).
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
    <main className="relative z-10 min-h-screen" style={brandStyle(host.brand)}>
      <div className="mx-auto max-w-[460px] px-5 py-14">
        <BrandMark brand={host.brand} className="mb-6 font-display text-[16px]" />

        <div
          className="rounded-card border border-line p-7"
          style={brandPanelStyle(host.brand)}
        >
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
        <BrandFooter brand={host.brand} />
      </div>
    </main>
  );
}
