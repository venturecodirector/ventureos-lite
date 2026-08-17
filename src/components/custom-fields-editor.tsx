"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveCustomFieldValues } from "@/modules/fields/actions";
import type { FieldDef, FieldEntity, FieldValue, FieldValues } from "@/modules/fields/types";

/**
 * Rendering and editing Owner-defined field values (playbook-v2 P5/1).
 *
 * One component for every entity, because the shape of the form comes entirely
 * from the definitions. Nothing here decides what is valid — it draws the
 * inputs the definitions describe and lets the server refuse what it must, so
 * a stale form in an open tab cannot write a value the workspace no longer
 * accepts.
 *
 * Archived fields render READ-ONLY when they hold a value and disappear when
 * they do not: the value still matters (it is why archiving is not deletion),
 * but offering to change it would be offering to fill in a retired field.
 */

const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";

export function CustomFieldsEditor({
  entity,
  entityId,
  defs,
  values,
  onSaved,
}: {
  entity: FieldEntity;
  entityId: string;
  defs: FieldDef[];
  values: FieldValues;
  onSaved?: (next: FieldValues) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<FieldValues>(values);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const editable = defs.filter((d) => !d.archived);
  const archivedWithValues = defs.filter(
    (d) => d.archived && draft[d.key] !== undefined && draft[d.key] !== null,
  );

  if (editable.length === 0 && archivedWithValues.length === 0) {
    return (
      <p className="text-[12px] text-muted">
        No custom fields yet. An Owner adds them in Settings → Fields.
      </p>
    );
  }

  function set(key: string, value: FieldValue) {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function save() {
    setError(null);
    startTransition(async () => {
      // Send every editable key, including the cleared ones — the server treats
      // null as "cleared", and omitting a key would silently keep an old value
      // the person had just deleted from the form.
      const payload: Record<string, unknown> = {};
      for (const def of editable) payload[def.key] = draft[def.key] ?? null;

      const res = await saveCustomFieldValues({ entity, entityId, values: payload });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSaved(true);
      onSaved?.(draft);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-2.5" data-testid="custom-fields">
      {error && <p className="text-[12px] text-[#FFB3C2]">{error}</p>}

      {editable.map((def) => (
        <label key={def.key} className="grid gap-1">
          <span className={LABEL}>
            {def.label}
            {def.required && <span className="ml-1 text-accent-ink">*</span>}
          </span>
          <FieldInput def={def} value={draft[def.key]} onChange={(v) => set(def.key, v)} />
          {def.help && <span className="text-[11px] text-muted">{def.help}</span>}
        </label>
      ))}

      {archivedWithValues.map((def) => (
        <div key={def.key} className="grid gap-1 opacity-70">
          <span className={LABEL}>
            {def.label} <span className="normal-case tracking-normal">· archived</span>
          </span>
          <span className="text-[13px]">{String(draft[def.key])}</span>
        </div>
      ))}

      {editable.length > 0 && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={pending}
            data-testid="custom-fields-save"
            className="min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45"
          >
            {pending ? "Saving…" : "Save fields"}
          </button>
          {saved && <span className="text-[11.5px] text-pos">saved</span>}
        </div>
      )}
    </div>
  );
}

function FieldInput({
  def,
  value,
  onChange,
}: {
  def: FieldDef;
  value: FieldValue | undefined;
  onChange: (v: FieldValue) => void;
}) {
  switch (def.type) {
    case "CHECKBOX":
      return (
        <input
          type="checkbox"
          checked={value === true}
          aria-label={def.label}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-[#7427C6]"
        />
      );
    case "NUMBER":
      return (
        <input
          type="number"
          value={value === null || value === undefined ? "" : String(value)}
          aria-label={def.label}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          className={INPUT}
        />
      );
    case "DATE":
      return (
        <input
          type="date"
          value={typeof value === "string" ? value : ""}
          aria-label={def.label}
          onChange={(e) => onChange(e.target.value || null)}
          className={INPUT}
        />
      );
    case "SELECT":
      return (
        <select
          value={typeof value === "string" ? value : ""}
          aria-label={def.label}
          onChange={(e) => onChange(e.target.value || null)}
          className={INPUT}
        >
          <option value="">—</option>
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "MULTISELECT": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-1 rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] p-1.5">
          {def.options.length === 0 && (
            <span className="px-1 text-[12px] text-muted">no options defined</span>
          )}
          {def.options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange(
                    on ? selected.filter((v) => v !== o.value) : [...selected, o.value],
                  )
                }
                className={`rounded-full border px-2 py-0.5 text-[11.5px] ${
                  on
                    ? "border-accent bg-accent-soft text-[#E4D3FF]"
                    : "border-line text-muted hover:text-ink"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    default:
      return (
        <input
          type={def.type === "URL" ? "url" : "text"}
          value={typeof value === "string" ? value : ""}
          aria-label={def.label}
          placeholder={def.type === "URL" ? "https://…" : undefined}
          onChange={(e) => onChange(e.target.value || null)}
          className={INPUT}
        />
      );
  }
}
