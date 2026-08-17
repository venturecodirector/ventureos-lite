import {
  NAV_BASE_URL,
  NAV_TIMEOUT_MS,
  navPasswordHash,
  navRequestId,
  navRequestSignature,
  navTimestamp,
  type NavEnvironment,
} from "./nav-signature";
import { validateTaxNumber } from "./tax-number";

/**
 * NAV Online Számla `queryTaxpayer` — the authoritative, free source for a
 * Hungarian company's legal name, registered seat and taxpayer status.
 *
 * The flow this belongs to is inverted from the paid-registry design it
 * replaces: search only has to find a TAX NUMBER, and NAV then supplies the
 * name and seat as official data. That ordering matters because a name from a
 * search engine is a guess, and a name from NAV is the register.
 *
 * Verified end to end against production on 2026-08-17. See
 * docs/integrations/nav-taxpayer.md for the signing rules, the credentials, and
 * the three response outcomes measured rather than inferred.
 *
 * READ-ONLY. This module issues exactly one operation, `queryTaxpayer`, which
 * changes nothing on NAV's side. Nothing here may grow an invoice-submitting
 * path; that is a different operation with different consequences and belongs in
 * its own module with its own review.
 */

export interface NavCredentials {
  login: string;
  /** The plaintext password. Hashed on every request; never stored hashed here. */
  password: string;
  signKey: string;
  /** The requesting entity's own 8-digit tax number. */
  taxNumber: string;
  environment: NavEnvironment;
  /**
   * Self-declared software identity, required by the API.
   *
   * No defaults, deliberately. These fields tell NAV who WROTE the software
   * making the call, and on a white-labelled deployment that is the operator,
   * not us — so they come from the workspace brand rather than a constant in
   * this file. `softwareId` is exactly 18 characters (SoftwareIdType).
   */
  softwareId: string;
  softwareName: string;
  softwareDevName: string;
  softwareDevContact: string;
}

export interface NavAddress {
  countryCode: string | null;
  postalCode: string | null;
  city: string | null;
  streetName: string | null;
  /** NAV's name for the street type (közterület jellege), e.g. "UTCA". */
  publicPlaceCategory: string | null;
  number: string | null;
  building: string | null;
  staircase: string | null;
  floor: string | null;
  door: string | null;
  lotNumber: string | null;
  /** One line, in Hungarian address order, for display and document pre-fill. */
  oneLine: string;
}

export interface NavTaxpayer {
  legalName: string;
  shortName: string | null;
  taxNumber: string;
  vatCode: string | null;
  countyCode: string | null;
  incorporation: string | null;
  /** Present when this company is a member of a VAT group. */
  vatGroupMembership: string | null;
  /** The registered seat (székhely) — the HQ item, never a SITE. */
  seat: NavAddress | null;
  /** How many other establishments NAV lists. Not fetched into detail. */
  otherAddressCount: number;
}

/**
 * The three outcomes, all of which arrive as HTTP 200 / funcCode OK.
 *
 * `deregistered` and `unknown` both return taxpayerValidity=false; what
 * separates them is whether taxpayerData came with it. They mean very different
 * things to a salesperson, so they are different statuses here.
 */
export type NavLookup =
  | { status: "valid"; taxpayer: NavTaxpayer; infoDate: string | null }
  | { status: "deregistered"; taxpayer: NavTaxpayer; infoDate: string | null }
  | { status: "unknown" }
  | { status: "error"; error: NavErrorKind; code: string | null; message: string };

export type NavErrorKind =
  | "not_configured"
  | "invalid_tax_number"
  | "invalid_signature"
  | "invalid_credentials"
  | "user_not_related"
  | "not_registered_in_osa"
  | "forbidden"
  | "request_id_not_unique"
  | "invalid_timestamp"
  | "version_not_allowed"
  | "maintenance"
  | "rate_limited"
  | "malformed_request"
  | "network"
  | "timeout"
  | "unexpected";

/**
 * NAV's technical error codes, mapped to something a user can act on.
 *
 * `maintenance` is called out because it is the one that must never be reported
 * as a business conclusion: "NAV is down" and "this company does not exist" look
 * identical to a caller that only checks for absence.
 */
const ERROR_MAP: Record<string, { kind: NavErrorKind; message: string }> = {
  INVALID_REQUEST_SIGNATURE: {
    kind: "invalid_signature",
    message: "A NAV elutasította az aláírást — ellenőrizd az aláírókulcsot és a szerver óráját.",
  },
  INVALID_SECURITY_USER: {
    kind: "invalid_credentials",
    message: "Hibás technikai felhasználó vagy jelszó.",
  },
  INVALID_USER_RELATION: {
    kind: "user_not_related",
    message: "A technikai felhasználó nem ehhez az adószámhoz tartozik.",
  },
  NOT_REGISTERED_CUSTOMER: {
    kind: "not_registered_in_osa",
    message: "A kérdező cég nincs regisztrálva az Online Számla rendszerben.",
  },
  FORBIDDEN: {
    kind: "forbidden",
    message: "A technikai felhasználónak nincs joga ehhez a művelethez.",
  },
  REQUEST_ID_NOT_UNIQUE: {
    kind: "request_id_not_unique",
    message: "Ismétlődő kérésazonosító — próbáld újra.",
  },
  INVALID_TIMESTAMP: {
    kind: "invalid_timestamp",
    message: "A szerver órája több mint egy nappal eltér a NAV idejétől.",
  },
  REQUEST_VERSION_NOT_ALLOWED: {
    kind: "version_not_allowed",
    message: "A NAV nem fogadja el ezt az interfész-verziót — frissítés szükséges.",
  },
  MAINTENANCE_MODE: {
    kind: "maintenance",
    message: "A NAV rendszere karbantartás alatt van. Ez nem cégadat — próbáld később.",
  },
  INVALID_REQUEST: {
    kind: "malformed_request",
    message: "A NAV érvénytelennek találta a kérést — ez a mi hibánk, jelezd.",
  },
};

/**
 * Read an element's text by LOCAL NAME.
 *
 * The response uses different namespace prefixes from the request — `ns2` for
 * the api namespace, `ns3` for base, and the default namespace for common — so
 * `header` is unprefixed while `taxpayerData` is `ns2:`. Matching on prefixes
 * would work today and break the moment NAV renumbers them, which is exactly
 * the kind of breakage that is invisible until it is in production.
 */
function localText(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`).exec(xml);
  return m ? decodeXml(m[1]!.trim()) : null;
}

/** Every occurrence of an element, as raw inner XML. */
function localBlocks(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]!);
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function parseAddress(block: string): NavAddress {
  const get = (n: string) => localText(block, n);
  const addr: Omit<NavAddress, "oneLine"> = {
    countryCode: get("countryCode"),
    postalCode: get("postalCode"),
    city: get("city"),
    streetName: get("streetName"),
    publicPlaceCategory: get("publicPlaceCategory"),
    number: get("number"),
    building: get("building"),
    staircase: get("staircase"),
    floor: get("floor"),
    door: get("door"),
    lotNumber: get("lotNumber"),
  };
  // Hungarian order: postcode, settlement, street, type, number, then the
  // building details. This is the string a contract's party block uses, so it
  // follows the convention a Hungarian reader expects rather than a generic one.
  const street = [addr.streetName, addr.publicPlaceCategory, addr.number]
    .filter(Boolean)
    .join(" ");
  const inner = [
    addr.building && `${addr.building}. ép.`,
    addr.staircase && `${addr.staircase}. lh.`,
    addr.floor && `${addr.floor}. em.`,
    addr.door && `${addr.door}.`,
  ]
    .filter(Boolean)
    .join(" ");
  const oneLine = [
    [addr.postalCode, addr.city].filter(Boolean).join(" "),
    [street || addr.lotNumber, inner].filter(Boolean).join(" ").trim(),
  ]
    .filter((p) => p && p.length > 0)
    .join(", ");
  return { ...addr, oneLine };
}

/**
 * Look up a Hungarian taxpayer.
 *
 * `deps.fetch` is injectable so the parser can be tested against the real
 * responses captured in `test/fixtures/nav/` without a network call or a
 * credential — which is what makes the error taxonomy testable at all.
 */
export async function navQueryTaxpayer(
  taxNumberRaw: string,
  creds: NavCredentials | null,
  deps: {
    fetch?: typeof fetch;
    now?: () => Date;
    /**
     * Where call volume is recorded. NAV publishes no numeric rate limit, so the
     * only way to know we are approaching one is to count — and the count has to
     * survive a restart, which is why it is a sink rather than a counter here.
     * Injected so the provider needs no database.
     */
    logUsage?: (row: { operation: string; outcome: string }) => Promise<void> | void;
  } = {},
): Promise<NavLookup> {
  if (!creds?.login || !creds.signKey || !creds.password || !creds.taxNumber) {
    return {
      status: "error",
      error: "not_configured",
      code: null,
      message: "A NAV Online Számla hozzáférés nincs beállítva (Beállítások → Integrációk).",
    };
  }

  // The cheap gate first: a malformed number must never cost a request.
  const verdict = validateTaxNumber(taxNumberRaw);
  if (!verdict.ok) {
    return {
      status: "error",
      error: "invalid_tax_number",
      code: verdict.reason,
      message: "Ez nem érvényes magyar adószám.",
    };
  }
  const queried = verdict.parts.base;

  const doFetch = deps.fetch ?? fetch;
  const at = deps.now?.() ?? new Date();
  const requestId = navRequestId();

  const xml = buildRequest({ creds, requestId, at, queried });

  let res: Response;
  try {
    res = await doFetch(`${NAV_BASE_URL[creds.environment]}/queryTaxpayer`, {
      method: "POST",
      headers: { "content-type": "application/xml", accept: "application/xml" },
      body: xml,
      signal: AbortSignal.timeout(NAV_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    const lookup: NavLookup =
      name === "TimeoutError" || name === "AbortError"
        ? { status: "error", error: "timeout", code: null, message: "A NAV nem válaszolt időben." }
        : { status: "error", error: "network", code: null, message: "A NAV nem elérhető." };
    await record(deps.logUsage, lookup);
    return lookup;
  }

  const body = await res.text();
  const lookup = parseTaxpayerResponse(body, res.status);
  await record(deps.logUsage, lookup);
  return lookup;
}

/** Never let a logging failure lose a lookup that already succeeded. */
async function record(
  sink: ((row: { operation: string; outcome: string }) => Promise<void> | void) | undefined,
  lookup: NavLookup,
): Promise<void> {
  if (!sink) return;
  try {
    await sink({
      operation: "queryTaxpayer",
      outcome: lookup.status === "error" ? `error:${lookup.error}` : lookup.status,
    });
  } catch {
    /* counting is not worth failing a lookup over */
  }
}

/** Exported for the "Test connection" action, which shows the request shape. */
export function buildRequest(params: {
  creds: NavCredentials;
  requestId: string;
  at: Date;
  queried: string;
}): string {
  const { creds, requestId, at, queried } = params;
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<QueryTaxpayerRequest xmlns:common="http://schemas.nav.gov.hu/NTCA/1.0/common" xmlns="http://schemas.nav.gov.hu/OSA/3.0/api">
  <common:header>
    <common:requestId>${requestId}</common:requestId>
    <common:timestamp>${navTimestamp(at)}</common:timestamp>
    <common:requestVersion>3.0</common:requestVersion>
    <common:headerVersion>1.0</common:headerVersion>
  </common:header>
  <common:user>
    <common:login>${esc(creds.login)}</common:login>
    <common:passwordHash cryptoType="SHA-512">${navPasswordHash(creds.password)}</common:passwordHash>
    <common:taxNumber>${esc(creds.taxNumber)}</common:taxNumber>
    <common:requestSignature cryptoType="SHA3-512">${navRequestSignature({
      requestId,
      timestamp: at,
      signKey: creds.signKey,
    })}</common:requestSignature>
  </common:user>
  <software>
    <softwareId>${esc(creds.softwareId)}</softwareId>
    <softwareName>${esc(creds.softwareName)}</softwareName>
    <softwareOperation>LOCAL_SOFTWARE</softwareOperation>
    <softwareMainVersion>1.0</softwareMainVersion>
    <softwareDevName>${esc(creds.softwareDevName)}</softwareDevName>
    <softwareDevContact>${esc(creds.softwareDevContact)}</softwareDevContact>
    <softwareDevCountryCode>HU</softwareDevCountryCode>
    <softwareDevTaxNumber>${esc(creds.taxNumber)}</softwareDevTaxNumber>
  </software>
  <taxNumber>${esc(queried)}</taxNumber>
</QueryTaxpayerRequest>`;
}

/**
 * Turn a response body into one of the three outcomes, or an error.
 *
 * Separated from the request so it can be tested against the real captured
 * responses in `test/fixtures/nav/`.
 */
export function parseTaxpayerResponse(body: string, httpStatus: number): NavLookup {
  const errorCode = localText(body, "errorCode");
  const funcCode = localText(body, "funcCode");

  if (errorCode || funcCode === "ERROR" || httpStatus >= 400) {
    // 429 is not in NAV's published chart, but rate limiting exists and an
    // unmapped 429 reported as "unexpected" would send someone hunting for a
    // bug that is really a queue.
    if (httpStatus === 429) {
      return {
        status: "error",
        error: "rate_limited",
        code: errorCode,
        message: "Túl sok NAV kérés egymás után. Várj egy kicsit.",
      };
    }
    const mapped = errorCode ? ERROR_MAP[errorCode] : undefined;
    if (mapped) {
      return { status: "error", error: mapped.kind, code: errorCode, message: mapped.message };
    }
    return {
      status: "error",
      error: "unexpected",
      code: errorCode,
      message:
        localText(body, "message") ??
        `A NAV váratlan választ adott (HTTP ${httpStatus}${errorCode ? `, ${errorCode}` : ""}).`,
    };
  }

  const validity = localText(body, "taxpayerValidity");
  const dataBlocks = localBlocks(body, "taxpayerData");
  const data = dataBlocks[0] ?? null;

  // No data at all means the number belongs to nobody. This is the one case the
  // brief expected an error code for; NAV answers it with a 200 and a false.
  if (!data) return { status: "unknown" };

  const detail = localBlocks(data, "taxNumberDetail")[0] ?? "";
  const addressItems = localBlocks(data, "taxpayerAddressItem");
  let seat: NavAddress | null = null;
  let others = 0;
  for (const item of addressItems) {
    const type = localText(item, "taxpayerAddressType");
    const block = localBlocks(item, "taxpayerAddress")[0];
    if (!block) continue;
    if (type === "HQ" && !seat) seat = parseAddress(block);
    else others += 1;
  }

  const taxpayer: NavTaxpayer = {
    legalName: localText(data, "taxpayerName") ?? "",
    shortName: localText(data, "taxpayerShortName"),
    taxNumber: localText(detail, "taxpayerId") ?? "",
    vatCode: localText(detail, "vatCode"),
    countyCode: localText(detail, "countyCode"),
    incorporation: localText(data, "incorporation"),
    vatGroupMembership: localText(data, "vatGroupMembership") || null,
    seat,
    otherAddressCount: others,
  };

  const infoDate = localText(body, "infoDate");
  return validity === "true"
    ? { status: "valid", taxpayer, infoDate }
    : { status: "deregistered", taxpayer, infoDate };
}

/**
 * Is this taxpayer a business risk?
 *
 * A deregistered taxpayer is the strongest possible signal that a deal should
 * not proceed — it feeds the existing liquidation/risk chip path and blocks
 * finalising a legal document, the same way an in-liquidation flag does.
 */
export function navRiskFlags(lookup: NavLookup): string[] {
  if (lookup.status === "deregistered") return ["nav_deregistered"];
  if (lookup.status === "valid" && lookup.taxpayer.vatGroupMembership) {
    // Not a risk, but it changes invoicing: the number held is a group member's,
    // not the group's trading number.
    return ["vat_group_member"];
  }
  return [];
}
