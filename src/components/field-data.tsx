import {
  formatMetric,
  verdictFor,
  fieldSummaryEn,
  fieldSummaryHu,
  type CruxData,
} from "@/modules/audit/crux";

/**
 * Lab score beside real-visitor field data (P2/2).
 *
 * Server-rendered and shared by the internal audit view and the public share
 * page — the numbers are identical facts about the prospect's own site, so
 * there is nothing internal to strip. Only the language changes.
 */
const ROWS = [
  { key: "lcp", en: "Loading (LCP)", hu: "Betöltés (LCP)" },
  { key: "inp", en: "Responsiveness (INP)", hu: "Válaszkészség (INP)" },
  { key: "cls", en: "Layout stability (CLS)", hu: "Elrendezés (CLS)" },
] as const;

const VERDICT_CLASS: Record<string, string> = {
  good: "text-[#3DDC97]",
  "needs-improvement": "text-warn",
  poor: "text-[#FF5C7A]",
};

export function FieldData({
  crux,
  lang,
  labDetail,
}: {
  crux: CruxData | null;
  lang: "en" | "hu";
  /** The PageSpeed line, when there is one. */
  labDetail?: string | null;
}) {
  const hu = lang === "hu";

  return (
    <div className="mt-3.5 rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        {hu ? "Sebesség — mérés és valós látogatók" : "Speed — lab vs. real visitors"}
      </div>

      {labDetail && (
        <div className="mb-2.5 text-[12px] text-[#C9CEE3]">
          {hu ? "Laborteszt (PageSpeed)" : "Lab (PageSpeed)"}{" "}
          <span className="text-muted">· {labDetail}</span>
        </div>
      )}

      {crux ? (
        <>
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-muted">
                <th className="py-1.5 pr-3 text-left font-semibold">
                  {hu ? "Valós látogatók (28 nap)" : "Field data (28 days)"}
                </th>
                <th className="py-1.5 pr-3 text-right font-semibold">p75</th>
                <th className="py-1.5 pr-3 text-right font-semibold">{hu ? "jó" : "good"}</th>
                <th className="py-1.5 pr-3 text-right font-semibold">
                  {hu ? "közepes" : "needs work"}
                </th>
                <th className="py-1.5 text-right font-semibold">{hu ? "gyenge" : "poor"}</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(({ key, en, hu: huLabel }) => {
                const m = crux[key];
                if (!m) return null;
                const v = verdictFor(key, m.p75);
                return (
                  <tr key={key} className="border-b border-[rgba(239,241,248,0.05)]">
                    <td className="py-1.5 pr-3 text-[#C9CEE3]">{hu ? huLabel : en}</td>
                    <td
                      className={`py-1.5 pr-3 text-right tabular-nums ${
                        v ? (VERDICT_CLASS[v] ?? "text-muted") : "text-muted"
                      }`}
                    >
                      {formatMetric(key, m.p75)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted">
                      {Math.round(m.good * 100)}%
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted">
                      {Math.round(m.needsImprovement * 100)}%
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted">
                      {Math.round(m.poor * 100)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
            {hu ? fieldSummaryHu(crux) : fieldSummaryEn(crux)}
            {crux.period ? ` · ${crux.period}` : ""} ·{" "}
            {crux.formFactor === "PHONE"
              ? hu
                ? "mobilforgalom"
                : "phone traffic"
              : hu
                ? "minden eszköz"
                : "all devices"}
          </p>
        </>
      ) : (
        <p className="text-[12px] leading-relaxed text-muted">
          {hu
            ? "Nincs elegendő forgalmi adat a valós látogatói méréshez — a Chrome csak a nagyobb forgalmú oldalakról közöl adatot."
            : "No field data — Chrome only reports on origins above a traffic threshold."}
        </p>
      )}
    </div>
  );
}
