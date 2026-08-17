# Venture OS Lite — Operator Handbook

For the Owner of a Venture OS Lite installation. Covers the things only you can
do: managing people and their permissions, provisioning workspaces, editing
legal document templates, controlling AI spend, verifying backups, executing a
GDPR erasure request, and running the test suites before you ship a change.

Installation and server maintenance live in [`DEPLOY.md`](DEPLOY.md).
Feature-level behaviour lives in [`spec.md`](spec.md).

---

> ### Security model in one paragraph
>
> Everyone signs in with an email and a bcrypt-hashed password, optionally
> backed by a TOTP second factor. Sessions live as rows in the database, so they
> are revocable and expire after 12 hours. Roles and grants are checked
> server-side on every mutation — not merely hidden in the UI. Five failed
> sign-ins lock an account for 15 minutes.
>
> The three prospect-facing surfaces (`audit.`, `quote.`, `meet.`) are
> deliberately public, reachable only via unguessable slugs.

---

## 1. Users and grants

### Roles vs. grants

Two independent layers:

**Role** (`OWNER`, `ADMIN`, `BDR`) — set when a person is added to a workspace.
It governs broad access: only an Owner can change grants, provision workspaces,
finalize legal documents, or change retention policy.

**Grants** — individual capabilities, assigned per user *per workspace*. They
are checked server-side on every mutation, not just hidden in the UI. Turning
one on takes effect immediately; no redeploy, no restart.

The seven grants:

| Grant | What it unlocks |
|---|---|
| `documents.quote.create` | Generate quotes from templates |
| `documents.contract.create` | Generate contracts from an accepted quote |
| `documents.certificate.create` | Generate completion certificates |
| `documents.send` | Email a document to a client, and publish its public accept link |
| `templates.edit` | Edit quote/contract/certificate/email templates |
| `signal_engine.approve` | Approve the weekly Signal Engine proposals |
| `exports.run` | Run a full data export |

**Default:** an Owner gets all seven. Everyone else gets **none** until you
explicitly grant them. This is deliberate — the document and template grants
control legally binding output.

### Granting a capability

1. **Settings → users & grants**.
2. Find the person's row; each grant is a toggle grouped by module.
3. Click the toggle. It saves immediately.

Every grant change is written to the audit log with who changed it, for whom,
which grant, and when.

### Adding someone to a workspace

**Settings → workspace → add member**: enter their email address and pick a
role. If no user exists with that address, one is created.

They start with zero grants regardless of role (except Owner). Add the grants
they need, one at a time — the safe default is to grant nothing until someone
is blocked by its absence.

### Removing access

There is no "remove member" button yet. To revoke someone today:

```bash
# 1. Kill their live sessions immediately.
docker compose -f docker-compose.prod.yml exec db psql -U venture -d ventureos -c \
  "UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL AND user_id =
   (SELECT id FROM users WHERE email = 'person@example.hu');"

# 2. Remove their membership.
docker compose -f docker-compose.prod.yml exec db psql -U venture -d ventureos -c \
  "DELETE FROM memberships WHERE user_id =
   (SELECT id FROM users WHERE email = 'person@example.hu');"
```

Step 1 takes effect on their very next request — the session row is the
authority, so a browser holding a valid cookie is signed out at once. Step 2
alone would also deny them (no membership, no workspace), but revoking first
closes the window.

### Locked out / lost second factor

Both are fixed from the server console:

```bash
docker compose -f docker-compose.prod.yml run --rm worker \
  npm run set-password -- person@ventureco.group            # new password, clears any lock
docker compose -f docker-compose.prod.yml run --rm worker \
  npm run set-password -- person@ventureco.group --clear-2fa  # also removes TOTP
```

Setting a password revokes every existing session for that account.

---

## 2. Workspace provisioning

A workspace is a complete tenant: its own companies, leads, documents,
templates, campaigns, budget and settings. Nothing crosses between workspaces.

Use a second workspace when you are running sales for a genuinely separate legal
entity or brand — **not** to separate teams or regions within Venture CO Group.
Data cannot be moved or reported across workspaces afterwards.

### Creating one

**Settings → workspaces → create workspace.** You need:

- **Name** — internal label shown in the switcher.
- **Legal name** — the exact registered company name. This is printed on every
  quote, contract and certificate as `{{workspace.legal_name}}`. Get it right.

The creator becomes its Owner and is switched into it. A new workspace starts
with the default document templates and default settings.

### After creating one

Do these before generating any document from it:

1. **Settings → brand** — tax number (adószám) and registered address. They fill
   `{{workspace.tax_id}}` and `{{workspace.address}}` on legal documents.
2. **Settings → email** — the verified Mailgun sending domain for this
   workspace, if it differs from the installation default.
3. **Settings → AI budget** — see §5. New workspaces default to **$2/day**.
4. **Settings → ICP** — scoring thresholds, if this entity targets a different
   customer profile.

### Switching

The workspace switcher is in the top bar. It only ever lists workspaces you are
a member of, and your choice is stored on the session row server-side — there is
no client-writable value to tamper with. A session pointing at a workspace you
are not a member of is ignored and repaired to one of your own. Verified by the
isolation test suite.

---

## 3. Editing templates

Templates produce every quote, contract and completion certificate. There is
**no AI in this path** — documents render from a versioned template plus
variables, and nothing else. That is what makes them reproducible.

Requires the `templates.edit` grant.

### The editor

**Templates** in the left rail. Pick a type (Quote / Contract / Certificate /
Email) and a language (HU / EN).

- Type `{{` to get autocomplete for available variables.
- The live preview on the right renders with sample data.
- **Unknown variables are flagged** as you type. Fix them before saving — an
  unknown variable renders as empty text on a client-facing document.

### Versioning — the important part

**Saving creates a new version. It never edits the existing one.**

Documents already generated keep rendering from the version they were created
with, byte-identically, forever. So:

- Changing a template does **not** retroactively change any quote you have
  already sent.
- A contract signed last month still renders exactly as signed, even after ten
  template revisions.

After saving, the new version is a **draft**. It is not used for new documents
until you **activate** it. Activate it from the version list.

### Working practice

1. Save a draft.
2. Read the preview end to end — especially totals, VAT wording and legal
   clauses.
3. Activate.
4. Generate one throwaway document and read the PDF before sending anything to
   a client.

### The DRAFT watermark

Every generated legal document carries a **DRAFT watermark** until an Owner
finalizes it. Finalizing is an audited action — who removed the watermark, on
which document, and when. Do not finalize a document you have not read in full.

---

## 4. Outreach and the human-edit rule

Outreach Studio (**Outreach** in the rail) runs a three-step LinkedIn sequence
per lead: a connection note capped at 300 characters, then up to two follow-ups.

**Claude drafts; you send.** The system never sends outreach itself — "Mark
sent" only records that *you* sent it, after "Copy & open LinkedIn".

Two rules are enforced on the server, not just in the interface:

1. **A Claude-drafted message cannot be marked sent until you have changed it.**
   Adding spaces does not count; the comparison ignores whitespace. If you press
   Mark sent on an untouched draft, the server refuses and says so. The intent
   is that nothing leaves in Claude's voice unedited.
2. **Two follow-ups with no reply parks the lead as `Not now`**, with a wake-up
   in 30 days. Nobody gets chased indefinitely.

Also available: **Critique** (Claude reviews your text and names what is weak),
**Blank draft** (write it yourself, no AI at all), and one-click **audit hooks**
that insert a finding from the lead's website audit as an opening line. Hooks
are assembled from audit data, not generated, so they cost nothing and cannot
invent a fact.

Both Draft and Critique are manual buttons and count against the AI budget
below. Nothing on this screen calls Claude on load.

---

## 5. AI budget caps

Every Claude call is metered and charged against a **per-workspace daily USD
cap**. When today's spend reaches the cap, further AI calls are refused with a
clear message and **every deterministic feature keeps working** — prospecting,
website audits, scoring, the pipeline, documents, email, invoicing. You lose
research cards, outreach drafts, meeting briefs and the weekly analysis until
midnight.

### Setting the cap

**Settings → AI budget**. Default is **$2.00/day** per workspace.

Sensible starting points:

| Usage | Cap |
|---|---|
| Trying it out | $1/day |
| One BDR, normal day | $2–3/day |
| Heavy prospecting week | $5/day |

Set it low first. It is easier to raise a cap that bit than to explain a bill.

### Watching spend

**Analytics → AI usage** shows spend per day, broken down by use case and model.
Every single call is logged to `ClaudeUsage` with its token counts and computed
cost.

### What controls cost

The system is built to be frugal, and these properties are enforced in code:

- **No AI on page load or save.** Every call is a manual trigger.
- **Haiku by default.** Sonnet only for research cards, outreach drafts, meeting
  briefs and the weekly analysis.
- **Results are cached.** Re-opening a lead does not re-run its research.

If spend surprises you, look at **Analytics → AI usage** grouped by use case
before raising the cap — it is usually one workflow, not general drift.

### When the cap is hit

You get: `Claude daily budget reached for workspace … AI calls resume tomorrow.`

You can raise the cap and retry immediately. The counter resets at midnight UTC.

---

## 6. Backup verification

Backups run nightly at 03:30 via cron (`DEPLOY.md` step 8). The script already
verifies each dump is readable before it counts it. That is not the same as
knowing you can restore — **verify quarterly**.

### Monthly: is it running?

```bash
ls -lht /var/backups/ventureos/ | head -20
tail -30 /var/log/ventureos-backup.log
```

You should see roughly 14 pairs of files, the newest from last night, and a log
ending in `done — N database backup(s) retained`.

Red flags:

- Newest file older than 48 hours → cron is not firing. Check `crontab -l`.
- Database dump under ~50 KB → the dump is probably empty. Investigate now.
- `FAILED:` anywhere in the log → read the line above it.

### Quarterly: restore drill

The only real test is restoring somewhere that is not production. On a scratch
machine with Docker:

```bash
# 1. Copy the newest dump off the server
scp root@SZERVER_IP:/var/backups/ventureos/db-*.dump ./

# 2. Throwaway Postgres
docker run -d --name restore-test \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=ventureos \
  -e POSTGRES_USER=venture -p 55432:5432 postgres:16-alpine

# 3. Restore into it
cat db-20260812-033001.dump | docker exec -i restore-test \
  pg_restore -U venture -d ventureos --no-owner

# 4. Does it hold real data?
docker exec restore-test psql -U venture -d ventureos -c \
  "SELECT (SELECT count(*) FROM workspaces) AS workspaces,
          (SELECT count(*) FROM leads)      AS leads,
          (SELECT count(*) FROM documents)  AS documents;"

# 5. Clean up
docker rm -f restore-test
```

Counts should match production within a day's activity. Write down the date you
last did this.

### What is and is not backed up

| Backed up | Not backed up |
|---|---|
| Database (all tenants) | TLS certificates (Caddy re-issues them automatically) |
| `/data/files`: PDFs, screenshots, exports | The `.env` file |
| | Redis queue state (in-flight jobs; they re-queue) |

> ⚠️ **Keep a copy of `.env` somewhere safe and separate.** It is deliberately
> excluded from backups, and without it a restored database is not a running
> system. A password manager entry is fine.

> ⚠️ **Backups live on the same server as the data.** Pull them down weekly, or
> enable Vultr snapshots. A single-machine loss otherwise takes both.

---

## 7. GDPR erasure procedure

A data subject has the right to have their personal data deleted. This system
completes the live deletion **well within 72 hours** and hard-deletes — it does
not flag rows as hidden.

### Executing an erasure request

Owner only. **Settings → Data & privacy → Erase lead data**.

1. Select the lead.
2. Type the confirmation phrase exactly as shown.
3. Confirm.

This queues an erasure job that hard-deletes the lead and cascades through every
derived record: activities, messages, calls, meetings, audit results and their
share links, campaign recipients, quote acceptances, email logs, and generated
documents (subject to the document-retention setting below). Completion is
written to the audit log.

Verify it landed:

```bash
docker compose -f docker-compose.prod.yml logs worker | grep -i erasure
```

### Before you erase: legal retention

Hungarian accounting law requires issued invoices to be retained for eight
years. **An invoice is not erasable personal data you may delete on request.**

**Settings → Data & privacy → `eraseDocumentsOnErasure`** controls whether
generated documents are destroyed along with the lead. Decide this deliberately,
with your accountant:

- **Off (recommended)** — invoices and signed contracts survive erasure, meeting
  the statutory retention obligation. Everything else goes.
- **On** — documents are destroyed too. Only appropriate for leads that never
  reached an invoice.

If a data subject with issued invoices requests erasure, erase everything else
and tell them the invoices are retained under a legal obligation (GDPR Art.
17(3)(b)). That is a valid and expected answer.

### Backups and erasure

Erasure cannot rewrite already-written backup archives without corrupting them.
Instead, erasure is satisfied by **expiry**: every backup is permanently deleted
within the 14-day rotation, so personal data in a pre-erasure snapshot is gone
at most 14 days later.

This is why `RETENTION_DAYS` must stay at 14. Raising it lengthens the window in
which erased data still exists, and breaks the stated policy. Full reasoning:
[`backup-erasure-policy.md`](backup-erasure-policy.md).

### Automatic anonymization

Separately from requests, a monthly job pseudonymizes person-level fields on
leads with **no activity for 12 months**, while keeping aggregate statistics
intact. Your win-rate history survives; the individual's name and contact
details do not.

Adjust the window in **Settings → Data & privacy → `anonymizeAfterDays`**
(default 365). The job is idempotent — re-running it changes nothing.

### Data export (subject access requests)

Requires the `exports.run` grant. **Settings → Data & privacy → Run export**
produces a CSV bundle written to `/data/files/exports/`, downloadable through
the authenticated file route. Every export is audit-logged.

### Where the data lives

All data is on your EU server (Vultr Frankfurt/Amsterdam) and in Mailgun's EU
region (`MAILGUN_EU=true`, enforced at boot). Claude API calls send prompt
content to Anthropic for processing; they are not used for training. Note this
in your privacy policy.

---

## 8. Running the tests yourself

Three checks gate every change (CLAUDE.md, "definition of done"). The first
three are instant and need nothing running:

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # ESLint
npm test              # vitest — unit + DB-backed integration
```

`npm test` needs Postgres up, because the integration tests prove tenant
isolation against the real database rather than a mock.

### The browser suite (Playwright)

This one drives a real browser through the critical flows: capture → score →
gate, quote → PDF → send, and workspace isolation.

```bash
# 1. Database and Redis (leave running; they persist between runs).
docker compose up -d db redis

# 2. Schema — only after a schema change, or on a fresh database.
npx prisma db push
npm run db:seed

# 3. Browser binaries — once per machine.
npx playwright install chromium

# 4. Run everything. The dev server starts and stops on its own.
npx playwright test
```

Useful variations:

```bash
npx playwright test workspace-isolation   # one spec by name
npx playwright test --headed              # watch it happen
npx playwright test --ui                  # pick and re-run interactively
npx playwright show-report                # after a failure
```

**Expected result: 94 passed, 1 skipped, in about 3–4 minutes.** The skip is
deliberate — one public audit test needs a real registrable domain and cannot
mean anything on `localhost`, so it opts out rather than asserting something
false.

The suite runs on a single worker on purpose. Every spec shares one seeded
workspace and one dev server, and the lead specs create, filter, re-stage and
delete leads; in parallel they revalidated pages underneath one another and
produced failures that moved around between runs. Serial costs a couple of
minutes and makes a red result mean something. Do not raise `workers` in
`playwright.config.ts` without first giving each worker its own workspace.

### Two things that look like failures but are not

**The environment warning on startup.** Every run prints:

```
Environment check failed — 2 problems:
  ✗ MAILGUN_WEBHOOK_SIGNING_KEY — is required when MAIL_PROVIDER=mailgun
  ✗ NEXTAUTH_SECRET — is still the placeholder
```

That is the boot check doing its job on a development `.env`. It refuses to
start in production and continues in development, which is what you want
locally. Do not "fix" it by putting real secrets in the development `.env`.

**`FILES_DIR`.** `.env` sets `FILES_DIR=/data/files` — that path is *inside* the
app and worker containers, where docker-compose mounts the files volume. A test
run on your own machine cannot create `/data`, so `playwright.config.ts` points
host-side runs at `data/files` in the repo instead (already gitignored). Nothing
about the container changes, and you do not need to edit `.env`. If you ever
want a different location, export `FILES_DIR` before running and it is honoured.

---

## 9. What v2 added, in one place

The v2 release (playbook-v2 P4–P7) added five Owner-facing things. Each has its
own section above where it needed one; this is the map.

### Deals, pipelines and the forecast

A **lead** is a person you are trying to reach. A **deal** is a piece of work
with money attached. Everything up to Replied is the lead board; from Qualified
onward it is the deals board, and the two link across so nobody has to remember
which one a name is on.

Pipelines are **yours to shape**: *Web projects* and *Grants* come seeded because
they close on completely different clocks, and you can rename, re-weight and
re-order the stages of either. Each stage has a default probability (what the
forecast weighs a deal there at) and a rotting threshold (how long a card may sit
before it turns amber).

**Analytics → Forecast** multiplies value by probability and groups by expected
close month, split into *commit* (at or above your threshold) and *upside*.
Closed deals are excluded on purpose — a forecast that grows every time
something closes is a scoreboard, not a forecast.

Once a quarter the system compares each stage's configured probability against
what actually closed and, if the gap is real and the sample is at least twenty,
raises a proposal in the approval queue. It never changes a number on its own.

### Your own fields

**Settings → Fields.** Add fields to leads, companies and deals: text, number,
date, single or multi select, checkbox, URL. They show on the record, as
optional table columns, in the filter builder, in CSV import and export, and in
search where they hold words.

Two things the screen deliberately will not let you do, both for the same
reason — they would silently change what your existing data MEANS:

- **change a field's type.** A number turned into a dropdown leaves every value
  already stored invalid, and nothing could tell you which records had stopped
  making sense. Archive it and add a new one.
- **delete a field.** Archiving keeps the values readable (and erasable when
  somebody asks); deleting would strand them.

### Data quality: duplicates and imports

**Settings → Data quality** lists records that look like the same company or the
same person — a shared adószám is certain, a shared domain is strong, a similar
name is a suggestion — and every import that has run.

**Merging** shows you both records field by field and lets you pick a side for
each before anything moves. The losing record is kept as a tombstone, so old
links still work, and the whole merge can be undone for **30 days**.

**Imports** are undoable for **7 days**. The rollback removes what the import
created and puts back what it changed — and it will REFUSE, naming the records,
if somebody has worked on them since. That refusal is the feature: a rollback
that quietly discards a colleague's correction is a second import, not an undo.

Rolling an import back deletes leads, so it is Owner-only, the same rule as
deleting a lead by hand.

### Automation

**Settings → Automation.** Rules of the form *when* something happens, *if* it
looks a certain way, *then* do this. Twenty per workspace, Owner-only, each with
an on/off switch and a run log.

The one thing worth knowing before writing a rule: **the email action prepares a
DRAFT and stops.** It writes the message onto the lead and waits for a person to
open it, read it and send it. There is no setting that makes it send, and there
is no code path that would — that guarantee is the same one that governs every
other message this system touches.

The run log records **every** evaluation, including the times a rule considered
an event and decided not to act. That is deliberate: the question people
actually ask is "why did my rule *not* fire?", and a log of successes cannot
answer it.

A rule cannot trigger itself, and no more than three rules run in a chain from
one original event. Two rules that trigger each other are stopped by the second
limit, not the first.

### Sessions, and getting signed out less

A session now lasts **30 days**, or **7 days without use** — whichever comes
first. The old behaviour signed you out mid-week; the idle limit is the part
that actually protects a laptop left in a drawer.

**Settings → security** lists your signed-in devices by something you can
recognise ("Chrome on macOS"), highlights the one you are using, and lets you
revoke any of the others individually. A sign-in on your account raises a
notification to you and to nobody else.

Five failed sign-ins lock the account, and each consecutive lock waits longer —
fifteen minutes, then thirty, an hour, four hours, a day — resetting the moment
somebody gets in. Every lockout is on the audit log.

---

## Quick reference

| Task | Where |
|---|---|
| Change your password / 2FA | Settings → security |
| Sign out other devices | Settings → security |
| Grant a capability | Settings → users & grants |
| Add a person | Settings → workspace → add member |
| New workspace | Settings → workspaces → create workspace |
| Edit a template | Templates → pick type + language → save → activate |
| Change AI cap | Settings → AI budget |
| Add your own field | Settings → Fields |
| Merge two duplicates | Settings → Data quality → Compare… |
| Undo a merge (30 days) | Settings → Data quality → recent merges → Undo |
| Roll an import back (7 days) | Settings → Data quality → imports → Roll back |
| Write an automation rule | Settings → Automation → New rule |
| See why a rule did not fire | Settings → Automation → show run log |
| Revoke one device | Settings → security → Revoke |
| Convert a lead to a deal | open the lead → Deals → Convert to deal |
| Change a deal's value | Deals → click the amount on the card |
| Read the forecast | Analytics → Forecast |
| Set the commit threshold | Analytics → Forecast → Commit threshold |
| Everything by keyboard | ⌘K, or `?` for the full map |
| See AI spend | Analytics → AI usage |
| Draft outreach | Outreach → pick a lead → ✦ Draft with Claude |
| Erase a lead | Settings → Data & privacy → Erase lead data |
| Run an export | Settings → Data & privacy → Run export |
| Check backups | `ls -lht /var/backups/ventureos/` |
| Restore a backup | [`DEPLOY.md`](DEPLOY.md) → Troubleshooting §4 |
| Run the fast checks | `npm run typecheck && npm run lint && npm test` |
| Run the browser suite | `npx playwright test` (see §8) |

### Audited actions

These are permanently recorded with actor and timestamp:

- grant changes
- data exports
- lead erasures
- DRAFT watermark removal (document finalization)
- invoice submissions to Számlázz.hu
- password changes, 2FA enable/disable, and session revocations (bulk and single)
- account lockouts after repeated failed sign-ins
- adding, editing and archiving a custom field
- merging two records, and undoing a merge
- running an import, and rolling one back
- creating, editing, enabling, disabling and deleting an automation rule
- every undo, alongside the action it reversed
- changing the forecast's commit threshold

The audit log cannot be edited from the UI.
