/**
 * Finding → service item mapping (P2/4).
 *
 * The step between "here is what is wrong" and "here is what it costs" is
 * where most audits stall. This is a per-workspace lookup table: an audit
 * category maps to a service line and a price band, so selected findings turn
 * into a DRAFT quote in one action.
 *
 * Deterministic and editable. No AI decides a price — and per CLAUDE.md rule 4
 * nothing here renders a legal document either; it only prefills the existing
 * quote builder, which the Owner then edits and finalises as always.
 *
 * THE SEEDED PRICES ARE PLACEHOLDERS. They are the shape of the answer, not
 * the answer: the Owner's real catalogue belongs in Settings, and the UI says
 * so until it has been edited.
 */
import type { AuditCategory } from "./categories";

export interface ServiceMapping {
  /** The quote line as the client will read it. */
  item: string;
  /** Integer forints, per CLAUDE.md: money is never a float. */
  minHuf: number;
  maxHuf: number;
}

export const DEFAULT_SERVICE_MAP: Record<AuditCategory, ServiceMapping> = {
  security: { item: "Biztonsági beállítások rendbetétele (HTTPS, fejlécek)", minHuf: 60_000, maxHuf: 140_000 },
  email: { item: "E-mail hitelesítés beállítása (SPF, DMARC)", minHuf: 40_000, maxHuf: 80_000 },
  legal: { item: "Jogi megfelelési csomag (impresszum, adatkezelés, süti)", minHuf: 80_000, maxHuf: 180_000 },
  seo: { item: "Keresőoptimalizálási alapcsomag", minHuf: 120_000, maxHuf: 280_000 },
  conversion: { item: "Mérés és megkeresési pontok kiépítése", minHuf: 90_000, maxHuf: 220_000 },
  accessibility: { item: "Akadálymentesítési javítások", minHuf: 150_000, maxHuf: 400_000 },
  performance: { item: "Sebesség-optimalizálás", minHuf: 150_000, maxHuf: 350_000 },
  structure: { item: "Oldalszerkezet rendezése (linkek, címek, aloldalak)", minHuf: 90_000, maxHuf: 200_000 },
};

/** Owner overrides from Workspace.auditConfig.serviceMap, merged per key. */
export function serviceMapFrom(config: unknown): Record<AuditCategory, ServiceMapping> {
  const out = { ...DEFAULT_SERVICE_MAP };
  const raw =
    config && typeof config === "object" && "serviceMap" in config
      ? (config as { serviceMap?: unknown }).serviceMap
      : null;
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!(key in out) || !value || typeof value !== "object") continue;
      const v = value as Partial<ServiceMapping>;
      const base = out[key as AuditCategory];
      out[key as AuditCategory] = {
        item: typeof v.item === "string" && v.item.trim() ? v.item.trim() : base.item,
        minHuf: Number.isInteger(v.minHuf) && v.minHuf! >= 0 ? v.minHuf! : base.minHuf,
        maxHuf: Number.isInteger(v.maxHuf) && v.maxHuf! >= 0 ? v.maxHuf! : base.maxHuf,
      };
    }
  }
  return out;
}

/** True when the workspace is still on the seeded numbers. */
export function isSeededMap(config: unknown): boolean {
  const raw =
    config && typeof config === "object" && "serviceMap" in config
      ? (config as { serviceMap?: unknown }).serviceMap
      : null;
  return !raw || typeof raw !== "object" || Object.keys(raw as object).length === 0;
}

export interface QuoteSkeletonLine {
  description: string;
  baseNet: number;
  preset: "none";
  /** Which findings produced this line, for the operator to sanity-check. */
  findings: string[];
  band: { minHuf: number; maxHuf: number };
}

/**
 * One line per category, not one per finding.
 *
 * Six SEO failures are one piece of work, and a quote with six 20,000 Ft rows
 * invites the client to delete five of them. The findings that produced the
 * line are carried alongside so the operator can see what they are quoting.
 *
 * The amount starts at the band's midpoint, rounded to a thousand forints — a
 * starting point the Owner edits in the quote builder, never a final price.
 */
export function buildQuoteSkeleton(
  findings: Array<{ key: string; label: string; category: string | null }>,
  map: Record<AuditCategory, ServiceMapping> = DEFAULT_SERVICE_MAP,
): QuoteSkeletonLine[] {
  const byCategory = new Map<AuditCategory, string[]>();
  for (const f of findings) {
    if (!f.category || !(f.category in map)) continue;
    const cat = f.category as AuditCategory;
    byCategory.set(cat, [...(byCategory.get(cat) ?? []), f.label]);
  }

  return [...byCategory.entries()].map(([category, labels]) => {
    const m = map[category];
    const midpoint = Math.round((m.minHuf + m.maxHuf) / 2 / 1000) * 1000;
    return {
      description: m.item,
      baseNet: midpoint,
      preset: "none" as const,
      findings: labels,
      band: { minHuf: m.minHuf, maxHuf: m.maxHuf },
    };
  });
}
