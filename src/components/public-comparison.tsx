import {
  anonymizeComparison,
  peerColumnLabelHu,
  type ComparisonTable,
} from "@/modules/audit/comparison";

/**
 * Competitor comparison as a PROSPECT may see it (P2/3).
 *
 * Never a name, never a URL, never a per-competitor number — this report is
 * one company's, and publishing another company's audit on it would be
 * indefensible whatever the sales value. The stripping happens in
 * anonymizeComparison, so the only thing this component can render is the
 * reader's own number beside one anonymous average.
 */
const DIRECTION_CLASS: Record<string, string> = {
  better: "text-[#3DDC97]",
  worse: "text-[#FF5C7A]",
  same: "text-muted",
};

export function PublicComparison({ table }: { table: ComparisonTable | null }) {
  if (!table || table.subjects.length < 2) return null;
  const anon = anonymizeComparison(table);

  return (
    <div className="mt-7">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        Összehasonlítás helyi versenytársakkal
      </div>
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-muted">
            <th className="py-1.5 pr-3 text-left font-semibold">Szempont</th>
            <th className="py-1.5 pr-3 text-right font-semibold">Ez az oldal</th>
            <th className="py-1.5 text-right font-semibold">
              {peerColumnLabelHu(anon.competitorCount)}
            </th>
          </tr>
        </thead>
        <tbody>
          {anon.rows.map((r) => (
            <tr key={r.hu} className="border-b border-[rgba(239,241,248,0.05)]">
              <td className="py-1.5 pr-3 text-[#C9CEE3]">{r.hu}</td>
              <td
                className={`py-1.5 pr-3 text-right tabular-nums ${
                  DIRECTION_CLASS[r.direction] ?? "text-muted"
                }`}
              >
                {r.mine === null ? "—" : r.mine}
              </td>
              <td className="py-1.5 text-right tabular-nums text-muted">
                {r.peerAverage === null ? "—" : r.peerAverage}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
        A versenytársak azonos, gépi mérésen estek át. Nevüket nem közöljük.
      </p>
    </div>
  );
}
