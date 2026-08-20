"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  bookMeeting,
  generateMeetingBrief,
  updateBrief,
  logMeetingOutcome,
  getMeeting,
  disconnectGoogleCalendar,
  setWriteCalendar,
  type MeetingRow,
  type MeetingDetail,
} from "@/modules/meetings/actions";
import { EmptyState } from "./empty-state";

const BRIEF_BADGE: Record<string, { label: string; cls: string }> = {
  none: { label: "no brief", cls: "bg-panel-2 text-muted" },
  generating: { label: "generating…", cls: "bg-accent-soft text-accent-ink" },
  done: { label: "brief ready", cls: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]" },
  error: { label: "brief failed", cls: "bg-[rgba(255,92,122,0.12)] text-[#FFB3C2]" },
};

function fmtWhen(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

export function Meetings({
  meetings,
  leads,
  calendars,
  googleNotice,
}: {
  meetings: MeetingRow[];
  leads: Array<{ id: string; name: string }>;
  calendars: Array<{
    id: string;
    accountEmail: string | null;
    purpose: string;
    canReadBusy: boolean;
  }>;
  googleNotice: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(meetings[0]?.id ?? null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // booking form
  const [lead, setLead] = useState(leads[0]?.id ?? "");
  const [when, setWhen] = useState("");
  const [duration, setDuration] = useState(30);
  const [type, setType] = useState("Discovery");

  // brief editor
  const [briefText, setBriefText] = useState("");

  // outcome form
  const [result, setResult] = useState<"WON" | "LOST" | "POSTPONED">("WON");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [competitor, setCompetitor] = useState("");

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    getMeeting(selected).then((d) => {
      setDetail(d);
      setBriefText(d?.brief ?? "");
    });
  }, [selected]);

  async function reload() {
    if (selected) {
      const d = await getMeeting(selected);
      setDetail(d);
      setBriefText(d?.brief ?? "");
    }
    router.refresh();
  }

  async function submitBooking() {
    if (!lead || !when) return;
    setBusy(true);
    setError(null);
    const res = await bookMeeting({
      leadId: lead,
      scheduledAt: new Date(when).toISOString(),
      durationMin: duration,
      type,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (!res.calendarOk) {
      setError("Meeting saved, but the calendar event failed — see the Today Queue.");
    }
    setWhen("");
    setSelected(res.meetingId);
    router.refresh();
  }

  async function genBrief() {
    if (!detail) return;
    setBusy(true);
    await generateMeetingBrief(detail.id);
    setBusy(false);
    await reload();
  }

  async function saveBrief() {
    if (!detail) return;
    setBusy(true);
    await updateBrief(detail.id, briefText);
    setBusy(false);
    await reload();
  }

  async function submitOutcome() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    const res = await logMeetingOutcome({
      meetingId: detail.id,
      result,
      reason: reason || undefined,
      value: value ? Number(value) : undefined,
      competitor: competitor || undefined,
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setValue("");
      setReason("");
      setCompetitor("");
      await reload();
    }
  }

  return (
    <div className="max-w-[1400px]">
      {googleNotice && (
        <div className="mb-3 rounded-[10px] border border-line bg-panel px-3.5 py-2.5 text-[12.5px] text-muted">
          {googleNotice}
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[320px_1fr]">
        {/* left: connect + book + list */}
        <div className="grid gap-4">
          <div className="rounded-card border border-line bg-panel p-[18px]">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Google Calendar
            </div>
            {calendars.length > 0 ? (
              <>
                <ul className="mb-2 grid gap-2">
                  {calendars.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-[10px] border border-line bg-panel-2 px-3 py-2"
                      data-testid="calendar-account"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <b className="text-[12.5px]">{c.accountEmail ?? "Google account"}</b>
                        {c.purpose === "WRITE" ? (
                          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent-ink">
                            meetings land here
                          </span>
                        ) : (
                          <span className="rounded-full bg-panel px-2 py-0.5 text-[10.5px] text-muted">
                            busy-check only
                          </span>
                        )}
                        <span className="ml-auto flex gap-2">
                          {c.purpose !== "WRITE" && (
                            <button
                              type="button"
                              onClick={async () => {
                                await setWriteCalendar(c.id);
                                router.refresh();
                              }}
                              className="rounded-[8px] border border-line px-2.5 py-1 text-[11.5px] hover:bg-panel"
                            >
                              Write meetings here
                            </button>
                          )}
                          <button
                            type="button"
                            data-testid="google-disconnect"
                            onClick={async () => {
                              if (!confirm(`Disconnect ${c.accountEmail ?? "this account"}?`)) return;
                              await disconnectGoogleCalendar(c.id);
                              router.refresh();
                            }}
                            className="rounded-[8px] border border-line px-2.5 py-1 text-[11.5px] text-[#FF8FA5] hover:border-[rgba(255,92,122,0.5)]"
                          >
                            Disconnect
                          </button>
                        </span>
                      </div>
                      {!c.canReadBusy && (
                        <p className="mt-1 text-[11.5px] text-warn" data-testid="google-scope-warning">
                          Cannot read busy times — its events do NOT block slots.
                          Reconnect to fix.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                <a
                  href="/api/google/connect"
                  data-testid="google-reconnect"
                  className="inline-block rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2"
                >
                  Connect another calendar
                </a>
                <p className="mt-1.5 text-[11.5px] text-muted">
                  Add a personal calendar to block its times without meetings
                  ever being written to it.
                </p>
              </>
            ) : (
              <>
                <p className="mb-2 text-[12px] text-muted">
                  Not connected. Bookings still save; events post to your calendar once connected.
                </p>
                <a
                  href="/api/google/connect"
                  className="inline-block rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2"
                >
                  Connect Google Calendar
                </a>
              </>
            )}
          </div>

          <div className="rounded-card border border-line bg-panel p-[18px]">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Book a meeting
            </div>
            <div className="grid gap-2">
              <select
                value={lead}
                onChange={(e) => setLead(e.target.value)}
                className="rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
              >
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <select
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className="flex-1 rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
                >
                  {[15, 30, 45, 60].map((d) => (
                    <option key={d} value={d}>{d} min</option>
                  ))}
                </select>
                <input
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  placeholder="Type"
                  className="flex-1 rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
                />
              </div>
              <button
                onClick={submitBooking}
                disabled={busy || !lead || !when}
                className="rounded-[9px] border border-accent bg-accent-soft px-3 py-2 text-[12.5px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60"
              >
                Book meeting
              </button>
              <p className="text-[11px] text-muted">
                Booking auto-generates a Claude brief — one call per booking.
              </p>
            </div>
          </div>

          <div className="rounded-card border border-line bg-panel p-2">
            {meetings.length === 0 && (
              <EmptyState title="no meetings yet" testId="meetings-empty" inset>
                Book one from a lead, or share your public booking page — the brief is
                written once, when the meeting is booked, and waits on the card.
              </EmptyState>
            )}
            {meetings.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelected(m.id)}
                className={`block w-full rounded-[10px] p-3 text-left ${
                  selected === m.id ? "bg-panel-2" : "hover:bg-panel-2"
                }`}
              >
                <b className="text-[13px]">{m.leadName}</b>
                <span className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
                  {fmtWhen(m.scheduledAt)}
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${BRIEF_BADGE[m.briefStatus].cls}`}>
                    {BRIEF_BADGE[m.briefStatus].label}
                  </span>
                  {m.outcome && (
                    <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-ink">
                      {m.outcome}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* right: detail */}
        <div className="rounded-card border border-line bg-panel p-[18px]">
          {!detail ? (
            <p className="text-[13px] text-muted">Select a meeting.</p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <b className="text-[15px]">{detail.leadName}</b>
                <span className="text-[12px] text-muted">{detail.company}</span>
                <span className="text-[12px] text-muted">· {fmtWhen(detail.scheduledAt)} · {detail.durationMin}m</span>
                <span className={`ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${BRIEF_BADGE[detail.briefStatus].cls}`}>
                  {BRIEF_BADGE[detail.briefStatus].label}
                </span>
              </div>

              <div className="mb-3 flex flex-wrap gap-2">
                {detail.briefStatus !== "done" && (
                  <button
                    onClick={genBrief}
                    disabled={busy || detail.briefStatus === "generating"}
                    className="rounded-[9px] border border-accent bg-accent-soft px-3 py-1.5 text-[12.5px] font-semibold hover:bg-panel-2 disabled:opacity-60"
                  >
                    ✦ {detail.briefStatus === "error" ? "Retry brief" : "Generate brief"}
                  </button>
                )}
                <button
                  onClick={reload}
                  className="rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2"
                >
                  Refresh
                </button>
                {detail.briefPdfPath && (
                  <a
                    href={`/api/files/${detail.briefPdfPath}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2"
                  >
                    ⬇ Brief PDF
                  </a>
                )}
                {detail.eventUrl && (
                  <a
                    href={detail.eventUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2"
                  >
                    Calendar event
                  </a>
                )}
              </div>

              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                ✦ Meeting brief (editable)
              </div>
              <textarea
                value={briefText}
                onChange={(e) => setBriefText(e.target.value)}
                placeholder={
                  detail.briefStatus === "generating"
                    ? "Claude is compiling the brief… hit Refresh in a moment."
                    : "No brief yet. Generate one, or type notes here."
                }
                className="min-h-[280px] w-full resize-y rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] p-3 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-accent"
              />
              <button
                onClick={saveBrief}
                disabled={busy}
                className="mt-2 rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-60"
              >
                Save edits
              </button>

              {/* outcome / handoff */}
              <div className="mt-5 border-t border-line pt-4">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                  Post-meeting outcome → handoff
                </div>
                {detail.outcome ? (
                  <p className="text-[12.5px] text-[#3DDC97]">
                    Logged: {detail.outcome}. Lead handed off.
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <select
                      value={result}
                      onChange={(e) => setResult(e.target.value as typeof result)}
                      className="rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
                    >
                      <option value="WON">Won</option>
                      <option value="LOST">Lost</option>
                      <option value="POSTPONED">Postponed</option>
                    </select>
                    <input
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      inputMode="numeric"
                      placeholder="Value (HUF)"
                      className="rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
                    />
                    <input
                      value={competitor}
                      onChange={(e) => setCompetitor(e.target.value)}
                      placeholder="Competitor (if lost)"
                      className="rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
                    />
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason / notes"
                      className="rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
                    />
                    <button
                      onClick={submitOutcome}
                      disabled={busy}
                      className="rounded-[9px] border border-line bg-panel px-3 py-2 text-[12.5px] font-semibold hover:bg-panel-2 disabled:opacity-60 sm:col-span-2"
                    >
                      Log outcome & hand off
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
