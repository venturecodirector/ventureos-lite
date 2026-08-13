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
3. Open the extension popup → Settings → paste your Venture OS URL and the token.

## Why a token instead of your session

The extension runs on `linkedin.com`. A session cookie for `ventureco.agency`
is not sent cross-site — that is what SameSite is for. The capture token is a
per-user bearer credential, hashed at rest, revocable from Settings, and scoped
to one workspace.

## Captured fields

Name, headline, current company, location, About text, profile photo URL and up
to three visible posts. The photo is downloaded once server-side and stored on
your own volume rather than hotlinked, because the CDN URL expires and
hotlinking would leak every lead-card view to LinkedIn.

Everything captured is personal data: it joins the GDPR erasure cascade and the
anonymization job like any other lead field.
