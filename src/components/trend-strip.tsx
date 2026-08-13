import type { AuditDelta } from "@/modules/audit/delta";
import { CATEGORY_LABEL } from "@/modules/audit/categories";

/**
 * What changed since last time (P2/5).
 *
 * Compact on purpose: the delta earns a strip, not a panel. Direction is
 * colour-coded against the OPPORTUNITY scale, where a rising number means a
 * weakening site — so red is "their site got worse", which for us is a reason
 * to call, and green means somebody may have beaten us to the work.
 */
export function TrendStrip({ delta }: { delta: AuditDelta | null }) {
  if (!delta) return null;

  const worse = delta.significance === "worse";
  const better = delta.significance === "better";
  const tone = worse
    ? "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)]"
    : better
      ? "border-[rgba(61,220,151,0.3)] bg-[rgba(61,220,151,0.07)]"
      : "border-line bg-panel";

  const moved = delta.categories
    .filter((c) => c.delta !== null && Math.abs(c.delta) >= 5)
    .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!))
    .slice(0, 3);

  return (
    <div className={`mt-3.5 rounded-card border p-3 ${tone}`}>
      <div className="flex flex-wrap items-baseline gap-2 text-[12.5px]">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Since {delta.previousAt.slice(0, 10)}
        </span>
        <span className="tabular-nums text-[#C9CEE3]">
          {delta.scoreFrom} → {delta.scoreTo}
        </span>
        <span
          className={
            worse ? "text-[#FF5C7A]" : better ? "text-[#3DDC97]" : "text-muted"
          }
        >
          {delta.scoreDelta > 0 ? "+" : ""}
          {delta.scoreDelta}
          {worse ? " · their site got worse" : better ? " · their site improved" : " · stable"}
        </span>
        {delta.broken.length > 0 && (
          <span className="text-muted">{delta.broken.length} newly failing</span>
        )}
        {delta.resolved.length > 0 && (
          <span className="text-muted">{delta.resolved.length} fixed</span>
        )}
      </div>
      {moved.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-4 text-[11.5px] text-muted">
          {moved.map((c) => (
            <span key={c.category}>
              {CATEGORY_LABEL[c.category].en} {c.delta! > 0 ? "+" : ""}
              {c.delta}
            </span>
          ))}
        </div>
      )}
      {better && (
        <p className="mt-1 text-[11.5px] text-muted">
          An improving site often means someone else was hired — worth a call sooner rather
          than later.
        </p>
      )}
    </div>
  );
}
