# Venture OS — Capture (browser extension)

Assistive capture for the profile page you are already looking at.

## What it does, and deliberately does not

It **reads** the current tab when you press the button, and posts the result to
your Venture OS. That is all.

It does **not** crawl, paginate, open profiles, click, message, connect, run in
the background, or read anything you have not opened yourself. There is no
persistent content script — the reader is injected on your click and returns
one object. CLAUDE.md forbids LinkedIn scraping and automation; the line this
extension stays on is that a human is on the page and pressed a button.

## Install (unpacked)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this
   `extension/` folder.
2. In Venture OS: **Settings → Extension** → create a capture token (shown once).
3. Open the extension popup → Settings → enter your Venture OS address and the
   token → **Save**. Chrome asks for permission to reach that address; that is
   the only site access the extension ever gets.
4. **Test connection** confirms the address, token and permission in one go
   without creating a lead.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `activeTab` | read the profile tab, only when you press the button |
| `scripting` | inject the reader on that click (no persistent content script) |
| `storage` | remember your server address and token locally |
| `optional_host_permissions` | reach YOUR Venture OS — requested when you save it, not at install |

The manifest asks for **no site access up front**: installing it grants nothing
until you name your server. There is deliberately no `host_permissions` entry
for linkedin.com — `activeTab` covers the click, so Chrome never shows "read
your data on linkedin.com".

## Why a token instead of your session

The extension runs on `linkedin.com`. A session cookie for `ventureco.agency`
is not sent cross-site — that is what SameSite is for. The capture token is a
per-user bearer credential, hashed at rest, revocable from Settings, and scoped
to one workspace.

## Captured fields

Name, headline, current job title, current company, location, About text, up to
three visible posts, the profile photo, and an email address, phone number or
website **if the person published one on the page**. Contact details come from
two places, both of them already on screen: prose the person wrote into their
own profile, and `mailto:`/`tel:` links the page has already rendered. LinkedIn
keeps the contact overlay behind a click and this extension does not click — if
you open that panel yourself before pressing Capture, its links are read like
anything else on the page.

The photo is downloaded once server-side and stored on your own volume rather
than hotlinked, because the CDN URL expires and hotlinking would leak every
lead-card view to LinkedIn. The avatar lazy-loads, so its real address is read
from `data-delayed-url`/`srcset` rather than `src` — reading `src` gets you the
1×1 placeholder, which is why captured leads used to show initials.

Everything read is written to the lead's **notes** as a delimited block as well
as to its own fields, which is what "Research with Claude" reads. A re-capture
replaces that block and leaves anything you typed around it alone.

Things a LinkedIn profile does **not** carry, so this will never read them: a
company registration number (adószám) and, usually, a company domain. The tax
number comes from the company-registry lookup in the app; the domain arrives
only when the person published a website link on their profile.

## When a capture reads too little

Press **Copy diagnostics** in the popup and send what it copies.

It reports the page's *shape* — was there an `<h1>`, which sections were found
and under what heading, how many lines the top card yielded, what the images
look like. Every piece of text is replaced by a signature (`«24c 3w latin»`),
so it says where a headline lives without saying whose it is. Section headings
come through in the clear, because matching them by name is the mechanism being
tested and "About" is not personal data.

This exists because LinkedIn's markup cannot be inspected from outside — it
needs a signed-in session on a real profile. Without a report from the actual
page, a fix is written blind, and a test fixture invented to match a guess
passes happily while the real page stays broken.

Everything captured is personal data: it joins the GDPR erasure cascade and the
anonymization job like any other lead field.

## Updating the icons

`icons/mark.svg` is the source. Re-rasterise from the repo root:

```
node -e "…"   # see the rasterize snippet in the P1/1e commit
```

The mark sits at ~74% of the tile: edge-to-edge artwork reads as a smudge at
16px next to other toolbar icons.
