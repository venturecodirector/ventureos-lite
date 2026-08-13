"use client";

import { useEffect, useRef, useState } from "react";
import {
  submitPublicAudit,
  getPublicAuditStatus,
  type PublicAuditStatus,
} from "@/modules/public-audit/actions";
import type { WorkspaceBrand } from "@/modules/workspaces/brand";
import { JobProgress } from "./job-progress";

/**
 * The self-serve audit landing (P12/1a) at the root of the audit domain.
 *
 * Prospect-facing and unauthenticated, so it carries the brand but none of the
 * app chrome. One input, one promise, and honest progress while the worker
 * runs — the audit takes tens of seconds and a blank wait is what makes people
 * close the tab.
 */
const POLL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

const STAGES = [
  { key: "queued", label: "Sorban áll" },
  { key: "running", label: "Betöltjük az oldalt egy böngészőben" },
  { key: "scoring", label: "Pontozás és képernyőképek" },
];

type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "running"; id: string; startedAt: number }
  | { kind: "done"; status: PublicAuditStatus }
  | { kind: "refused"; message: string; friendly: boolean };

export function PublicAuditLanding({ brand }: { brand: WorkspaceBrand }) {
  const [url, setUrl] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [status, setStatus] = useState<PublicAuditStatus | null>(null);
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
      const s = await getPublicAuditStatus(phase.id);
      if (!active) return;
      if (s) {
        setStatus(s);
        if (s.status === "done" || s.status === "error") {
          setPhase({ kind: "done", status: s });
          return;
        }
      }
      if (Date.now() - started > POLL_TIMEOUT_MS) return;
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
    setPhase({ kind: "running", id: res.publicAuditId, startedAt: Date.now() });
  }

  const busy = phase.kind === "submitting" || phase.kind === "running";

  return (
    <main className="relative z-10 min-h-screen">
      <div className="mx-auto max-w-[720px] px-5 py-14">
        <div className="mb-10 font-display text-[18px]">
          {brand.logoUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element --
               a workspace logo behind /api/files, not a static asset */
            <img src={brand.logoUrl} alt={brand.name} className="max-h-[34px]" />
          ) : (
            <>
              <b className="font-extrabold">{brand.markBold}</b>
              {brand.markLight ? (
                <span className="font-light text-muted"> {brand.markLight}</span>
              ) : null}
            </>
          )}
        </div>

        <h1 className="mb-3 font-display text-[34px] font-bold lowercase leading-[1.1] tracking-display sm:text-[42px]">
          mennyit ér a weboldala?
        </h1>
        <p className="mb-8 max-w-[520px] text-[15px] leading-relaxed text-muted">
          Ingyenes átvilágítás 60 másodperc alatt. Sebesség, mobilnézet,
          megtalálhatóság, jogi megfelelés — gépi elemzés, marketingszöveg nélkül.
        </p>

        <form onSubmit={run} className="mb-4 flex flex-wrap gap-2.5">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="pelda.hu"
            inputMode="url"
            autoComplete="off"
            disabled={busy}
            data-testid="public-audit-url"
            aria-label="A weboldal címe"
            className="min-h-[48px] min-w-[220px] flex-1 rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-accent disabled:opacity-60"
          />
          {/*
            Honeypot. Off-screen rather than display:none — some bots skip
            hidden inputs but fill positioned ones. Never shown to a person,
            and tabIndex -1 keeps it out of keyboard order.
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
            className="min-h-[48px] rounded-[10px] border-[1.5px] border-transparent bg-canvas px-5 text-[14px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {busy ? "Fut…" : "Átvilágítás indítása"}
          </button>
        </form>

        {phase.kind === "refused" && (
          <div
            data-testid="public-audit-refused"
            className={`rounded-card border px-4 py-3 text-[13.5px] ${
              phase.friendly
                ? "border-accent-soft bg-accent-soft text-[#E4D3FF]"
                : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] text-[#FFB3C2]"
            }`}
          >
            {phase.message}
          </div>
        )}

        {phase.kind === "running" && (
          <>
            {status && status.queuePosition > 0 && (
              <p className="mb-2 text-[12.5px] text-muted" data-testid="queue-position">
                {status.queuePosition}. a sorban — mindjárt sorra kerül.
              </p>
            )}
            <JobProgress
              stages={STAGES}
              current={status?.status === "running" ? "running" : "queued"}
              startedAt={phase.startedAt}
              note="Az oldalt egy valódi böngészőben töltjük be, és mobilon is megnézzük."
              slowNote="Még dolgozunk rajta — a lassú oldalak átvilágítása tart tovább, ez önmagában is információ."
            />
          </>
        )}

        {phase.kind === "done" && phase.status.status === "error" && (
          <div className="rounded-card border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-4 py-3 text-[13.5px] text-[#FFB3C2]">
            Nem sikerült betölteni az oldalt. Elérhető egyáltalán? Próbáld újra,
            vagy írj nekünk.
          </div>
        )}

        {phase.kind === "done" && phase.status.status === "done" && (
          <div
            className="rounded-card border border-line bg-panel p-7"
            data-testid="public-audit-result"
          >
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
              Eredmény · {phase.status.url.replace(/^https?:\/\//, "")}
            </div>
            <div className="bg-grad bg-clip-text font-display text-[64px] font-extrabold leading-none tracking-[-0.03em] text-transparent">
              {phase.status.score}
            </div>
            <p className="mt-3 text-[13px] text-muted">
              A részletes eredmények és a teljes riport a következő lépésben
              érkezik.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
