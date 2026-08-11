"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setReportComment } from "@/modules/analytics/report-actions";

export function ReportComment({ id, initial }: { id: string; initial: string | null }) {
  const router = useRouter();
  const [comment, setComment] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setSaved(false);
    const res = await setReportComment({ id, comment });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      router.refresh();
    }
  }

  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        Note from the team
      </div>
      <textarea
        value={comment}
        onChange={(e) => {
          setComment(e.target.value);
          setSaved(false);
        }}
        placeholder="Fanni's comment for this week's report…"
        className="min-h-[64px] w-full resize-y rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] p-3 text-[12.5px] text-ink outline-none focus:border-accent"
      />
      <div className="mt-1.5 flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-[9px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save comment"}
        </button>
        {saved && <span className="text-[11px] text-[#3DDC97]">Saved</span>}
      </div>
    </div>
  );
}
