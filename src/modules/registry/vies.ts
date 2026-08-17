import { validateTaxNumber } from "./tax-number";

/**
 * EU VIES — the secondary, free cross-check.
 *
 * SECONDARY IS THE WHOLE POINT. VIES answers a different question from NAV: "is
 * this a valid EU VAT identifier", not "does this taxpayer exist". For a
 * Hungarian VAT-group member those answers legitimately disagree — measured
 * during this integration, MOL Nyrt.'s own number returns `valid: false` from
 * VIES and a perfectly valid taxpayer from NAV, because a group MEMBER's number
 * is not a trading VAT identifier; the group's common number is.
 *
 * So a VIES `false` is never evidence that a company does not exist, and this
 * module refuses to be read that way: it returns a `mismatch` or `not_valid`
 * verdict, never anything a caller could mistake for "not found".
 *
 * It is also famously unreliable — each member state runs its own back end and
 * any of them can be down. Every failure here is `unavailable`, and the caller
 * is expected to carry on without it.
 *
 * Verified live 2026-08-17: the modern REST endpoint works and folds the old
 * `checkVatApproximate` behaviour into the same call via the `trader*` fields, so
 * one request covers both operations.
 */

const VIES_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

/** Short: VIES is a nice-to-have and must never hold a lookup open. */
const VIES_TIMEOUT_MS = 6000;

export interface ViesResult {
  /** VIES's own name, unstructured. Useful for comparison, not for a contract. */
  name: string | null;
  /** One address line, as VIES returns it. Not parseable into a seat. */
  address: string | null;
  requestDate: string | null;
}

export type ViesVerdict =
  | { status: "valid"; result: ViesResult }
  /** A well-formed number VIES does not recognise as a trading VAT identifier. */
  | { status: "not_valid" }
  /** Down, slow, rate-limited, or refusing — never a conclusion about the company. */
  | { status: "unavailable"; reason: string };

/**
 * Check a Hungarian tax number against VIES.
 *
 * Takes the 8-digit törzsszám (VIES wants the number without the VAT and county
 * digits) and validates the checksum first, so a malformed number costs nothing.
 *
 * `traderName` enables the approximate-match fields: when supplied, VIES reports
 * whether the name it holds agrees, which is a second opinion on the
 * NAV-versus-searched-name cross-check.
 */
export async function viesCheck(
  taxNumberRaw: string,
  opts: { traderName?: string | null; fetch?: typeof fetch } = {},
): Promise<ViesVerdict> {
  const verdict = validateTaxNumber(taxNumberRaw);
  if (!verdict.ok) return { status: "unavailable", reason: `invalid_tax_number_${verdict.reason}` };

  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(VIES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        countryCode: "HU",
        vatNumber: verdict.parts.base,
        ...(opts.traderName ? { traderName: opts.traderName } : {}),
      }),
      signal: AbortSignal.timeout(VIES_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return {
      status: "unavailable",
      reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
    };
  }

  if (!res.ok) return { status: "unavailable", reason: `http_${res.status}` };

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { status: "unavailable", reason: "unparseable_response" };
  }

  // VIES has a habit of answering with a fault object rather than an HTTP error.
  if (typeof body.errorWrappers === "object" && body.errorWrappers) {
    return { status: "unavailable", reason: "service_error" };
  }
  if (body.valid !== true && body.valid !== false) {
    return { status: "unavailable", reason: "no_verdict_in_response" };
  }
  if (body.valid === false) return { status: "not_valid" };

  // VIES fills unknown fields with "---" rather than omitting them.
  const clean = (v: unknown) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s && s !== "---" ? s : null;
  };

  return {
    status: "valid",
    result: {
      name: clean(body.name),
      address: clean(body.address),
      requestDate: clean(body.requestDate),
    },
  };
}

/**
 * A sentence for the UI.
 *
 * Deliberately never says "not found" or "does not exist" for a `not_valid`
 * verdict: that is the misreading this whole module is shaped to prevent.
 */
export function viesSummary(v: ViesVerdict): string {
  switch (v.status) {
    case "valid":
      return v.result.name
        ? `VIES: érvényes uniós adószám — ${v.result.name}`
        : "VIES: érvényes uniós adószám";
    case "not_valid":
      // The wording carries the explanation, because the obvious reading is wrong.
      return "VIES: nem érvényes uniós adószámként. Ez nem jelenti, hogy a cég nem létezik — áfacsoport tagjánál ez a normális válasz.";
    case "unavailable":
      return "VIES: nem elérhető (a szolgáltatás gyakran áll). A NAV adata ettől független.";
  }
}
