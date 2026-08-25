"use client";

import { useEffect, useMemo, useState } from "react";
import {
  submitPublicBooking,
  loadAvailability,
} from "@/modules/meetings/public-actions";
import type { Availability, AvailableSlot } from "@/modules/meetings/public-booking";
import type { MeetingType } from "@/modules/meetings/booking-config";

const INPUT =
  "mb-2.5 w-full rounded-[9px] border border-line bg-[rgba(239,241,248,0.04)] px-3 py-2.5 text-[12.5px] text-ink outline-none placeholder:text-muted focus:border-accent";

function visitorTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "your timezone";
  } catch {
    return "your timezone";
  }
}

function inTz(iso: string, tz: string): string {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso))) {
    p[part.type] = part.value;
  }
  return `${Number(p.hour)}:${p.minute}`;
}

export function BookingWidget({
  slug,
  hostTimezone,
  meetingTypes,
  initial,
}: {
  slug: string;
  hostTimezone: string;
  meetingTypes: MeetingType[];
  initial: Availability;
}) {
  const [typeId, setTypeId] = useState(initial.meetingType.id);
  const [avail, setAvail] = useState<Availability>(initial);
  const [dayISO, setDayISO] = useState<string>(
    initial.days.find((d) => d.slots.length)?.dateISO ?? initial.days[0]?.dateISO ?? "",
  );
  const [slot, setSlot] = useState<AvailableSlot | null>(null);

  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [honeypot, setHoneypot] = useState(""); // must stay empty
  const [renderedAt] = useState(() => Date.now());

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [vtz, setVtz] = useState(hostTimezone);
  useEffect(() => setVtz(visitorTz()), []);

  async function switchType(id: string) {
    setTypeId(id);
    setSlot(null);
    const next = await loadAvailability(slug, id);
    if (next) {
      setAvail(next);
      setDayISO(next.days.find((d) => d.slots.length)?.dateISO ?? next.days[0]?.dateISO ?? "");
    }
  }

  const day = useMemo(() => avail.days.find((d) => d.dateISO === dayISO), [avail, dayISO]);
  const tzDiffers = vtz !== hostTimezone;

  async function confirm() {
    if (!slot) return;
    setBusy(true);
    setError(null);
    const res = await submitPublicBooking({
      slug,
      meetingTypeId: typeId,
      startMs: slot.startMs,
      name,
      company,
      email,
      honeypot,
      renderedAt,
    });
    setBusy(false);
    if (res.ok) setDone(res.label);
    else setError(res.error);
  }

  if (done) {
    return (
      <div
        data-testid="booking-confirmed"
        className="rounded-[10px] border border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.1)] px-4 py-4 text-[13px] text-[#8FE9C3]"
      >
        You&rsquo;re booked for <b>{done}</b>. A confirmation email is on its way.
      </div>
    );
  }

  const confirmLabel = slot
    ? `Confirm — ${avail.days.find((d) => d.dateISO === dayISO)?.weekday ?? ""} ${slot.label}`
    : "Pick a time";

  return (
    <div>
      {meetingTypes.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {meetingTypes.map((t) => (
            <button
              key={t.id}
              onClick={() => switchType(t.id)}
              className={`rounded-[9px] border px-3 py-1.5 text-[12px] ${
                t.id === typeId
                  ? "border-accent bg-accent-soft text-[#E4D3FF]"
                  : "border-line text-[#C9CEE3] hover:border-accent"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/*
        THE DAY STRIP, WHICH WAS RAGGED.

        `flex-1` with `min-w-[52px]` inside an `overflow-x-auto` row is three
        rules pulling against each other: a flex basis of 0 wants every card the
        same width, the minimum stops the ones that cannot shrink, and the
        overflow lets the rest size to their own content. The result was cards
        of visibly different widths with the last one sliced in half at the
        edge — the same fourteen days, laid out differently every time the
        container changed.

        Grid auto-columns cannot do that: EVERY column is `minmax(56px, 1fr)`,
        so they share the width equally when they fit and become an honest,
        snapping scroller when they do not.
      */}
      <div className="grid snap-x snap-mandatory grid-flow-col auto-cols-[minmax(56px,1fr)] gap-[7px] overflow-x-auto pb-1">
        {avail.days.map((d) => (
          <button
            key={d.dateISO}
            data-testid="day"
            onClick={() => {
              setDayISO(d.dateISO);
              setSlot(null);
            }}
            disabled={d.slots.length === 0}
            className={`snap-start rounded-[10px] border px-0 py-2 text-center text-[11px] ${
              d.dateISO === dayISO ? "border-accent bg-accent-soft" : "border-line"
            } ${d.slots.length === 0 ? "opacity-40" : ""}`}
          >
            <b className="block font-display text-[14px] text-ink">{d.dayNum}</b>
            <span className="block truncate text-muted">{d.weekday}</span>
          </button>
        ))}
      </div>

      {/* slot grid */}
      <div className="my-3 grid grid-cols-3 gap-2">
        {(day?.slots ?? []).map((s) => (
          <button
            key={s.startMs}
            data-testid="slot"
            onClick={() => setSlot(s)}
            className={`rounded-[9px] border px-1 py-2.5 text-center text-[12px] ${
              slot?.startMs === s.startMs
                ? "border-accent bg-accent-soft font-semibold text-[#E4D3FF]"
                : "border-line text-[#C9CEE3] hover:border-accent"
            }`}
          >
            {s.label}
          </button>
        ))}
        {day && day.slots.length === 0 && (
          <p className="col-span-3 py-2 text-[12px] text-muted">No times this day.</p>
        )}
      </div>

      <p className="mb-3 text-[11px] text-muted">
        Times shown in {hostTimezone}.{" "}
        {tzDiffers && slot
          ? `That's ${inTz(slot.startISO, vtz)} in your timezone (${vtz}).`
          : `Your timezone: ${vtz}.`}
      </p>

      {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}

      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={INPUT} />
      <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" className={INPUT} />
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className={INPUT} />

      {/* honeypot — hidden from humans, must remain empty */}
      <input
        type="text"
        name="company_url"
        tabIndex={-1}
        autoComplete="off"
        value={honeypot}
        onChange={(e) => setHoneypot(e.target.value)}
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0 opacity-0"
      />

      <button
        data-testid="confirm"
        onClick={confirm}
        disabled={busy || !slot || !name.trim() || !email.trim()}
        className="w-full rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2.5 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-50"
      >
        {busy ? "Booking…" : confirmLabel}
      </button>

      <p className="mt-2.5 text-[10px] leading-relaxed text-muted">
        Booking creates the meeting, the Claude brief for {slug}, and confirmations — automatically.
      </p>
    </div>
  );
}
