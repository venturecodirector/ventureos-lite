"use client";

import { useEffect, useMemo, useState } from "react";
import {
  commitImport,
  getImportTemplates,
  previewImport,
  saveTemplate,
} from "@/modules/import/actions";
import {
  CSV_FIELDS,
  autoMap,
  isImportable,
  parseCsv,
  toCandidates,
  validateMapping,
  type CsvTarget,
  type ParsedCsv,
} from "@/modules/leads/csv";
import { PROBLEM_LABELS, type ValidationSummary } from "@/modules/import/validate";
import { listCustomFields } from "@/modules/fields/actions";
import { customFieldRef, type FieldDef } from "@/modules/fields/types";
import type { TemplateRow } from "@/modules/import/store";
import { Modal } from "./modal";

/**
 * CSV import v2 (playbook-v2 P5/3).
 *
 * Three things the v1 flow did not do, each of which cost somebody an evening:
 *   - it dropped every row it could not use without saying which or why. Now
 *     every row carries a reason, and the operator ticks off the ones to leave.
 *   - it re-mapped the same fourteen columns from the same monthly export every
 *     time. Now a mapping is saveable and reusable.
 *   - it had no way back. Now an import is a tracked batch with a 7-day
 *     rollback in Settings → Data quality.
 */

const INPUT =
  "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent";
const CTA =
  "rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60";
const PLAIN =
  "rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2";

export function CsvImport({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  // Loaded here rather than passed in: the dialog opens from the top bar on
  // every screen, and threading the workspace's field set through each of them
  // would mean every page paying for a query most of them never use.
  const [customFields, setCustomFields] = useState<FieldDef[]>([]);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Partial<Record<CsvTarget, number>>>({});
  const [mode, setMode] = useState<"skip" | "update">("skip");
  const [summary, setSummary] = useState<ValidationSummary | null>(null);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const [templateName, setTemplateName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    updated: number;
    skipped: number;
  } | null>(null);

  useEffect(() => {
    getImportTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
    listCustomFields("lead")
      .then(setCustomFields)
      .catch(() => setCustomFields([]));
  }, []);

  const targets = useMemo(
    () => [
      ...CSV_FIELDS.map((f) => ({ key: f.key as CsvTarget, label: f.label })),
      ...customFields
        .filter((d) => !d.archived)
        .map((d) => ({ key: customFieldRef(d.key) as CsvTarget, label: `${d.label} (custom)` })),
    ],
    [customFields],
  );

  const candidates = useMemo(
    () => (parsed ? toCandidates(parsed, mapping).filter(isImportable) : []),
    [parsed, mapping],
  );
  const problems = useMemo(
    () => (parsed ? validateMapping(parsed, mapping) : []),
    [parsed, mapping],
  );

  async function onFile(file: File) {
    setError(null);
    setSummary(null);
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

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) setMapping(t.mapping as Partial<Record<CsvTarget, number>>);
  }

  async function runPreview() {
    setBusy(true);
    setError(null);
    try {
      setSummary(await previewImport({ candidates, mode }));
      setSkipped(new Set());
    } catch {
      setError("Could not check the file. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const res = await commitImport({
        candidates,
        filename: fileName,
        templateId: templateId || null,
        mode,
        skipIndexes: [...skipped],
      });
      if (!res.ok) setError(res.error);
      else setResult({ created: res.created, updated: res.updated, skipped: res.skipped });
    } catch {
      setError("The import failed. Nothing was created.");
    } finally {
      setBusy(false);
    }
  }

  const willApply =
    summary === null
      ? 0
      : summary.rows.filter((r) => r.status !== "skip" && !skipped.has(r.index)).length;

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
            Created <b>{result.created}</b>, updated <b>{result.updated}</b>, skipped{" "}
            <b>{result.skipped}</b>.
          </p>
          <p className="mt-1.5 text-[12px] text-muted">
            This import is a tracked batch — it can be rolled back for 7 days from Settings →
            Data quality.
          </p>
          <div className="mt-3 flex justify-end">
            <button onClick={onDone} className={PLAIN}>
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
      ) : !summary ? (
        <>
          <p className="mb-2 text-[12px] text-muted" data-testid="csv-summary">
            {fileName} · {parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} ·{" "}
            {parsed.delimiter === "\t" ? "tab" : parsed.delimiter}-separated
          </p>

          {templates.length > 0 && (
            <label className="mb-2 flex items-center gap-2 text-[12px]">
              <span className="w-28 flex-none text-muted">Saved mapping</span>
              <select
                value={templateId}
                data-testid="csv-template"
                onChange={(e) => applyTemplate(e.target.value)}
                className={`${INPUT} min-w-0 flex-1`}
              >
                <option value="">—</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.source ? ` · ${t.source}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          {parsed.raggedRows.length > 0 && (
            <p className="mb-2 rounded-[8px] border border-[rgba(245,184,65,0.4)] bg-[rgba(245,184,65,0.08)] px-3 py-2 text-[12px] text-[#FFD79A]">
              {parsed.raggedRows.length} row
              {parsed.raggedRows.length === 1 ? " has" : "s have"} a different number of columns
              than the header (first: row {parsed.raggedRows[0] + 2}). Missing values import as blank.
            </p>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            {targets.map((f) => (
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
                  className={`${INPUT} min-w-0 flex-1`}
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

          <fieldset className="mt-3 flex flex-wrap items-center gap-3 text-[12px]">
            <legend className="sr-only">What to do with rows already here</legend>
            {(
              [
                ["skip", "Skip rows already here"],
                ["update", "Update rows already here"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === value}
                  onChange={() => setMode(value)}
                  data-testid={`csv-mode-${value}`}
                  className="accent-[#7427C6]"
                />
                {label}
              </label>
            ))}
          </fieldset>

          {problems.length > 0 && (
            <p className="mt-2 text-[12px] text-warn" data-testid="csv-mapping-problem">
              {problems[0].message}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-[11.5px] text-muted">
              {candidates.length} of {parsed.rows.length} rows have something to import
            </span>
            <input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Save this mapping as…"
              data-testid="csv-template-name"
              className={`${INPUT} w-[190px]`}
            />
            <button
              type="button"
              disabled={busy || !templateName.trim()}
              data-testid="csv-template-save"
              onClick={async () => {
                const clean: Record<string, number> = {};
                for (const [k, v] of Object.entries(mapping)) {
                  if (typeof v === "number") clean[k] = v;
                }
                const res = await saveTemplate({ name: templateName, mapping: clean });
                if (!res.ok) setError(res.error);
                else {
                  setTemplateName("");
                  setTemplates(await getImportTemplates());
                  setTemplateId(res.id);
                }
              }}
              className={PLAIN}
            >
              Save mapping
            </button>
            <button
              onClick={() => {
                setParsed(null);
                setMapping({});
              }}
              className={PLAIN}
            >
              Choose another file
            </button>
            <button
              data-testid="csv-preview"
              onClick={runPreview}
              disabled={busy || problems.length > 0}
              className={CTA}
            >
              {busy ? "Checking…" : "Validate"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-muted" data-testid="csv-dedupe-summary">
            {summary.newCount} new · {summary.updateCount} to update · {summary.skipCount}{" "}
            skipped
            {Object.keys(summary.byCode).length > 0 && (
              <>
                {" — "}
                {Object.entries(summary.byCode)
                  .map(
                    ([code, n]) =>
                      `${n} ${PROBLEM_LABELS[code as keyof typeof PROBLEM_LABELS] ?? code}`,
                  )
                  .join(", ")}
              </>
            )}
          </p>

          <div className="max-h-[300px] overflow-auto rounded-[8px] border border-line">
            <table className="w-full border-collapse text-[12px]">
              <tbody data-testid="csv-rows">
                {summary.rows.map((r) => {
                  const c = r.candidate;
                  const off = skipped.has(r.index);
                  return (
                    <tr key={r.index} className="border-b border-line last:border-0">
                      <td className="px-2.5 py-1.5 align-top">
                        <span className="text-muted">{r.index + 2}</span>
                      </td>
                      <td className="px-2.5 py-1.5 align-top">
                        {c.contactName || c.email || c.companyName || "(blank)"}
                      </td>
                      <td className="px-2.5 py-1.5 align-top text-right">
                        {r.status === "new" && <span className="text-[#3DDC97]">new</span>}
                        {r.status === "update" && <span className="text-accent-ink">update</span>}
                        {r.status === "skip" && <span className="text-warn">skip</span>}
                        {r.problems.length > 0 && (
                          <span className="block text-[11px] text-muted">
                            {r.problems.map((p) => p.message).join("; ")}
                          </span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 text-right align-top">
                        {r.status !== "skip" && (
                          <label className="flex items-center justify-end gap-1 text-[11px] text-muted">
                            <input
                              type="checkbox"
                              checked={off}
                              onChange={() =>
                                setSkipped((s) => {
                                  const next = new Set(s);
                                  if (next.has(r.index)) next.delete(r.index);
                                  else next.add(r.index);
                                  return next;
                                })
                              }
                              className="accent-[#7427C6]"
                            />
                            skip
                          </label>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setSummary(null)} className={PLAIN}>
              Back
            </button>
            <button
              data-testid="csv-commit"
              onClick={commit}
              disabled={busy || willApply === 0}
              className={CTA}
            >
              {busy ? "Importing…" : `Import ${willApply}`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
