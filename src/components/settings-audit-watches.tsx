"use client";

import { useEffect, useState, useTransition } from "react";
import { attemptVoid } from "@/lib/client/server-action";
import {
  listAuditWatches,
  clearAuditWatch,
  setAuditWatch,
  type WatchListView,
} from "@/modules/audit/watch-actions";

/**
 * Settings → Audit watches (playbook-v2 P2/5).
 *
 * ── WHY IT NEEDED A SCREEN ─────────────────────────────────────────────────
 *
 * Watches are created automatically when a lead reaches a stage worth watching,
 * and a nightly sweep re-audits them. That worked — invisibly. There was no
 * list, no off switch, and no way to see how many audits a week the list had
 * quietly grown into. A background job that spends money on other people's
 * websites should be something you can look at.
 */
const BTN =
  "min-h-[30px] rounded-[8px] border border-line px-2 py-1 text-[11px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

export function SettingsAuditWatches() {
  const [pending, startTransition] = useTransition();
  const [view, setView] = useState<WatchListView | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    startTransition(async () => setView(await listAuditWatches()));
  }
  useEffect(load, []);

  function stop(companyId: string) {
    setError(null);
    startTransition(async () => {
      const err = await attemptVoid(clearAuditWatch(companyId));
      if (err) {
        setError(err);
        return;
      }
      setView(await listAuditWatches());
    });
  }

  function resume(companyId: string, frequencyDays: number) {
    setError(null);
    startTransition(async () => {
      const err = await attemptVoid(setAuditWatch({ companyId, frequencyDays, enabled: true }));
      if (err) {
        setError(err);
        return;
      }
      setView(await listAuditWatches());
    });
  }

  return (
    <section
      data-testid="settings-audit-watches"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-lg font-bold lowercase">audit watches</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        Ezeket az oldalakat mérjük újra rendszeresen, hogy szóljunk, ha romlik az
        állapotuk. A figyelő magától jön létre, amikor egy lead a megfelelő
        szakaszba ér — itt látod, mibe került, és itt tudod leállítani.
      </p>

      {error && (
        <p className="mb-2 rounded-[9px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2 text-[12px] text-[#FFB3C2]">
          {error}
        </p>
      )}

      {!view ? (
        <p className="text-[12.5px] text-muted">Betöltés…</p>
      ) : view.watches.length === 0 ? (
        <p className="text-[12.5px] text-muted">Jelenleg egyetlen oldalt sem figyelünk.</p>
      ) : (
        <>
          <p className="mb-2 text-[11.5px] text-muted">
            {view.watches.length} figyelt oldal · körülbelül <b>{view.weeklyLoad} átvilágítás
            hetente</b> {view.max > 0 && `(a keret ${view.max})`}
          </p>
          <div className="grid gap-1.5">
            {view.watches.map((w) => (
              <div
                key={w.companyId}
                data-testid="audit-watch-row"
                className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line px-3 py-2 text-[12px]"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{w.companyName}</span>
                  <span className="block truncate text-[11px] text-muted">{w.url}</span>
                </span>
                <span className="text-[11px] text-muted">
                  {w.frequencyDays} naponta
                  <span className="block">
                    {w.lastRunAt
                      ? `utoljára ${w.lastRunAt.slice(0, 10)}`
                      : "még nem futott"}
                  </span>
                </span>
                {w.enabled ? (
                  <button onClick={() => stop(w.companyId)} disabled={pending} className={BTN}>
                    Leállítás
                  </button>
                ) : (
                  <button
                    onClick={() => resume(w.companyId, w.frequencyDays)}
                    disabled={pending}
                    className={BTN}
                  >
                    Újraindítás
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
