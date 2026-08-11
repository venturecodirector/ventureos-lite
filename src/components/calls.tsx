"use client";

import { useEffect, useRef, useState } from "react";
import { CALLBACK_CHIPS, type CallbackChip } from "@/modules/calls/schedule";
import {
  logCall,
  listDueCallbacks,
  listRecentCalls,
  completeCallback,
  type DueCallback,
  type RecentCall,
} from "@/modules/calls/actions";

const OUTCOMES: Array<{ key: string; label: string }> = [
  { key: "NO_ANSWER", label: "No answer" },
  { key: "CALLBACK_REQUESTED", label: "Callback requested" },
  { key: "INTERESTED", label: "Interested" },
  { key: "NOT_INTERESTED", label: "Not interested" },
  { key: "WRONG_NUMBER", label: "Wrong number" },
];

const OUTCOME_ICON: Record<string, { ch: string; cls: string }> = {
  INTERESTED: { ch: "✓", cls: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]" },
  CALLBACK_REQUESTED: { ch: "↺", cls: "bg-[rgba(245,184,65,0.12)] text-warn" },
  NO_ANSWER: { ch: "—", cls: "bg-[rgba(133,140,174,0.12)] text-muted" },
  NOT_INTERESTED: { ch: "✕", cls: "bg-[rgba(255,92,122,0.12)] text-[#FF5C7A]" },
  WRONG_NUMBER: { ch: "?", cls: "bg-[rgba(133,140,174,0.12)] text-muted" },
};

function fmt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function Calls({
  leads,
  initialDue,
  initialRecent,
}: {
  leads: Array<{ id: string; name: string }>;
  initialDue: DueCallback[];
  initialRecent: RecentCall[];
}) {
  const [leadId, setLeadId] = useState(leads[0]?.id ?? "");
  const [outcome, setOutcome] = useState("CALLBACK_REQUESTED");
  const [chip, setChip] = useState<CallbackChip | "custom" | null>(null);
  const [customAt, setCustomAt] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [due, setDue] = useState(initialDue);
  const [recent, setRecent] = useState(initialRecent);
  const [notify, setNotify] = useState<"unknown" | "granted" | "denied">("unknown");
  const notified = useRef<Set<string>>(new Set());

  // Register the service worker (PWA installability + future push).
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    if ("Notification" in window && Notification.permission === "granted") {
      setNotify("granted");
    }
  }, []);

  // Poll due callbacks; fire a notification when one becomes due (app open).
  useEffect(() => {
    const fireFor = (items: DueCallback[]) => {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      for (const d of items) {
        if (d.due && !notified.current.has(d.callId)) {
          notified.current.add(d.callId);
          new Notification("Callback due", { body: d.name, icon: "/icon.svg" });
        }
      }
    };
    fireFor(due);
    const iv = setInterval(async () => {
      const fresh = await listDueCallbacks();
      setDue(fresh);
      fireFor(fresh);
    }, 60_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function enableReminders() {
    if (!("Notification" in window)) return;
    const perm = await Notification.requestPermission();
    setNotify(perm === "granted" ? "granted" : "denied");
  }

  async function refresh() {
    const [d, r] = await Promise.all([listDueCallbacks(), listRecentCalls()]);
    setDue(d);
    setRecent(r);
  }

  async function save() {
    if (!leadId) return;
    setSaving(true);
    try {
      await logCall({
        leadId,
        outcome,
        note: note || undefined,
        ...(chip && chip !== "custom" ? { callbackChip: chip } : {}),
        ...(chip === "custom" && customAt
          ? { callbackAt: new Date(customAt).toISOString() }
          : {}),
      });
      setNote("");
      setChip(null);
      setCustomAt("");
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function complete(callId: string) {
    await completeCallback(callId);
    await refresh();
  }

  return (
    <div className="grid max-w-[1400px] grid-cols-1 items-start gap-4 lg:grid-cols-[340px_1fr]">
      {/* one-thumb log sheet */}
      <div className="rounded-card border border-line bg-panel p-[18px]">
        <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Log a call
        </div>
        <select
          value={leadId}
          onChange={(e) => setLeadId(e.target.value)}
          className="mb-1 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
        >
          {leads.length === 0 && <option value="">No leads yet</option>}
          {leads.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>

        <div className="my-3 grid grid-cols-2 gap-2.5">
          {OUTCOMES.map((o) => (
            <button
              key={o.key}
              onClick={() => setOutcome(o.key)}
              className={`min-h-[44px] rounded-[11px] border px-2.5 py-3 text-center text-[12.5px] font-semibold ${
                outcome === o.key
                  ? "border-accent bg-accent-soft text-[#E4D3FF]"
                  : "border-line bg-panel text-ink hover:border-accent-soft hover:bg-panel-2"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Callback
        </div>
        <div className="flex flex-wrap gap-2">
          {CALLBACK_CHIPS.map((c) => (
            <button
              key={c.key}
              onClick={() => setChip(chip === c.key ? null : c.key)}
              className={`min-h-[36px] rounded-full border px-3 text-[12px] ${
                chip === c.key
                  ? "border-accent bg-accent-soft text-[#E4D3FF]"
                  : "border-line bg-panel text-[#C9CEE3] hover:border-accent"
              }`}
            >
              {c.label}
            </button>
          ))}
          <button
            onClick={() => setChip(chip === "custom" ? null : "custom")}
            className={`min-h-[36px] rounded-full border px-3 text-[12px] ${
              chip === "custom"
                ? "border-accent bg-accent-soft text-[#E4D3FF]"
                : "border-line bg-panel text-[#C9CEE3] hover:border-accent"
            }`}
          >
            Pick…
          </button>
        </div>
        {chip === "custom" && (
          <input
            type="datetime-local"
            value={customAt}
            onChange={(e) => setCustomAt(e.target.value)}
            className="mt-2 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent"
          />
        )}

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note — 'ask for Gábor, he decides on the website'"
          className="mt-3 min-h-[56px] w-full resize-y rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] p-3 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
        />
        <button
          onClick={save}
          disabled={saving || !leadId}
          className="mt-3 w-full rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2.5 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save call"}
        </button>
        <p className="mt-2.5 text-[11px] text-muted">
          One-thumb sized — built for logging from the street. Callbacks land in
          Today Queue on time.
        </p>
      </div>

      {/* due + recent */}
      <div>
        <div className="mb-3.5 rounded-card border border-line bg-panel p-[18px]">
          <div className="flex items-center">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Due callbacks
            </div>
            {notify !== "granted" && (
              <button
                onClick={enableReminders}
                className="ml-auto rounded-[10px] border border-line bg-panel px-3 py-1 text-[11.5px] hover:bg-panel-2"
              >
                {notify === "denied" ? "Reminders blocked" : "Enable reminders"}
              </button>
            )}
          </div>
          {due.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-muted">No callbacks scheduled.</p>
          ) : (
            due.map((d) => (
              <div
                key={d.callId}
                className="flex items-center gap-3 border-b border-line py-2.5 last:border-0"
              >
                <div className="grid h-7 w-7 flex-none place-items-center rounded-[9px] bg-[rgba(245,184,65,0.12)] text-[12px] text-warn">
                  ↺
                </div>
                <div className="min-w-0 flex-1">
                  <b className="text-[13px]">{d.name}</b>
                  <span className="block text-[11.5px] text-muted">
                    {fmt(d.at)}
                    {d.note ? ` · ${d.note}` : ""}
                  </span>
                </div>
                {d.due && (
                  <span className="rounded-full bg-[rgba(245,184,65,0.12)] px-2.5 py-0.5 text-[11px] font-semibold text-warn">
                    due
                  </span>
                )}
                <button
                  onClick={() => complete(d.callId)}
                  className="rounded-[10px] border border-line bg-panel px-3 py-1 text-[11.5px] hover:bg-panel-2"
                >
                  Done
                </button>
              </div>
            ))
          )}
        </div>

        <div className="rounded-card border border-line bg-panel p-[18px]">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Recent calls
          </div>
          {recent.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-muted">No calls logged yet.</p>
          ) : (
            recent.map((c) => {
              const ic = OUTCOME_ICON[c.outcome] ?? OUTCOME_ICON.NO_ANSWER;
              return (
                <div
                  key={c.callId}
                  className="flex items-center gap-3 border-b border-line py-2.5 last:border-0"
                >
                  <div className={`grid h-7 w-7 flex-none place-items-center rounded-[9px] text-[12px] ${ic.cls}`}>
                    {ic.ch}
                  </div>
                  <div className="min-w-0 flex-1">
                    <b className="text-[13px]">{c.name}</b>
                    <span className="block text-[11.5px] text-muted">
                      {c.outcome.toLowerCase().replace(/_/g, " ")}
                      {c.note ? ` — ${c.note}` : ""}
                    </span>
                  </div>
                  <span className="text-[11.5px] text-muted">{fmt(c.at)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
