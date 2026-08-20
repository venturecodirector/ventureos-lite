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

## STATUS: two snapshots recorded, the first mapping derived from them

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
