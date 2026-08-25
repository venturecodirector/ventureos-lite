"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import { saveQuoteRules, resetQuoteRules, type QuoteRulesView } from "@/modules/quote-rules/actions";
import { DEFAULT_QUOTE_RULES, type QuoteRulesSettings } from "@/modules/quote-rules/rules";

/**
 * Settings → Quote follow-up rules (playbook-v4 P14/3).
 *
 * The thresholds are visible because they are judgements, not facts: three
 * opens rather than two, ninety seconds on the price rather than sixty. A
 * number hidden in code is a rule nobody can disagree with — and this one
 * decides when the whole team is told to pick up the phone.
 */
const BTN =
  "min-h-[34px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const NUM =
  "w-[86px] rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12.5px] tabular-nums text-ink outline-none focus:border-accent";

const LABEL: Record<string, { title: string; what: string }> = {
  repeat_open: {
    title: "Többször megnyitva, elfogadás nélkül",
    what: "Visszatértek hozzá, tehát érdekli őket, és valami mégis megállítja.",
  },
  price_dwell: {
    title: "Sokáig az áron, a tartalomig el sem jutottak",
    what: "Egy összeget mérlegelnek anélkül, hogy látnák, mit fedez. Ez tartalom-kérdés, nem árkérdés.",
  },
  went_quiet: {
    title: "Megnyitották, aztán elcsendesedett",
    what: "Egy rövid, nyomásmentes kérdés ilyenkor még jól esik.",
  },
};

export function SettingsQuoteRules({ view, isOwner }: { view: QuoteRulesView; isOwner: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [r, setR] = useState<QuoteRulesSettings>(view.rules);
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(saveQuoteRules(r));
      setMsg(res.ok ? "Mentve." : res.error);
      if (res.ok) router.refresh();
    });
  }

  function reset() {
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(resetQuoteRules());
      if (!res.ok) {
        setMsg(res.error);
        return;
      }
      setR(DEFAULT_QUOTE_RULES);
      router.refresh();
    });
  }

  const eff = (id: string) => view.effectiveness.find((e) => e.ruleId === id);

  const Row = ({
    id,
    children,
  }: {
    id: keyof typeof LABEL;
    children: React.ReactNode;
  }) => {
    const e = eff(id);
    return (
      <div className="grid gap-1.5 rounded-[10px] border border-line p-3">
        <div className="text-[12.5px] font-semibold text-ink">{LABEL[id]!.title}</div>
        <p className="text-[11.5px] text-muted">{LABEL[id]!.what}</p>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
        {e && (
          <p className="text-[11px] text-muted">
            {e.fired}× indult
            {e.rate != null
              ? ` · ezek ${Math.round(e.rate * 100)}%-a után elfogadták az ajánlatot`
              : " · a hatékonyságához még kevés adat"}
          </p>
        )}
      </div>
    );
  };

  const Toggle = ({
    on,
    onChange,
    label,
  }: {
    on: boolean;
    onChange: (v: boolean) => void;
    label: string;
  }) => (
    <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
      <input
        type="checkbox"
        checked={on}
        disabled={!isOwner}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-[#7427C6]"
      />
      {label}
    </label>
  );

  return (
    <section
      data-testid="settings-quote-rules"
      className="rounded-card border border-line bg-panel p-[18px]"
    >
      <h2 className="mb-1 font-display text-lg font-bold lowercase">quote follow-up rules</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        Amit az ajánlat olvasása elárul, teendővé fordítva. Minden szabály{" "}
        <b>ajánlatonként egyszer</b> indul, és mindig csak <b>teendőt és piszkozatot</b> hoz
        létre — küldeni innen semmit nem lehet.
      </p>

      <div className="grid gap-2.5">
        <Row id="repeat_open">
          <Toggle
            on={r.repeatOpen.enabled}
            onChange={(v) => setR({ ...r, repeatOpen: { ...r.repeatOpen, enabled: v } })}
            label="aktív"
          />
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <input
              className={NUM}
              type="number"
              min={2}
              max={20}
              disabled={!isOwner}
              value={r.repeatOpen.minSessions}
              onChange={(e) =>
                setR({
                  ...r,
                  repeatOpen: { ...r.repeatOpen, minSessions: Number(e.target.value) || 3 },
                })
              }
            />
            megnyitástól
          </label>
          <Toggle
            on={r.repeatOpen.draft}
            onChange={(v) => setR({ ...r, repeatOpen: { ...r.repeatOpen, draft: v } })}
            label="piszkozat is"
          />
        </Row>

        <Row id="price_dwell">
          <Toggle
            on={r.priceDwell.enabled}
            onChange={(v) => setR({ ...r, priceDwell: { ...r.priceDwell, enabled: v } })}
            label="aktív"
          />
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <input
              className={NUM}
              type="number"
              min={15}
              max={3600}
              disabled={!isOwner}
              value={r.priceDwell.minPricingSeconds}
              onChange={(e) =>
                setR({
                  ...r,
                  priceDwell: {
                    ...r.priceDwell,
                    minPricingSeconds: Number(e.target.value) || 90,
                  },
                })
              }
            />
            mp az áron
          </label>
          <Toggle
            on={r.priceDwell.draft}
            onChange={(v) => setR({ ...r, priceDwell: { ...r.priceDwell, draft: v } })}
            label="piszkozat is"
          />
        </Row>

        <Row id="went_quiet">
          <Toggle
            on={r.wentQuiet.enabled}
            onChange={(v) => setR({ ...r, wentQuiet: { ...r.wentQuiet, enabled: v } })}
            label="aktív"
          />
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <input
              className={NUM}
              type="number"
              min={2}
              max={90}
              disabled={!isOwner}
              value={r.wentQuiet.quietDays}
              onChange={(e) =>
                setR({
                  ...r,
                  wentQuiet: { ...r.wentQuiet, quietDays: Number(e.target.value) || 7 },
                })
              }
            />
            nap csend után
          </label>
          <Toggle
            on={r.wentQuiet.draft}
            onChange={(v) => setR({ ...r, wentQuiet: { ...r.wentQuiet, draft: v } })}
            label="piszkozat is"
          />
        </Row>
      </div>

      {isOwner && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={save} disabled={pending} className={BTN} data-testid="quote-rules-save">
            Mentés
          </button>
          <button onClick={reset} disabled={pending} className={BTN}>
            Alapértelmezés
          </button>
          {msg && <span className="text-[11.5px] text-muted">{msg}</span>}
        </div>
      )}
    </section>
  );
}
