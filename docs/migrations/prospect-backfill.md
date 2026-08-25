# Prospected-company backfill — plan and record

*Runner: `npm run prospects:backfill -- --dry-run | --apply` (the free pass only).
The paid pass is Prospector → "korábbi prospectek feltöltése".*

---

## 1. What was missing, and why

Seventy-one companies entered through the Prospector before three separate fixes landed:
before the Places request asked for Hungarian, before the city and the place id were read
out of the response at all, and before the company's own site was read for an email address.
None of it failed anything — the rows type-checked, the pages rendered, the leads worked.
The data was simply not there.

Counted in production before the run:

| gap | rows |
|---|---|
| companies with no city, though every one has an address | 69 |
| industries in English — 11 "Bakery", 4 "Cafe", 1 "Store" | 71 |
| leads with no email address | 71 |
| companies with no phone number | 13 |
| leads missing a phone the company row already had | 10 |
| companies with no `google_place_id` — the only exact dedupe key | 71 |

## 2. Two passes, because two different risks

**The free pass** derives from data the workspace already holds, costs nothing, and asks
nobody:

- **City** out of the stored address. Google writes Hungarian addresses as
  `Budapest, Wesselényi utca 25, 1077 Hungary`, so the town is the comma-separated segment
  carrying no house number and no street word. That last rule is what keeps
  `Harminckettesek tere` — a square, standing exactly where the street segment normally
  does — from being filed as a city, and the existing floor-marker deny-list is reused
  rather than copied, so `Fszt` cannot come back.
- **Industry** through a closed English→Hungarian map of the sixteen category names the
  data actually contains. Closed on purpose: it exists to repair rows fetched before the
  request asked for Hungarian, and nothing new can arrive in English any more. An unknown
  value is left alone rather than guessed at — a wrong industry is worse than an English
  one, because it feeds the ICP score.
- **Phone**, in the canonical spelling, on the company and on the lead. These rows predate
  the normalisation, so they hold `06 1 322 1234` where every later write produces
  `+3613221234`, and the duplicate check reads those as two businesses.

**The paid pass** asks Google again, once per company (~$2.27 for 71), and can fill a place
id, a missing phone, a website — and through a website, an email. It is opt-in, priced on
the button, batched twelve at a time, and it never writes without a preview.

## 3. The risk is the matching, not the money

A text search for a business that has since closed returns the shop two doors down. Writing
its phone number into the CRM means the operator rings a stranger. So:

- the address must agree — town, street and house number — before anything is written;
- the name is only ever a tie-breaker, because it is precisely the field we suspect of
  having been anglicised;
- a matching phone number is decisive on its own, since two businesses do not share one;
- **a row that cannot be identified writes nothing at all** — not the phone, and not even
  the place id, because a wrong place id would poison every future dedupe for that row
  silently and permanently.

Every proposed change is shown beside its old value with a tick per field: holes
pre-ticked, replacements not. Owner or Admin, enforced in both mutating actions rather than
by hiding the panel.

## 4. The record

Free pass, applied 2026-08-25 against production (workspace: Venture CO Group):

```
71 prospected companies · 69 without a city · 13 without a phone ·
71 with an English industry · 71 leads without an email
  71 companies, 208 fields.
  written: 71 companies, 208 fields, 0 emails read off websites.
```

Verified afterwards, straight out of psql:

| check | before | after |
|---|---|---|
| companies with no city | 69 | 0 |
| English industries | 71 | 0 |
| non-canonical phone numbers | 58 | 0 |
| leads carrying a phone | 48 | 58 |
| `prospector.backfill` audit entries | 0 | 1 |

**Zero emails, and that is not a failure of the reader.** Exactly one of the seventy-one
companies has anything in the website field at all, and it is `facebook.com` — these are
businesses with no or weak web presence, which is precisely why they are prospects. The
email gap cannot be closed by reading websites that do not exist; it needs the Google pass
to find a site that has appeared since, or another source entirely.

One thing worth a decision, left alone rather than changed quietly: that `facebook.com`
sits in the company's **domain** field, so an audit or a site enrichment for that company
would run against Facebook rather than against the business. The Prospector's
`WebsitePresence` treats "Facebook only" as a real and valuable category — these are the
money rows — so storing the URI is right; storing it as the domain is probably not.
