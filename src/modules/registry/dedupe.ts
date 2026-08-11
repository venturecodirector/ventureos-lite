/**
 * Adószám (Hungarian tax number) dedupe key (spec §4.19). Far stronger than
 * name/domain matching — two companies with the same adószám cannot both be
 * created. Format is an 8-digit core + check digit + 2-digit area (11 digits);
 * we normalize to digits.
 */
export function normalizeTaxId(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

export interface TaxKeyed {
  id: string;
  taxId?: string | null;
}

export function findByTaxId<E extends TaxKeyed>(
  taxId: string | null | undefined,
  existing: E[],
  excludeId?: string,
): E | null {
  const target = normalizeTaxId(taxId);
  if (!target) return null;
  for (const e of existing) {
    if (e.id === excludeId) continue;
    if (normalizeTaxId(e.taxId) === target) return e;
  }
  return null;
}
