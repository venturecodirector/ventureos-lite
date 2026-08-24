# Recorded LinkedIn API snapshots

**This directory is empty and the re-architecture is blocked on filling it.**

The field mapping is derived *from these files*. Nothing is mapped that has not
been seen in a recorded snapshot — that rule is the whole point of the
re-architecture, because six rounds of DOM fixes failed precisely by reasoning
about a shape instead of looking at one.

## Why there is nothing here yet

Recording requires a signed-in LinkedIn session in a real browser. It cannot be
done from a test runner, and it must not be done by asking LinkedIn for anything
— the observer only copies responses **the page itself already fetched**.

So this is a step you have to drive. It takes about ten minutes.

## STATUS: name, email and phone are mapped. Headline and location were tried and REJECTED.

Three snapshots, each earning its bytes:

| file | what only it supplies |
|---|---|
| `own-profile.json` | the operator's own profile, with the four values KNOWN — the only capture where a rule can be checked against a real answer |
| `profile-full-2.json` | a second profile, and the full card vocabulary |
| `contact-overlay.json` | the phone |

| field | how it is found | evidence |
|---|---|---|
| `name` | `{ firstName, lastName }`, in a record that names this person and nobody else | profile-full-2.json |
| `email` | `viewTrackingSpecs.viewName = contact-email`, then a `mailto:` url | contact-overlay.json |
| `phone` | `viewTrackingSpecs.viewName = contact-phone`, then a phone-shaped value | contact-overlay.json |

### The rule that was written, tested, and thrown away

`own-profile.json` made a style-based rule testable for the first time: the four
values were supplied separately, so each could be matched to its redacted LENGTH.

On that profile, reading one record, the headline looked like the only Text with
`fontSize: xsmall`, `fontWeight: normal` and no `textColorExpression` — and it is
37 characters, matching "Business Developer, C-level Executive" exactly. The
location looked like the only `small`/`normal` Text inside the Topcard node, 17
characters, matching "Budapest, Hungary". Both rules were written.

Then they were run against the whole fixture:

```
own-profile      signature matches 6 texts:  11, 29, 32, 37, 159, 177
profile-full-2   signature matches 2 texts:  37, 213
```

The headline is in there. The extractor returned it only because document order
reached it first. On the second profile the same rule offers a 213-character
paragraph as somebody's headline.

**So they are not shipped.** A field that is silently wrong is worse than a field
that is absent: absent leaves the DOM path to fill it and the operator to notice,
while a 213-character headline is a plausible-looking value nobody checks. This is
the same failure that took six rounds on the DOM path — caught here before
shipping, because a fixture with known answers existed to catch it. A test pins
the measurement so the next person to see that signature does not derive it again.

### What would settle it

Two or three more own-profile captures from DIFFERENT accounts, each with its
four values known. If one signature holds across all of them it is a rule. If it
does not, LinkedIn's design system is not a data model, and headline, location,
company and job title belong to the DOM path — which is a legitimate answer, and
better than a mapping that is right about one person.

Company and job title never got as far as a rule: on this capture the company is
the only bold Text in the experience record, and the job title has no signature at
all.

## What was recorded before, and what it taught

Two snapshots, each earning its bytes (a test enforces that):

| file | what only it supplies |
|---|---|
| `profile-full-2.json` | the name, the email, and the full card vocabulary — one recording with the contact panel open |
| `contact-overlay.json` | the phone |

| field | how it is found | evidence |
|---|---|---|
| `name` | `{ firstName, lastName }` keys, in the record whose url IS that profile | profile-full-2.json |
| `email` | `viewTrackingSpecs.viewName = contact-email`, then a `mailto:` url | contact-overlay.json |
| `phone` | `viewTrackingSpecs.viewName = contact-phone`, then a phone-shaped value | contact-overlay.json |

`email` and `phone` are verified against a RAW unscrubbed capture: the extractor
returns the real address and the real number.

### The card vocabulary, which is the durable anchor

`componentkey` names every profile card, indexed by the member id:

```
com.linkedin.sdui.profile.card.ref<MEMBERID>Topcard
com.linkedin.sdui.profile.card.ref<MEMBERID>About
com.linkedin.sdui.profile.card.ref<MEMBERID>ExperienceTopLevelSection
com.linkedin.sdui.profile.card.ref<MEMBERID>ContactInfoDetailSection
```

Not localised, not hashed, and stable across the three captures. Anything mapped
from a card should be anchored here rather than on a tracked view.

### WHY HEADLINE, LOCATION, COMPANY AND JOB TITLE ARE NOT MAPPED

Not for want of looking. Their cards are locatable — `Topcard`, `About`,
`ExperienceTopLevelSection` are all in the capture. What is missing is anything
that says WHICH text is which:

- no semantic key. The whole capture has no `headline`, `occupation`,
  `companyName` or `jobTitle` key anywhere. The name is mappable precisely
  because it is the one field LinkedIn does put behind keys (`firstName`,
  `lastName`);
- no style discriminator. Every `textProps` under the top card carries the same
  `fontSize: "small"`, `fontFamily: "sans"` — nothing separates a headline from a
  location;
- and the one thing that WOULD tell them apart is the text itself, which is
  exactly what a committed fixture must not contain.

Position within the card is the only remaining signal, and "the second text is
the headline" is a guess dressed as a rule — the thing this directory exists to
prevent. It is also the thing that broke six times on the DOM path.

**What would unblock it, without putting anyone's data in the repo:** a capture
of an OWN profile, plus the four values told to me separately. Matching a known
string to a `<text:N>` length pins each path exactly once; the rules then cite
this file, and only the scrubbed fixture is committed. Nobody else's data is
involved, because the profile is the operator's own.

## What was recorded before, and what it taught

Three snapshots: `profile-full.json` (2 records, trimmed from 17),
`rsc-profile.json` (2 of 20) and `contact-overlay.json` (2 of 11).

| field | how it is found | evidence |
|---|---|---|
| `name` | `{ firstName, lastName }` keys, in the record whose url IS that profile | profile-full.json |
| `email` | `viewTrackingSpecs.viewName = contact-email`, then a `mailto:` url | contact-overlay.json |
| `phone` | `viewTrackingSpecs.viewName = contact-phone`, then a phone-shaped value | contact-overlay.json |

`email` and `phone` are verified against the RAW unscrubbed capture: the
extractor returns the real address and the real number.

### One capture holds more than one person

The name is in objects with explicit `firstName`/`lastName` keys and no tracked
view anywhere near them — and a session that walks from one profile to another
leaves BOTH in the buffer. The recorded capture holds two. A rule that took the
first pair it found would attach one person's name to the other person's lead,
silently, and only for operators who browse the way people actually browse.

So a rule can declare `scope: "profile-document"`: it may only read the record
whose url is that person's page. The test that matters asks for a slug whose
record has no name and asserts the answer is NOTHING rather than the other
person's.

### Still unmapped, and why

- **headline, location, company, job title** — their nodes are in the capture
  (`profile-top-card`, `profile-card-about`, `profile-card-experience`, ten
  `experience-*` views) but no key names them the way `firstName` does, and every
  text value is a `<text:N>` placeholder. Which of forty is the headline is not
  something a fixture can currently answer. A capture that includes the
  **Contact info panel AND the About section expanded** may carry keyed values
  the way the name did.
- **websiteUrl** — the `contact-website` node is witnessed but the person in that
  snapshot has no website, so the shape a real value arrives in is unseen.

### What the scrubber learned from this round

- **A key beats a shape.** `Farkhod` and `Ibragimov` — a third person's name,
  from a recommendation rail — came through as PascalCase tokens, because their
  owner's slug was nowhere in the payload for the token rule to catch. Where a
  key names the field the guessing stops, so `firstName`, `headline`,
  `vanityName` and their kind are now scrubbed on the KEY whatever the value
  looks like. Shape is the default; the key rule is the override, and each
  covers the other's blind spot.
- **Re-scrubbing has to be idempotent.** `scripts/rescrub-snapshot.ts` brings an
  older snapshot up to date without asking for another recording. Its first
  version re-placeholdered its own output (`<text:24>` → `<text:9>` → `<text:8>`,
  losing the one thing a redacted value still carried) and re-mapped placeholder
  slugs, so a record's url said one person and its body said another. Both fixed,
  and a fixture test runs it twice and compares bytes.

## What was recorded before, and what it taught

`rsc-profile.json` (2 records, trimmed from 20 — see `scripts/trim-snapshot.ts`)
and `contact-overlay.json` (2 records). What is settled, and what is not:

**WORKING, verified against the raw unscrubbed capture:** `email` and `phone`.
The extractor returns the actual address and the actual number. Both are found by
`viewTrackingSpecs.viewName` and then by the SHAPE of the value.

**A bug that nearly shipped, and what it changed.** The first extractor took "the
first string that is not scaffolding". Against the raw payload that is
`gpRhtA9jSFObSQRBJwS5vQ==` — the node's own `contentTrackingId` — offered as
somebody's phone number. The fixture test passed, because it asserted only that
something had been found at that position. Two things stop it now: the walk skips
`viewTrackingSpecs` entirely, and every rule names the shape it is looking for.
Nothing here should ever again "find" a value by being near one.

**BLOCKED, and this is what one more save fixes.** Measured against the
20-record capture, the scrubber was destroying the payload's own vocabulary:

    $type                 7543 of 7563     the primary SDUI discriminator
    legacyControlName      279 of  285     one of the two contact names
    presentationStyle      152 of  152
    pageKey                151 of  494

The allow-list only knew `com.linkedin.…`, so `proto.sdui.components.core.Text`
and `contact_email` were being redacted as if they were free text. Fixed — dotted
namespaces, SCREAMING_SNAKE and snake_case are structure now, each still checked
against the slug tokens so a name cannot ride in on one — but the two committed
snapshots were recorded BEFORE the fix, so their `$type`s are gone.

That is why name, headline, location, company and job title are still unmapped.
Their nodes are in the capture (`profile-top-card`, `profile-card-about`,
`profile-card-experience`, and ten `experience-*` views), but with `$type`
redacted there is no way to tell which of forty `<text:N>` values under the top
card is the name. Guessing is what this directory exists to prevent.

`websiteUrl` is unmapped for a second reason: the `<url>` placeholder threw away
the scheme, so a url-shaped rule cannot be verified against the fixture. The
scrubber now writes `https://<host>/<path:2>`, which can be.

### The one save that unblocks all of it

Extension **5.4.0 or later** — check the version in the popup before recording.

1. Reload the LinkedIn tab, then click through to a profile **from the feed**.
2. Open **Contact info** on that profile.
3. Popup → **Save API snapshot**, label `profile-full`.
4. Hand over the file. Expect ~11 MB; `scripts/trim-snapshot.ts` cuts it to
   ~350 KB by keeping only the records that carry a field this fixture teaches,
   and it prints exactly what it dropped.

A profile that HAS a website in its contact panel also closes `websiteUrl`.

## What was recorded before, and what it taught

`rsc-profile.json` (10 records) and `contact-overlay.json` (2 records — only what
the profile snapshot does not already hold). What they taught, all of it from the
files rather than from the brief:

**The payload is React Server Components, not Voyager.** There is no `included`
array and no `$type` entity anywhere. `PROFILE_MAPPING` therefore stays empty and
a test now pins that as a FINDING — if a Voyager-shaped response ever appears in a
snapshot, the test starts failing and asks for the rules.

**Fields are found by tracking discriminator, not by label.** Each contact row
carries two, neither localised:

```
viewTrackingSpecs.viewName            contact-email  contact-phone  contact-website
viewTrackingSpecs.legacyControlName   contact_email  contact_call   contact_website
```

That matters: this account's visible labels are Hungarian, so a mapping keyed on
label text would have worked on an English profile and failed silently here.

**The value is in a DIFFERENT ROW from the discriminator.** `contact-email` sits
in row `19`; the address is in row `1b`, as `mailto:…` inside a navigate action,
reached by the string `"$L1b"`. The first run of the mapping against the fixture
returned nothing at all because of this — following row references is not an
optimisation, it is the difference between a mapping that works and one that
quietly returns empty.

**What is mapped, and what is not.** `email` and `phone` are in, each citing
`contact-overlay.json`, and a test runs the extractor against the committed file.
`websiteUrl` is NOT: the `contact-website` node exists, so the discriminator is
witnessed, but this person has no website, so the only http url in the record is
their own profile link — the shape a real website value arrives in has not been
seen. One snapshot from a profile that HAS a website closes that.

**Still needed**, in the order they would pay off:

| label | what to open | what it unlocks |
|---|---|---|
| `with-website` | a profile with a website in Contact info | the `websiteUrl` rule |
| `name-headline` | any profile — the top card | name, headline, location: the fields the DOM path just lost |
| `experience` | a profile with positions | company and job title |
| `no-experience` | a profile with none | proof the absence is reported, not guessed |

## What the scrubber does to these files, and why it is not optional

The first pair went through a scrubber that was "working" and carried **52
strangers' profile slugs, 126 member ids, a live email address, a mobile number
and 1351 name occurrences**. None of it was committed, because the check ran
before the commit — but it was one `git add` away.

The reason it failed is worth knowing before you record the next one. Everywhere
else in that file identity is found by KEY (`firstName`, `entityUrn`,
`emailAddress`). A flight body is React elements, so the keys are `children`,
`id` and `value`, and a name is a bare string in an array position. There is no
key to key off.

So for these bodies the rule is inverted: **every string is redacted unless its
shape is provably structure** — React refs, chunk hashes, `com.linkedin.…` ids,
camelCase and PascalCase tokens, short numeric layout values, urns. Everything
else becomes `<text:12>`, `<email>`, `mailto:<email>`, `https://<host>/<path:2>`.
A mapping needs to learn WHERE a value sits, not what it said.

Three shapes got through even that, and each is now a regression test:

- **a first name alone** (`"Tom"`) is shape-identical to a component name. It is
  only recoverable because the SLUG spells out its own tokens, so the slug's parts
  become redaction targets.
- **a phone number** is "just digits and punctuation". Numeric strings are
  structural only below seven digits.
- **a member id glued to a component name** (`…95XkContactInfoDetailSection`).
  The id is exactly 39 characters — measured across 156 occurrences, not guessed —
  so a bounded match takes the id and leaves the name.

## How the observer reports a failure, if one happens again

**The "LinkedIn server-renders, there is nothing to observe" conclusion was
wrong.** The census found the profile being fetched client-side all along. From a
real report, twelve responses had been declined unread, every one of them
`application/octet-stream`, and among them:

```
…/rsc-action/actions/component?componentId=…profile.dsl.impl.profileCardsAboveActivity
…/rsc-action/actions/component?componentId=…profile.dsl.impl.profileCardsActivity
…/rsc-action/actions/navigation?screenId=…profile.ProfileContactDetailsOverlay
…/rsc-action/actions/server-request?sduiid=…requests.profile.profilePolicyNotice
```

LinkedIn moved the profile onto **React Server Components**. The wire format is
numbered rows of JSON fragments — not JSON as a whole, so a JSON test rejects it,
and served as octet-stream, so a content-type test rejects it too. It was
invisible twice over, and the same change explains why the DOM extractor started
returning nothing but the URL: the old markup is gone.

Three things changed as a result, and this directory is no longer blocked:

1. the filter reads anything that is not provably markup, script, style or media,
   and judges the BODY (JSON, or an RSC row set) — matched by shape, never by
   path, so it does not depend on knowing which product shipped this week;
2. the scrubber parses RSC rows and scrubs identity inside each fragment, with an
   unparsable fragment reported by length and never by text;
3. `ProfileContactDetailsOverlay` is in that list — the contact panel, fetched as
   its own response. That is the field set the DOM path has never read reliably.

**So the recording procedure below now works.** What it needs is one snapshot per
case in the table further down.

## How the observer reports a failure, if one happens again

Recording was attempted three times and produced telemetry only. Since none of
the committed DOM fixtures carries a `<code>` block or a JSON script tag either,
the working conclusion is that LinkedIn server-renders the profile and this
account's app never fetches it as JSON — in which case there is nothing here to
record and **the DOM path is the path**.

That conclusion was an INFERENCE, though, and the observer could not tell three
different situations apart:

| what actually happened | what the old observer said |
|---|---|
| the page fetched nothing | "buffer empty, page loaded before observer" |
| it fetched, and our filter dropped it | "buffer empty, page loaded before observer" |
| it fetched through a worker or another realm, so our patch never saw it | "buffer empty, page loaded before observer" |
| something replaced our patch | "buffer empty, page loaded before observer" |

It now distinguishes them, and the reason it reports names the fix:

- `page_fetched_nothing_server_rendered` — the inference confirmed. Stop here;
  the DOM extractor is the whole answer and this directory stays empty.
- `responses_arrived_but_none_were_json` — responses DID arrive and were
  declined. `skippedByReason` in the diagnostics says on what grounds; the filter
  in `observer-main.js` is the thing to change.
- `document_loaded_resources_our_patches_never_saw` — the census saw loads that
  our patched `fetch`/XHR did not, which means a Worker, a Service Worker, or a
  function taken from another realm. The interception POINT is wrong, not the
  filter.
- `our_fetch_patch_was_replaced` — something overwrote `window.fetch` after us.

**So the next step is one click, not a session:** open a profile the way the
procedure below says, press **Copy observed responses**, and read
`skippedCount`, `censusCount` and `patchHealth`. Those three numbers decide
whether this directory ever gets a file.

## How to record — READ THIS, THE OBVIOUS WAY DOES NOT WORK

The first real attempt taught us something that changes the procedure.

**A hard reload produces nothing.** On a fresh page load LinkedIn server-renders
the profile straight into the HTML and fetches no JSON for it — the only JSON on
that load is telemetry (`sensorCollect` and a couple of obfuscated tracking
POSTs). None of the committed DOM fixtures carries a `<code>` block or an
`application/json` script tag either, so there is no embedded payload to read.

The profile arrives as JSON only when the app navigates to it **client-side**.
So the procedure is:

1. **Load the extension**, then open `https://www.linkedin.com/feed/` and let it
   settle. (Reloading the extension does not reach tabs that are already open, so
   this tab must be opened or reloaded AFTER the extension is in place.)
2. **Click through to a profile from inside the app** — from the feed, from search,
   from the "People you may know" rail. Do NOT paste the URL into the address bar
   and do NOT reload: both are fresh page loads, and a fresh page load is exactly
   the case that fetches nothing.
3. Popup → **Copy observed responses**. You are looking for a record of tens or
   hundreds of kilobytes. `pendingCount` above zero means something was seen
   before the URL caught up, which is normal and is claimed on arrival.
4. Popup → **Save API snapshot**, label it, save into this directory.
5. For each further case, **navigate in-app again** rather than reloading.

If step 3 shows only small POSTs to obfuscated paths, stop and say so: it would
mean the profile is not fetched as JSON on this account either, and the approach
needs rethinking rather than more snapshots.

## The snapshots needed, and why each one

| label | what to open | what it is for |
|---|---|---|
| `hungarian-name` | any profile with accents in the name (e.g. a Hungarian colleague) | the accent handling that repeatedly failed via the DOM |
| `abbreviated-slug` | a profile whose URL is like `/in/mgoldberger` | the single-token slug that broke the name validator |
| `no-experience` | a profile with no Experience section rendered | the clearest proof the new path works — company and title must still come out |
| `first-degree` | someone you are connected to | contact data and connection-degree differences |
| `third-degree` | someone you are not connected to | the reduced payload a distant profile returns |
| `company-page` | a `/company/...` page | company enrichment, later |
| `contact-overlay` | a profile, then **open the Contact info overlay** before saving | email / phone / websites arrive in their own response |

For `contact-overlay`: navigate to the profile in-app, press **Contact info** on
the page so LinkedIn fetches it, then save the snapshot. The observer will have
seen both the profile response and the contact one. (The overlay is fetched on
demand, so this one works whether or not the page itself was server-rendered.)

## What the scrubber does before anything is written

Snapshots go into version control, so they carry no people. The scrubber replaces
values and never structure:

- **Names** → `Ödön Anonimizált` and friends, keyed by *person* (via `entityUrn`),
  so one human stays one human across every entry that mentions them. Accents are
  kept so the accent-folding tests still have something to fold.
- **Urns** → `urn:li:fsd_profile:SCRUBBED001`, same prefix, same segment count,
  same **type** segment — that part is schema, not identity.
- **Image paths** → placeholders that keep their directory depth, because the
  mapping has to learn how a root URL and a path segment are joined.
- **Emails / phones / birthdays** → obvious fakes.
- **Query strings** → parameter *names* only (`?queryId=<scrubbed>`).

Everything else is untouched: every key, every `$type`, every nesting level, every
array length. A test asserts both halves — that no real name survives, and that
the discriminators do.

## The boundary this all sits inside

Read the block at the top of `extension/observer-main.js`. In short: we never
issue a request to LinkedIn, never construct a CSRF token, never read a cookie,
and never alter what the page sends or receives. We copy responses the browser
already received, for the page the user is already looking at. Tests enforce it.
