"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { saveTargets, type TargetRow } from "@/modules/targets/actions";

/**
 * Settings → Weekly targets (spec §4.1).
 *
 * Empty means NO target, not a target of zero — the Friday report already knows
 * how to say "no target set", and a zero would read as a goal of nothing.
 */
const BTN =
  "min-h-[34px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

export function SettingsTargets({ targets, isOwner }: { targets: TargetRow[]; isOwner: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(targets.map((t) => [t.metric, t.value === null ? "" : String(t.value)])),
  );
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(
        saveTargets({
          targets: targets.map((t) => {
            const raw = (values[t.metric] ?? "").trim();
            return { metric: t.metric, value: raw === "" ? null : Number(raw) };
          }),
        }),
      );
      setMsg(res.ok ? "Mentve." : res.error);
      if (res.ok) router.refresh();
    });
  }

  return (
    <section
      data-testid="settings-targets"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-lg font-bold lowercase">weekly targets</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        Ehhez méri magát a pénteki riport. Üresen hagyva nincs célszám — a riport
        akkor csak a tényt mutatja, összehasonlítás nélkül.
      </p>

      <div className="grid gap-2">
        {targets.map((t) => (
          <div key={t.metric} className="flex flex-wrap items-center gap-2">
            <span className="min-w-[170px] flex-1">
              <span className="block text-[12.5px] text-ink">{t.label}</span>
              <span className="block text-[11px] text-muted">{t.hint}</span>
            </span>
            <input
              type="number"
              min={0}
              max={100000}
              disabled={!isOwner}
              value={values[t.metric] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [t.metric]: e.target.value }))}
              placeholder="nincs"
              data-testid={`target-${t.metric}`}
              className="w-[100px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12.5px] tabular-nums text-ink outline-none focus:border-accent"
            />
            <span className="w-[56px] text-[11px] text-muted">{t.unit}</span>
          </div>
        ))}
      </div>

      {isOwner && (
        <div className="mt-3 flex items-center gap-2">
          <button onClick={save} disabled={pending} className={BTN} data-testid="targets-save">
            Mentés
          </button>
          {msg && <span className="text-[11.5px] text-muted">{msg}</span>}
        </div>
      )}
    </section>
  );
}
