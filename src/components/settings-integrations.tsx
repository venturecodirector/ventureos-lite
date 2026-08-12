"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveIntegration,
  testIntegration,
  type IntegrationFieldView,
  type IntegrationsView,
} from "@/modules/integrations/actions";

const CARD = "rounded-[14px] border border-line bg-[rgba(239,241,248,0.04)] p-4 sm:p-5";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";

export function SettingsIntegrations({ data }: { data: IntegrationsView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string }>>({});

  return (
    <div className={CARD} id="integrations">
      <div className="mb-4">
        <h2 className="font-display text-2xl font-bold lowercase tracking-display">
          integrations
        </h2>
        <p className="mt-0.5 text-[12px] text-muted">
          Owner-only. Keys are encrypted before they are stored and only ever
          shown as the last four characters. A value set here overrides the
          server&apos;s environment for this workspace; clearing it falls back.
        </p>
      </div>

      {data.encryptionUnavailable && (
        <p
          role="alert"
          data-testid="integrations-no-key"
          className="mb-4 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]"
        >
          CREDENTIALS_KEY is not set on the server, so secrets cannot be stored.
          Set it and restart before saving anything here.
        </p>
      )}

      {data.problems.length > 0 && (
        <div
          role="alert"
          data-testid="integrations-problems"
          className="mb-4 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]"
        >
          {data.problems.map((p) => (
            <p key={p.key}>{p.message}</p>
          ))}
        </div>
      )}

      {msg && (
        <p
          role="status"
          data-testid="integrations-message"
          className={`mb-4 rounded-[8px] border px-3 py-2 text-[12.5px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </p>
      )}

      <div className="grid gap-3">
        {data.groups.map((g) => (
          <section key={g.id} className="rounded-[11px] border border-line p-3.5">
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h3 className="font-display text-[16px] font-bold lowercase tracking-display">
                {g.title}
              </h3>
              {g.testable && (
                <button
                  type="button"
                  className={`${BTN} ml-auto`}
                  disabled={pending}
                  data-testid={`integration-test-${g.id}`}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await testIntegration({ groupId: g.id });
                      setTests((t) => ({ ...t, [g.id]: res }));
                    })
                  }
                >
                  Test connection
                </button>
              )}
            </div>
            <p className="mb-3 text-[12px] text-muted">{g.description}</p>

            {tests[g.id] && (
              <p
                data-testid={`integration-test-result-${g.id}`}
                className={`mb-3 rounded-[8px] border px-3 py-2 text-[12px] ${
                  tests[g.id].ok
                    ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
                    : "border-[rgba(245,184,65,0.4)] bg-[rgba(245,184,65,0.08)] text-[#FFD79A]"
                }`}
              >
                {tests[g.id].message}
              </p>
            )}

            <div className="grid gap-2.5">
              {g.fields.map((f) => (
                <Field
                  key={f.key}
                  field={f}
                  disabled={pending || (f.kind === "secret" && data.encryptionUnavailable)}
                  onSaved={(text, ok) => {
                    setMsg({ kind: ok ? "ok" : "err", text });
                    router.refresh();
                  }}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* ---------- infrastructure (read-only) ---------- */}
      <section className="mt-4 rounded-[11px] border border-line p-3.5" data-testid="infra-list">
        <h3 className="mb-1 font-display text-[16px] font-bold lowercase tracking-display">
          infrastructure
        </h3>
        <p className="mb-3 text-[12px] text-muted">
          Set in the server environment and deliberately not editable here —
          changing a database URL or the encryption key from inside the app that
          depends on them is how you lock yourself out. Names only; values are
          never rendered.
        </p>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {data.infrastructure.map((v) => (
            <li
              key={v.name}
              className="flex items-center gap-2 rounded-[8px] border border-line px-2.5 py-1.5"
            >
              <code className="text-[11.5px] text-ink">{v.name}</code>
              <span
                className={`ml-auto text-[10.5px] ${v.present ? "text-pos" : "text-warn"}`}
              >
                {v.present ? "set" : "not set"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Field({
  field,
  disabled,
  onSaved,
}: {
  field: IntegrationFieldView;
  disabled: boolean;
  onSaved: (text: string, ok: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();

  function save(next: string) {
    startTransition(async () => {
      const res = await saveIntegration({ key: field.key, value: next });
      if (!res.ok) {
        onSaved(res.error, false);
        return;
      }
      setEditing(false);
      setValue("");
      onSaved(next ? `${field.label} updated.` : `${field.label} cleared.`, true);
    });
  }

  return (
    <div className="grid gap-1.5 sm:grid-cols-[180px_1fr] sm:items-center">
      <label className="text-[12px] text-muted" htmlFor={`f-${field.key}`}>
        {field.label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <input
              id={`f-${field.key}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={field.placeholder ?? (field.kind === "secret" ? "Paste the new value" : "")}
              autoComplete="off"
              data-testid={`integration-input-${field.key}`}
              className={`${INPUT} min-w-0 flex-1`}
            />
            <button
              type="button"
              className={BTN}
              disabled={pending || disabled}
              data-testid={`integration-save-${field.key}`}
              onClick={() => save(value)}
            >
              Save
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                setEditing(false);
                setValue("");
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <code
              data-testid={`integration-value-${field.key}`}
              className="min-w-0 flex-1 truncate rounded-[8px] border border-line bg-[rgba(0,5,29,0.4)] px-2.5 py-2 text-[12px] text-ink"
            >
              {field.display || <span className="text-muted">not set</span>}
            </code>
            {field.source && (
              <span
                className={`rounded-[5px] px-1.5 py-px text-[10px] ${
                  field.source === "db"
                    ? "bg-accent-soft text-accent-ink"
                    : "bg-panel-2 text-muted"
                }`}
                title={
                  field.source === "db"
                    ? "Set for this workspace"
                    : `Inherited from ${field.envVar}`
                }
              >
                {field.source === "db" ? "workspace" : "env"}
              </span>
            )}
            <button
              type="button"
              className={BTN}
              disabled={disabled}
              data-testid={`integration-edit-${field.key}`}
              onClick={() => setEditing(true)}
            >
              {field.configured ? "Replace" : "Set"}
            </button>
            {field.source === "db" && (
              <button
                type="button"
                className={BTN}
                disabled={pending || disabled}
                data-testid={`integration-clear-${field.key}`}
                onClick={() => save("")}
              >
                Clear
              </button>
            )}
          </>
        )}
        {field.help && !editing && (
          <p className="w-full text-[11px] text-muted">{field.help}</p>
        )}
      </div>
    </div>
  );
}
