"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setSzamlazzKey } from "@/modules/invoicing/actions";

export function SzamlazzKey({ hasKey, isOwner }: { hasKey: boolean; isOwner: boolean }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    if (!key.trim()) return;
    setBusy(true);
    const res = await setSzamlazzKey(key.trim());
    setBusy(false);
    setMsg(res.ok ? "Számla Agent key saved." : res.error);
    if (res.ok) {
      setKey("");
      router.refresh();
    }
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        Számlázz.hu · Számla Agent
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${hasKey ? "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]" : "bg-panel-2 text-muted"}`}>
          {hasKey ? "key set" : "not set"}
        </span>
      </div>
      <p className="mb-2 text-[11.5px] text-muted">
        Per-workspace Agent key used to submit invoices from acknowledged certificates. Stored
        server-side; never shown after saving.
      </p>
      {msg && <p className="mb-2 text-[12px] text-[#C9CEE3]">{msg}</p>}
      {isOwner ? (
        <div className="flex gap-2">
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? "Replace agent key…" : "Agent key"}
            className="flex-1 rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none focus:border-accent"
          />
          <button onClick={save} disabled={busy || !key.trim()} className="rounded-[9px] border border-line bg-panel px-3 py-2 text-[12px] font-semibold hover:bg-panel-2 disabled:opacity-60">
            Save key
          </button>
        </div>
      ) : (
        <p className="text-[12px] text-muted">Only an Owner can set the Agent key.</p>
      )}
    </div>
  );
}
