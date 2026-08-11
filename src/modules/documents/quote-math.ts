/**
 * Quote totals (spec §4.9). House-rule presets: ~15% commission on pass-through
 * items, ~30% markup on production items. Money is integer HUF forints, VAT is
 * computed, never floats (CLAUDE.md "Money").
 */
export const PRESETS = {
  none: { label: "—", num: 100, den: 100 },
  passthrough: { label: "pass-through +15%", num: 115, den: 100 },
  production: { label: "production +30%", num: 130, den: 100 },
} as const;

export type PresetKey = keyof typeof PRESETS;

export function computeLineTotal(baseNet: number, preset: PresetKey): number {
  const p = PRESETS[preset];
  return Math.round((baseNet * p.num) / p.den);
}

export interface QuoteItem {
  description: string;
  baseNet: number; // integer forints
  preset: PresetKey;
}

export interface QuoteTotals {
  net: number;
  vat: number;
  gross: number;
}

export function computeQuoteTotals(
  items: QuoteItem[],
  vatRatePct: number,
): QuoteTotals {
  const net = items.reduce((sum, i) => sum + computeLineTotal(i.baseNet, i.preset), 0);
  const vat = Math.round((net * vatRatePct) / 100);
  return { net, vat, gross: net + vat };
}

export function formatHuf(forints: number): string {
  return `${forints.toLocaleString("hu-HU").replace(/ /g, " ")} Ft`;
}
