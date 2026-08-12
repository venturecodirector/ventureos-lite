"use client";

import { useMemo, useState } from "react";
import { previewCsvImport, commitCsvImport } from "@/modules/leads/actions";
import {
  CSV_FIELDS,
  autoMap,
  isImportable,
  parseCsv,
  toCandidates,
  validateMapping,
  type CsvCandidate,
  type CsvField,
  type ParsedCsv,
} from "@/modules/leads/csv";
import { Modal } from "./modal";

type PreviewRow = Awaited<ReturnType<typeof previewCsvImport>>[number];

export function CsvImport({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Partial<Record<CsvField, number>>>({});
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);

  const candidates = useMemo(
    () => (parsed ? toCandidates(parsed, mapping) : []),
    [parsed, mapping],
  );
  const problems = useMemo(
    () => (parsed ? validateMapping(parsed, mapping) : []),
    [parsed, mapping],
  );

  async function onFile(file: File) {
    setError(null);
    setPreview(null);
    setResult(null);
    setFileName(file.name);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError("Could not read that file.");
      return;
    }
    const res = parseCsv(text);
    if (!res.ok) {
      setParsed(null);
      setError(res.error);
      return;
    }
    setParsed(res.data);
    setMapping(autoMap(res.data.headers));
  }

  const input =
    "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent";
  const importable = candidates.filter(isImportable).length;

  return (
    <Modal>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">import csv</h3>
        <button onClick={onClose} className="ml-auto text-muted hover:text-ink" aria-label="Close">
          ✕
        </button>
      </div>

      {error && (
        <p
          role="alert"
          data-testid="csv-error"
          className="mb-3 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]"
        >
          {error}
        </p>
      )}

      {result ? (
        <div data-testid="csv-result">
          <p className="text-[13px] text-ink">
            Imported <b>{result.created}</b> lead{result.created === 1 ? "" : "s"}.
            {result.skipped > 0 && (
              <span className="text-muted"> {result.skipped} skipped as duplicates.</span>
            )}
          </p>
          <div className="mt-3 flex justify-end">
            <button onClick={onDone} className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2">
              Done
            </button>
          </div>
        </div>
      ) : !parsed ? (
        <>
          <p className="mb-2 text-[12.5px] text-muted">
            A header row plus one row per lead. Commas, semicolons or tabs all work.
          </p>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            data-testid="csv-file"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            className="text-[13px] text-muted"
          />
        </>
      ) : !preview ? (
        <>
          <p className="mb-2 text-[12px] text-muted" data-testid="csv-summary">
            {fileName} · {parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} ·{" "}
            {parsed.delimiter === "\t" ? "tab" : parsed.delimiter}-separated
          </p>
          {parsed.raggedRows.length > 0 && (
            <p className="mb-2 rounded-[8px] border border-[rgba(245,184,65,0.4)] bg-[rgba(245,184,65,0.08)] px-3 py-2 text-[12px] text-[#FFD79A]">
              {parsed.raggedRows.length} row
              {parsed.raggedRows.length === 1 ? " has" : "s have"} a different number of columns
              than the header (first: row {parsed.raggedRows[0] + 2}). Missing values import as blank.
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {CSV_FIELDS.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-[12px]">
                <span className="w-28 flex-none text-muted">{f.label}</span>
                <select
                  value={mapping[f.key] ?? ""}
                  data-testid={`csv-map-${f.key}`}
                  onChange={(e) =>
                    setMapping((m) => ({
                      ...m,
                      [f.key]: e.target.value === "" ? undefined : Number(e.target.value),
                    }))
                  }
                  className={`${input} min-w-0 flex-1`}
                >
                  <option value="">—</option>
                  {parsed.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {problems.length > 0 && (
            <p className="mt-2 text-[12px] text-warn" data-testid="csv-mapping-problem">
              {problems[0].message}
            </p>
          )}

          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="mr-auto text-[11.5px] text-muted">
              {importable} of {parsed.rows.length} rows have something to import
            </span>
            <button
              onClick={() => {
                setParsed(null);
                setMapping({});
              }}
              className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
            >
              Choose another file
            </button>
            <button
              data-testid="csv-preview"
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setPreview(await previewCsvImport(candidates.filter(isImportable)));
                } catch {
                  setError("Could not check for duplicates. Try again.");
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy || problems.length > 0}
              className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
            >
              {busy ? "Checking…" : "Preview dedupe"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-muted" data-testid="csv-dedupe-summary">
            {preview.filter((r) => r.status === "new").length} new ·{" "}
            {preview.filter((r) => r.status === "duplicate").length} duplicate
          </p>
          <div className="max-h-[280px] overflow-auto rounded-[8px] border border-line">
            <table className="w-full border-collapse text-[12px]">
              <tbody>
                {preview.map((r) => {
                  const c = importableCandidates(candidates)[r.index];
                  return (
                    <tr key={r.index} className="border-b border-line last:border-0">
                      <td className="px-2.5 py-1.5">
                        {c?.contactName || c?.email || c?.companyName || `Row ${r.index + 1}`}
                      </td>
                      <td className="px-2.5 py-1.5 text-right">
                        {r.status === "new" ? (
                          <span className="text-[#3DDC97]">new</span>
                        ) : (
                          <span className="text-warn">duplicate · {r.reason}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setPreview(null)}
              className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
            >
              Back
            </button>
            <button
              data-testid="csv-commit"
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setResult(await commitCsvImport(candidates.filter(isImportable)));
                } catch {
                  setError("The import failed. No leads were created.");
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy || preview.every((r) => r.status !== "new")}
              className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
            >
              {busy ? "Importing…" : `Import ${preview.filter((r) => r.status === "new").length} new`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** The same subset the server saw, so preview indices line up with rows. */
function importableCandidates(all: CsvCandidate[]): CsvCandidate[] {
  return all.filter(isImportable);
}

