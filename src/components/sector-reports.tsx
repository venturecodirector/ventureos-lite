"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import {
  startSectorReport,
  generateSectorReport,
  publishSectorReport,
  unpublishSectorReport,
  previewSectorCost,
  type SectorReportRow,
} from "@/modules/sector-reports/actions";
import { EmptyState } from "./empty-state";

/**
 * The report builder (playbook-v4 P12/2a), Owner-gated.
 *
 * Every button here spends money — a Places search and up to sixty website
 * audits — so the cost is shown BEFORE the click, the way the Prospector does
 * it. A batch nobody priced is a bill nobody expected.
 */
const CARD = "rounded-card border border-line bg-panel p-4";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const INPUT =
  "rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[12.5px] text-ink outline-none focus:border-accent";

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "piszkozat", cls: "bg-panel-2 text-muted" },
  running: { label: "mérés fut", cls: "bg-accent-soft text-accent-ink" },
  ready: { label: "kész", cls: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]" },
  published: { label: "közzétéve", cls: "bg-[rgba(61,220,151,0.2)] text-[#8FE9C3]" },
};

export function SectorReports({ reports }: { reports: SectorReportRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sector, setSector] = useState("");
  const [location, setLocation] = useState("");
  const [cap, setCap] = useState("40");
  const [cost, setCost] = useState<{ usd: number; audits: number } | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function price() {
    startTransition(async () => setCost(await previewSectorCost(Number(cap) || 40)));
  }

  function start() {
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(
        startSectorReport({ sector, location, cap: Number(cap) || 40 }),
      );
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setSector("");
      setLocation("");
      setMsg({ kind: "ok", text: "A mérés elindult. Tíz percenként frissül." });
      router.refresh();
    });
  }

  function act(fn: () => Promise<{ ok: boolean; error?: string; url?: string }>) {
    setMsg(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error ?? "Nem sikerült." });
        return;
      }
      setMsg({ kind: "ok", text: res.url ? `Közzétéve: ${res.url}` : "Kész." });
      router.refresh();
    });
  }

  return (
    <div className="max-w-[900px]">
      {msg && (
        <div
          className={`mb-3 rounded-[10px] border px-3.5 py-2.5 text-[12.5px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.1)] text-[#8FE9C3]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </div>
      )}

      <div className={`${CARD} mb-4`}>
        <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Új szektor-riport
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            className={`${INPUT} min-w-[160px] flex-1`}
            placeholder="Szektor — pl. fogorvos"
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            data-testid="sector-input"
          />
          <input
            className={`${INPUT} min-w-[140px] flex-1`}
            placeholder="Terület — pl. Debrecen"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            data-testid="location-input"
          />
          <input
            className={`${INPUT} w-[90px] tabular-nums`}
            type="number"
            min={12}
            max={60}
            value={cap}
            onChange={(e) => {
              setCap(e.target.value);
              setCost(null);
            }}
            title="Legfeljebb ennyi oldalt mérünk meg"
          />
          <button onClick={price} disabled={pending} className={BTN}>
            Költség
          </button>
          <button
            onClick={start}
            disabled={pending || !sector.trim() || !location.trim()}
            className={BTN}
            data-testid="sector-start"
          >
            Indítás
          </button>
        </div>
        {cost && (
          <p className="mt-2 text-[11.5px] text-muted">
            Becsült keresési költség {cost.usd.toFixed(3)} USD, plusz legfeljebb {cost.audits}{" "}
            weboldal átvilágítása. A 30 napnál frissebb mérések újrahasználódnak.
          </p>
        )}
        <p className="mt-2 text-[11px] text-muted">
          A riport kizárólag összesített adatokat közöl — publikálás előtt a rendszer
          ellenőrzi, hogy egyetlen cégnév, domain vagy URL sem került bele.
        </p>
      </div>

      {reports.length === 0 ? (
        <EmptyState title="még nincs riport">
          Egy szektor-riport két dolgot csinál egyszerre: leadet hoz a letöltésekből,
          és feltölti az audit-adatbázist, amiből később a szakmai összehasonlítás
          készül.
        </EmptyState>
      ) : (
        <div className="grid gap-2.5">
          {reports.map((r) => {
            const s = STATUS[r.status] ?? STATUS.draft!;
            return (
              <div key={r.id} className={CARD} data-testid="sector-report-row">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="block text-[13.5px] font-semibold text-ink">{r.title}</span>
                    <span className="block text-[11.5px] text-muted">
                      {r.location} · {r.sector} · {r.auditedCount}/{r.foundCount} megmérve
                      {r.costUsd > 0 && ` · ${r.costUsd.toFixed(3)} USD`}
                      {r.downloads > 0 && ` · ${r.downloads} letöltés`}
                    </span>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${s.cls}`}>
                    {s.label}
                  </span>
                </div>

                {r.note && <p className="mt-1.5 text-[11.5px] text-warn">{r.note}</p>}

                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {(r.status === "ready" || r.status === "published") && (
                    <button
                      onClick={() => act(() => generateSectorReport(r.id))}
                      disabled={pending}
                      className={BTN}
                      data-testid="sector-generate"
                    >
                      {r.hasPdf ? "Újragenerálás" : "Riport elkészítése"} · 1 Sonnet hívás
                    </button>
                  )}
                  {r.hasPdf && r.status !== "published" && (
                    <button
                      onClick={() => act(() => publishSectorReport(r.id))}
                      disabled={pending}
                      className={BTN}
                      data-testid="sector-publish"
                    >
                      Közzététel
                    </button>
                  )}
                  {r.status === "published" && r.slug && (
                    <>
                      <a href={`/reports/${r.slug}`} className={BTN} target="_blank" rel="noreferrer">
                        Megnyitás
                      </a>
                      <button
                        onClick={() => act(() => unpublishSectorReport(r.id))}
                        disabled={pending}
                        className={BTN}
                      >
                        Visszavonás
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
