"use client";
import { attempt } from "@/lib/client/server-action";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createCustomField, updateCustomField } from "@/modules/fields/actions";
import {
  CUSTOM_FIELD_TYPES,
  ENTITY_LABELS,
  FIELD_ENTITIES,
  TYPE_LABELS,
  slugifyKey,
  type CustomFieldType,
  type FieldDef,
  type FieldEntity,
} from "@/modules/fields/types";

/**
 * Settings → Fields (playbook-v2 P5/1).
 *
 * The one place a workspace's own vocabulary is defined. Two things it
 * deliberately refuses to offer, both because they would silently reinterpret
 * data already stored:
 *   - changing a field's TYPE. A number turned into a select leaves every
 *     existing value invalid and nothing can tell you which rows stopped
 *     meaning anything.
 *   - deleting a field. Archive is the only removal, so the values stay
 *     readable — and, just as importantly, stay erasable when someone asks.
 */

const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

function needsOptions(type: CustomFieldType): boolean {
  return type === "SELECT" || type === "MULTISELECT";
}

export function SettingsFields({
  defs,
  canManage,
}: {
  defs: FieldDef[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [entity, setEntity] = useState<FieldEntity>("lead");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<CustomFieldType>("TEXT");
  const [optionsText, setOptionsText] = useState("");
  const [required, setRequired] = useState(false);
  const [help, setHelp] = useState("");
  const [error, setError] = useState<string | null>(null);

  const forEntity = defs.filter((d) => d.entity === entity);
  const key = slugifyKey(label);

  function add() {
    setError(null);
    startTransition(async () => {
      const options = optionsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [value, ...rest] = line.split("|");
          return { value: value.trim(), label: (rest.join("|") || value).trim() };
        });
      const res = await attempt(createCustomField({
        entity,
        label,
        type,
        required,
        help: help || null,
        options: needsOptions(type) ? options : undefined,
      }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setLabel("");
      setOptionsText("");
      setRequired(false);
      setHelp("");
      router.refresh();
    });
  }

  function patch(id: string, change: Record<string, unknown>) {
    setError(null);
    startTransition(async () => {
      const res = await attempt(updateCustomField({ id, ...change }));
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <section
      data-testid="settings-fields"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-[18px] lowercase tracking-display">fields</h2>
      <p className="mb-4 max-w-[620px] text-[12.5px] text-muted">
        Your own fields on leads, companies and deals. They appear on the record, as
        optional table columns, in the filter builder, and in CSV import and export.
        A field is archived rather than deleted, so its values stay readable.
      </p>

      {error && <p className="mb-3 text-[12.5px] text-[#FFB3C2]">{error}</p>}

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FIELD_ENTITIES.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => setEntity(e)}
            data-testid={`fields-entity-${e}`}
            className={`rounded-[10px] border px-3 py-1.5 text-[12.5px] font-medium ${
              entity === e
                ? "border-accent bg-accent-soft text-[#E4D3FF]"
                : "border-line bg-panel text-muted hover:bg-panel-2 hover:text-ink"
            }`}
          >
            {ENTITY_LABELS[e]}
          </button>
        ))}
      </div>

      {forEntity.length === 0 ? (
        <p className="mb-4 text-[12.5px] text-muted">
          No fields on {ENTITY_LABELS[entity].toLowerCase()} yet.
        </p>
      ) : (
        <ul className="mb-4 grid gap-1.5" data-testid="fields-list">
          {forEntity.map((d) => (
            <li
              key={d.id}
              className={`flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-[rgba(0,5,29,0.35)] px-3 py-2 text-[12.5px] ${
                d.archived ? "opacity-60" : ""
              }`}
            >
              <b>{d.label}</b>
              <code className="rounded-[5px] border border-line px-1.5 py-px text-[11px] text-muted">
                {d.key}
              </code>
              <span className="text-[11.5px] text-muted">{TYPE_LABELS[d.type]}</span>
              {d.required && !d.archived && (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-ink">
                  required
                </span>
              )}
              {d.archived && (
                <span className="rounded-full bg-panel px-2 py-0.5 text-[10px] font-semibold text-muted">
                  archived
                </span>
              )}
              {d.options.length > 0 && (
                <span className="text-[11px] text-muted">
                  {d.options.length} option{d.options.length === 1 ? "" : "s"}
                </span>
              )}
              {canManage && (
                <span className="ml-auto flex gap-1.5">
                  {!d.archived && (
                    <button
                      type="button"
                      className={BTN}
                      disabled={pending}
                      onClick={() => patch(d.id, { required: !d.required })}
                    >
                      {d.required ? "Make optional" : "Make required"}
                    </button>
                  )}
                  <button
                    type="button"
                    className={BTN}
                    disabled={pending}
                    data-testid={`field-archive-${d.key}`}
                    onClick={() => patch(d.id, { archived: !d.archived })}
                  >
                    {d.archived ? "Restore" : "Archive"}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="grid gap-2 rounded-[11px] border border-line p-3">
          <p className={LABEL}>Add a field to {ENTITY_LABELS[entity].toLowerCase()}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className={LABEL}>Label</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Ügyfél típusa"
                data-testid="field-label"
                className={INPUT}
              />
              {label && (
                <span className="text-[11px] text-muted">
                  key: <code>{key || "—"}</code>
                </span>
              )}
            </label>
            <label className="grid gap-1">
              <span className={LABEL}>Type</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as CustomFieldType)}
                data-testid="field-type"
                className={INPUT}
              >
                {CUSTOM_FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {needsOptions(type) && (
            <label className="grid gap-1">
              <span className={LABEL}>Options — one per line</span>
              <textarea
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                rows={4}
                data-testid="field-options"
                placeholder={"retail\nhoreca|HoReCa"}
                className={`${INPUT} font-mono text-[12px]`}
              />
              <span className="text-[11px] text-muted">
                Use <code>value|Label</code> when the stored value should differ from what
                people read.
              </span>
            </label>
          )}

          <label className="grid gap-1">
            <span className={LABEL}>Help text (optional)</span>
            <input value={help} onChange={(e) => setHelp(e.target.value)} className={INPUT} />
          </label>

          <label className="flex items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
              className="accent-[#7427C6]"
            />
            Required
          </label>

          <div>
            <button
              type="button"
              onClick={add}
              disabled={pending || !label.trim()}
              data-testid="field-add"
              className="min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45"
            >
              {pending ? "Adding…" : "Add field"}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-muted">
          Only an Owner can change the field set.
        </p>
      )}
    </section>
  );
}
