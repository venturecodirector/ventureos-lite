"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  requestLeadErasure,
  setRetention,
  runExport,
} from "@/modules/gdpr/actions";
import type { RetentionPolicy } from "@/modules/gdpr/retention";

const INPUT =
  "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none focus:border-accent";

export function GdprPanel({
  retention,
  leads,
  isOwner,
  canExport,
}: {
  retention: RetentionPolicy;
  leads: Array<{ id: string; name: string }>;
  isOwner: boolean;
  canExport: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // retention
  const [days, setDays] = useState(retention.anonymizeAfterDays);
  const [eraseDocs, setEraseDocs] = useState(retention.eraseDocumentsOnErasure);
  const [backupDays, setBackupDays] = useState(retention.backupRotationDays);

  // erasure
  const [eraseLead, setEraseLead] = useState(leads[0]?.id ?? "");
  const [confirm, setConfirm] = useState("");

  // export
  const [exportPath, setExportPath] = useState<string | null>(null);

  async function saveRetention() {
    setBusy(true);
    setMsg(null);
    const res = await setRetention({
      anonymizeAfterDays: days,
      eraseDocumentsOnErasure: eraseDocs,
      backupRotationDays: backupDays,
    });
    setBusy(false);
    setMsg(res.ok ? "Retention settings saved." : res.error);
    if (res.ok) router.refresh();
  }

  async function erase() {
    if (confirm !== "ERASE") {
      setMsg('Type ERASE to confirm.');
      return;
    }
    setBusy(true);
    setMsg(null);
    const res = await requestLeadErasure(eraseLead);
    setBusy(false);
    if (res.ok) {
      setConfirm("");
      setMsg("Erasure queued — completes within 72h and is audit-logged.");
      router.refresh();
    } else setMsg(res.error);
  }

  async function doExport() {
    setBusy(true);
    setMsg(null);
    const res = await runExport();
    setBusy(false);
    if (res.ok) {
      setExportPath(res.path);
      setMsg("Export ready.");
    } else setMsg(res.error);
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        Data & privacy (GDPR)
      </div>
      <p className="mb-3 text-[11.5px] text-muted">
        Retention, right-to-erasure, and data portability. Erasure and retention are Owner-only and
        audit-logged; backups expire within the {retention.backupRotationDays}-day rotation.
      </p>

      {msg && <p className="mb-3 text-[12px] text-[#C9CEE3]">{msg}</p>}

      {/* Retention */}
      <div className="mb-4 grid gap-2 rounded-[11px] border border-line bg-panel-2 p-3.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Retention policy</div>
        <label className="flex items-center justify-between gap-2 text-[12.5px] text-[#C9CEE3]">
          Anonymize inactive leads after (days)
          <input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={!isOwner} className={`${INPUT} w-28 text-right`} />
        </label>
        <label className="flex items-center justify-between gap-2 text-[12.5px] text-[#C9CEE3]">
          Backup rotation window (days)
          <input type="number" value={backupDays} onChange={(e) => setBackupDays(Number(e.target.value))} disabled={!isOwner} className={`${INPUT} w-28 text-right`} />
        </label>
        <label className="flex items-center gap-2 text-[12.5px] text-[#C9CEE3]">
          <input type="checkbox" checked={eraseDocs} onChange={(e) => setEraseDocs(e.target.checked)} disabled={!isOwner} style={{ accentColor: "#7427C6" }} />
          Purge legal documents on erasure (default: retain under legal basis, detached)
        </label>
        {isOwner && (
          <button onClick={saveRetention} disabled={busy} className="mt-1 w-fit rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12px] font-semibold hover:bg-panel-2 disabled:opacity-60">
            Save retention
          </button>
        )}
      </div>

      {/* Export */}
      <div className="mb-4 grid gap-2 rounded-[11px] border border-line bg-panel-2 p-3.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Full data export</div>
        <p className="text-[12px] text-muted">CSV bundle (leads, companies, activities, calls, outcomes, documents).</p>
        {canExport ? (
          <div className="flex items-center gap-2">
            <button onClick={doExport} disabled={busy} className="w-fit rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12px] font-semibold hover:bg-panel-2 disabled:opacity-60">
              {busy ? "Building…" : "Export CSV bundle"}
            </button>
            {exportPath && (
              <a href={`/api/files/${exportPath}`} className="rounded-[9px] border border-accent bg-accent-soft px-3 py-1.5 text-[12px] font-semibold text-[#E4D3FF]">
                ⬇ Download .zip
              </a>
            )}
          </div>
        ) : (
          <p className="text-[11.5px] text-muted">Requires the <code className="text-accent-ink">exports.run</code> grant.</p>
        )}
      </div>

      {/* Erasure */}
      {isOwner && (
        <div className="grid gap-2 rounded-[11px] border border-[rgba(255,92,122,0.3)] bg-[rgba(255,92,122,0.06)] p-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#FFB3C2]">Erase a lead (right to erasure)</div>
          <p className="text-[12px] text-muted">Hard-deletes the lead and all derived data within 72h. Irreversible.</p>
          <select value={eraseLead} onChange={(e) => setEraseLead(e.target.value)} className={INPUT}>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type ERASE to confirm" className={`${INPUT} flex-1`} />
            <button onClick={erase} disabled={busy || !eraseLead} className="rounded-[9px] border border-[rgba(255,92,122,0.4)] bg-[rgba(255,92,122,0.12)] px-3 py-2 text-[12px] font-semibold text-[#FFB3C2] disabled:opacity-60">
              Request erasure
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
