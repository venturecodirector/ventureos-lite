/**
 * Registry red-flag chip (spec §4.19). Reused on the lead screen and — when the
 * Documents module lands — on quote generation.
 */
export function RiskChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-2.5 py-0.5 text-[11px] font-semibold text-[#FFB3C2]">
      ⚠ {label}
    </span>
  );
}
