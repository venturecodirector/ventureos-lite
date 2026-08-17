# NAV Online Számla — taxpayer lookup (free, authoritative)

Research notes for the free Hungarian company-enrichment path. Everything below
was verified against current primary sources in **August 2026**, not recalled —
the signing details in particular had changed, and one of them would have made
every request fail.

## Verified against production

The signing implementation was confirmed end to end on 2026-08-17 with live
credentials, using only the read-only `queryTaxpayer` operation. `funcCode=OK`
on the first attempt, which means the SHA3-512 signature, the SHA-512 password
hash, the timestamp mask, the requestId pattern and the mandatory `<software>`
block are all correct as implemented.

One response-side detail the request samples do not show: the RESPONSE uses
different namespace prefixes from the request — `ns2` for `OSA/3.0/api`, `ns3`
for `OSA/3.0/base`, and the default namespace for `NTCA/1.0/common`, so `header`
and `result` are unprefixed while `taxpayerData` is `ns2:`. Parse by local name;
prefix-matching will break.

## What I am implementing against

| | |
|---|---|
| **API** | NAV Online Számla `/invoiceService/v3`, operation `queryTaxpayer` |
| **requestVersion** | `3.0` (the only accepted value) |
| **headerVersion** | `1.0` (the only accepted value) |
| **Spec document** | *EN_Online Invoice System 3.0 Interface Specification (2026.02.12.)*, 410pp, from NAV's own repo |
| **Schema namespace** | `http://schemas.nav.gov.hu/OSA/3.0/api` + `http://schemas.nav.gov.hu/NTCA/1.0/common` |
| **Source of truth** | [github.com/nav-gov-hu/Online-Invoice](https://github.com/nav-gov-hu/Online-Invoice) — NAV's official repository |

3.0 is still current: the repo is actively maintained (most recent schema/error
commits February 2026) and the interface spec has carried `3.0` since September
2020. There is no 4.0.

## Three corrections to the brief

**1. `requestSignature` is SHA3-512, not SHA-512.** The brief specifies SHA-512.
The spec is explicit that `cryptoType` on `requestSignature` has *"only one
currently accepted value: SHA3-512"* (§1.3.2 note 7). SHA-512 and SHA3-512 are
different algorithms, not aliases — using the former means every request is
rejected with `INVALID_REQUEST_SIGNATURE`.

The `passwordHash` **is** SHA-512, uppercase hex (§1.3.2 note 6). So the two
hashes in the same `<user>` block use *different* algorithms, which is exactly
the kind of detail worth writing down once.

**2. There is no "unknown taxpayer" error code.** The brief asks for one in the
error taxonomy. There is none: every one of the three outcomes is `HTTP 200`
with `funcCode=OK`. See "The three outcomes" below — measured against production,
not inferred, because my first reading of the schema got the detail wrong.

**3. The `<software>` block is mandatory and the brief does not mention it.**
`queryTaxpayer` requires `softwareId`, `softwareName`, `softwareOperation`,
`softwareMainVersion`, `softwareDevName`, `softwareDevContact`,
`softwareDevCountryCode` and `softwareDevTaxNumber`. `softwareId` is an 18-char
identifier and `softwareOperation` is `LOCAL_SOFTWARE` or `ONLINE_SERVICE`. This
is self-declared, not issued — but it must be present and well-formed.

## The signature, and a known-answer vector

For every operation **except** `manageInvoice` / `manageAnnulment` — so including
`queryTaxpayer` — the rule is (§1.5.2):

```
requestSignature = UPPERCASE( SHA3-512( requestId + timestampMask + signKey ) )
timestampMask    = the UTC timestamp as YYYYMMDDhhmmss — separators and zone stripped
```

The spec publishes a worked example (§1.5.1, for the invoice variant) which
doubles as a test vector for the concatenation and the hash. Our implementation
reproduces **all four** of its checkpoints exactly:

| Checkpoint | Result |
|---|---|
| partial authentication base string | matches |
| index #1 hash (`CREATE` + base64) | matches |
| index #2 hash (`MODIFY` + base64) | matches |
| final `requestSignature` | matches |

From the same inputs, the `queryTaxpayer`-shaped signature (no invoice indices)
is the value asserted in `test/unit/nav-signature.test.ts`.

Other header rules worth having in one place:

- `requestId` — `[+a-zA-Z0-9_]{1,30}`, must be **unique per taxpayer** within the
  timestamp tolerance. Uniqueness is enforced across successful requests *and*
  requests rejected with `INVALID_REQUEST_SIGNATURE` or `FORBIDDEN`, so a retry
  must mint a new one.
- `timestamp` — UTC, `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(.\d{1,3})?Z`, tolerance
  **±1 day** against server time.
- `login` — 15 characters, system-generated.
- `taxNumber` in `<user>` — the first 8 digits of the taxpayer the technical user
  belongs to. The number being *queried* is the separate top-level `<taxNumber>`.

## Endpoints

```
Test        https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3/queryTaxpayer
Production  https://api.onlineszamla.nav.gov.hu/invoiceService/v3/queryTaxpayer

Test frontend        https://onlineszamla-test.nav.gov.hu
Production frontend  https://onlineszamla.nav.gov.hu
```

`content-type: application/xml`, `accept: application/xml`, HTTP POST, body is
XML. Typical response under 200 ms; the documented synchronous blocking timeout
is 5000 ms, which is what our client timeout is set from.

## Rate limits — what the spec actually says

**No numeric limit is published in the interface specification.** Rate limiting
was introduced in the 02/11/2020 revision (it appears in the change log) but the
2026.02.12 document states no requests-per-minute figure anywhere in its body. I
would rather record that than invent a number.

What exists instead is an **unauthenticated metrics service** for observing load:

```
/metricService/v3/queryServiceMetrics/metric
/metricService/v3/queryServiceMetrics/list
```

Our posture, therefore: cache aggressively (90 days on success, 7 on a negative
result), log every call to `ApiUsage` so the real volume is visible, and throttle
client-side. If NAV starts refusing us we will see it in the logs before a user
does.

## Response shape

```
QueryTaxpayerResponse
  infoDate                     dateTime, optional
  taxpayerValidity             boolean, optional   ← false + no data = unknown
  taxpayerData                 optional
    taxpayerName               ≤512 chars           ← the legal name, authoritative
    taxpayerShortName          ≤200 chars, optional
    taxNumberDetail            { taxpayerId, vatCode?, countyCode? }
    incorporation              ORGANIZATION | SELF_EMPLOYED | TAXABLE_PERSON
    vatGroupMembership         optional
    taxpayerAddressList        optional
      taxpayerAddressItem[]    { taxpayerAddressType, taxpayerAddress }
        taxpayerAddressType    HQ | SITE | BRANCH
        taxpayerAddress        DetailedAddressType
```

`DetailedAddressType` is `countryCode`, `region?`, `postalCode`, `city`,
`streetName`, `publicPlaceCategory`, `number?`, `building?`, `staircase?`,
`floor?`, `door?`, `lotNumber?`.

Two notes for the mapping. NAV calls the street-type field
`publicPlaceCategory` (közterület jellege), not `streetType` as the brief does.
And the registered seat is the `HQ` item — a company with sites returns several
items and only `HQ` is the székhely.

## The three outcomes — verified against production

Every case below returned `HTTP 200` and `funcCode=OK`. There is no error code
for "no such company"; the answer is in the body.

| Case | `taxpayerValidity` | `taxpayerData` | `infoDate` |
|---|---|---|---|
| **Valid taxpayer** | `true` | present | recent |
| **Deregistered** | `false` | **present** | old (2002, in the case measured) |
| **Unknown / never registered** | `false` | **absent** | absent |

So `taxpayerValidity=false` alone does not distinguish "this company was struck
off" from "this number belongs to nobody" — the presence of `taxpayerData` is
what separates them, and the two mean very different things to a salesperson.

My earlier note here claimed an unknown taxpayer omits `taxpayerValidity`
entirely. It does not: it returns `false`. That was a reading of `minOccurs="0"`
in the schema rather than an observation, and probing production corrected it.
The fixtures in `test/fixtures/nav/` are those exact responses.

## VIES disagrees with NAV, legitimately — do not treat it as a veto

While researching I recorded `10625790` as "passes the checksum but is not a
registered taxpayer", on the strength of VIES returning `valid: false`. **That
was wrong.** NAV returns it as MOL Nyrt., a large and entirely real company,
with `vatCode: 4` — *member of a VAT group*.

The explanation is the interesting part. A VAT-group member's own tax number is
not a valid EU VAT number; the group's common number (`vatCode: 5`) is the one
that trades. VIES is answering "is this a valid EU VAT identifier" and NAV is
answering "does this taxpayer exist", and for group members those answers
diverge *correctly*.

Two consequences, both load-bearing:

1. **A VIES `valid: false` must never be reported as "company not found".** It
   is a cross-check on a different question. NAV is the authority on existence.
2. **`vatCode: 4` has to be surfaced**, not hidden. It changes how the company is
   invoiced, and the operator needs to know the number they hold is a group
   member's rather than the group's.

## Error taxonomy (§3.2, technical errors)

| HTTP | errorCode | Means | Our message |
|---|---|---|---|
| 400 | `INVALID_REQUEST_SIGNATURE` | signature mismatch | wrong signKey, or clock skew |
| 400 | `INVALID_REQUEST` | malformed XML / schema | our bug, report it |
| 401 | `INVALID_SECURITY_USER` | login or password wrong | check the technical user |
| 500 | `INVALID_USER_RELATION` | user not assigned to that taxpayer | wrong requesting taxNumber |
| 500 | `NOT_REGISTERED_CUSTOMER` | taxpayer not registered in OSA | the *requesting* party, not the queried one |
| 500 | `FORBIDDEN` | operation not permitted for this user | technical user lacks the right |
| 400 | `REQUEST_ID_NOT_UNIQUE` | requestId reused | retry with a fresh id |
| 400 | `INVALID_TIMESTAMP` | outside ±1 day | server clock |
| 400 | `REQUEST_VERSION_NOT_ALLOWED` | requestVersion rejected | we are on the wrong version |
| 527 | `MAINTENANCE_MODE` | planned downtime | retry later, never a data conclusion |

`MAINTENANCE_MODE` deserves its own handling: it must never be reported as
"company not found".

## Credentials you have to obtain

All five come from **onlineszamla.nav.gov.hu**, and all five are per legal
entity. A Primary User (elsődleges felhasználó) with company access creates a
*technical user* (technikai felhasználó) and the system generates the rest.

| Value | Where it comes from | Notes |
|---|---|---|
| `login` | generated when the technical user is created | 15 chars |
| `password` | **you** set it, on the web interface | we store the SHA-512 hash, never the password |
| `signKey` (XML aláírókulcs) | generated with the technical user | shown once |
| `exchangeKey` (XML cserekulcs) | generated with the technical user | not needed for `queryTaxpayer`; only for `tokenExchange`/invoice submission |
| `taxNumber` | your own company's first 8 digits | the requesting entity |

Two practical points. Register on the **test** system separately —
`onlineszamla-test.nav.gov.hu` is a distinct registration with its own technical
user, which is what "Test connection" will use. And `queryTaxpayer` needs only
`login`, `password`, `signKey` and `taxNumber`; `exchangeKey` is collected
because the same credential block will serve invoice submission later, and it is
better to ask once.

## Secondary source: EU VIES

Verified live on 2026-08-17. The modern **REST** endpoint works and is simpler
than the SOAP service the brief names:

```
POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number
     {"countryCode":"HU","vatNumber":"15789934"}
```

A real response, for NAV's own number:

```json
{ "countryCode":"HU", "vatNumber":"15789934", "valid":true,
  "name":"NEMZETI ADÓ- ÉS VÁMHIVATAL",
  "address":"SZÉCHENYI UTCA 2 1054 BUDAPEST",
  "traderNameMatch":"NOT_PROCESSED", … }
```

The `trader*Match` fields are the `checkVatApproximate` behaviour folded into the
same call: supply `traderName`/`traderStreet`/etc. and each comes back
`VALID`/`INVALID`/`NOT_PROCESSED`. So one endpoint covers both operations the
brief asks for. The SOAP WSDL is still served (HTTP 200) and stays as a fallback
only.

VIES gives a name and a single unstructured address line — useful for
cross-checking, useless for a contract's registered seat. It is a check, not a
source. It is also famously unreliable, member-state by member-state, so every
call is best-effort and a failure never blocks anything.

## Why checksum validation cannot stand alone

Verified empirically while writing this:

| Tax number | Checksum | VIES | NAV |
|---|---|---|---|
| `15789934` (NAV) | passes | valid | valid, `vatCode 2` |
| `10773381` (Magyar Telekom) | passes | valid | valid, `vatCode 2` |
| `10625790` (MOL) | passes | **invalid** | **valid**, `vatCode 4` — VAT group member |
| `11111111` (BRO-KOMPLEX) | passes | not checked | **deregistered** since 2002 |
| `99999999` | passes | not checked | **unknown** |
| `12862208` | **fails** | invalid | never asked |

Read the last three rows together and the design falls out. A correct check
digit tells you nothing about whether a company exists, is still trading, or is
the same company you meant — `99999999` passes the checksum and belongs to
nobody. So the checksum is a free filter for typos and fabrications, nothing
more, and NAV is the only thing that establishes existence and status. Hence the
order: checksum first to discard nonsense at no cost, then NAV for the truth.

## Tax number structure, as validated

```
15789934-2-51
└──┬───┘ │ └┬┘
   │     │  └── county / territorial tax authority code
   │     └───── VAT code (áfakód), 1–5
   └─────────── törzsszám: 7 significant digits + 1 CDV check digit
```

**Check digit** — weights `9,7,3,1,9,7,3` across the first seven digits, summed;
`check = (10 - (sum mod 10)) mod 10`. Confirmed against NAV's own number and
Magyar Telekom's.

**VAT code (9th digit)**

| | |
|---|---|
| 1 | not in the VAT system / exempt activity |
| 2 | general VAT rules |
| 3 | simplified (EVA-era) status |
| 4 | member of a VAT group |
| 5 | VAT group's common number |

**County code (last two)** — `02`–`20` and `22`–`40` are the county tax
authorities (each county has two), then `41` North Budapest, `42` East Budapest,
`43` South Budapest, `44` Priority Taxpayers, `51` Priority Cases. Non-resident
taxpayers are uniformly `51`.

## Sources

- [NAV official API repository](https://github.com/nav-gov-hu/Online-Invoice) — schemas, samples, interface specification
- [queryTaxpayer request sample](https://github.com/nav-gov-hu/Online-Invoice/blob/master/sample/API%20sample/queryTaxpayer.xml)
- [Online Számla 3.0 changelog](https://github.com/nav-gov-hu/Online-Invoice/blob/master/src/schemas/nav/gov/hu/OSA/CHANGELOG_3.0.md)
- [Interface specification 3.0 (HU, 2026.02.12)](https://autosoft.hu/wp-content/uploads/2025/04/Online_Szamla_interfesz-specifikacio_HU_v3.0.pdf) — mirror; the repo copy is canonical
- [VIES REST API documentation](https://viesapi.eu/vies-rest-api-documentation/)
- [Adószám structure (Wikipédia, HU)](https://hu.wikipedia.org/wiki/Ad%C3%B3sz%C3%A1m)
- [Territorial tax authority code change (Adózóna)](https://adozona.hu/kerdesek/2023_7_26_Adoszamilletekes_teruleti_adohato_psh)
