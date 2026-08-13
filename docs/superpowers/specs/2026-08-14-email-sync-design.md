# Two-way email sync (playbook-v2 P2)

**Date:** 2026-08-14
**Status:** approved architecture, implementing a+b first
**Covers:** playbook-v2 P2 a–f

## Problem

Correspondence with a lead lives in a personal Gmail mailbox. The CRM knows
about it only when someone pastes it in, which means the timeline is always
partial and always stale. The playbook calls this phase *"a legnagyobb
értéknövelő"*, and it is: every other module gets better when the system can
see what was actually said.

## The constraint that shapes the design

We are syncing a mailbox we do not own, containing correspondence that is
mostly none of the product's business. The rule from the playbook is *"filter
at query level, not post-hoc"*.

**Chosen: repeated filtered search.** Each cycle issues Gmail queries built from
known lead/company addresses and domains, plus an `after:` watermark. Only
matching messages are ever returned by the API.

Rejected: the History API (returns every change unfiltered; we would fetch
headers for private mail and discard them — post-hoc filtering wearing a
query-level costume) and Pub/Sub push (same problem, plus infrastructure).
Repeated search costs more quota. With two mailboxes and a few hundred
addresses, quota is not the constraint, and this is the only option where "we
never touch your unrelated mail" is literally true.

Consequence to accept: a newly-added lead has no history in our copy until a
one-off backfill pass runs for its addresses. That is a feature — it means the
scope of what we hold is always derived from the CRM, never wider.

## OAuth

The consent screen is **Internal** on the `ventureco.group` Workspace domain,
which means `gmail.readonly` and `gmail.send` need no Google verification and
refresh tokens do not expire. The existing `/api/google/connect` route already
sends `include_granted_scopes=true`, so mail is an incremental grant on the
account the user already connected for Calendar — no second consent screen, no
new credential row type beyond a purpose.

If this ever moves to External, restricted-scope verification and the 7-day
testing-mode refresh token expiry both come back. The `MailProvider` interface
exists so IMAP can replace Gmail without touching anything above it.

## Data model

- **`MailAccount`** — one per connected mailbox. Links `userId` +
  `GoogleCredential` (new `purpose: "MAIL"`). Holds sync state: `watermark`
  (the `after:` boundary), backfill progress, `health`
  (`ok | reconnect_needed | rate_limited | error`), last error, last sync at.
  Health is a stored field rather than something inferred at render, so
  Settings can show "reconnect needed" without probing Google on page load.
- **`EmailThread`** — workspace-scoped. Provider thread id, subject, `leadId`,
  `companyId`, and `matchType` (`address | domain | manual`). Storing HOW it
  matched is what lets a domain-matched thread be corrected without the next
  sync silently re-matching it the same wrong way.
- **`EmailMessage`** — direction, from/to/cc, `sentAt`, snippet, sanitized
  HTML, plain text, `hasAttachments`, attachment **metadata** only. Bytes are
  fetched on demand and written under `/data/files`.
- **`AddressLink`** — `email → leadId`, workspace-scoped, written when someone
  manually links an unmatched thread. Without it the unmatched queue is endless
  manual work; with it, one correction teaches the matcher permanently.

Matching precedence: exact address → domain → unmatched.

## Sanitization

`sanitize-html` (approved addition). Email HTML is hostile input from strangers
and hand-rolled regex sanitizing is how XSS ships. Two layers, because one is
not enough for content this untrusted:

1. sanitize on ingest — allowlist of tags and attributes, no scripts, no event
   handlers, no `style` that can position or overlay;
2. render inside a sandboxed iframe with no `allow-scripts`.

Remote images are blocked by default behind a click-to-load. A remote image in
an email is a read receipt: loading it silently tells the sender the message was
opened, which is not a decision the product should make on the operator's
behalf.

## Sending

Two paths that share no code:

- **Thread reply** — `modules/email/send-gmail.ts`, takes a thread id and the
  sending user's id. Sends through that user's Gmail so the reply lands in
  their real Sent folder and threads correctly for the recipient. Respects the
  existing price-mention escalation lock.
- **Cold campaigns** — unchanged, Mailgun cold domain only.

Enforced by an **import-graph test**: `modules/campaigns/**` may not import the
Gmail sender, and the Gmail sender may not import campaign modules. A runtime
flag can be forgotten in a new call site; a missing import cannot.

## AI budget

Reply analysis is the existing Haiku call and fires only when a human opens an
unread inbound message tied to a lead. Never during backfill — a 90-day
backfill of two mailboxes would otherwise be thousands of calls in a burst.
Pinned by a test that runs a fixture backfill and asserts `ClaudeUsage` is
unchanged.

## GDPR

`eraseLeadData` gains email threads, messages and attachment files. Attachments
are the part that is easy to miss: the rows go, and the bytes stay on the
volume forever unless the cascade removes them explicitly.

## Order of work

1. **(a) data model** — schema, migration, and the pure matching logic with its
   tests. Shippable on its own; nothing syncs yet.
2. **(b) sync engine** — provider interface, Gmail implementation, query
   builder, backfill and incremental jobs, Settings → Email with per-mailbox
   health.
3. (c) timeline integration, (d) composer, (e) privacy copy, (f) remaining
   tests — after a+b are working against a real mailbox.

## Risks

1. **Quota.** Filtered search is chattier than the History API. Mitigated by
   address chunking and a 2-minute cadence; if it ever bites, the fix is a
   longer cadence, not a switch to unfiltered sync.
2. **A domain match is a guess.** `@nagycég.hu` may be five different people.
   Domain matches are visibly labelled as such and correctable, and a manual
   correction wins permanently via `AddressLink`.
3. **Backfill volume.** 90 days across two mailboxes, filtered, is small — but
   the job reports progress and is resumable, because "it looked stuck" is the
   most likely support question.
