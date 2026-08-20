"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  createReferrer,
  setLeadReferrer,
  type ReferrerOption,
} from "@/modules/referrals/actions";
import type { LedgerRow } from "@/modules/referrals/data";
import { STAGE_LABELS } from "@/modules/pipeline/transitions";
import type { Stage } from "@prisma/client";
import { EmptyState } from "./empty-state";

function huf(n: number): string {
  return `${n.toLocaleString("en-US").replace(/,/g, " ")} Ft`;
}

const INPUT =
  "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-muted focus:border-accent";

const OUTCOME_CHIP: Record<string, string> = {
  won: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]",
  lost: "bg-[rgba(255,92,122,0.12)] text-[#FFB3C2]",
  postponed: "bg-panel text-muted",
};

export function Referrers({
  ledger,
  referrers,
  leads,
  companies,
}: {
  ledger: LedgerRow[];
  referrers: ReferrerOption[];
  leads: Array<{ id: string; name: string; source: string; referrerId: string | null }>;
  companies: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // new referrer
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"PERSON" | "COMPANY">("PERSON");
  const [linkedCompanyId, setLinkedCompanyId] = useState("");

  // assign referral
  const [leadId, setLeadId] = useState(leads[0]?.id ?? "");
  const [source, setSource] = useState("REFERRAL");
  const [assignRef, setAssignRef] = useState("");

  async function addReferrer() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const res = await createReferrer({ name, kind, linkedCompanyId: linkedCompanyId || null });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setName("");
      setLinkedCompanyId("");
      router.refresh();
    }
  }

  async function assign() {
    if (!leadId) return;
    setBusy(true);
    setError(null);
    const res = await setLeadReferrer({
      leadId,
      source,
      referrerId: source === "REFERRAL" ? assignRef || null : null,
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  const totalRevenue = ledger.reduce((s, r) => s + r.attributedRevenue, 0);

  return (
    <div className="max-w-[1200px]">
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      {/*
        `items-start`, as every other two-column screen in the app has (and as the
        prototype's own grids do). Without it the ledger panel stretched to the
        height of the two forms beside it, so an empty ledger was a 570px box with
        its content floating at the top — the other half of "the design is broken".
      */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[300px_1fr]">
        {/* left: manage + assign */}
        <div className="grid gap-4">
          <div className="rounded-card border border-line bg-panel p-[18px]">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              New referrer
            </div>
            <div className="grid gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={INPUT} />
              <div className="flex gap-2">
                {(["PERSON", "COMPANY"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    className={`flex-1 rounded-[8px] border px-2 py-1.5 text-[12px] ${
                      kind === k ? "border-accent bg-accent-soft text-[#E4D3FF]" : "border-line text-[#C9CEE3]"
                    }`}
                  >
                    {k === "PERSON" ? "Person" : "Company"}
                  </button>
                ))}
              </div>
              <select value={linkedCompanyId} onChange={(e) => setLinkedCompanyId(e.target.value)} className={INPUT}>
                <option value="">Link to a client company… (optional)</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button
                onClick={addReferrer}
                disabled={busy || !name.trim()}
                className="rounded-[9px] border border-line bg-panel px-3 py-2 text-[12.5px] font-semibold hover:bg-panel-2 disabled:opacity-60"
              >
                Add referrer
              </button>
            </div>
          </div>

          <div className="rounded-card border border-line bg-panel p-[18px]">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Assign / edit a lead&rsquo;s source
            </div>
            <div className="grid gap-2">
              <select value={leadId} onChange={(e) => setLeadId(e.target.value)} className={INPUT}>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <select value={source} onChange={(e) => setSource(e.target.value)} className={INPUT}>
                {["REFERRAL", "MANUAL", "LINKEDIN", "PROSPECTOR", "COLD_EMAIL"].map((s) => (
                  <option key={s} value={s}>Source: {s.toLowerCase()}</option>
                ))}
              </select>
              {source === "REFERRAL" && (
                <select value={assignRef} onChange={(e) => setAssignRef(e.target.value)} className={INPUT}>
                  <option value="">Referred by… (optional)</option>
                  {referrers.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              )}
              <button
                onClick={assign}
                disabled={busy || !leadId}
                className="rounded-[9px] border border-line bg-panel px-3 py-2 text-[12.5px] font-semibold hover:bg-panel-2 disabled:opacity-60"
              >
                Save assignment
              </button>
            </div>
          </div>
        </div>

        {/* right: ledger */}
        <div className="rounded-card border border-line bg-panel p-[18px]">
          <div className="mb-3 flex items-baseline gap-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Referrer ledger
            </div>
            <span className="ml-auto text-[12px] text-muted">
              Attributed revenue <b className="text-ink">{huf(totalRevenue)}</b>
            </span>
          </div>

          {ledger.length === 0 && (
            <EmptyState title="no referrers yet" testId="referrers-empty" inset>
              A referrer is the person or company who made an introduction. Tag a lead as
              a referral and the revenue it produces is attributed back to them here.
            </EmptyState>
          )}

          {ledger.map((r) => (
            <div key={r.referrerId} className="mb-2 rounded-[11px] border border-line bg-panel-2">
              <button
                onClick={() => setExpanded(expanded === r.referrerId ? null : r.referrerId)}
                className="flex w-full items-center gap-2 px-3.5 py-3 text-left"
              >
                <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-muted">
                  {r.kind === "company" ? "company" : "person"}
                </span>
                <b className="text-[13px]">{r.name}</b>
                {r.linkedCompany && <span className="text-[11.5px] text-muted">· {r.linkedCompany}</span>}
                <span className="ml-auto flex items-center gap-3 text-[11.5px] text-muted tabular-nums">
                  <span>{r.referred} referred</span>
                  <span className="text-[#3DDC97]">{r.won} won</span>
                  <span>{r.open} open</span>
                  <b className="text-ink">{huf(r.attributedRevenue)}</b>
                  <span>{expanded === r.referrerId ? "▲" : "▼"}</span>
                </span>
              </button>
              {expanded === r.referrerId && (
                <div className="border-t border-line px-3.5 py-2">
                  {r.leads.length === 0 ? (
                    <p className="py-1 text-[12px] text-muted">No referred leads yet.</p>
                  ) : (
                    r.leads.map((l) => (
                      <div key={l.id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                        <span className="text-[#C9CEE3]">{l.name}</span>
                        {l.company && <span className="text-[11px] text-muted">· {l.company}</span>}
                        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted">
                          <span className="rounded-full bg-panel px-2 py-0.5">
                            {STAGE_LABELS[l.stage as Stage] ?? l.stage}
                          </span>
                          {l.result && (
                            <span className={`rounded-full px-2 py-0.5 font-semibold ${OUTCOME_CHIP[l.result]}`}>
                              {l.result}
                              {l.result === "won" ? ` · ${huf(l.value)}` : ""}
                            </span>
                          )}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
