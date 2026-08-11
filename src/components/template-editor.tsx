"use client";

import { useMemo, useRef, useState } from "react";
import type { TemplateType, Lang } from "@prisma/client";
import {
  loadTemplate,
  saveTemplateVersion,
  activateVersion,
  type TemplateEditorData,
} from "@/modules/templates/actions";
import { renderTemplate, extractVariables } from "@/modules/templates/render";
import { VARIABLE_CATALOG, SAMPLE_DATA, isKnownVariable } from "@/modules/templates/catalog";

const TYPES: TemplateType[] = ["QUOTE", "CONTRACT", "CERTIFICATE", "EMAIL"];
const LANGS: Lang[] = ["HU", "EN"];

/** The open `{{prefix` under the caret, or null. */
function openVarPrefix(textBeforeCaret: string): string | null {
  const open = textBeforeCaret.lastIndexOf("{{");
  const close = textBeforeCaret.lastIndexOf("}}");
  if (open === -1 || open < close) return null;
  const prefix = textBeforeCaret.slice(open + 2);
  return /^[\w.]*$/.test(prefix) ? prefix : null;
}

export function TemplateEditor({
  initial,
  canEdit,
}: {
  initial: TemplateEditorData;
  canEdit: boolean;
}) {
  const [data, setData] = useState(initial);
  const [type, setType] = useState<TemplateType>(initial.type);
  const [lang, setLang] = useState<Lang>(initial.lang);
  const [name, setName] = useState(initial.name);
  const [body, setBody] = useState(initial.body);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const preview = useMemo(() => renderTemplate(body, SAMPLE_DATA), [body]);
  const unknownVars = useMemo(
    () => extractVariables(body).filter((v) => !isKnownVariable(v)),
    [body],
  );

  const prefix = openVarPrefix(body.slice(0, caret));
  const suggestions =
    prefix !== null
      ? VARIABLE_CATALOG.filter((v) => v.key.toLowerCase().includes(prefix.toLowerCase())).slice(0, 8)
      : [];

  async function switchTemplate(t: TemplateType, l: Lang) {
    const next = await loadTemplate(t, l);
    setData(next);
    setType(t);
    setLang(l);
    setName(next.name);
    setBody(next.body);
    setMsg(null);
  }

  function insertVar(key: string) {
    const before = body.slice(0, caret);
    const open = before.lastIndexOf("{{");
    const next = body.slice(0, open) + `{{${key}}}` + body.slice(caret);
    setBody(next);
    const pos = open + `{{${key}}}`.length;
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const { version } = await saveTemplateVersion({ type, lang, name, body });
      setMsg(`Saved as version ${version} (draft).`);
      await switchTemplate(type, lang);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function activate(id: string) {
    await activateVersion(id);
    await switchTemplate(type, lang);
  }

  const chipBtn = (active: boolean) =>
    `rounded-[9px] border px-3 py-1.5 text-[12.5px] font-semibold ${
      active ? "border-accent-soft bg-accent-soft text-accent-ink" : "border-line bg-panel text-muted hover:bg-panel-2"
    }`;

  return (
    <div className="max-w-[1400px]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {TYPES.map((t) => (
          <button key={t} onClick={() => switchTemplate(t, lang)} className={chipBtn(t === type)}>
            {t.charAt(0) + t.slice(1).toLowerCase()}
          </button>
        ))}
        <span className="mx-2 h-5 w-px bg-line" />
        {LANGS.map((l) => (
          <button key={l} onClick={() => switchTemplate(type, l)} className={chipBtn(l === lang)}>
            {l}
          </button>
        ))}
        {!canEdit && (
          <span className="ml-auto text-[12px] text-warn">
            Read-only — requires the templates.edit grant from the workspace owner.
          </span>
        )}
      </div>

      {msg && (
        <div className="mb-3 rounded-[10px] border border-line bg-panel px-3.5 py-2 text-[12.5px] text-[#C9CEE3]">
          {msg}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_1fr_220px]">
        {/* editor */}
        <div className="rounded-card border border-line bg-panel p-[18px]">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canEdit}
            className="mb-2 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] font-semibold text-ink outline-none focus:border-accent disabled:opacity-60"
          />
          <div className="relative">
            <textarea
              ref={taRef}
              value={body}
              disabled={!canEdit}
              onChange={(e) => {
                setBody(e.target.value);
                setCaret(e.target.selectionStart);
              }}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
              onClick={(e) => setCaret(e.currentTarget.selectionStart)}
              spellCheck={false}
              className="min-h-[420px] w-full resize-y rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] p-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none focus:border-accent disabled:opacity-60"
            />
            {suggestions.length > 0 && (
              <div className="absolute left-3 top-3 z-10 w-[280px] overflow-hidden rounded-[10px] border border-accent-soft bg-[rgba(6,11,38,0.98)] shadow-glow-lg">
                <div className="border-b border-line px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-muted">
                  Insert variable
                </div>
                {suggestions.map((v) => (
                  <button
                    key={v.key}
                    onClick={() => insertVar(v.key)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-panel-2"
                  >
                    <code className="text-accent-ink">{`{{${v.key}}}`}</code>
                    <span className="ml-auto text-[11px] text-muted">{v.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {unknownVars.length > 0 && (
            <div className="mt-2 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2 text-[12px] text-[#FFB3C2]">
              Unknown variables — these render empty and block finalization:{" "}
              {unknownVars.map((v) => `{{${v}}}`).join(", ")}
            </div>
          )}

          <button
            onClick={save}
            disabled={!canEdit || saving}
            className="mt-3 rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save new version"}
          </button>
          <p className="mt-2 text-[11px] text-muted">
            Saving creates a new version; older versions stay immutable so pinned
            documents re-render identically.
          </p>
        </div>

        {/* live preview with DRAFT watermark */}
        <div className="rounded-card border border-line bg-panel p-[18px]">
          <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Live preview · sample data
          </div>
          <div className="relative min-h-[420px] overflow-hidden rounded-[12px] border border-line bg-[#0A0F2E] p-6">
            <div
              className="relative z-10 whitespace-pre-wrap text-[12px] leading-relaxed text-[#C9CEE3] [&_h1]:mb-2 [&_h1]:font-display [&_h1]:text-[18px] [&_h1]:font-extrabold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-bold [&_hr]:my-3 [&_hr]:border-line [&_table]:my-2 [&_td]:border-b [&_td]:border-line [&_td]:py-1"
              dangerouslySetInnerHTML={{ __html: preview.output }}
            />
            <div className="pointer-events-none absolute inset-0 z-0 grid place-items-center">
              <span className="rotate-[-24deg] font-display text-[70px] font-extrabold tracking-[0.1em] text-[rgba(239,241,248,0.05)]">
                DRAFT
              </span>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            DRAFT watermark stays until an Owner finalizes the generated document.
          </p>
        </div>

        {/* version history */}
        <div className="rounded-card border border-line bg-panel p-[18px]">
          <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Version history
          </div>
          {data.versions.length === 0 ? (
            <p className="text-[12px] text-muted">No versions yet — save to create v1.</p>
          ) : (
            data.versions.map((v) => (
              <div key={v.id} className="flex items-center gap-2 border-b border-line py-2 last:border-0">
                <div className="min-w-0 flex-1">
                  <b className="text-[12.5px]">v{v.version}</b>
                  <span className="ml-2 text-[10.5px] text-muted">{v.status.toLowerCase()}</span>
                  <span className="block text-[10.5px] text-muted">{v.createdAt.slice(0, 10)}</span>
                </div>
                {canEdit && v.status !== "ACTIVE" && (
                  <button
                    onClick={() => activate(v.id)}
                    className="rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[11px] hover:bg-panel-2"
                  >
                    Activate
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
