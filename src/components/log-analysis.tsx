"use client";

import { useEffect, useRef, useState } from "react";
import { serverActionError } from "@/lib/client/server-action";
import { MAX_UPLOAD_BYTES } from "@/modules/logs/limits";
import {
  uploadAccessLog,
  listLogUploads,
  type LogUploadView,
} from "@/modules/logs/actions";

/**
 * "Log analízis" (P2/8) — an internal, client-work tool.
 *
 * Not a prospecting surface: this needs a client's own server logs, which
 * means a relationship. The GDPR line is stated in the UI rather than buried
 * in a policy, because the person uploading is the person who has to be able
 * to answer for it.
 */
function PathTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Array<{ path: string; hits: number }>;
  empty: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="text-[11.5px] text-muted">{empty}</p>
      ) : (
        <div className="space-y-0.5">
          {rows.slice(0, 8).map((r) => (
            <div key={r.path} className="flex gap-2 text-[12px]">
              <span className="truncate text-[#C9CEE3]">{r.path}</span>
              <span className="ml-auto tabular-nums text-muted">{r.hits}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function LogAnalysis({ companyId }: { companyId?: string }) {
  const [uploads, setUploads] = useState<LogUploadView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    setUploads(await listLogUploads(companyId));
  }

  useEffect(() => {
    let active = true;
    listLogUploads(companyId).then((u) => {
      if (active) setUploads(u);
    });
    return () => {
      active = false;
    };
  }, [companyId]);

  // Parsing is streamed in the worker and can take minutes on a month of
  // traffic, so poll while anything is in flight.
  useEffect(() => {
    if (!uploads.some((u) => u.status === "queued" || u.status === "running")) return;
    const t = setTimeout(refresh, 3000);
    return () => clearTimeout(t);
  });

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (companyId) form.set("companyId", companyId);
      await uploadAccessLog(form);
      await refresh();
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const open = uploads.find((u) => u.id === openId);

  return (
    <div className="mt-3.5 rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        Log analízis
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".log,.txt,.gz"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
          disabled={busy}
          className="text-[12px] text-muted file:mr-2 file:rounded-[8px] file:border file:border-line file:bg-panel-2 file:px-3 file:py-1.5 file:text-[12px] file:text-ink"
        />
        <span className="text-[11px] text-muted">
          nginx / Apache, gzip is jó · max {MAX_UPLOAD_BYTES / 1024 / 1024} MB
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        A logsorok IP-címeket tartalmaznak, tehát személyes adatok: feldolgozás után
        összesítést tartunk meg, a feltöltött fájlt 7 napon belül töröljük.
      </p>

      {error && <p className="mt-2 text-[11.5px] text-[#FFB3C2]">{error}</p>}

      {uploads.length > 0 && (
        <div className="mt-3 space-y-1">
          {uploads.map((u) => (
            <button
              key={u.id}
              onClick={() => setOpenId(openId === u.id ? null : u.id)}
              className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12px] hover:bg-panel-2"
            >
              <span className="truncate text-[#C9CEE3]">{u.filename}</span>
              <span className="text-muted">{Math.round(u.bytes / 1024)} KB</span>
              <span
                className={
                  u.status === "error"
                    ? "text-[#FF5C7A]"
                    : u.status === "done"
                      ? "text-[#3DDC97]"
                      : "text-warn"
                }
              >
                {u.status}
              </span>
              <span className="ml-auto text-[11px] text-muted">
                {u.purged ? "raw file deleted" : `raw kept until ${u.purgeAfter.slice(0, 10)}`}
              </span>
            </button>
          ))}
        </div>
      )}

      {open?.analysis && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11.5px] text-muted">
            <span>
              {open.analysis.parsed.toLocaleString("hu-HU")} sor feldolgozva
              {open.analysis.lines !== open.analysis.parsed
                ? ` (${(open.analysis.lines - open.analysis.parsed).toLocaleString("hu-HU")} kihagyva)`
                : ""}
            </span>
            {open.analysis.from && (
              <span>
                {open.analysis.from.slice(0, 10)} → {open.analysis.to?.slice(0, 10)}
              </span>
            )}
            <span>
              Googlebot {open.analysis.verifiedBotHits.googlebot}/
              {open.analysis.botHits.googlebot} igazolt · Bingbot{" "}
              {open.analysis.verifiedBotHits.bingbot}/{open.analysis.botHits.bingbot}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PathTable
              title="Crawl budget — hova jut a robot"
              rows={open.analysis.crawlBudget}
              empty="Nem járt itt robot ebben az időszakban."
            />
            <PathTable
              title="404 gócpontok"
              rows={open.analysis.notFoundHotspots}
              empty="Nincs ismétlődő 404."
            />
            <PathTable
              title="5xx hibák"
              rows={open.analysis.serverErrorHotspots}
              empty="Nincs szerverhiba."
            />
            <PathTable
              title="Átirányítás-találatok"
              rows={open.analysis.redirectHotspots}
              empty="Nincs jelentős átirányítás."
            />
            <PathTable
              title="Csak robot járt itt (árva oldal)"
              rows={open.analysis.botOnlyPaths}
              empty="Nincs ilyen oldal."
            />
            <PathTable
              title="Robot még nem járt itt"
              rows={open.analysis.humanOnlyPaths}
              empty="Minden látogatott oldalt bejárt robot is."
            />
          </div>

          {open.analysis.hasTimings && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                Leglassabb végpontok
              </div>
              {open.analysis.slowEndpoints.slice(0, 8).map((s) => (
                <div key={s.path} className="flex gap-2 text-[12px]">
                  <span className="truncate text-[#C9CEE3]">{s.path}</span>
                  <span className="ml-auto tabular-nums text-muted">
                    átlag {s.avgSeconds.toFixed(2)}s · max {s.maxSeconds.toFixed(2)}s · {s.hits}×
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
