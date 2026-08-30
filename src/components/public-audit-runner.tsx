"use client";

import { useEffect, useRef, useState } from "react";
import {
  submitPublicAudit,
  getPublicAuditStatus,
  type PublicAuditStatus,
} from "@/modules/public-audit/actions";
import { unlockFullReport } from "@/modules/public-audit/unlock";
import { copyFor, withBrand } from "@/modules/public-audit/copy";
import type { Locale } from "@/lib/locale";
import { JobProgress } from "./job-progress";
import { auditStagesFor, currentAuditStage } from "@/modules/audit/stages";

/**
 * The one interactive region of the landing page (P12/1a, 1b).
 *
 * Everything else on the page is server-rendered content; this island owns the
 * URL form, the honest progress display, the free teaser, and the form that
 * unlocks the full report.
 *
 * The teaser is deliberately valuable and deliberately incomplete: a score,
 * the three findings that matter most, and both screenshots. Enough to be
 * worth the minute; not so much that the report has nothing left to give.
 */
const POLL_MS = 1500;
/**
 * Outlast the worker's own five-minute ceiling.
 *
 * At two minutes this gave up on runs that were still perfectly healthy, and
 * gave up SILENTLY: the spinner kept turning and the visitor — an anonymous
 * prospect with no reason to be patient — watched a page that was never going
 * to change. The visitor-facing timeout now ends in a sentence, not in
 * nothing (see `timedOut` below).
 */
const POLL_TIMEOUT_MS = 360_000;

type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "running"; id: string; startedAt: number }
  | { kind: "done"; status: PublicAuditStatus }
  | { kind: "refused"; message: string; friendly: boolean };

export function AuditRunnerIsland({
  locale,
  brandName,
}: {
  locale: Locale;
  /** The workspace collecting the data — it is named in the consent line. */
  brandName: string;
}) {
  const copy = copyFor(locale);
  const [url, setUrl] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [status, setStatus] = useState<PublicAuditStatus | null>(null);
  /** The page stopped asking; the audit may well still be running. */
  const [timedOut, setTimedOut] = useState(false);
  const shownAt = useRef<number>(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    shownAt.current = Date.now();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (phase.kind !== "running") return;
    let active = true;
    const started = Date.now();

    const tick = async () => {
      // A dropped request used to end the poll for good: the rejection escaped
      // the loop, so no further tick was scheduled and the page hung.
      const s = await getPublicAuditStatus(phase.id).catch(() => null);
      if (!active) return;
      if (s) {
        setStatus(s);
        if (s.status === "done" || s.status === "error") {
          setPhase({ kind: "done", status: s });
          return;
        }
      }
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        setTimedOut(true);
        return;
      }
      timer.current = setTimeout(tick, POLL_MS);
    };
    timer.current = setTimeout(tick, 600);
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [phase]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setPhase({ kind: "submitting" });
    const res = await submitPublicAudit({
      url,
      website: honeypot,
      elapsedMs: Date.now() - shownAt.current,
    });
    if (!res.ok) {
      setPhase({ kind: "refused", message: res.message, friendly: res.friendly });
      return;
    }
    setTimedOut(false);
    setPhase({ kind: "running", id: res.publicAuditId, startedAt: Date.now() });
  }

  const busy = phase.kind === "submitting" || phase.kind === "running";

  // Self-serve audits are always single-page and never buy a Claude call
  // (P12/1), so the crawl and pitch steps are correctly absent here.
  const STAGES = auditStagesFor({}, copy.progress.stages);

  return (
    <div>
      <form onSubmit={run} className="flex flex-wrap gap-2.5">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={copy.hero.inputPlaceholder}
          inputMode="url"
          autoComplete="off"
          disabled={busy}
          data-testid="public-audit-url"
          aria-label={copy.hero.inputLabel}
          className="min-h-[52px] min-w-[220px] flex-1 rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-4 py-3 text-[15px] text-ink outline-none focus:border-accent disabled:opacity-60"
        />
        {/*
          Honeypot. Off-screen rather than display:none — some bots skip hidden
          inputs but fill positioned ones. Never shown to a person, and
          tabIndex -1 keeps it out of keyboard order.
        */}
        <input
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="absolute left-[-9999px] h-0 w-0 opacity-0"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          data-testid="public-audit-submit"
          className="min-h-[52px] rounded-[10px] border-[1.5px] border-transparent bg-canvas px-6 text-[14px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {busy ? copy.hero.ctaBusy : copy.hero.cta}
        </button>
      </form>
      <p className="mt-2 text-[12px] text-muted">{copy.hero.reassurance}</p>

      {phase.kind === "refused" && (
        <div
          data-testid="public-audit-refused"
          className={`mt-4 rounded-card border px-4 py-3 text-[13.5px] ${
            phase.friendly
              ? "border-accent-soft bg-accent-soft text-[#E4D3FF]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] text-[#FFB3C2]"
          }`}
        >
          {phase.message}
        </div>
      )}

      {phase.kind === "running" && (
        <div className="mt-4">
          {status && status.queuePosition > 0 && (
            <p className="mb-2 text-[12.5px] text-muted" data-testid="queue-position">
              {copy.progress.queuePosition(status.queuePosition)}
            </p>
          )}
          <JobProgress
            stages={STAGES}
            current={timedOut ? null : status ? currentAuditStage(status) : "queued"}
            startedAt={phase.startedAt}
            slowAfterMs={60_000}
            note={copy.progress.note}
            slowNote={copy.progress.slowNote}
          />
          {/*
            Say that we stopped waiting. The old code just stopped polling,
            leaving an anonymous visitor watching a spinner that would never
            resolve.
          */}
          {timedOut && (
            <div
              data-testid="public-audit-timeout"
              className="rounded-card border border-[rgba(245,184,65,0.35)] bg-[rgba(245,184,65,0.1)] px-4 py-3 text-[13.5px] text-[#F5D9A0]"
            >
              {copy.progress.timedOut}
            </div>
          )}
        </div>
      )}

      {phase.kind === "done" && phase.status.status === "error" && (
        <div className="mt-4 rounded-card border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-4 py-3 text-[13.5px] text-[#FFB3C2]">
          {copy.result.error}
        </div>
      )}

      {phase.kind === "done" && phase.status.status === "done" && (
        <Teaser status={phase.status} locale={locale} brandName={brandName} />
      )}
    </div>
  );
}

/** Score, the three findings that matter most, both screenshots. */
function Teaser({
  status,
  locale,
  brandName,
}: {
  status: PublicAuditStatus;
  locale: Locale;
  brandName: string;
}) {
  const copy = copyFor(locale);
  const site = status.url.replace(/^https?:\/\//, "").replace(/\/$/, "");

  return (
    <div className="mt-6" data-testid="public-audit-result">
      <div className="rounded-card border border-line bg-panel p-6 sm:p-7">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
          {copy.result.eyebrow} · {site}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="bg-grad bg-clip-text font-display text-[64px] font-extrabold leading-none tracking-[-0.03em] text-transparent">
            {status.score}
          </div>
          <div className="mb-2 text-[12px] text-muted">{copy.result.scoreCaption}</div>
        </div>

        {status.headlineFindings.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 text-[12px] font-semibold">{copy.result.findingsTitle}</div>
            <ul className="grid gap-1.5">
              {status.headlineFindings.map((f) => (
                <li key={f} className="flex gap-2.5 text-[13px] leading-relaxed text-[#C9CEE3]">
                  <span className="mt-[7px] h-[5px] w-[5px] flex-none rounded-full bg-[#FF5C7A]" aria-hidden />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}

        {(status.screenshots.desktop || status.screenshots.mobile) && (
          <div className="mt-6">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              {copy.result.screenshotsTitle}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(["desktop", "mobile"] as const).map((kind) =>
                status.screenshots[kind] ? (
                  <figure key={kind}>
                    {/* eslint-disable-next-line @next/next/no-img-element --
                        served by a public route scoped to this audit id */}
                    <img
                      src={`/api/public-audit/${status.id}/shot/${kind}`}
                      alt={kind === "desktop" ? copy.result.desktop : copy.result.mobile}
                      loading="lazy"
                      className="w-full rounded-[10px] border border-line object-cover object-top"
                    />
                    <figcaption className="mt-1 text-center text-[10.5px] text-muted">
                      {kind === "desktop" ? copy.result.desktop : copy.result.mobile}
                    </figcaption>
                  </figure>
                ) : null,
              )}
            </div>
          </div>
        )}
      </div>

      <UnlockForm publicAuditId={status.id} locale={locale} brandName={brandName} />
    </div>
  );
}

/** Name, email, company, and two separate consents (P12/1b). */
function UnlockForm({
  publicAuditId,
  locale,
  brandName,
}: {
  publicAuditId: string;
  locale: Locale;
  /** Named in the consent line — it has to be the controller (item 6). */
  brandName: string;
}) {
  const copy = withBrand(copyFor(locale), brandName);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [serviceConsent, setServiceConsent] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await unlockFullReport({
        publicAuditId,
        name,
        email,
        companyName: company,
        serviceConsent,
        marketingConsent,
        locale,
      });
      if (res.ok) setSent(true);
      else setError(res.message);
    } catch {
      setError(copy.result.error);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div
        data-testid="unlock-success"
        className="mt-3 rounded-card border border-accent-soft bg-accent-soft px-5 py-4"
      >
        <div className="text-[14px] font-bold text-[#E4D3FF]">{copy.unlock.success}</div>
        <p className="mt-1 text-[13px] leading-relaxed text-[#C9CEE3]">
          {copy.unlock.successBody}
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      data-testid="unlock-form"
      className="mt-3 rounded-card border border-line bg-panel p-5 sm:p-6"
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
        {copy.unlock.eyebrow}
      </div>
      <h3 className="mb-2 font-display text-[20px] font-bold lowercase tracking-display">
        {copy.unlock.title}
      </h3>
      <p className="mb-4 max-w-[520px] text-[13px] leading-relaxed text-muted">
        {copy.unlock.body}
      </p>

      <div className="grid gap-2.5 sm:grid-cols-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={copy.unlock.name}
          aria-label={copy.unlock.name}
          autoComplete="name"
          required
          data-testid="unlock-name"
          className="min-h-[46px] rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3.5 text-[14px] text-ink outline-none focus:border-accent"
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={copy.unlock.email}
          aria-label={copy.unlock.email}
          type="email"
          autoComplete="email"
          required
          data-testid="unlock-email"
          className="min-h-[46px] rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3.5 text-[14px] text-ink outline-none focus:border-accent"
        />
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder={copy.unlock.company}
          aria-label={copy.unlock.company}
          autoComplete="organization"
          data-testid="unlock-company"
          className="min-h-[46px] rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3.5 text-[14px] text-ink outline-none focus:border-accent"
        />
      </div>

      {/*
        Two separate, unticked boxes. The first authorises the delivery; the
        second is the only thing that ever permits contacting them. Neither is
        pre-checked, because a pre-checked box is not consent.
      */}
      <label className="mt-4 flex cursor-pointer gap-2.5 text-[13px] leading-relaxed text-[#C9CEE3]">
        <input
          type="checkbox"
          checked={serviceConsent}
          onChange={(e) => setServiceConsent(e.target.checked)}
          data-testid="unlock-service-consent"
          className="mt-[3px]"
          style={{ accentColor: "#7427C6" }}
        />
        {copy.unlock.serviceConsent}
      </label>
      <label className="mt-2.5 flex cursor-pointer gap-2.5 text-[13px] leading-relaxed text-muted">
        <input
          type="checkbox"
          checked={marketingConsent}
          onChange={(e) => setMarketingConsent(e.target.checked)}
          data-testid="unlock-marketing-consent"
          className="mt-[3px]"
          style={{ accentColor: "#7427C6" }}
        />
        {copy.unlock.marketingConsent}
      </label>

      {error && (
        <p data-testid="unlock-error" className="mt-3 text-[12.5px] text-[#FFB3C2]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        data-testid="unlock-submit"
        className="mt-4 min-h-[46px] rounded-[10px] border-[1.5px] border-transparent bg-canvas px-5 text-[14px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
      >
        {busy ? copy.unlock.submitBusy : copy.unlock.submit}
      </button>
    </form>
  );
}
