# Privacy — Venture OS Capture

**Short version: the extension sends the profile you captured to your own
Venture OS server, and nowhere else. There is no analytics, no telemetry, and
no third party.**

## What it reads

Only the LinkedIn profile tab you have open, and only when you press Capture.
From that page it reads: name, headline, current company, location, the About
text, the profile photo URL, and up to three visible posts.

It does not read other tabs, does not run in the background, does not follow
links, and does not open or paginate anything. There is no persistent content
script — the reader is injected when you click and stops when it returns.

## What it stores

On your machine: the address of your Venture OS server and your capture token,
in extension local storage. Nothing else.

## Where data goes

To the server address you configured, over HTTPS, authenticated with your
capture token. That server is operated by you (or your employer), not by the
extension. No data is sent to the extension's authors or to any analytics,
crash-reporting or advertising service.

## The profile photo

The URL is sent to your server, which downloads the image once and stores it on
your own disk. It is deliberately not hot-linked, so viewing a lead card does
not tell LinkedIn that you looked.

## Personal data and erasure

Everything captured is personal data about a real person and is treated as such
in Venture OS: it is covered by the same GDPR erasure and anonymization
handling as any other lead field. Erasing a lead deletes the captured text and
removes the stored photo from disk.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | read the tab you are on, at the moment you click |
| `scripting` | inject the reader for that one read |
| `storage` | remember your server address and token |
| host access to your server | send the capture; requested when you save the address |

The extension requests **no site access at install**. It never asks for access
to linkedin.com, because `activeTab` already covers a click.

## Contact

Raise anything through your Venture OS administrator.
