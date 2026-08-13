# Public audit landing — full feature, bilingual

**Date:** 2026-08-14
**Status:** approved design, not yet implemented
**Covers:** P12/1b, P12/1c, P12/1d, plus the marketing surface around them

## Problem

`audit.ventureco.agency` today is one input and a dead end. A visitor pastes a
URL, waits, sees a score, and reads *"a részletes eredmények és a teljes riport
a következő lépésben érkezik"* — a next step that does not exist. There is no
form, no report delivery, no lead, no consent record. The page generates zero
leads, which is the only reason it was built.

It is also Hungarian-only, and single-language in a way that is hardcoded into
the markup rather than expressed as content.

## Goals

1. A page that reads as a finished product rather than a form on a background.
2. Hungarian and English, chosen automatically and overridable.
3. The capture flow that makes the page worth having: teaser → email → full
   report → lead in the CRM, with a consent record that stands up.

## Non-goals

- **Sector reports (P12/2).** Separate feature, separate spec.
- **Page-view analytics.** Counting *visits* needs the P8 first-party tracker,
  which does not exist. We report what is countable from rows and say so.
- **Social proof.** No client names, counts, logos or testimonials. The system
  is days old; the demo is the proof. Revisit when there is something true to
  say.

## Approach

### Bilingual content: one typed dictionary

`src/modules/public-audit/copy.ts` exports:

```ts
export type Locale = "hu" | "en";
export interface LandingCopy { /* every string on the page, structured */ }
export const LANDING_COPY: Record<Locale, LandingCopy>;
```

Chosen over `next-intl` (real infrastructure, but a dependency and routing
integration for two pages of copy) and over duplicating the component per
language (guarantees drift — the Hungarian gets a fix the English does not, and
nobody notices for months).

The `Record<Locale, LandingCopy>` type makes a missing translation a **compile
error**, which is the property that matters: the failure mode of hand-rolled
i18n is a blank space on a live page in the language you do not speak.

### Routing: detect, then redirect

`audit.ventureco.agency/` reads `Accept-Language` and 307s to `/hu` or `/en`.
The language switcher sets a `venture_lang` cookie, which wins on every later
visit.

Auto-detection alone — same URL, different content per visitor — was rejected:
it breaks sharing (you cannot send someone "the English one"), caching, and
`hreflang`. Redirecting keeps detection while leaving every visitor on an
explicit, shareable, indexable URL.

`src/lib/locale.ts` holds `detectLocale(acceptLanguage, cookie)` as a pure
function so the precedence rule is testable without a request.

Middleware gains `/hu` and `/en` as explicit audit-host routes, matched
**before** the legacy bare-slug fallback, so a report slug can never shadow a
language.

The direct in-app paths keep working without any hostname setup, as the other
public surfaces already do: `/public-audit` redirects by the same rule, and
`/public-audit/hu` and `/public-audit/en` render directly. This is what keeps
local development and the e2e suite free of proxy configuration.

### Page composition

A server component renders the static sections; two client islands handle
interaction. Marketing copy must be in the server-rendered HTML — a landing
page whose content only exists after hydration is invisible to the crawlers it
is meant to attract.

Sections:

1. **Hero** — headline, promise, URL input
2. **How it works** — three steps, honest about the ~60 second wait
3. **What we check** — rendered from the real category registry
   (`CATEGORY_LABEL` in `modules/audit/categories.ts`), so the page cannot
   advertise a check the engine does not run
4. **Teaser vs full report** — what is free, what arrives by email
5. **Privacy** — what is stored, why, how to be erased
6. **FAQ** — is it really free; do you keep my site; who sees the result
7. **Footer** — brand identity, contact, privacy link

Section 3 deserves the note: driving it from the registry rather than a copy
deck means the marketing claim and the product cannot diverge.

### Capture flow

**Teaser** (free, no email): overall score, three headline findings, both
screenshots.

"Headline findings" is defined, not left to taste: the top three **failing**
checks by the P2/4 impact-then-effort ranking (`buildPriorityMatrix().ordered`),
rendered with their plain-language labels. Reusing that ordering means the free
teaser shows the same three things the paid report opens with, and neither can
drift from the other.

**Full report** unlocks through a form: name, email, company, plus two
checkboxes.

- **Required**, unchecked by default: *"send me the full report by email"* —
  service delivery. Without it there is nothing to deliver.
- **Optional**, unchecked by default: marketing consent — permission to contact
  them about the findings.

New model `PublicAuditConsent`:

| field | why |
|---|---|
| `workspaceId`, `publicAuditId` | tenancy + which audit |
| `name`, `email`, `companyName` | what they gave |
| `serviceConsent` (bool) | must be true to submit |
| `marketingConsent` (bool) | the lawful basis for follow-up |
| `consentTextVersion` | which wording they agreed to |
| `ip`, `userAgent` | evidence, full address — not the /24 prefix |
| `createdAt`, `leadId` | when, and what it became |

The record is **evidence, not a flag**. A boolean alone cannot answer "what
exactly did they agree to, and when", which is the question that actually gets
asked. Hence the text version, and hence the full IP — `PublicAudit` stores a
truncated prefix because it is abuse control; a consent record stores the whole
address because the visitor asked us for something.

Submission creates Company + Lead, deduped against existing records, with a new
`LeadSource.SELF_SERVE_AUDIT` enum value.

- **With marketing consent:** warm inbound. Lead surfaces at the top of the
  Today Queue with a suggested same-day follow-up referencing their top finding.
- **Without:** they get the report and **nothing else**. The lead card shows
  the restriction, and the lead is excluded from every campaign audience.

Exclusion is enforced in `previewSegment` (`modules/campaigns/segment.ts`) —
the single function every campaign audience flows through, which is why it is
the right choke point and why one test can prove it.

### Delivery

The existing PDF pipeline renders the branded report; the Mailgun
**transactional** domain sends it, in the branded email shell (P2/6 workspace
brand), in the visitor's language. Cold domain is never involved: this is a
requested delivery, not outreach.

### Funnel reporting (P12/1d)

Countable without a tracker: audits run, reports requested, marketing consents
given, and the conversion between them. Shown in the Friday report. Page visits
are explicitly absent with a one-line note that they need P8 — an invented
visit count would be worse than none.

## Testing

**Unit**
- `detectLocale` precedence: cookie > `Accept-Language` > Hungarian default;
  malformed headers; unsupported languages.
- Copy completeness: iterate every key of `LandingCopy` and assert both locales
  are present and non-empty. This is the test that makes the dictionary safe.
- Consent validation: submission refused without `serviceConsent`; marketing
  consent defaults false; text version always stamped.
- Campaign exclusion: a lead without marketing consent never appears in
  `previewSegment` output.

**E2E**
- Both languages render server-side, with the right `lang` attribute.
- Switcher persists across a reload.
- Form refuses submission without the required checkbox.
- A non-consented capture produces a lead that a campaign audience does not
  contain.

## Risks and open questions

1. **The consent wording is not lawyer-reviewed.** It will be defensible and
   versioned, but Grtv. + GDPR framing of marketing consent is exactly where a
   Hungarian regulator looks first. Flagged in code and in the handbook; the
   version field means replacing the text later does not invalidate records
   collected under the old one.
2. **The intake workspace must be configured.** The landing resolves its tenant
   from `PUBLIC_INTAKE_WORKSPACE_ID`; with several workspaces and no setting it
   fails closed. Already true today, but capture makes the failure louder.
3. **Email deliverability.** Report delivery goes to addresses typed by
   strangers; bounces hit the transactional domain's reputation. Existing
   suppression handling applies, worth watching after launch.
