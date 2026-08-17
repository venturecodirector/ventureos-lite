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

## How to record

1. **Load the extension fresh.** `chrome://extensions` → remove the old copy →
   *Load unpacked* → the `extension/` directory. Version must read **5.0.0**.
   Chrome will now ask for access to `linkedin.com` — that is new, and it is what
   lets the observer install before the page starts fetching.

2. **Open a LinkedIn profile and RELOAD it.** This matters: the interceptor is
   installed at `document_start`, so it only sees responses fetched *after* it is
   in place. A tab that was already open when you installed the extension has
   nothing in its buffer.

3. **Check that anything arrived.** Open the extension popup and press
   **Copy observed responses**. You should see `observerInstalled: true` and a
   non-zero `recordCount`. If it is zero, the reload in step 2 did not happen or
   the page served everything from cache — reload with ⇧⌘R.

4. **Press "Save API snapshot"**, give it one of the labels below, and save the
   file into this directory.

5. **Repeat for each case.** Then commit, and tell me — I will derive the mapping
   from what is actually in the files and report which fields I found and which I
   did not.

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

For `contact-overlay`: open the profile, reload, press **Contact info** on the
page so LinkedIn fetches it, then save the snapshot. The observer will have seen
both the profile response and the contact one.

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
