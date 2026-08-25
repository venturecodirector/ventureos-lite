"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attemptData } from "@/lib/client/server-action";
import {
  previewBackfill,
  applyBackfill,
} from "@/modules/prospector/backfill-actions";
import type { BackfillPreview, BackfillState } from "@/modules/prospector/backfill-store";
import type { BackfillPlan, BackfillField } from "@/modules/prospector/backfill";

/**
 * Prospector → backfill the companies that came in before the fixes (P4/1e).
 *
 * Preview first, always. This rewrites company names across the CRM and fills
 * phone numbers the operator will actually ring, so every proposed change is on
 * screen with its old value beside it, and every one of them can be unticked.
 * The paid pass says what it will cost before it is clicked.
 */

const BTN =
  "min-h-[34px] rounded-[8px] border border-line px-3 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

const FIELD_LABEL: Record<BackfillField, string> = {
  name: "Cégnév",
  city: "Város",
  industry: "Iparág",
  phone: "Telefon (cég)",
  address: "Cím",
  domain: "Domain",
  website: "Weboldal",
  googlePlaceId: "Google place id",
  leadPhone: "Telefon (lead)",
  leadEmail: "E-mail (lead)",
};

/** Row key for the tick state: one company, one field. */
const key = (companyId: string, field: string) => `${companyId}|${field}`;

export function ProspectorBackfill({ state }: { state: BackfillState }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [plans, setPlans] = useState<BackfillPlan[] | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  if (state.total === 0) return null;

  function receive(incoming: BackfillPlan[]) {
    setPlans((prev) => {
      const merged = [...(prev ?? [])];
      for (const plan of incoming) {
        const at = merged.findIndex((p) => p.companyId === plan.companyId);
        if (at >= 0) merged[at] = plan;
        else merged.push(plan);
      }
      return merged;
    });
    setTicked((prev) => {
      const next = { ...prev };
      for (const plan of incoming) {
        for (const change of plan.changes) {
          // A hole being filled is ticked; a value being REPLACED is not, and a
          // row Google could not confirm is not either. The operator opts in to
          // anything that destroys what is already there.
          const safe = !change.overwrites && plan.level !== "likely";
          next[key(plan.companyId, change.field)] = safe;
        }
      }
      return next;
    });
  }

  function runFree() {
    setMsg(null);
    setProgress(null);
    startTransition(async () => {
      const res = await attemptData(previewBackfill({ offset: 0, google: false }));
      if (!res.ok) return setMsg(res.error);
      receive(res.data.plans);
      setMsg(res.data.notice);
    });
  }

  /**
   * The paid pass, batch by batch.
   *
   * Each batch is a separate action call so the operator sees the table filling
   * rather than a spinner, and so a network failure halfway through keeps the
   * batches already paid for.
   */
  function runGoogle() {
    setMsg(null);
    startTransition(async () => {
      let offset: number | null = 0;
      let spent = 0;
      const notes: string[] = [];
      while (offset !== null) {
        // Annotated: `offset` is assigned from `res`, which TypeScript otherwise
        // has to infer from a call that reads `offset`.
        const res: { ok: true; data: BackfillPreview } | { ok: false; error: string } =
          await attemptData(previewBackfill({ offset, google: true }));
        if (!res.ok) {
          setMsg(`${res.error} (${spent.toFixed(2)} USD already spent, results kept)`);
          return;
        }
        receive(res.data.plans);
        spent += res.data.costUsd;
        if (res.data.notice) notes.push(res.data.notice);
        offset = res.data.nextOffset;
        setProgress(
          offset === null
            ? `Kész — ${res.data.total} cég, ${spent.toFixed(2)} USD.`
            : `${offset}/${res.data.total} · ${spent.toFixed(2)} USD`,
        );
      }
      setMsg(notes.join(" ") || null);
    });
  }

  function apply() {
    if (!plans) return;
    const rows = plans
      .map((plan) => ({
        companyId: plan.companyId,
        changes: plan.changes
          .filter((c) => ticked[key(plan.companyId, c.field)])
          .map((c) => ({ field: c.field, to: c.to })),
      }))
      .filter((r) => r.changes.length > 0);
    if (!rows.length) return setMsg("Nincs kipipálva semmi.");

    setMsg(null);
    startTransition(async () => {
      const res = await attemptData(applyBackfill({ rows }));
      if (!res.ok) return setMsg(res.error);
      const { companies, fields, emailsFound, notice } = res.data;
      setPlans(null);
      setMsg(
        `${companies} cég frissítve, ${fields} mező · ${emailsFound} e-mail a weboldalakról.${
          notice ? ` ${notice}` : ""
        }`,
      );
      router.refresh();
    });
  }

  const tickedCount = plans
    ? plans.reduce(
        (n, p) => n + p.changes.filter((c) => ticked[key(p.companyId, c.field)]).length,
        0,
      )
    : 0;

  return (
    <section
      data-testid="prospector-backfill"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-lg font-bold lowercase">
        korábbi prospectek feltöltése
      </h2>
      <p className="mb-3 text-[12.5px] leading-relaxed text-muted">
        {state.total} cég került be a Prospectorból még a javítások előtt.{" "}
        {state.missingCity} városa, {state.missingPhone} telefonszáma és{" "}
        {state.missingEmail} lead e-mail-címe hiányzik, {state.englishIndustry} iparág
        angolul áll, és {state.missingPlaceId} cégnek nincs Google place id-je — ez
        utóbbi az egyetlen egzakt kulcs a duplikátumszűréshez.
      </p>

      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={pending} onClick={runFree}>
          Ingyenes javítás előnézete
        </button>
        <button
          type="button"
          className={BTN}
          disabled={pending}
          onClick={runGoogle}
          title="Egy Google Places kérés cégenként"
        >
          Google-lekérdezés ({state.total} kérés · ~{state.googleCostUsd.toFixed(2)} USD)
        </button>
        {progress && <span className="self-center text-[11.5px] text-muted">{progress}</span>}
      </div>

      <p className="mb-3 text-[11.5px] leading-relaxed text-muted">
        Az ingyenes javítás a már eltárolt címből olvassa ki a várost, a zárt
        kategórialistából fordítja az iparágat, és a cég telefonszámát ráteszi a
        leadre. A Google-lekérdezés ezen felül place id-t, hiányzó telefonszámot és
        weboldalt hoz — és ahol weboldal lett, onnan e-mail-címet is. Ahol nem
        azonosítható biztosan a cég, semmit nem ír.
      </p>

      {plans && plans.length > 0 && (
        <>
          <div className="max-h-[420px] overflow-y-auto rounded-[9px] border border-line">
            <table className="w-full text-left text-[11.5px]">
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.companyId} className="border-b border-line/60 align-top last:border-0">
                    <td className="w-[38%] p-2">
                      <div className="font-semibold text-ink">{plan.label}</div>
                      <div className="text-[10.5px] text-muted">
                        {plan.source === "google"
                          ? plan.level === "confirmed"
                            ? "Google · azonosítva"
                            : "Google · valószínű, ellenőrizd"
                          : "a tárolt adatból"}
                      </div>
                    </td>
                    <td className="p-2">
                      {plan.changes.map((c) => (
                        <label
                          key={c.field}
                          className="mb-1 flex cursor-pointer items-start gap-2 last:mb-0"
                        >
                          <input
                            type="checkbox"
                            className="mt-[3px] h-3.5 w-3.5 accent-accent"
                            checked={!!ticked[key(plan.companyId, c.field)]}
                            onChange={(e) =>
                              setTicked((prev) => ({
                                ...prev,
                                [key(plan.companyId, c.field)]: e.target.checked,
                              }))
                            }
                          />
                          <span className="leading-snug">
                            <span className="text-muted">{FIELD_LABEL[c.field]}: </span>
                            {c.overwrites && (
                              <span className="text-muted line-through">{c.from} </span>
                            )}
                            <span className="text-ink">{c.to}</span>
                          </span>
                        </label>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN} disabled={pending || !tickedCount} onClick={apply}>
              {tickedCount} kipipált mező mentése
            </button>
            <button type="button" className={BTN} disabled={pending} onClick={() => setPlans(null)}>
              Elvetés
            </button>
          </div>
        </>
      )}

      {plans && plans.length === 0 && (
        <p className="text-[12.5px] text-muted">Nincs mit javítani.</p>
      )}
      {msg && <p className="mt-3 text-[12.5px] text-muted">{msg}</p>}
    </section>
  );
}
