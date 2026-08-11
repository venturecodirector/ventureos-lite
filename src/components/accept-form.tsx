"use client";

import { useState } from "react";
import { acceptQuote } from "@/modules/documents/acceptance";

const INPUT =
  "mb-2 w-full rounded-[9px] border border-line bg-[rgba(239,241,248,0.04)] px-3 py-2.5 text-[12.5px] text-ink outline-none placeholder:text-muted focus:border-accent";

export function AcceptForm({ slug }: { slug: string }) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await acceptQuote(slug, { name, company, agreed });
    if (res.ok) setDone(name || "köszönjük");
    else setError(res.error);
    setBusy(false);
  }

  if (done) {
    return (
      <div className="rounded-[10px] border border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.1)] px-3.5 py-3 text-[13px] text-[#8FE9C3]">
        Elfogadva — köszönjük, {done}!
      </div>
    );
  }

  return (
    <div>
      {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Név" className={INPUT} />
      <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Cégnév" className={INPUT} />
      <label className="mb-3.5 flex gap-2 text-[11.5px] leading-relaxed text-muted">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5"
          style={{ accentColor: "#7427C6" }}
        />
        Az ajánlatot elfogadom. Az elfogadás ténye, időpontja és IP-címe rögzítésre kerül.
      </label>
      <button
        onClick={submit}
        disabled={busy}
        className="w-full rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2.5 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
      >
        {busy ? "Feldolgozás…" : "Ajánlat elfogadása"}
      </button>
    </div>
  );
}
