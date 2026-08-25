"use client";

import { useState, useTransition } from "react";
import { attempt } from "@/lib/client/server-action";
import { requestSectorReport } from "@/modules/sector-reports/download";

/**
 * The download form (playbook-v4 P12/2c).
 *
 * TWO SEPARATE BOXES, and the second one starts unchecked and stays that way
 * unless somebody ticks it. The first exists so there is something to deliver
 * and a basis to hold an address; the second is the only lawful basis for
 * writing to them afterwards. Bundling them — "download implies consent" — is
 * the thing that makes a lead magnet indefensible.
 */
const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent";

export function SectorReportForm({ slug }: { slug: string }) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [service, setService] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await attempt(
        requestSectorReport({
          slug,
          name,
          email,
          companyName: company || undefined,
          serviceConsent: service as true,
          marketingConsent: marketing,
          website,
        }),
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setUrl(res.url);
    });
  }

  if (url) {
    return (
      <div className="rounded-[10px] border border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.1)] px-4 py-3.5">
        <p className="text-[13px] text-[#8FE9C3]">Köszönjük — a riport letölthető.</p>
        <a
          href={url}
          className="mt-2 inline-block rounded-[9px] bg-grad px-4 py-2 text-[12.5px] font-semibold text-ink"
          data-testid="report-download"
        >
          Riport megnyitása (PDF)
        </a>
      </div>
    );
  }

  return (
    <div className="grid gap-2.5">
      {error && (
        <p className="rounded-[9px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2 text-[12.5px] text-[#FFB3C2]">
          {error}
        </p>
      )}
      <input className={INPUT} placeholder="Név" value={name} onChange={(e) => setName(e.target.value)} data-testid="report-name" />
      <input className={INPUT} placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="report-email" />
      <input className={INPUT} placeholder="Cég (nem kötelező)" value={company} onChange={(e) => setCompany(e.target.value)} />

      {/* Honeypot: hidden from people, irresistible to form bots. */}
      <input
        className="hidden"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
      />

      <label className="flex items-start gap-2 text-[12px] leading-relaxed text-muted">
        <input
          type="checkbox"
          checked={service}
          onChange={(e) => setService(e.target.checked)}
          data-testid="report-consent-service"
          className="mt-0.5 h-3.5 w-3.5 accent-[#7427C6]"
        />
        Kérem a riportot e-mailben. *
      </label>
      <label className="flex items-start gap-2 text-[12px] leading-relaxed text-muted">
        <input
          type="checkbox"
          checked={marketing}
          onChange={(e) => setMarketing(e.target.checked)}
          data-testid="report-consent-marketing"
          className="mt-0.5 h-3.5 w-3.5 accent-[#7427C6]"
        />
        Megkereshetnek a riport tanulságaival kapcsolatban. (nem kötelező)
      </label>

      <button
        onClick={submit}
        disabled={pending || !service || !name.trim() || !email.trim()}
        data-testid="report-submit"
        className="rounded-[10px] bg-grad px-4 py-2.5 text-[13px] font-semibold text-ink disabled:opacity-45"
      >
        {pending ? "Egy pillanat…" : "Kérem a teljes riportot"}
      </button>
    </div>
  );
}
