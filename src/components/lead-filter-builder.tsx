"use client";

import { useState } from "react";
import {
  FIELD_LABELS,
  FILTER_FIELDS,
  OPERATORS_BY_FIELD,
  OPERATOR_LABELS,
  labelForField,
  operatorsForField,
  type FilterCondition,
  type FilterField,
  type FilterOperator,
  type FilterSet,
} from "@/modules/leads/filters";
import { describeCondition, MAX_CONDITIONS } from "@/modules/leads/view-params";
import type { LeadFacets } from "@/modules/leads/table";
import { customFieldRef, isCustomFieldRef, type FieldDef } from "@/modules/fields/types";

/**
 * The filter builder (playbook-v2 P3/2): combinable field/operator/value
 * conditions over the core lead fields.
 *
 * It edits a DRAFT and only lifts the result on Apply. Re-running the query on
 * every keystroke would re-sort and re-paginate the table under the user while
 * they are halfway through describing what they want.
 */

const field0: FilterField = "stage";

function defaultCondition(): FilterCondition {
  return { field: field0, operator: OPERATORS_BY_FIELD[field0][0]!, values: [] };
}

/** Which values a given operator needs, so the row renders the right input. */
type InputKind = "none" | "number" | "range" | "text" | "one" | "many";

function inputKind(
  field: string,
  operator: FilterOperator,
  customFields: FieldDef[],
): InputKind {
  if (["is_set", "is_not_set", "is_true", "is_false"].includes(operator)) return "none";
  if (operator === "between") return "range";
  if (["gte", "lte", "within_days", "older_than_days"].includes(operator)) return "number";
  if (["is_any_of", "has_any_of", "has_all_of", "has_none_of"].includes(operator)) return "many";
  if (isCustomFieldRef(field)) {
    const def = customFields.find((d) => customFieldRef(d.key) === field);
    return def?.type === "SELECT" ? "one" : "text";
  }
  if (["stage", "source", "owner"].includes(field)) return "one";
  return "text";
}

/** The option list a field draws on, when it has one. */
function optionsFor(
  field: string,
  facets: LeadFacets,
  customFields: FieldDef[],
): Array<{ value: string; label: string }> {
  const plain = (values: string[]) =>
    values.map((v) => ({ value: v, label: v.toLowerCase().replace(/_/g, " ") }));
  if (isCustomFieldRef(field)) {
    const def = customFields.find((d) => customFieldRef(d.key) === field);
    return def?.options ?? [];
  }
  switch (field) {
    case "stage":
      return plain(facets.stages);
    case "source":
      return plain(facets.sources);
    case "signals":
      return facets.signals.map((v) => ({ value: v, label: v }));
    case "owner":
      return facets.owners.map((o) => ({ value: o.id, label: o.name }));
    case "industry":
      return facets.industries.map((v) => ({ value: v, label: v }));
    case "city":
      return facets.cities.map((v) => ({ value: v, label: v }));
    default:
      return [];
  }
}

const selectClass =
  "rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent";
const inputClass = `${selectClass} min-w-0`;

function ConditionRow({
  condition,
  facets,
  customFields,
  onChange,
  onRemove,
}: {
  condition: FilterCondition;
  facets: LeadFacets;
  customFields: FieldDef[];
  onChange: (next: FilterCondition) => void;
  onRemove: () => void;
}) {
  const field = String(condition.field);
  const specs = customFields.map((d) => ({ key: d.key, type: d.type, label: d.label }));
  const operators = operatorsForField(field, specs);
  const kind = inputKind(field, condition.operator, customFields);
  const options = optionsFor(field, facets, customFields);
  const selected = condition.values ?? [];

  function setField(next: string) {
    // Operators are field-specific, so changing the field has to reset the rest
    // of the row — otherwise "stage is between 3 and 5" becomes representable.
    const ops = operatorsForField(next, specs);
    onChange({ field: next, operator: ops[0]!, values: [] });
  }

  function toggleValue(value: string) {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange({ ...condition, values: next });
  }

  return (
    <div
      data-testid="filter-condition"
      className="flex flex-wrap items-start gap-2 rounded-[10px] border border-line bg-[rgba(0,5,29,0.35)] p-2"
    >
      <select
        aria-label="Field"
        data-testid="filter-field"
        value={field}
        onChange={(e) => setField(e.target.value)}
        className={selectClass}
      >
        {FILTER_FIELDS.map((f) => (
          <option key={f} value={f}>
            {FIELD_LABELS[f]}
          </option>
        ))}
        {/* Owner-defined fields (P5/1), grouped so they read as a workspace's
            own vocabulary rather than as more built-ins. */}
        {customFields.length > 0 && (
          <optgroup label="Custom fields">
            {customFields.map((d) => (
              <option key={d.key} value={customFieldRef(d.key)}>
                {d.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      <select
        aria-label="Operator"
        data-testid="filter-operator"
        value={condition.operator}
        onChange={(e) =>
          onChange({ ...condition, operator: e.target.value as FilterOperator })
        }
        className={selectClass}
      >
        {operators.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </option>
        ))}
      </select>

      {kind === "number" && (
        <input
          type="number"
          aria-label="Value"
          data-testid="filter-value"
          value={condition.value == null ? "" : String(condition.value)}
          onChange={(e) =>
            onChange({ ...condition, value: e.target.value === "" ? null : Number(e.target.value) })
          }
          className={`${inputClass} w-24`}
        />
      )}

      {kind === "range" && (
        <span className="flex items-center gap-1.5">
          <input
            type="number"
            aria-label="Minimum"
            data-testid="filter-min"
            value={condition.min ?? ""}
            onChange={(e) =>
              onChange({ ...condition, min: e.target.value === "" ? undefined : Number(e.target.value) })
            }
            className={`${inputClass} w-20`}
          />
          <span className="text-[12px] text-muted">and</span>
          <input
            type="number"
            aria-label="Maximum"
            data-testid="filter-max"
            value={condition.max ?? ""}
            onChange={(e) =>
              onChange({ ...condition, max: e.target.value === "" ? undefined : Number(e.target.value) })
            }
            className={`${inputClass} w-20`}
          />
        </span>
      )}

      {kind === "text" && (
        <>
          <input
            aria-label="Value"
            data-testid="filter-value"
            list={options.length ? `facet-${field}` : undefined}
            value={condition.value == null ? "" : String(condition.value)}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            placeholder={field === "text" ? "name, company, email…" : "value"}
            className={`${inputClass} w-48`}
          />
          {options.length > 0 && (
            <datalist id={`facet-${field}`}>
              {options.map((o) => (
                <option key={o.value} value={o.value} />
              ))}
            </datalist>
          )}
        </>
      )}

      {kind === "one" && (
        <select
          aria-label="Value"
          data-testid="filter-value"
          value={condition.value == null ? "" : String(condition.value)}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
          className={selectClass}
        >
          <option value="">choose…</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {kind === "many" && (
        <div className="flex max-h-[132px] min-w-[200px] flex-1 flex-wrap gap-1 overflow-y-auto rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] p-1.5">
          {options.length === 0 && (
            <span className="px-1 text-[12px] text-muted">nothing to choose from yet</span>
          )}
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => toggleValue(o.value)}
                aria-pressed={on}
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
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove condition"
        className="ml-auto rounded-[8px] border border-line px-2 py-1 text-[12px] text-muted hover:bg-panel-2 hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}

export function LeadFilterBuilder({
  value,
  facets,
  customFields = [],
  onApply,
  activeCount,
}: {
  value: FilterSet;
  facets: LeadFacets;
  customFields?: FieldDef[];
  onApply: (next: FilterSet) => void;
  activeCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FilterSet>(value);

  function openPanel() {
    // Always start from what is actually applied, not from an abandoned draft.
    setDraft(value);
    setOpen(true);
  }

  function update(index: number, next: FilterCondition) {
    setDraft({ ...draft, conditions: draft.conditions.map((c, i) => (i === index ? next : c)) });
  }

  function remove(index: number) {
    setDraft({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) });
  }

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openPanel())}
          data-testid="filter-toggle"
          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-panel-2"
        >
          Filters
          {activeCount > 0 && (
            <span className="ml-1.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] text-[#E4D3FF]">
              {activeCount}
            </span>
          )}
        </button>

        {/* The applied conditions, readable at a glance without opening the panel. */}
        {value.conditions.map((c, i) => (
          <span
            key={i}
            data-testid="filter-chip"
            className="inline-flex items-center gap-1.5 rounded-full border border-accent-soft bg-accent-soft/40 px-2.5 py-0.5 text-[11.5px] text-[#E4D3FF]"
          >
            {describeCondition(c)}
            <button
              type="button"
              aria-label={`Remove filter: ${describeCondition(c)}`}
              onClick={() =>
                onApply({ ...value, conditions: value.conditions.filter((_, j) => j !== i) })
              }
              className="text-[#E4D3FF]/70 hover:text-ink"
            >
              ✕
            </button>
          </span>
        ))}

        {value.conditions.length > 0 && (
          <button
            type="button"
            data-testid="filter-clear"
            onClick={() => onApply({ match: "all", conditions: [] })}
            className="text-[12px] text-muted underline hover:text-ink"
          >
            clear all
          </button>
        )}
      </div>

      {open && (
        <div
          data-testid="filter-panel"
          className="absolute left-0 top-[calc(100%+8px)] z-30 w-[min(720px,calc(100vw-32px))] rounded-card border border-line bg-[#050A25] p-3 shadow-glow-lg"
        >
          <div className="mb-2.5 flex items-center gap-2 text-[12px] text-muted">
            <span>Match</span>
            <select
              aria-label="Match mode"
              data-testid="filter-match"
              value={draft.match}
              onChange={(e) => setDraft({ ...draft, match: e.target.value as "all" | "any" })}
              className={selectClass}
            >
              <option value="all">all conditions</option>
              <option value="any">any condition</option>
            </select>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto text-muted hover:text-ink"
              aria-label="Close filters"
            >
              ✕
            </button>
          </div>

          <div className="grid gap-2">
            {draft.conditions.length === 0 && (
              <p className="px-1 py-2 text-[12.5px] text-muted">
                No conditions yet — the table is showing every lead.
              </p>
            )}
            {draft.conditions.map((c, i) => (
              <ConditionRow
                key={i}
                condition={c}
                facets={facets}
                customFields={customFields}
                onChange={(next) => update(i, next)}
                onRemove={() => remove(i)}
              />
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="filter-add"
              disabled={draft.conditions.length >= MAX_CONDITIONS}
              onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, defaultCondition()] })}
              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-50"
            >
              + Add condition
            </button>
            <button
              type="button"
              onClick={() => setDraft({ match: "all", conditions: [] })}
              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] text-muted hover:bg-panel-2 hover:text-ink"
            >
              Reset
            </button>
            <button
              type="button"
              data-testid="filter-apply"
              onClick={() => {
                onApply(draft);
                setOpen(false);
              }}
              className="ml-auto rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-1.5 text-[12.5px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
