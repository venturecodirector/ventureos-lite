/**
 * The consent wording, versioned (P12/1b).
 *
 * ⚠️ NOT LAWYER-REVIEWED. This is a defensible construction — separate,
 * unticked boxes, service delivery kept apart from marketing permission, the
 * exact text stored with every record — but the WORDING has not been checked
 * against the Hungarian advertising act (2008. évi XLVIII. tv.) or the GDPR by
 * anyone qualified. Have counsel read it before relying on it in a dispute.
 *
 * The version string is what makes that fixable later: records collected under
 * one wording stay attributable to it, so replacing the text does not
 * retroactively muddy consent already given. Bump the date when the text
 * changes, and never edit a published version in place.
 */
import type { Locale } from "@/lib/locale";
import { LANDING_COPY } from "./copy";

export const CONSENT_TEXT_VERSION = "2026-08-14";

/** The full stored record of what a person was shown when they ticked. */
export interface ConsentSnapshot {
  version: string;
  locale: Locale;
  serviceText: string;
  marketingText: string;
}

export function consentSnapshot(locale: Locale): ConsentSnapshot {
  const copy = LANDING_COPY[locale];
  return {
    version: `${locale}-${CONSENT_TEXT_VERSION}`,
    locale,
    serviceText: copy.unlock.serviceConsent,
    marketingText: copy.unlock.marketingConsent,
  };
}
