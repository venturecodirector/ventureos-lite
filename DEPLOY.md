# Deployment & Data Operations — Venture OS Lite

Self-hosted on the owner's server via Docker Compose (`app`, `db`, `redis`, `worker`, `caddy`).
Caddy terminates TLS with automatic HTTPS. This document covers backups and how they interact
with GDPR erasure (spec §10).

## Backups

- **What:** nightly logical dump of the Postgres database **plus** the `/data/files` volume
  (generated PDFs, screenshots, export bundles, meeting briefs).
- **Where:** written to a second location (separate disk/host/offsite bucket) so a single-machine
  loss does not lose the backups.
- **Cadence:** nightly, unattended (cron on the host or a `backup` compose service).

### Rotation — 14-day window

Backups are retained on a **rolling 14-day rotation**: each nightly backup is kept for 14 days,
after which it is **permanently deleted** (the offsite copy too). At any time at most the last 14
daily snapshots exist. The rotation window is surfaced in the app under
**Settings → Data & privacy → Retention** (`backupRotationDays`, default 14) so operators keep the
documented value and the deployed cron in sync.

> Operationally: the backup script must **delete** expired archives, not merely stop referencing
> them. Verify with a periodic restore drill that snapshots older than 14 days are absent.

## Backup–erasure policy (GDPR, spec §10)

Right-to-erasure runs against the **live database** immediately (queued job, completes well within
the 72-hour SLA, cascading all derived data and audit-logging completion). Erasure cannot rewrite
history inside already-written backup archives — doing so would corrupt them.

Instead, **erasure is satisfied by backup expiry**: because every backup is destroyed within the
14-day rotation, any personal data captured in a snapshot taken *before* an erasure request is
**gone at most 14 days later**, when that snapshot is deleted. 14 days < the 72-hour live-deletion
SLA plus a safe margin, and comfortably within a reasonable "without undue delay" reading of
Art. 17.

Guarantees this relies on:

1. **Live deletion is real and complete** — `eraseLeadData` hard-deletes the lead and every
   `lead_id`-bearing row (activities, messages, calls, deal outcomes, meetings, email logs, audit
   shares, campaign recipients) and their files; legal documents follow the per-workspace retention
   policy (retained detached, or purged). Proven by the cascade-completeness test.
2. **Backups are never restored selectively into production** to "recover" an erased subject. A full
   restore (disaster recovery) is followed by **re-applying any erasure requests recorded in the
   audit log** since the snapshot, before the system is returned to normal use.
3. **Rotation actually deletes** old archives within 14 days (see above).

If a longer backup window is ever required (e.g. compliance retention of the DB), the erasure
guarantee must be re-derived — either by extending the "re-apply erasures after restore" step to
cover that window, or by encrypting per-subject data with keys that can be destroyed. Lite keeps it
simple with the 14-day rotation.

## Anonymization

A monthly BullMQ job (`monthly-anonymize`, 1st of month 03:00) pseudonymizes leads inactive beyond
the workspace retention window (`anonymizeAfterDays`, default 365). It scrubs person fields and
conversation bodies while keeping the rows so aggregate analytics survive. It is idempotent — safe
to re-run — and, like erasure, its effects propagate into backups via the same 14-day expiry.

## Environment

See `.env.example`. `FILES_DIR` (default `/data/files`) must point at the backed-up volume so
exports and generated documents are included in — and expired by — the rotation.
