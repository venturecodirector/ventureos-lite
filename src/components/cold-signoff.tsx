"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { recordSignoff, type ColdStatus } from "@/modules/campaigns/actions";

const INPUT =
  "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted focus:border-accent";

export function ColdSignoff({ status, isOwner }: { status: ColdStatus; isOwner: boolean }) {
  const router = useRouter();
  const [approvedBy, setApprovedBy] = useState(status.signoff?.approvedBy ?? "");
  const [date, setDate] = useState(status.signoff?.date ?? "");
  const [scopeNote, setScopeNote] = useState(status.signoff?.scopeNote ?? "");
  const [coldDomain, setColdDomain] = useState(status.coldDomain ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await recordSignoff({ approvedBy, date, scopeNote, coldDomain });
    setBusy(false);
    if (res.ok) {
      setMsg("Sign-off recorded — the Cold Email module is now active for this workspace.");
      router.refresh();
    } else setMsg(res.error);
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        Cold email · counsel sign-off
        {status.allowed ? (
          <span className="rounded-full bg-[rgba(61,220,151,0.12)] px-2 py-0.5 text-[10px] font-semibold text-[#3DDC97]">active</span>
        ) : (
          <span className="rounded-full bg-[rgba(245,184,65,0.12)] px-2 py-0.5 text-[10px] font-semibold text-warn">locked</span>
        )}
      </div>
      <p className="mb-3 text-[11.5px] leading-relaxed text-muted">
        Hungarian law (2008. évi XLVIII. tv.) restricts unsolicited electronic advertising, including
        B2B. The module activates only once counsel sign-off is recorded here — who approved, when,
        and the scope. This is a business gate, not a toggle.
      </p>
      {msg && <p className="mb-2 text-[12px] text-[#C9CEE3]">{msg}</p>}

      {isOwner ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <input value={approvedBy} onChange={(e) => setApprovedBy(e.target.value)} placeholder="Approved by (counsel) *" className={INPUT} />
          <input value={date} onChange={(e) => setDate(e.target.value)} type="date" className={INPUT} />
          <input value={coldDomain} onChange={(e) => setColdDomain(e.target.value)} placeholder="Cold domain (separate from transactional) *" className={INPUT} />
          <input value={scopeNote} onChange={(e) => setScopeNote(e.target.value)} placeholder="Scope note (e.g. B2B legitimate interest) *" className={`${INPUT} sm:col-span-1`} />
          <button onClick={save} disabled={busy} className="w-fit rounded-[9px] border border-accent bg-accent-soft px-3 py-2 text-[12px] font-semibold text-[#E4D3FF] disabled:opacity-60 sm:col-span-2">
            {status.allowed ? "Update sign-off" : "Record sign-off & activate"}
          </button>
        </div>
      ) : (
        <p className="text-[12px] text-muted">Only an Owner can record counsel sign-off.</p>
      )}
    </div>
  );
}
