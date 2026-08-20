"use client";
import { serverActionError } from "@/lib/client/server-action";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createLeadManual } from "@/modules/leads/actions";
import { listReferrers, type ReferrerOption } from "@/modules/referrals/actions";
import { Modal } from "./modal";

const SOURCE_OPTIONS = [
  { value: "MANUAL", label: "Manual" },
  { value: "REFERRAL", label: "Referral" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "PROSPECTOR", label: "Prospector" },
  { value: "COLD_EMAIL", label: "Cold email" },
] as const;

export function ManualLeadForm({
  onClose,
  onDone,
  navigateOnCreate = false,
}: {
  onClose: () => void;
  /** Called after a successful create; the caller decides what to refresh. */
  onDone: (leadId: string) => void;
  /** Open the new lead after creating it (the shell's "+ New lead" flow). */
  navigateOnCreate?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  const [source, setSource] = useState<string>("MANUAL");
  const [referrerId, setReferrerId] = useState<string>("");
  const [referrers, setReferrers] = useState<ReferrerOption[]>([]);

  useEffect(() => {
    listReferrers().then(setReferrers);
  }, []);

  async function submit(form: FormData) {
    setBusy(true);
    setMsg(null);
    setDuplicateOf(null);
    try {
      const res = await createLeadManual({
        contactName: String(form.get("contactName") || ""),
        title: String(form.get("title") || ""),
        email: String(form.get("email") || ""),
        phone: String(form.get("phone") || ""),
        linkedinUrl: String(form.get("linkedinUrl") || ""),
        notes: String(form.get("notes") || ""),
        source,
        referrerId: source === "REFERRAL" ? referrerId || undefined : undefined,
        company: {
          name: String(form.get("companyName") || ""),
          domain: String(form.get("companyDomain") || ""),
          industry: String(form.get("industry") || ""),
          sizeBand: String(form.get("sizeBand") || ""),
          taxId: String(form.get("companyTaxId") || ""),
        },
      });
      if (res.ok) {
        // Dedupe already ran server-side (adószám first, then email /
        // LinkedIn / domain) — reaching here means this is genuinely new.
        if (navigateOnCreate) router.push(`/leads?lead=${res.leadId}`);
        onDone(res.leadId);
        return;
      }
      setDuplicateOf(res.duplicateOf);
      setMsg("This matches a lead you already have.");
    } catch (e) {
      setMsg(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  const input =
    "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent";

  return (
    <Modal onClose={onClose} labelledBy="manual-lead-title">
      <div className="mb-3 flex items-center">
        <h3 id="manual-lead-title" className="font-display text-lg font-bold lowercase">add a lead manually</h3>
        <button type="button" aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">
          ✕
        </button>
      </div>
      <form action={submit} className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <input name="contactName" placeholder="Contact name" data-testid="manual-name" className={input} />
        <input name="title" placeholder="Title" className={input} />
        <input name="email" placeholder="Email" data-testid="manual-email" className={input} />
        <input name="phone" placeholder="Phone" className={input} />
        <input name="linkedinUrl" placeholder="LinkedIn URL" className={`${input} sm:col-span-2`} />
        <input name="companyName" placeholder="Company name *" required data-testid="manual-company" className={input} />
        <input name="companyDomain" placeholder="Company domain" className={input} />
        <input name="companyTaxId" placeholder="Adószám (tax id)" className={input} />
        <input name="industry" placeholder="Industry" className={input} />
        <input name="sizeBand" placeholder="Size band (e.g. 24 employees)" className={input} />
        <select value={source} onChange={(e) => setSource(e.target.value)} className={input}>
          {SOURCE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              Source: {s.label}
            </option>
          ))}
        </select>
        {source === "REFERRAL" ? (
          <select
            value={referrerId}
            onChange={(e) => setReferrerId(e.target.value)}
            className={input}
          >
            <option value="">Referred by… (optional)</option>
            {referrers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.linkedCompany ? ` · ${r.linkedCompany}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <div />
        )}
        <textarea name="notes" placeholder="Notes" className={`${input} min-h-[60px] sm:col-span-2`} />
        {msg && (
          <p
            className="col-span-1 flex flex-wrap items-center gap-2 text-[12px] text-[#FFB3C2] sm:col-span-2"
            role="alert"
            data-testid="manual-lead-error"
          >
            {msg}
            {duplicateOf && (
              <button
                type="button"
                onClick={() => {
                  router.push(`/leads?lead=${duplicateOf}`);
                  onClose();
                }}
                className="underline underline-offset-2 hover:text-ink"
              >
                Open it
              </button>
            )}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2 sm:col-span-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            data-testid="manual-submit"
            className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {busy ? "Saving…" : "Add lead"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

