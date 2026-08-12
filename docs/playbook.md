# Claude Code Playbook — Venture OS Lite
### Saját szerveres (self-hosted) változat · MySQL vagy Postgres · kezdőbarát

---

## A) Claude Code alapok — ha még sosem nyitottad meg

**Mi ez:** Claude a termináljában — látja a repót, fájlokat ír/módosít, futtatja a parancsokat, tesztel, committol. Te promptokat adsz neki, ő dolgozik, te jóváhagysz.

**Telepítés (a saját gépeden, nem a szerveren):**
1. Kell Node.js 18+ (`node -v` mutatja; ha nincs: nodejs.org).
2. Terminál megnyitása: Windowson a **PowerShell** vagy a **Windows Terminal** (Start menü → "terminal"), Macen a **Terminal** app.
3. Telepítés és belépés:
```bash
npm install -g @anthropic-ai/claude-code
claude
```
Első indításkor böngészőben belépteti a Claude-fiókodat (Pro/Max előfizetés vagy API-kulcs kell). *A pontos telepítési parancs és a díjszabás változhat — ha a fenti nem megy, a docs.claude.com „Claude Code" oldala az irányadó.*

**A napi kezelés, amit tudni kell:**

| Mit akarsz | Hogyan |
|---|---|
| Elindítani a projektben | `cd venture-os` majd `claude` |
| Promptot adni | Simán begépeled/beilleszted, Enter |
| Megszakítani, amit épp csinál | `Esc` |
| Új témát kezdeni (kontextus ürítése) | `/clear` |
| Hosszú session tömörítése | `/compact` |
| Fájlra hivatkozni a promptban | `@docs/spec.md` formában |
| Jóváhagyás fájlírásnál/parancsnál | Megkérdezi; `Shift+Tab`-bal auto-accept módra váltasz (csak ha már bízol benne) |
| Tervezés kódolás nélkül | Kérd: "plan first, don't write code yet" |
| Kilépés | `/exit` vagy `Ctrl+C` kétszer |

**Git — nem kell külön megtanulnod.** Minden elfogadott lépés után csak írd be neki: `commit this with a proper message`. Ha valamit elrontott és vissza akarsz állni: `revert the last commit`. A GitHubra töltést is rá lehet bízni (`create a private GitHub repo and push` — ehhez egyszer kelleni fog a `gh auth login`).

**Az aranyszabály:** egy prompt = egy feladat = egy commit. Minden lépés után nézd meg böngészőben (`npm run dev` → http://localhost:3000), és csak akkor jön a következő prompt, ha az előző jó. Ha nem jó: írd le konkrétan, mit látsz és mit vártál.

---

## B) Miért nem Supabase, és mit választasz helyette

A Supabase csak menedzselt Postgres volt + kész auth. Saját szerveren mindkettő kiváltható, egy döntést viszont meg kell hoznod:

- **Postgres Dockerben (javasolt):** ugyanúgy egy konténer a szervereden, mint a MySQL, de van benne **Row-Level Security** — a workspace-ek szétválasztását maga az adatbázis kényszeríti ki, az app-hibák sem tudják átlépni.
- **MySQL:** ha ragaszkodsz hozzá (pl. már fut a szerveren), működik — a szigetelést ilyenkor egy kötelező Prisma tenant-guard adja app-szinten, teszttel bizonyítva. Egy fokkal gyengébb garancia, de vállalható.

A választásod egyetlen env-változó: `DB_FLAVOR=postgres` vagy `DB_FLAVOR=mysql`. A promptok mindkettőt kezelik.

---

## C) Előkészítés (Claude Code indítása ELŐTT — kb. 45 perc)

Fiókok, kulcsok — ezt neked kell:
1. **Google Cloud** — *Places API (New)* + *PageSpeed Insights API* bekapcsolása, API-kulcs, havi $30 budget alert.
2. **Anthropic API-kulcs** — külön kulcs ennek a projektnek.
3. **Mailgun** — EU régió, subdomain (pl. `mail.ventureco.group`), a DNS-rekordokat állítsd be most (átfutási idő miatt); Phase 3-ig ráér hitelesülnie.
4. **Szerver — Vultr:**
   - **Régió:** Frankfurt vagy Amszterdam (EU — GDPR miatt maradjon EU-ban).
   - **Típus/méret:** Cloud Compute → **2 vCPU / 4 GB RAM / 80 GB NVMe** (~$20–24/hó). A 4 GB nem luxus: a Playwright-worker (audit + PDF renderelés) memóriaigényes — 2 GB-on rendszeresen elhalna. Az árak változnak, ellenőrizd rendeléskor.
   - **OS:** Ubuntu 24.04 LTS.
   - **Rendeléskor pipáld:** *Auto Backups* (+20%, megéri — a saját nightly backup mellé második védvonal), *SSH key* (generálj a gépeden: `ssh-keygen -t ed25519`, a `.pub` tartalmát adod meg — jelszavas SSH-t ne használj).
   - **Rendelés után:** a Vultr felületén állíts be Firewall Group-ot: bejövő csak 22 (SSH), 80 és 443 (web); majd `ssh root@<szerver-ip>` és `curl -fsSL https://get.docker.com | sh`.
   - **Domain:** az aldomain (pl. `os.ventureco.group`) A-rekordja a Vultr-instance IP-jére. A Caddy ettől kezdve automatikusan intézi a HTTPS-tanúsítványt.
   - *Fejleszteni a saját gépeden fogsz, a szerverre csak a P1.8-nál deployolsz először.*

Repo a saját gépeden:
```bash
mkdir venture-os && cd venture-os && git init
mkdir docs
# másold be:
#   CLAUDE.md            → a repo gyökerébe
#   docs/spec.md         → a 2_VentureOS_Software_Specification.md
#   docs/plan.md         → a 3_VentureOS_UIUX_and_Development_Plan.md
#   docs/prototype.html  → a VentureOS_UI_Prototype.html
claude
```
Az `.env` fájlt majd az első prompt hozza létre sablonból — a kulcsokat te írod bele, Claude-nak soha ne másold be őket a chatbe.

---

## D) Phase 1 — Alap + core loop

**P1.1 — Scaffold + Docker**
```
Read docs/spec.md and docs/plan.md. Scaffold per CLAUDE.md: Next.js 15 + TS strict + Tailwind, Prisma, vitest + Playwright. Create docker-compose.yml with services app, db (honor DB_FLAVOR=postgres|mysql from .env — default postgres), redis, worker (Playwright-capable image), caddy with automatic HTTPS, and a /data/files volume. Provide .env.example with every variable from CLAUDE.md and a README section "local dev": docker compose up db redis, then npm run dev. Set up the design tokens from docs/prototype.html as Tailwind theme values and load Bricolage Grotesque + Inter. Placeholder home page rendering the empty app shell with correct canvas and fonts. Verify npm run dev, typecheck and lint pass.
```
*(Utána: másold ki az `.env.example`-t `.env`-be, írd be a kulcsokat és a DB_FLAVOR-t, majd `docker compose up -d db redis`.)*

**P1.2 — Adatmodell + tenancy (a legfontosabb prompt az egészben)**
```
Implement the full Prisma schema from docs/spec.md §8 (v1.0 + v1.1 entities), every business table with workspace_id, portable across postgres and mysql (no Postgres-only types). Build the mandatory Prisma tenant-guard client extension: all business-table queries auto-scoped to the session workspace, raw queries on business tables forbidden by lint rule. If DB_FLAVOR=postgres, additionally generate RLS policies keyed to workspace membership. Seed script: one workspace (Venture CO Group), users Tamas (Owner) and Fanni (BDR), default ICP config and targets. Write the isolation test proving a user with membership only in workspace B cannot read workspace A rows — through the guarded client on mysql, and through both guard and RLS on postgres. Do not proceed past a red isolation test.
```

**P1.3 — Auth + shell**
```
Implement Auth.js credentials auth per CLAUDE.md: bcrypt passwords, TOTP 2FA with QR enrollment, DB sessions, login rate limiting, protected routes. Build the app shell exactly per docs/prototype.html: sidebar with workspace switcher and Claude budget meter, topbar with the account dropdown (profile, settings, password & security with 2FA management, workspace list, log out), bottom tab bar under 700px. Wire the menu and switcher to real session/membership data.
```

**P1.4 — Claude budget middleware**
```
Build src/lib/ai: a single callClaude() wrapper routing to sonnet or haiku per use case, zod-validated JSON outputs with one repair-retry, Anthropic prompt caching for static system content, every call logged to ClaudeUsage with cost, per-workspace daily USD cap enforced (typed BudgetExceeded error). Unit-test budget math and cap rejection. No UI yet. Verify current model names against docs.claude.com.
```

**P1.5 — Lead capture ×3 + Lead Engine**
```
Build the Lead Engine per spec §4.2–4.3: manual lead form, LinkedIn paste capture, CSV import with column mapping and dedupe preview. Claude research run (sonnet): streaming lead card in the right rail exactly like docs/prototype.html, structured output (company, person, signals, pains, hook, ICP score breakdown), score override with audit logging. Enforce the score gate server-side: leads under the workspace threshold cannot transition to Contacted. Tests: scoring math, gate enforcement, dedupe.
```

**P1.6 — Pipeline**
```
Build the pipeline kanban per spec §4.5 and the prototype: stages, desktop drag & drop, swipeable columns + "Move to…" sheet on mobile, days-in-stage, Not now (wake-up date) and Disqualified (required reason) lanes. Stage transitions create Activity records. BullMQ jobs: FU1 task +2-3d after Accepted, FU2 +7-10d, auto Not now (+6 months) after FU2 without reply, daily wake-up surfacing. Playwright test for capture→score→gate→stage.
```

**P1.7 — Outreach Studio + Dashboard**
```
Build Outreach Studio per spec §4.6: sequence view (connection ≤300 chars live counter, FU1, FU2), Claude draft-from-hook and critique (highlights, never rewrites), human-edit guardrail before Sent, "Copy & open LinkedIn" confirm flow. Then the Dashboard per §4.1: Today Queue from due tasks, KPI cards vs targets, pipeline strip, daily insight placeholder. Verify the whole daily loop at 390px width.
```

**P1.8 — Első deploy a szerverre (Vultr)**
```
Prepare production deployment for a Vultr Ubuntu 24.04 instance (2 vCPU / 4 GB): multi-stage Dockerfile, docker-compose.prod.yml (app, db postgres 16 with a named volume, redis, worker with Playwright deps, caddy with my domain from .env), DB migration on boot, memory limits per service sized for 4 GB total, nightly backup script (pg_dump + /data/files, 14-day rotation, optionally pushed to Vultr Object Storage if configured), and a DEPLOY.md that walks a beginner through: SSH to the server, cloning the repo, filling .env, docker compose -f docker-compose.prod.yml up -d, checking logs with docker compose logs -f, and updating later with git pull + compose up -d --build. Assume Docker is already installed and ports 22/80/443 are open.
```
*(Ez után SSH-zol a Vultr-szerverre, követed a DEPLOY.md-t, és él az app a domain-eden HTTPS-sel.)*

→ **Itt állj meg, és használjátok egy hétig Fannival.** A Phase 2 promptjait csak azután add ki.

---

## E) Phase 2 — Prospector, Auditor, telefon

- **P2.1 — Prospector:** `Build the Prospector per spec §4.3: Google Places Text Search + Details, pre-run cost estimate, 30-day caching keyed on query+location, saved searches, website-presence flags (none / facebook-only / has), "Add as lead" with dedupe, optional batched Haiku classification behind a button with a credit badge. Match the prototype's Prospector screen.`
- **P2.2 — Website Auditor:** `Build the audit worker per spec §4.4 as a BullMQ job in the worker service: Playwright checks (HTTPS, viewport, meta, H1, alt coverage, sitemap/robots, copyright year, contact/booking presence, cookie banner, page weight), PageSpeed API scores, screenshots to /data/files, rule-based 0-100 score and verdict thresholds from Settings, 30-day cache. Flags attach to leads as trigger signals feeding ICP score. Optional Haiku pitch summary behind a toggle, off by default. UI per the prototype's Site Audit screen; progressive results within 30s.`
- **P2.3 — Audit PDF + share page:** `Build the branded audit PDF via the headless-Chrome pipeline (Venture letterhead from the tokens) and the public audit share pages per spec: unique slug, unlisted, 60-day expiry, open tracking to the lead timeline. Prospect-facing — match the "public pages" aesthetic in the prototype, no product chrome.`
- **P2.4 — Cégjegyzék + dedupe:** `Implement registry enrichment per spec §4.19 behind a provider adapter (OptenProvider stub + MockProvider for dev): lookup by name/tax id, enrichment on Company, adószám as dedupe key blocking duplicates, liquidation warning chips on lead and quote screens. Tests for dedupe and the adapter contract.`
- **P2.5 — Hívásnapló:** `Build Calls per spec §4.17 and the prototype's Calls screen: one-thumb mobile log sheet (outcome buttons, callback quick-chips, note), callback tasks in Today Queue at the right time with PWA notification, due-callbacks list, calls as Activity records.`

## F) Phase 3 — Dokumentumok + email

- **P3.1 — Template Editor:** `Build the Template Editor per spec §4.10: editor with {{variable}} autocompletion, live preview with sample data, HU/EN variants, versioning (documents pin their template version and re-render identically), empty-variable errors blocking finalization, per-workspace sets. Seed Hungarian base templates for quote/contract/certificate/email with DRAFT watermark and legal-review footer built in.`
- **P3.2 — Grants UI + árajánlat:** `Build the Settings grants UI (per-user per-workspace, audit-logged) and the Quote generator per spec §4.9: client picker from pipeline, line items with +15% pass-through and +30% production presets, integer HUF math with VAT, validity date, live totals, PDF with DRAFT watermark, Owner-gated audited finalization. Server-side grant checks on every documents.* mutation. Tests: totals math, grant denial.`
- **P3.3 — Szerződés + tig + lánc:** `Build contract and completion-certificate generators and the document chain per spec: quote → contract (pre-filled from accepted quote + registry party data) → certificate (from contract scope items), chain stepper on documents and pipeline cards. No AI in the render path; the optional Claude scope-paragraph assist is a separate labeled button.`
- **P3.4 — Mailgun:** `Integrate Mailgun EU per spec §4.11: transactional composer sending documents with PDF attached, per-workspace sending identity, delivery/open webhooks to the lead timeline, suppression handling, failed sends into Today Queue, documents.send grant enforcement, Friday-report delivery path.`
- **P3.5 — Elfogadó oldal:** `Build the quote acceptance page per spec: unlisted public URL rendering the branded quote (match the prototype), Accept with name + company + checkbox, immutable QuoteAcceptance record (timestamp, IP, user agent), status flip + Owner notification + contract unlock. Implement Accept behind an AcceptanceProvider interface for the future in-house e-signature. State on the page that this records assent and is not a qualified e-signature.`

## G) Phase 4 — Intelligencia, meetingek, riporting (sorrendben, egyenként)

**P4.1 — Inbox**
```
Build the Inbox per spec §4.7 and the prototype's Inbox screen: threaded reply logging per lead (manual paste; leave an extension-capture hook), thread list with unread states, conversation view. On each logged reply run a Haiku analysis (through callClaude, budget-checked): intent chip (interested / objection / not now / referral), detected objection, and two suggested next questions drawn from the qualification set — suggestions are one-click inserts into the composer, never auto-sent. Qualification checklist (authority, history, budget, timeline) docked on the thread; the Qualified stage transition unlocks server-side only at 3 of 4 answered. Price/proposal/contract mentions auto-flag the thread, notify the Owner, and lock money-talk drafting per spec. Mobile-first layout — this is the primary on-the-go module. Tests: qualification unlock rule, escalation flagging.
```

**P4.2 — Meetings + Google Calendar + brief**
```
Build Meetings per spec §4.8: Google Calendar OAuth integration (server-side tokens per user), booking creates the event on Tamas's calendar with lead context attached. One-click meeting brief: a Sonnet call compiling company profile, person background, audit findings, hypothesized pain, full conversation history and 5 discovery questions into an editable 1-page brief, exported as branded PDF through the existing pipeline and attached to the calendar event. Entering the Meeting booked stage triggers brief generation automatically (this is the one permitted non-manual Claude trigger — it is bounded to one call per booking). Post-meeting outcome logging screen as the handoff point. Tests: brief generation is idempotent per meeting, calendar failure paths land in Today Queue.
```

**P4.3 — Public booking page**
```
Build the public booking page per spec §4.21 and the prototype's Public Pages view: meet.{domain}/{host-slug}, reading free/busy from the host's Google Calendar, configurable meeting types, slot length and buffers from Settings, Europe/Budapest timezone handling with visitor timezone display. Booking creates the Meeting record, triggers the brief, sends Mailgun confirmations to both sides, and drops the event on the calendar. Match the prototype exactly: day strip, slot grid, three fields, Venture letterhead, no product chrome. Rate-limit and bot-protect the endpoint (honeypot + timing check, no third-party CAPTCHA). Playwright test: book a slot end-to-end against a mocked calendar.
```

**P4.4 — Win/loss**
```
Build win/loss tracking per spec §4.20: closing a lead from Handed off requires an outcome dialog — result (won / lost / postponed), required reason from the taxonomy (price, timing, competitor, no budget, no response, other+note), deal value in integer HUF, optional competitor name. DealOutcome model per the data model. Analytics gains a "what closes" panel beside the funnel: close rate and revenue by hook, signal, source, segment and audit-score band. Add a quarterly win/loss digest job (BullMQ, Haiku, aggregates only) delivered to the Owner via Mailgun. Tests: outcome required on close, panel aggregation math.
```

**P4.5 — Referral ledger**
```
Build the referral module per spec §4.18 on the Phase-1 data model: referrer management (person or company, linkable to an existing client company), lead source + referrer assignment on capture and editable on the lead, and the Referrer ledger view — who referred what, current stage of each referred lead, and attributed revenue pulled from DealOutcome values through the referral chain. Surface top referrers in analytics. Keep it simple: a ledger, not a partner program.
```

**P4.6 — Signal Engine**
```
Build the Signal Engine per spec §4.13: a weekly BullMQ job that aggregates the week's activity data (frames, hooks, signals, segments, send-times, sources) joined with acceptance, reply AND win/loss outcomes, then makes one Sonnet call on the aggregates producing: (1) a weekly insight digest for the Dashboard insight card, (2) concrete proposals (frame promotion, score-weight change) each with evidence and n. Proposals require n>=20 and go to an approval queue — Owner approves or rejects in Settings; approval versions the frame library or updates score weights, nothing self-modifies. Wire the Dashboard daily insight card to the latest digest (daily Haiku rotation over the weekly digest content, one call). Tests: n-threshold gating, approval-only mutation.
```

**P4.7 — Analytics + péntek riport + hétfői digest**
```
Build Analytics per spec §4.14 and the prototype's Analytics screen: funnel with per-step conversion, weekly trends vs the 30/60/90 milestone overlay, per-source performance (prospector / linkedin / manual / referral / cold_email), audit-to-meeting conversion, document-chain metrics (quote acceptance rate, days quote→signed). Friday 16:00 job: auto-generate the weekly report (numbers deterministic; one Haiku call for the "what worked" commentary), in-app view with Fanni's comment field, branded PDF export, Mailgun delivery to the Owner. Monday 07:30 job: per-user per-workspace digest email (Today Queue preview, due callbacks, overdue follow-ups, pipeline deltas, pending approvals, top referrer) — one Haiku call per digest on aggregates. Tests: report renders with zero manual steps, digest respects workspace scoping.
```

**P4.8 — GDPR tooling**
```
Build the GDPR tooling per spec §10: lead erasure workflow — hard delete with full cascade over derived data (activities, messages, calls, audit results, documents metadata handling per retention policy) completing within 72h via a queued job, audit-logged; 12-month inactivity anonymization job (BullMQ, monthly) that pseudonymizes person fields while keeping aggregate stats; per-workspace retention settings in admin; full data export (CSV bundle) behind exports.run grant. Document the backup-erasure policy in DEPLOY.md (backups expire within the 14-day rotation, satisfying erasure). Tests: cascade completeness (no orphan rows referencing an erased lead), anonymization idempotency.
```

**P4.9 — Második workspace + izoláció-bizonyítás**
```
Build workspace provisioning per spec §7: Owner creates a new workspace from Settings (name, legal name, brand color/logo, Mailgun identity placeholder, Claude budget, retention), assigns members with role + grants. Workspace switcher and account-menu workspace list go fully dynamic. Then write the definitive isolation Playwright test for spec acceptance criterion 8: create workspace B and a user with membership only in B, and prove through the UI and the API that zero workspace-A rows are readable or mutable — including documents, files and public-page slugs. Run the full test suite, typecheck and lint, then verify every Phase 4 exit criterion from docs/plan.md and report pass/fail per criterion.
```

→ **Phase 4 vége: itt már minden v1.1-es átvételi kritériumnak zöldnek kell lennie a 14-es és 20-as kivételével (azok Phase 5).**

## H) Phase 5 — Cold email + Számlázz.hu

**P5.1 — Cold email (compliance-gated)**
```
Build the Cold Email module per spec §4.16 behind a per-workspace feature flag that is OFF by default. Activation requires a recorded counsel sign-off in Settings (who approved, date, scope note) — without that record the module UI shows the locked state from the prototype's Campaigns screen and every send path is blocked server-side. Campaign builder: audience from a saved lead segment with live recipient-count preview, 2-3 step sequence with stop-on-reply, personalization slots filled from audit and registry DATA (one Sonnet call drafts the frame per campaign — never per recipient), plain-text-first templates, mandatory unsubscribe footer injected on every step. Sending: dedicated Mailgun domain from workspace config (separate from transactional), warm-up ramp schedule, per-day send caps, suppression list shared across all campaigns with instant suppress on unsubscribe or objection, bounce-rate circuit breaker that auto-pauses a campaign above threshold. Inbound: Mailgun routes deliver replies into the Inbox module attached to the right lead, entering the same qualification flow. Domain-health strip in the UI (domain, warm-up week, bounce rate) per the prototype. Tests: gate blocks sending without sign-off record, unsubscribe suppresses across campaigns instantly, circuit breaker pauses, frame drafted once per campaign.
```

**P5.2 — Számlázz.hu integráció**
```
Build the Számlázz.hu Számla Agent integration per spec §4.23: from an acknowledged completion certificate, a "Prepare invoice" action composes the invoice payload — partner data from registry enrichment, line items from the quote/contract chain, integer HUF math with VAT — and shows a diff-style confirmation screen (exactly what will be submitted) before anything leaves the system; submission only on explicit confirm, behind the documents.send grant, audit-logged. Submit via the Számla Agent XML API using the per-workspace agent key; store the returned invoice number and PDF link on the Invoice record linked into the document chain; poll payment status on a daily job and reflect it on the pipeline card. Failures (validation, network, rejected payload) land in Today Queue with the raw response attached. Read the current Számla Agent API documentation before implementing and note any assumptions in code comments. Tests: payload composition from the chain, confirm-gate (no submit without confirmation), failure-to-queue path.
```

**P5.3 — Zárás (definition of done + domain-audit + production deploy)**
```
Closing task, four parts.

1) VERIFICATION. Run the full test suite, typecheck and lint. Verify every acceptance criterion in docs/spec.md §11 (1-20) and report pass/fail per criterion with evidence. Audit the entire codebase against CLAUDE.md hard rules and report violations.

2) DOMAIN AUDIT. Verify the entire codebase and configuration against the Domain layout section of CLAUDE.md: the app serves at the ROOT of ventureco.agency; public pages resolve on audit.ventureco.agency, quote.ventureco.agency and meet.ventureco.agency; transactional mail sends only via mg.ventureco.group; cold mail sends only via cold.ventureco.agency and can never fall back to the transactional domain (enforce in code, not just config). Grep for any hardcoded domain, localhost, ventureco.group app-URLs or leftover example hosts — every host must come from environment variables. Verify generated links (audit shares, quote acceptance, booking, email links, PWA manifest, calendar invites) render with the correct public domains. Report every finding and fix it.

3) PRODUCTION DOCKER DEPLOY. Produce the final production deployment: multi-stage Dockerfile; docker-compose.prod.yml with services app, db (postgres 16, named volume), redis, worker (Playwright-capable), caddy — Caddyfile serving ventureco.agency (root, with www redirect) plus the three public subdomains with automatic HTTPS; memory limits sized for a 4 GB Vultr instance; migrations run on boot; healthchecks per service; nightly backup script (pg_dump + /data/files, 14-day rotation). Verify docker compose -f docker-compose.prod.yml config passes and the app builds cleanly.

3b) ENV AUDIT. Review .env.production.example as its own deliverable: it must be COMPLETE (cross-check against every process.env reference in the codebase — no variable may be read in code that is missing from the example, and no dead variables may remain in the example) and CORRECT per the Domain layout in CLAUDE.md. In particular it must contain TWO distinct Mailgun configurations — transactional (MAILGUN_DOMAIN=mg.ventureco.group) and cold (MAILGUN_COLD_DOMAIN=cold.ventureco.agency) with their own API keys/credentials — and the app must fail fast at boot with a clear error if the two domains are configured to the same value. Also verify: APP_URL and the three public-page URLs point to the ventureco.agency layout, DB_FLAVOR=postgres, EU-region flags set (MAILGUN_EU=true), every secret-type variable has a placeholder (never a real value), and each line carries a one-line explanation of what it is and where to obtain it. Add a boot-time env validation (zod schema) that checks presence and format of all required variables and prints exactly which ones are missing or invalid.

4) INSTALL GUIDE. Write docs/DEPLOY.md as a beginner-proof, step-by-step install guide in Hungarian: Vultr instance requirements and firewall (22/80/443); DNS records to create (root A, www, audit, quote, meet → server IP) and how to check propagation; installing Docker on Ubuntu 24.04; cloning the repo; filling .env from the example (where each key comes from: Anthropic, Google Cloud, Mailgun mg + cold domains); first start with docker compose -f docker-compose.prod.yml up -d; verifying it works (compose ps, logs, opening each domain); creating the first Owner user; setting up the backup cron; and the update procedure (git pull, compose up -d --build) plus a short troubleshooting section (port conflicts, certificate issues, container restart loops, how to restore a backup).

Finally produce docs/HANDBOOK.md: operator guide for the Owner covering user & grant management, workspace provisioning, template editing, budget caps, backup verification, and the GDPR erasure procedure.
```

---

## I) Ha valami elakad — parancsminták

- Hibánál: `The dev server throws: <teljes hibaüzenet beillesztve>. Fix it and explain the root cause in one sentence.`
- Drift ellen: `Re-read CLAUDE.md hard rules 1, 3 and 5 and audit the code you just wrote against them. Fix violations.`
- UI-eltérésnél: `Compare this screen to the same view in docs/prototype.html and list every visual difference, then fix them.`
- Fázis végén: `Run all tests, typecheck and lint. Then verify the Phase N exit criteria from docs/plan.md and report pass/fail per criterion.`
- Ha összezavarodott: `/clear`, majd add ki újra a feladatot egy mondattal több kontextussal.

Két záró figyelmeztetés: a modellnevek és a Claude Code parancsai változhatnak — az első sessionben kérd meg, hogy ellenőrizze őket a docs.claude.com ellen. És a P1.2 izolációs tesztje szent: amíg nem zöld, semmi nem épülhet rá — MySQL-en ez az egyetlen fal a cégeid adatai között.
