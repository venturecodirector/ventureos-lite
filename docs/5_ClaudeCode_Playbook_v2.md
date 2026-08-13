# Claude Code Playbook v2 — Venture OS
### A Lite utáni fejlesztési ütem: CRM-alapok Pipedrive-szinten + csiszoltság

*Használat ugyanúgy, mint a v1-nél: egy prompt = egy kiadás, minden futás után ellenőrzés és commit, fázis végén a VERIFICATION blokk. Invazív fázis előtt (különösen P4) mindig: friss backup + git tag. Ha a session hosszú: `/compact` vagy új session, és először: `Re-read CLAUDE.md and docs/spec.md`.*

**Fázistérkép és becslés** (Claude Code-dal, a te tempódban):

| Fázis | Tartalom | Becslés |
|---|---|---|
| P1 | Folyamatban lévő funkciók (Lead Engine, Content Hub, Site Audit) | 2–3 nap |
| P2 | Kétirányú e-mail-szinkron | 4–6 nap |
| P3 | Munkasebesség: keresés, szűrők/nézetek/bulk, taskok | 4–5 nap |
| P4 | Deal-réteg: lead/deal szétválasztás, több pipeline, forecast | 5–7 nap |
| P5 | Adatréteg: custom fields, merge, import-visszavonás | 4–5 nap |
| P6 | Értesítések + rate limit/session-kezelés + teljesítmény | 3–4 nap |
| P7 | Csiszoltság: inline edit, undo, ⌘K, onboarding, workflow-lite | 4–5 nap |

---

## P0 — Előfeltételek (ellenőrzés, nem fejlesztés)

Mielőtt a v2 indul, a korábbi két javítócsomagnak élesnek kell lennie: a 10 tételes bugfix (keresés, CSV, new lead, public pages, content hub, user-admin, integrations-settings, analytics-layout, full-width, kanban-modal) és a sidebar-görgetés + favicon. Ellenőrző prompt:

```
Verify that the following previously requested items are implemented and working; report pass/fail each with one line of evidence, fix any that fail: global search; CSV import; "+ New lead" modal; public pages (audit share, quote acceptance, booking) resolving locally and per the Domain layout; Content Hub board functional; Owner user management (email/password edit, 2FA reset, audit-logged); Settings → Integrations with encrypted per-workspace keys and env fallback; analytics bar alignment; full-width desktop shell with visible account menu; clickable kanban cards with edit modal; scrollable sidebar nav with pinned top/bottom; favicon + PWA icon set.
```

---

## P1 — Folyamatban lévő funkciócsomag

*(Ez a korábban összeállított hármas prompt. Ha már lefuttattad, ugord át, és csak a VERIFICATION részét add ki.)*

```
Three feature tasks. Work in order, one commit per numbered item. Verify each manually in the dev server before moving on. Re-read CLAUDE.md hard rules first — especially: no LinkedIn scraping or automation, Claude budget discipline, tenant isolation and grants enforced server-side.

1. LEAD ENGINE — richer research from legitimate sources (NO LinkedIn scraping).
   a) URL-only input UX: when only a LinkedIn URL is pasted with no profile text, do not run a doomed research call. Show an inline guidance state: "Paste the profile text alongside the URL, or capture the page with the browser extension" with a one-click "Open profile" link. Only enable "Research with Claude" when there is actual text to analyze.
   b) Deterministic pre-parse BEFORE any Claude call: extract email address(es), phone number(s), website domain, city/location with regex/heuristics, store as structured lead/company fields, display in the lead card. These populate with zero AI.
   c) Company-website enrichment: when a domain is known, fetch the company's public website server-side (respect robots.txt, 1 fetch, cached 30 days), strip boilerplate, feed a trimmed version into the research call. Reuse existing Places data (phone, city, rating) when available.
   d) ICP scoring must work from these inputs, with explicit "unknown" handling per criterion (unknown ≠ 0 silently; show which criteria lacked data).
   e) Browser-extension capture v2: capture profile photo URL, about/bio and visible recent posts from the page the user is viewing. Store the photo as lead avatar (download once server-side; initials fallback). Add a "Person brief" section: 2-3 sentence Haiku summary on capture, cached, factual tone.
   f) GDPR: photo and bio join the erasure cascade and the anonymization job.
   Test: URL only → guidance state; text with email+city → fields populate without AI; domain → enrichment reflected in card and score.

2. CONTENT HUB — flexible cards + drag between statuses. Cards show title, status chip, date and 2-3 line excerpt (line-clamp); click opens the editor. Drag-and-drop across Draft → In review → Approved → Published with the pipeline kanban's interaction pattern (drag threshold, mobile "Move to…" fallback). Server-side transition enforcement: into Approved requires the content approval grant (denied drag snaps back with toast); Published requires Approved. Status changes activity-logged. Tests: clamping, drag across phases, grant-denied snap-back.

3. SITE AUDIT — screenshots in reports, clean public page, expanded checks.
   a) Desktop + mobile screenshots must render in all three surfaces (in-app, branded PDF, public share page), side by side, captioned; debug the worker and /data/files serving if broken; ensure PDF image embedding works.
   b) PUBLIC REPORT = FACTS ONLY: no Claude pitch-angle, no internal observations or sales framing on the public route — brand header, URL + date, screenshots, plain-language factual results, neutral closing with contact. Internal view and sales PDF keep everything. Add a test asserting pitch-angle text never renders publicly.
   c) Expanded deterministic checks, grouped with per-category subscores (weights in Settings): Security & trust (HTTPS redirect, SSL expiry <30d warn, HSTS/XCTO/XFO/CSP, mixed content); Email hygiene (SPF, DMARC via DNS); Hungarian legal (impresszum, adatkezelési tájékoztató, ÁSZF for webshops, cookie-banner behavior); SEO depth (OG, canonical, schema.org, H-hierarchy, alt %, sitemap count); Analytics & conversion (GA snippet, click-to-call, form, booking); Accessibility (axe-core, violations by severity, top 3 in plain language). Plain-language labels (Hungarian on public page), opportunity-flag wiring, fixture tests, runtime ≤45s with parallel DNS/axe.
   d) Report UI + PDF grouped by category with subscores; public page same grouping minus internal framing; version the audit schema so cached audits still render.

VERIFICATION: full test suite, typecheck, lint; one-line evidence per item; no CLAUDE.md hard-rule violation.
```

---

## P2 — Kétirányú e-mail-szinkron (a legnagyobb értéknövelő)

```
EMAIL SYNC — two-way per-user mailbox sync that threads correspondence onto leads. This is a major feature; plan first (present the sync architecture for approval before writing code), then implement in the sub-steps below, one commit each.

Architecture requirements: Gmail API (OAuth per user, reuse the existing Google credential infrastructure with incremental scopes) as the first provider, behind a MailProvider interface so IMAP can be added later. Sync worker runs in BullMQ: initial backfill (last 90 days, only messages matching known lead/company email addresses or domains), then incremental sync via Gmail history API every 2 minutes. NEVER auto-send anything; sending from the app goes through the user's Gmail (so replies land in their real mailbox) with explicit user action per message.

a) Data model: EmailThread and EmailMessage entities (workspace-scoped, linked to lead and/or company by matched address/domain), direction, snippet, sanitized HTML body (strip scripts/trackers), attachments metadata (download on demand, stored under /data/files, in the GDPR erasure cascade). Matching rules: exact address > domain match > unmatched (unmatched inbox for manual linking with one click, which also teaches a persistent address→lead mapping).
b) Sync engine: OAuth connect/disconnect in Settings → Email per user, backfill job with progress UI, incremental sync, rate-limit-aware with exponential backoff, clear reconnect state on token expiry, per-mailbox sync health visible in Settings.
c) Lead timeline integration: threads render in the lead's Inbox tab chronologically merged with existing logged activity; the manual paste flow remains as fallback. Reply analysis (existing Haiku call) runs ONLY when the user opens an unread inbound message tied to a lead — never in bulk during backfill (budget rule).
d) Compose & reply from the app: rich-but-simple composer (to/cc, subject, body, attach), sends via the user's Gmail, appends to the thread, respects the price-mention escalation lock. Outbound cold campaigns remain strictly on the Mailgun cold domain — sending campaign mail through personal Gmail must be impossible by construction.
e) Privacy & scope: sync ONLY messages matching lead/company addresses or the unmatched queue window; never import the user's unrelated personal mail (filter at query level, not post-hoc). Document this in code comments and the Settings UI copy.
f) Tests: address/domain matching, unmatched→link flow, escalation lock on composer, campaign/Gmail separation, erasure cascade includes email bodies and attachments for erased leads.

VERIFICATION: connect a test mailbox, backfill, send a reply from the app, see it thread; confirm no Claude call fired during backfill (check ClaudeUsage).
```

---

## P3 — Munkasebesség: keresés, szűrők/nézetek/bulk, taskok

```
Three speed features. One commit per item.

1. GLOBAL SEARCH, properly. Postgres-native full-text + trigram (pg_trgm) search across leads, companies, deals-if-present, documents, email threads and notes within the current workspace: typo-tolerant, prefix-friendly, ranked (name matches above body matches), fast (<150ms on 10k rows — add the necessary GIN indexes via migration). Results grouped by entity type with keyboard navigation. This becomes the backend for the ⌘K palette in a later phase — design the search API accordingly (single endpoint, typed results).

2. FILTERS + SAVED VIEWS + BULK ACTIONS on the leads table (and pipeline where applicable). Filter builder: combinable conditions (field, operator, value) across core fields — stage, ICP score range, industry, city, signals, source, owner, last-activity age, has-email/has-phone. Views: save a filter set + column selection + sort as a named view, personal or workspace-shared; views appear as tabs above the table. Bulk actions on the filtered selection (select all matching, not just visible page): change stage (score gate still enforced per lead — report skipped ones), add/remove signal tags, assign owner, move to Not now with wake-up date, export CSV, delete (grant-gated, confirm dialog, audit-logged). Server-side execution in batches with a progress indicator.

3. TASKS as a first-class object. Task entity: type (call / email / todo / follow-up), title, optional note, due datetime, linked entity (lead, company, deal, document — polymorphic), assignee, done/overdue state. Create from anywhere (lead modal, kanban card menu, ⌘-ready quick action) and standalone. Views: My tasks list (due today / overdue / upcoming), tasks section on the lead modal, and a week calendar view. Today Queue integration: manual tasks merge into the existing queue ordering; completing a system-generated follow-up task keeps the existing sequence logic intact. Overdue tasks surface in the Monday digest. Tests: polymorphic linking, queue merge ordering, overdue rollover.

VERIFICATION: search returns fuzzy matches across entities; a saved shared view persists for the other user; bulk stage-change on 50+ leads respects the score gate; a task created on a lead appears in Today Queue at due time.
```

---

## P4 — Deal-réteg: lead/deal szétválasztás, több pipeline, forecast

*(Architektúrálisan a leginvazívabb fázis. Előtte: `git tag pre-deals` + friss DB-backup. A promptban kötelező a terv-először.)*

```
DEALS LAYER — separate Deal from Lead, multiple pipelines, weighted forecast. This is an invasive architectural change: FIRST present a written migration plan (data model, how existing pipeline data maps onto the new structure, rollback strategy) and wait for approval; only then implement.

a) Model: Deal entity (workspace-scoped): linked lead/company, title, value (integer HUF), currency, expected close date, probability (from stage default, per-deal override), pipeline_id, stage_id, owner, status (open/won/lost with DealOutcome integration). Pipeline and Stage become data (per-workspace): name, ordered stages, per-stage default probability, per-stage rotting threshold (days-in-stage warning). Seed two pipelines from current config: "Web projects" and "Grants", and migrate every existing lead currently in Qualified/Meeting/Handed-off into a deal in the appropriate pipeline stage — leads keep the pre-deal journey (Researched→Replied), deals own the money journey. The existing lead kanban remains for the top-of-funnel; a new Deals kanban (per-pipeline tabs) owns the rest. Document the boundary clearly in the UI.
b) Deal UX: deal cards show value, probability, expected close, rotting indicator; the lead modal links to its deal(s) and vice versa; converting a qualified lead to a deal is one action (pre-filled from lead + audit data). Quotes/contracts chain onto the deal (migrate document linkage), pipeline card chain-status moves to the deal card.
c) Weighted forecast: per pipeline and per month — sum(value × probability) by expected close month, table + simple bar view in Analytics; commit vs. upside split (probability threshold configurable); compare against Targets. Win/loss data updates stage default probabilities QUARTERLY as a Signal Engine proposal (approval queue, min n=20) — never silently.
d) Migration safety: reversible migration script, dry-run mode printing the mapping, and a post-migration integrity check (every prior lead-stage state accounted for; document chains intact). All existing tests updated and green.

VERIFICATION: dry-run output reviewed; migration runs; old lead flow works top-of-funnel; a deal moves through a custom pipeline; forecast sums match a hand-checked fixture; document chain renders on the deal.
```

---

## P5 — Adatréteg: custom fields, merge, import-visszavonás

```
Three data-layer features. One commit per item.

1. CUSTOM FIELDS. Owner-defined fields on Lead, Company and Deal (per-workspace): types text, number, date, single-select, multi-select, checkbox, URL; required flag; archived flag (never hard-delete a field with data). Definition UI in Settings → Fields; values render and edit on the entity modal and inline in tables; fields are usable in the P3 filter builder and visible as optional table columns; included in CSV export and mappable in CSV import; searchable where text-typed. Store as a typed JSONB column with a definition registry — enforce type validation server-side with zod built from the definitions. Custom fields join the GDPR erasure/anonymization handling.

2. DUPLICATE MERGE. A merge tool for companies and leads: detect candidates (same tax id, same domain, fuzzy-same name via trigram) surfaced as a "possible duplicate" banner and a Settings → Data quality list. Merge UI: side-by-side field comparison, pick the surviving value per field (smart defaults: non-empty > newer), preview, then merge — activities, emails, tasks, documents, calls and deals re-link to the survivor; the loser is tombstoned (redirects resolve to the survivor); the merge is audit-logged and reversible for 30 days (store the pre-merge snapshot). Grant-gated.

3. IMPORT ROBUSTNESS. CSV import v2: saved mapping templates (name + column mapping + type coercions, reusable per source); a validation preview listing every problem row with reason (bad email, unknown stage, duplicate) and the choice to skip/fix; imports run as a tracked ImportBatch — every created/updated record tagged with the batch id; and a ROLLBACK action per batch (within 7 days) that removes created records and reverts updated fields to their pre-import snapshot, refusing politely if later manual edits would be lost (list the conflicts). Batch history in Settings → Data quality.

VERIFICATION: a custom select field appears in table, filter and export; merging two companies re-links a deal and its documents and is undoable; an import of 100 rows rolls back cleanly, and a conflicting rollback reports the exact conflicts.
```

---

## P6 — Értesítések + biztonság + teljesítmény

```
Three items. One commit per item.

1. NOTIFICATION CENTER. In-app notification entity + bell icon with unread count in the topbar; notification types: inbound reply on your lead, escalation (price mention), callback due, task due/overdue, quote accepted/declined, meeting booked/cancelled, campaign circuit-breaker pause, import/sync failures, Signal Engine proposal pending (Owner). Each notification deep-links to its entity. Per-user preferences in Settings: per-type toggle for in-app / push / email digest. PWA Web Push (VAPID) for mobile — respect the existing PWA setup; email fallback batches into the existing digests rather than sending per-event mail. Mark-read/mark-all; 90-day retention.

2. RATE LIMITING + SESSION MANAGEMENT. Rate limits (Redis-backed, per-IP and per-account): login and 2FA attempts (lockout with backoff + audit log entry), public routes (booking, quote acceptance, audit share) against scraping/abuse, and API-wide sane defaults; return 429 with Retry-After. Session management UI in the account menu → Security: list active sessions (device/browser, IP, last active, current highlighted), revoke one, revoke all others; password change revokes other sessions; new-login notification (in-app + email). Sessions get absolute (30d) and idle (7d) expiry. Audit-log revocations and lockouts.

3. PERFORMANCE AT SCALE. Target: smooth at 5,000 leads / 2,000 deals. Virtualize long lists (leads table, prospector results, notification list) and cap kanban columns with "load more"; add missing DB indexes for the hot queries (check with EXPLAIN on seeded data — write a seed script that generates 5k realistic leads for testing); paginate every list API (cursor-based); optimistic UI for stage moves, task completion and inline edits with rollback on failure; debounce and cache dashboard aggregates (60s); measure and report before/after timings for the 5 slowest interactions.

VERIFICATION: push notification arrives on a phone for a due callback; 6 failed logins lock with audit entry and 429s; "revoke all other sessions" works; the leads table scrolls smoothly with 5k seeded rows and the timing report shows the improvements.
```

---

## P7 — Csiszoltság: a Pipedrive-érzés

```
Five polish features. One commit per item. These are UX details — match the existing design tokens exactly, no visual drift.

1. INLINE EDITING. Editable cells in the leads/deals tables (click or Enter on focused cell): text, number, date, select and custom fields; Esc cancels, Enter/blur saves with optimistic update + server validation (grants, score gate, tenant guard as everywhere); edited cell flashes subtle confirmation. Keyboard: arrows move cell focus, Tab moves right. Also inline-editable: deal value and expected close on kanban cards (click the value).

2. UNDO. A 6-second undo toast after: stage/status moves (lead, deal, content), task completion, bulk actions, lead/deal archive-delete, merge (links to the 30-day revert), Not now moves. Implement as command-pattern with server-side inverse operations — not client-side illusion; concurrent-edit conflicts decline the undo with a clear message. Audit log records both the action and the undo.

3. COMMAND PALETTE + KEYBOARD MAP. ⌘K / Ctrl-K palette built on the P3 search API: fuzzy-find any entity (Enter opens), plus actions ("New lead", "New task", "Go to Pipeline", "Run audit on…", "Start import"), recent items on empty query. Complete the keyboard map: g+letter navigation (g p → pipeline, g i → inbox…), n → new lead, t → new task, ? → shortcut overlay (update the existing help). All shortcuts suppressed inside inputs.

4. EMPTY STATES + ONBOARDING. Every empty screen gets a purposeful empty state: one sentence of what this module does + the primary action button (match the prototype's tone, lowercase Bricolage headline). First-login guided tour (5-6 steps, dismissible, per-user "seen" flag): Dashboard/Today Queue → capture a lead → research → outreach → pipeline → where settings live. A "Getting started" checklist card on the Dashboard for new users (connect email, capture first lead, run first audit, book first meeting) that disappears when complete.

5. WORKFLOW-LITE. A small automation builder in Settings (Owner-gated): rules of the form WHEN trigger IF conditions THEN actions. Triggers: stage changed (lead or deal), quote accepted, meeting outcome logged, task overdue by N days, lead created from source X. Conditions: field comparisons incl. custom fields. Actions: create a task (template with due offset), send a template email VIA EXPLICIT DRAFT — the action creates a prepared draft that a human must review and send (no automated outreach, CLAUDE.md rule stands), add/remove signal tag, move to Not now, notify a user. Rules are per-workspace, versioned, with an execution log (what fired, on what, result) and a kill switch per rule. Max 20 rules; cycle protection (a rule's action cannot re-trigger itself or exceed 3 chained rule executions per originating event).

VERIFICATION: inline edit respects the score gate; undo restores a bulk stage move; ⌘K finds a lead by typo'd name and creates a task; the tour runs once for a fresh user; a workflow rule creates a draft email that requires human send, and its execution appears in the rule log.
```

---

## Zárás — v2 definition of done

```
Run the full test suite, typecheck and lint. Verify the P1-P7 VERIFICATION blocks end-to-end and report pass/fail with evidence. Audit the codebase against CLAUDE.md hard rules — with special attention to: no automated outreach introduced by workflow-lite or email sync; no unbudgeted Claude calls added anywhere in P1-P7 (diff the ClaudeUsage call sites against the registry); grants and tenant isolation on every new mutation (custom fields, merge, bulk, deals, sessions). Update docs/spec.md with the new modules (email sync, tasks, deals/pipelines, custom fields, notifications, workflow-lite) so the spec matches reality, and update docs/HANDBOOK.md with the new Owner-facing features. Tag the release v2.0.
```
