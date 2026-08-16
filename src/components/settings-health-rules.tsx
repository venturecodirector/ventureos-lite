"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { resetHealthRules, saveHealthRules } from "@/modules/revenue/health-actions";
import { DEFAULT_HEALTH_RULES, type HealthRules } from "@/modules/revenue/health";

/**
 * Settings → Client health (playbook-v3 P11/1c).
 *
 * The playbook is explicit that the scoring is rules with sane defaults and no
 * AI, so the rules have to be visible and editable — a threshold hidden in code
 * is a rule nobody can disagree with.
 */

const FIELDS: Array<{ key: keyof HealthRules; label: string; hint: string; unit: string }> = [
  {
    key: "paymentLateAmberDays",
    label: "Invoice overdue — amber",
    hint: "Days past the issue date with an invoice still unpaid.",
    unit: "days",
  },
  {
    key: "paymentLateRedDays",
    label: "Invoice overdue — red",
    hint: "Kept at or above the amber threshold, whatever is typed.",
    unit: "days",
  },
  {
    key: "quietAmberMonths",
    label: "No contact — amber",
    hint: "Months since any activity, email or call on the client.",
    unit: "months",
  },
  {
    key: "quietRedMonths",
    label: "No contact — red",
    hint: "Also reached early for a client who is still new.",
    unit: "months",
  },
  {
    key: "youngClientMonths",
    label: "Still a new client",
    hint: "Under this age, silence counts one level worse.",
    unit: "months",
  },
];

export function SettingsHealthRules({
  initial,
  isOwner,
}: {
  initial: HealthRules;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<HealthRules>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function commit(next: HealthRules) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await saveHealthRules(next);
      if (!res.ok) {
        setError(res.error);
        setRules(initial);
        return;
      }
      // The server normalises (red never below amber), so take back what it
      // stored rather than what was typed.
      setRules(res.rules);
      setSaved(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="settings-health-rules"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-lg font-bold lowercase">client health</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        Rules, not judgement — no AI touches this. A client goes amber or red on
        these thresholds, and every flag shows the reason it fired.
      </p>

      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3 py-2 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}
      {saved && <p className="mb-3 text-[12px] text-pos">Saved.</p>}

      <div className="grid gap-2.5">
        {FIELDS.map((field) => (
          <label key={field.key} className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">
              <b className="block text-[12.5px]">{field.label}</b>
              <span className="block text-[11.5px] text-muted">{field.hint}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                value={rules[field.key]}
                disabled={!isOwner || busy}
                data-testid={`health-rule-${field.key}`}
                onChange={(e) =>
                  setRules((r) => ({ ...r, [field.key]: Number(e.target.value) }))
                }
                onBlur={() => commit(rules)}
                className="w-20 rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-right text-[13px] tabular-nums text-ink outline-none focus:border-accent disabled:opacity-50"
              />
              <span className="w-12 text-[11.5px] text-muted">{field.unit}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={!isOwner || busy}
          data-testid="health-rules-reset"
          onClick={async () => {
            setBusy(true);
            const res = await resetHealthRules();
            if (res.ok) setRules(res.rules);
            setBusy(false);
            router.refresh();
          }}
          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-50"
        >
          Restore defaults
        </button>
        <span className="text-[11.5px] text-muted">
          Defaults: {DEFAULT_HEALTH_RULES.paymentLateAmberDays}/
          {DEFAULT_HEALTH_RULES.paymentLateRedDays} days, {DEFAULT_HEALTH_RULES.quietAmberMonths}/
          {DEFAULT_HEALTH_RULES.quietRedMonths} months.
        </span>
        {!isOwner && (
          <span className="ml-auto text-[11.5px] text-muted">Owner-only</span>
        )}
      </div>
    </section>
  );
}
