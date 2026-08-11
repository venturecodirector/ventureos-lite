"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  createCampaign,
  previewSegmentCount,
  activateCampaign,
  pauseCampaign,
  sendNow,
  type CampaignView,
  type ColdStatus,
} from "@/modules/campaigns/actions";

const INPUT =
  "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted focus:border-accent";

const STATUS_CHIP: Record<string, string> = {
  DRAFT: "bg-panel-2 text-muted",
  ACTIVE: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]",
  PAUSED: "bg-[rgba(245,184,65,0.12)] text-warn",
  COMPLETED: "bg-panel text-muted",
  DISABLED: "bg-panel text-muted",
};

export function Campaigns({ status, campaigns }: { status: ColdStatus; campaigns: CampaignView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // builder
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [source, setSource] = useState("");
  const [hasWebsite, setHasWebsite] = useState<string>("any");
  const [minScore, setMinScore] = useState("");
  const [dailyCap, setDailyCap] = useState("20");
  const [preview, setPreview] = useState<number | null>(null);

  function segment() {
    return {
      city: city || undefined,
      source: source || undefined,
      hasWebsite: hasWebsite === "any" ? undefined : hasWebsite === "yes",
      minAuditScore: minScore ? Number(minScore) : undefined,
    };
  }

  async function doPreview() {
    const res = await previewSegmentCount(segment());
    setPreview(res.count);
  }

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await createCampaign({ name, dailyCap: Number(dailyCap), segment: segment() });
    setBusy(false);
    if (res.ok) {
      setMsg("Campaign drafted (one Claude call) and created as a draft.");
      setName("");
      router.refresh();
    } else setMsg(res.error);
  }

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    await fn();
    setBusy(false);
    router.refresh();
  }

  // ---- LOCKED STATE (prototype compliance banner) ----
  if (!status.allowed) {
    return (
      <div className="max-w-[1000px]">
        <div className="mb-4 flex items-start gap-3 rounded-card border border-[rgba(245,184,65,0.35)] bg-[rgba(245,184,65,0.08)] p-4 text-[12.5px] leading-relaxed text-[#F5D9A0]">
          <span className="text-[16px]">⚖️</span>
          <span>
            <b>Cold email is locked for this workspace.</b> Hungarian law (2008. évi XLVIII. tv.)
            restricts unsolicited electronic advertising, including B2B. The module activates only
            after counsel sign-off is recorded in{" "}
            <Link href="/settings" className="text-accent-ink underline">
              Settings
            </Link>
            {" "}— this is a business gate, not a toggle.
          </span>
        </div>
        <div className="rounded-card border border-line bg-panel p-[18px] opacity-70">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <b className="text-[15px]">No-website plumbers · Budapest</b>
            <span className="rounded-full bg-[rgba(245,184,65,0.12)] px-2.5 py-0.5 text-[11px] font-semibold text-warn">paused — awaiting sign-off</span>
          </div>
          <p className="text-[12px] text-muted">Campaign building and every send path are blocked until sign-off is recorded.</p>
        </div>
      </div>
    );
  }

  // ---- ACTIVE STATE (builder + list) ----
  return (
    <div className="max-w-[1100px]">
      {msg && <p className="mb-3 text-[12px] text-[#C9CEE3]">{msg}</p>}

      <div className="mb-4 rounded-card border border-line bg-panel p-[18px]">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">New campaign</div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name *" className={`${INPUT} sm:col-span-2 lg:col-span-3`} />
          <input value={city} onChange={(e) => { setCity(e.target.value); setPreview(null); }} placeholder="City (segment)" className={INPUT} />
          <select value={source} onChange={(e) => { setSource(e.target.value); setPreview(null); }} className={INPUT}>
            <option value="">Any source</option>
            <option value="PROSPECTOR">Prospector</option>
            <option value="MANUAL">Manual</option>
            <option value="REFERRAL">Referral</option>
          </select>
          <select value={hasWebsite} onChange={(e) => { setHasWebsite(e.target.value); setPreview(null); }} className={INPUT}>
            <option value="any">Website: any</option>
            <option value="no">No website</option>
            <option value="yes">Has website</option>
          </select>
          <input value={minScore} onChange={(e) => { setMinScore(e.target.value); setPreview(null); }} inputMode="numeric" placeholder="Min audit score" className={INPUT} />
          <input value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} inputMode="numeric" placeholder="Daily cap" className={INPUT} />
          <button onClick={doPreview} className="rounded-[9px] border border-line bg-panel px-3 py-2 text-[12px] hover:bg-panel-2">
            Preview audience{preview !== null ? `: ${preview}` : ""}
          </button>
        </div>
        <button onClick={create} disabled={busy || !name.trim()} className="mt-2 rounded-[9px] border border-accent bg-accent-soft px-3 py-2 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60">
          ✦ Draft frame & create (one Claude call per campaign)
        </button>
      </div>

      {campaigns.length === 0 && <p className="text-[13px] text-muted">No campaigns yet.</p>}

      {campaigns.map((c) => (
        <div key={c.id} className="mb-4 rounded-card border border-line bg-panel p-[18px]">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-[15px]">{c.name}</b>
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_CHIP[c.status]}`}>{c.status.toLowerCase()}</span>
            <span className="ml-auto text-[12px] text-muted">Audience: {c.audience} recipients</span>
          </div>

          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            {[
              { v: `${c.sent} / ${c.audience}`, l: "Sent" },
              { v: c.replied || "—", l: "Replied" },
              { v: c.unsubscribed, l: "Unsubscribed" },
              { v: c.sent > 0 ? `${Math.round(c.bounceRate * 100)}%` : "—", l: "Bounce" },
            ].map((s) => (
              <div key={s.l} className="rounded-[10px] border border-line bg-panel-2 py-2">
                <b className="block text-[14px]">{s.v}</b>
                <span className="text-[11px] text-muted">{s.l}</span>
              </div>
            ))}
          </div>

          <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Sequence · stops on reply · daily cap {"·"} unsubscribe on every step</div>
          {c.steps.map((s) => (
            <div key={s.stepNumber} className="mt-2 flex gap-2.5 rounded-[10px] border border-line bg-panel-2 p-2.5">
              <div className="grid h-6 w-6 flex-none place-items-center rounded-full bg-accent-soft text-[12px] font-bold text-accent-ink">{s.stepNumber}</div>
              <div className="min-w-0">
                <b className="text-[12.5px]">{s.subject}</b>
                <p className="mt-0.5 whitespace-pre-wrap text-[11.5px] text-muted">{s.body.slice(0, 220)}</p>
              </div>
            </div>
          ))}

          {/* domain-health strip */}
          <div className="mt-3 grid gap-1.5 rounded-[10px] border border-line bg-panel-2 p-3 text-[12px]">
            <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#3DDC97]" />Domain: {c.coldDomain ?? "—"} (separate from transactional)</div>
            <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-warn" />Warm-up: week {c.warmupWeek} of 4</div>
            <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#3DDC97]" />Bounce rate: {c.sent > 0 ? `${Math.round(c.bounceRate * 100)}%` : "—"} (circuit breaker armed)</div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {c.status !== "ACTIVE" ? (
              <button onClick={() => act(() => activateCampaign(c.id))} disabled={busy} className="rounded-[9px] border border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60">Activate</button>
            ) : (
              <button onClick={() => act(() => pauseCampaign(c.id))} disabled={busy} className="rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2">Pause</button>
            )}
            <button onClick={() => act(async () => { const r = await sendNow(c.id); if (!r.ok) setMsg(r.error); })} disabled={busy || c.status !== "ACTIVE"} className="rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60">Send next batch</button>
          </div>
        </div>
      ))}

      <p className="mt-2 text-[12px] text-muted">Claude drafts the frame <b>once per campaign</b>, not per recipient — personalization fills from audit + registry data. Replies route into the Inbox.</p>
    </div>
  );
}
