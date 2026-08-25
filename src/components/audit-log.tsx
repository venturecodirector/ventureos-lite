"use client";

import { useEffect, useState, useTransition } from "react";
import { readAuditLog, type AuditLogPage, type AuditLogRow } from "@/modules/auditlog/actions";
import { AUDIT_LOG_CATEGORIES } from "@/modules/auditlog/categories";

/**
 * Settings → Audit log (CLAUDE.md hard rule #8).
 *
 * Read-only, deliberately and completely. No edit, no delete, no bulk action —
 * an audit log with a delete button answers no question at all. The only
 * controls are the ones that help somebody find the entry they came for.
 */
const BTN =
  "min-h-[32px] rounded-[8px] border border-line px-2.5 py-1 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

/** The five words a person scans for, in their language. */
const ACTION_LABEL: Record<string, string> = {
  "grant.change": "jogosultság módosítva",
  "export.run": "export",
  "lead.deleted": "lead törölve",
  "lead.erasure.requested": "törlés kérve",
  "lead.erasure.completed": "törlés végrehajtva",
  "document.finalize": "dokumentum véglegesítve",
  "invoice.submit": "számla beküldve",
  "invoice.issued": "számla kiállítva",
  "data.merge": "összevonás",
  "data.merge_reverted": "összevonás visszavonva",
  "import.run": "import",
  "import.rollback": "import visszavonva",
  "cold_email.signoff": "hideg e-mail jóváhagyás",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString("hu-HU");
}

export function AuditLogPanel() {
  const [pending, startTransition] = useTransition();
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<AuditLogPage | null>(null);
  const [rows, setRows] = useState<AuditLogRow[]>([]);

  function load(cursor?: string) {
    startTransition(async () => {
      const res = await readAuditLog({ category, search: search || undefined, cursor });
      setPage(res);
      setRows((prev) => (cursor ? [...prev, ...res.rows] : res.rows));
    });
  }

  // Reload from the top whenever the filter changes; the search is applied on
  // Enter or on the button, not per keystroke — this reads a growing table.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  return (
    <section
      data-testid="settings-audit-log"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-lg font-bold lowercase">audit log</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        Ki mit csinált, és mikor. Jogosultság-változás, export, törlés, dokumentum
        véglegesítés, számla-beküldés. <b>Csak olvasható</b> — ez a lényege.
      </p>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {AUDIT_LOG_CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              category === c.id
                ? "border-accent bg-accent-soft text-[#E4D3FF]"
                : "border-line text-muted hover:border-accent"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="mb-3 flex gap-1.5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="Keresés műveletre vagy azonosítóra…"
          data-testid="audit-log-search"
          className="min-w-[180px] flex-1 rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
        />
        <button onClick={() => load()} disabled={pending} className={BTN}>
          Keresés
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          {pending ? "Betöltés…" : "Nincs bejegyzés ebben a szűrésben."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-[0.1em] text-muted">
                  <th className="px-2 py-1.5 font-semibold">Mikor</th>
                  <th className="px-2 py-1.5 font-semibold">Ki</th>
                  <th className="px-2 py-1.5 font-semibold">Mit</th>
                  <th className="px-2 py-1.5 font-semibold">Mire</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0" data-testid="audit-log-row">
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">{when(r.at)}</td>
                    <td className="px-2 py-2 text-ink">{r.actorName}</td>
                    <td className="px-2 py-2">
                      <span className="text-ink">{ACTION_LABEL[r.action] ?? r.action}</span>
                      {r.detail && <span className="block text-[11px] text-muted">{r.detail}</span>}
                    </td>
                    <td className="px-2 py-2 text-muted">
                      {r.entityType ?? "—"}
                      {r.entityId && (
                        <span className="block font-mono text-[10.5px]">{r.entityId.slice(0, 12)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <span className="text-[11.5px] text-muted">
              {rows.length} / {page?.total ?? rows.length} bejegyzés
            </span>
            {page?.nextCursor && (
              <button
                onClick={() => load(page.nextCursor!)}
                disabled={pending}
                className={BTN}
                data-testid="audit-log-more"
              >
                Továbbiak
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
