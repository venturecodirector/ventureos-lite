"use client";

import { useEffect, useState } from "react";
import {
  getVisibility,
  addKeyword,
  removeKeyword,
  previewTrackingCost,
  type VisibilityView,
} from "@/modules/serp/actions";

/**
 * "Keresési láthatóság" — tracked terms and where they rank (P2/7).
 *
 * Deliberately small: this tracks terms someone typed. There is no keyword
 * research and no search-volume data behind it, and the panel says so rather
 * than letting the absence look like a bug.
 */
function Sparkline({ history }: { history: Array<{ position: number | null }> }) {
  const points = history.filter((h) => h.position !== null);
  if (points.length < 2) return <span className="text-muted">—</span>;

  // Rank 1 is the TOP, so the scale is inverted against the usual chart sense.
  const values = points.map((p) => p.position!);
  const max = Math.max(...values, 10);
  const w = 60;
  const h = 16;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = ((p.position! - 1) / Math.max(1, max - 1)) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <path d={d} fill="none" stroke="#7427C6" strokeWidth="1.5" />
    </svg>
  );
}

function Delta({ from, to }: { from: number | null; to: number | null }) {
  if (from === null || to === null) return null;
  const moved = from - to; // positive = climbed
  if (moved === 0) return <span className="text-muted">±0</span>;
  return (
    <span className={moved > 0 ? "text-[#3DDC97]" : "text-[#FF5C7A]"}>
      {moved > 0 ? "▲" : "▼"}
      {Math.abs(moved)}
    </span>
  );
}

export function SearchVisibility({ companyId }: { companyId: string }) {
  const [view, setView] = useState<VisibilityView | null>(null);
  const [keyword, setKeyword] = useState("");
  const [cost, setCost] = useState<{ monthlyUsd: number; perQueryUsd: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setView(await getVisibility(companyId));
  }

  useEffect(() => {
    let active = true;
    getVisibility(companyId).then((v) => {
      if (active) setView(v);
    });
    return () => {
      active = false;
    };
  }, [companyId]);

  // The bill is shown while there is still time to type a smaller number.
  useEffect(() => {
    if (!view) return;
    let active = true;
    previewTrackingCost(view.keywords.length + (keyword.trim() ? 1 : 0)).then((c) => {
      if (active) setCost(c);
    });
    return () => {
      active = false;
    };
  }, [view, keyword]);

  if (!view) return null;

  async function add() {
    if (!keyword.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addKeyword({ companyId, keyword, locale: "hu-HU" });
      setKeyword("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3.5 rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Keresési láthatóság
        </span>
        {view.keywords.length > 0 && (
          <span className="text-[11px] text-muted">
            {view.shareOfTopTen}% a top 10-ben · {view.keywords.length}/{view.cap} kulcsszó
          </span>
        )}
      </div>

      {!view.providerConfigured ? (
        <p className="text-[12px] leading-relaxed text-muted">
          Rank tracking is off: no SERP provider is configured. Add a credential in
          Settings → Integrations to enable it. We never scrape Google — positions come
          from a paid API, billed per query.
        </p>
      ) : (
        <>
          {view.keywords.length > 0 && (
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-muted">
                  <th className="py-1.5 pr-3 text-left font-semibold">Kulcsszó</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Pozíció</th>
                  <th className="py-1.5 pr-3 text-right font-semibold">Változás</th>
                  <th className="py-1.5 pr-3 text-left font-semibold">Trend</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {view.keywords.map((k) => (
                  <tr key={k.id} className="border-b border-[rgba(239,241,248,0.05)]">
                    <td className="py-1.5 pr-3 text-[#C9CEE3]">{k.keyword}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {k.position === null ? (
                        <span className="text-muted">100+</span>
                      ) : (
                        k.position
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      <Delta from={k.previousPosition} to={k.position} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <Sparkline history={k.history} />
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        onClick={async () => {
                          await removeKeyword(k.id);
                          await refresh();
                        }}
                        className="text-[11px] text-muted hover:text-ink"
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="mt-2.5 flex flex-wrap gap-2">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="kulcsszó, amit követni akarsz"
              className="min-w-[200px] flex-1 rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            />
            <button
              onClick={add}
              disabled={busy || !keyword.trim()}
              className="rounded-[10px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] font-semibold hover:border-accent disabled:opacity-60"
            >
              Track
            </button>
          </div>
          {cost && (
            <p className="mt-1.5 text-[11px] text-muted">
              Heti ellenőrzés · becsült havi költség ${cost.monthlyUsd.toFixed(2)} (
              ${cost.perQueryUsd.toFixed(4)}/lekérdezés). Csak megadott kifejezéseket
              követünk — kulcsszókutatás nincs benne.
            </p>
          )}
        </>
      )}

      {error && <p className="mt-2 text-[11.5px] text-[#FFB3C2]">{error}</p>}
    </div>
  );
}
