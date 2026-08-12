# CLAUDE.md — Venture OS Lite

Internal AI-assisted sales & delivery workspace for Venture CO Group. **Self-hosted on the owner's own server via Docker Compose.** Read `docs/spec.md` (source of truth for features) and `docs/plan.md` (phases) before large tasks. The UI reference is `docs/prototype.html` — match its look exactly.

## What this is
Single workspace for a BDR: find businesses (Google Places prospecting, LinkedIn paste, manual), audit their websites, score against ICP, draft outreach (human sends), manage pipeline/inbox/meetings, generate quotes → contracts → completion certificates, email them via Mailgun, invoice via Számlázz.hu. Multi-workspace (multi-company), RBAC + granular grants. English UI.

## Stack (do not deviate without asking)
- Next.js 15 (App Router) + TypeScript strict + Tailwind
- **Database: `DB_FLAVOR` decides.**
  - `postgres` (recommended): Postgres 16 in Docker; **tenancy enforced with Row-Level Security at the DB level** AND the Prisma tenant guard (belt and braces).
  - `mysql`: MySQL 8 in Docker; no RLS exists, so **tenancy is enforced exclusively by the mandatory Prisma tenant-guard client extension** — every query on business tables is auto-scoped to the session's workspace_id; raw queries on business tables are forbidden; an isolation test must prove it cannot be bypassed.
- ORM: Prisma (schema written to work on both flavors: no Postgres-only column types)
- Auth: **Auth.js (NextAuth) credentials provider** — bcrypt passwords, TOTP 2FA (otplib + QR enrollment), server sessions in DB, rate-limited login
- Jobs/cron: **BullMQ + Redis** (Docker service) for scheduled and background work (follow-up timers, wake-ups, Signal Engine, digests, anonymization)
- Anthropic API server-side only (claude-sonnet-4-6 for writing-quality tasks, claude-haiku-4-5 for classification/summaries) — never expose the key to the client
- Mailgun EU (transactional domain; separate cold-email domain in Phase 5)
- Playwright worker (own Docker service) for website audits + PDF rendering (headless-Chrome print from HTML templates — one pipeline for audits/quotes/contracts/certificates)
- Files (PDFs, screenshots): local volume `/data/files`, served through authenticated routes; included in backups
- Deployment: Docker Compose (`app`, `db`, `redis`, `worker`, `caddy`) — **Caddy** reverse proxy with automatic HTTPS. Nightly DB + files backup script to a second location.

## Hard rules
1. **Tenancy first.** Every business table has `workspace_id`. The Prisma tenant guard is mandatory on both DB flavors; on Postgres, RLS policies as well. Never write a query that could cross workspaces; never bypass the guarded client.
2. **No automated outreach.** The system never sends LinkedIn messages or unsolicited emails on its own. Transactional email sends only on explicit user action. Cold email module ships disabled behind a counsel-sign-off gate.
3. **Claude is frugal.** No AI calls on page load or save. Manual triggers only. Haiku by default; Sonnet only for research cards, outreach drafts, meeting briefs, weekly analysis. Cache research/audit/classification results. Every call goes through the budget middleware (per-workspace daily USD cap) and is logged to `ClaudeUsage`.
4. **No AI in legal-document rendering.** Quotes/contracts/certificates render from versioned templates + variables only. Every legal doc carries a DRAFT watermark until an Owner finalizes it (audited action).
5. **Score gate.** Leads with ICP score < threshold (default 3) cannot enter the Contacted stage. Enforce in the API layer, not just UI.
6. **Human-edit guardrail.** A Claude-drafted outreach message cannot be marked Sent without human modification.
7. **Grants over roles.** `documents.*` and `templates.*` capabilities are grants checked per user per workspace; default Owner-only. Check grants server-side on every mutation.
8. **Audit log** every grant change, export, delete, watermark removal, invoice submission.
9. **GDPR:** data stays on the EU server, hard-delete lead erasure within 72h (cascade derived data), 12-month inactivity anonymization job, backups honor erasure.

## Design system (match docs/prototype.html)
- Canvas `#00051D`; panels `rgba(239,241,248,0.04)` with 1px `rgba(239,241,248,0.09)` borders; text `#EFF1F8`; muted `#858CAE`; accent `#7427C6`; gradient `#310B59 → #7427C6`
- Fonts: Bricolage Grotesque (display, lowercase, weights 300/700/800) + Inter (UI); tabular-nums for data
- Primary CTA: gradient border + purple glow. The Claude rail is the only glowing element per screen.
- Responsive: <700px → bottom tab bar, swipeable kanban, 44px touch targets; PWA manifest.
- Logo: white "venture" (800) + light suffix; never recolor.

## Conventions
- `src/app` routes, `src/modules/<domain>` for business logic, `src/lib` shared, `prisma/schema.prisma` single schema
- All Claude prompts live in `src/lib/ai/prompts/` as versioned TS constants; JSON outputs validated with zod, one repair-retry
- Server Actions or route handlers with zod input validation; no client-side secrets
- Tests: vitest for units (scoring, totals math, gates, tenant guard), Playwright for the 3 critical flows (capture→score→gate, quote→pdf→send, workspace isolation)
- Money: store HUF as integer forints, VAT computed, never floats
- Commit per task, conventional commits, migration per schema change

## Environment (.env — never commit)
DB_FLAVOR=postgres|mysql, DATABASE_URL, REDIS_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY, PAGESPEED_API_KEY, MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_EU=true, APP_URL, FILES_DIR=/data/files

## Definition of done for any task
Type-checks clean, lint clean, relevant tests pass, works at 390px width, no cross-workspace data access possible (guard + isolation test), no unbudgeted Claude call introduced, runs inside `docker compose up`.

## Domain layout (owner decision)
- App at the ROOT of ventureco.agency; public pages on subdomains: audit.ventureco.agency, quote.ventureco.agency, meet.ventureco.agency — all A-records to the same server, routed by Caddy.
- Transactional Mailgun domain: mg.ventureco.group (already verified). Cold-email Mailgun domain: cold.ventureco.agency — fully separate reputation; never send cold mail from the transactional domain.
- Cold guardrails remain strict: daily cap starting 10/day, recipient quality gate (audit score or verified signal), plain-text-first, instant suppression, circuit breaker on bounce >3% or any complaint.
