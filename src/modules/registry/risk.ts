import { REGISTRY_STATUS } from "./provider";

/**
 * Red-flag detection (spec §4.19): a company under liquidation / enforcement /
 * proceedings surfaces a warning chip on the lead and on quote generation.
 */
const PROCEEDINGS: string[] = [
  REGISTRY_STATUS.UNDER_LIQUIDATION,
  REGISTRY_STATUS.UNDER_ENFORCEMENT,
  REGISTRY_STATUS.UNDER_PROCEEDINGS,
];

export function companyUnderProceedings(statusFlags?: string[] | null): boolean {
  if (!statusFlags) return false;
  return statusFlags.some((f) => PROCEEDINGS.includes(f));
}

export function riskLabel(statusFlags?: string[] | null): string | null {
  if (!statusFlags) return null;
  if (statusFlags.includes(REGISTRY_STATUS.UNDER_LIQUIDATION)) return "Under liquidation";
  if (statusFlags.includes(REGISTRY_STATUS.UNDER_ENFORCEMENT)) return "Under enforcement";
  if (statusFlags.includes(REGISTRY_STATUS.UNDER_PROCEEDINGS)) return "Under proceedings";
  return null;
}
