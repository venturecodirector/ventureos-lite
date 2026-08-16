import { Worker } from "bullmq";
import { checkEnvAtBoot } from "../lib/env";
import {
  getRedisConnection,
  wakeupsQueue,
  FOLLOWUPS_QUEUE,
  WAKEUPS_QUEUE,
  AUDIT_QUEUE,
  PDF_QUEUE,
  CALLBACKS_QUEUE,
  BRIEFS_QUEUE,
  ERASURE_QUEUE,
  LOGS_QUEUE,
} from "../lib/queue";
import { processFollowup, processWakeupSweep } from "../modules/pipeline/jobs";
import {
  processAudit,
  processPdfRender,
  processAuditWatchSweep,
} from "../modules/audit/jobs";
import { processCallbackDue } from "../modules/calls/jobs";
import { processDocumentPdf } from "../modules/documents/jobs";
import { processAnalyticsPdf } from "../modules/analytics/export-job";
import { processCommissionPdf } from "../modules/revenue/pdf-job";
import { processPublicAuditReport } from "../modules/public-audit/report-job";
import { processMeetingBrief } from "../modules/meetings/jobs";
import { processQuarterlyWinLoss } from "../modules/analytics/digest";
import { processWeeklyReports } from "../modules/analytics/report-job";
import { processMondayDigests } from "../modules/analytics/monday-digest";
import { processLeadErasure } from "../modules/gdpr/jobs";
import { processAnonymizationSweep } from "../modules/gdpr/sweep";
import { processColdSends } from "../modules/campaigns/jobs";
import { processInvoicePolls } from "../modules/invoicing/jobs";
import { processSignalEngine, processDailyInsight } from "../modules/signal/jobs";
import { processKeywordTracking } from "../modules/serp/jobs";
import { processLogUpload, processLogRetention } from "../modules/logs/jobs";
import { processMailSyncSweep } from "../modules/email/jobs";
import {
  processNotificationRetention,
  processTaskDueSweep,
} from "../modules/notifications/jobs";

/**
 * Background worker (BullMQ + Redis). Runs in its own Docker service.
 * Processes follow-up automations and the daily Not-now wake-up sweep.
 */
async function main(): Promise<void> {
  // Same boot gate as the app (src/instrumentation.ts): a misconfigured worker
  // would happily render PDFs with localhost links and send cold mail on the
  // wrong domain, so it must refuse to start instead.
  if (process.env.SKIP_ENV_VALIDATION !== "1") {
    checkEnvAtBoot("worker");
  }

  const connection = getRedisConnection();

  // eslint-disable-next-line no-console
  console.log("[worker] starting — followups, audits, pdfs, callbacks, briefs, wakeups");

  const followupWorker = new Worker(
    FOLLOWUPS_QUEUE,
    async (job) => {
      await processFollowup(job.data);
    },
    { connection },
  );
  followupWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] followup ${job?.id} failed`, err);
  });

  const auditWorker = new Worker(
    AUDIT_QUEUE,
    async (job) => {
      await processAudit(job.data);
    },
    { connection, concurrency: 2 },
  );
  auditWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] audit ${job?.id} failed`, err);
  });

  const pdfWorker = new Worker(
    PDF_QUEUE,
    async (job) => {
      if (job.name === "document-pdf") await processDocumentPdf(job.data);
      else if (job.name === "analytics-pdf") await processAnalyticsPdf(job.data);
      else if (job.name === "commission-pdf") await processCommissionPdf(job.data);
      else if (job.name === "public-audit-report") await processPublicAuditReport(job.data);
      else await processPdfRender(job.data);
    },
    { connection, concurrency: 2 },
  );
  pdfWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] pdf ${job?.id} failed`, err);
  });

  const callbackWorker = new Worker(
    CALLBACKS_QUEUE,
    async (job) => {
      await processCallbackDue(job.data);
    },
    { connection },
  );
  callbackWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] callback ${job?.id} failed`, err);
  });

  const briefWorker = new Worker(
    BRIEFS_QUEUE,
    async (job) => {
      await processMeetingBrief(job.data);
    },
    { connection, concurrency: 2 },
  );
  briefWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] brief ${job?.id} failed`, err);
  });

  const erasureWorker = new Worker(
    ERASURE_QUEUE,
    async (job) => {
      await processLeadErasure(job.data);
    },
    { connection },
  );
  erasureWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] erasure ${job?.id} failed`, err);
  });

  // Log parsing is streamed and can run for minutes on a month of traffic, so
  // it gets its own queue rather than blocking audits (P2/8).
  const logWorker = new Worker(
    LOGS_QUEUE,
    async (job) => {
      await processLogUpload(job.data);
    },
    { connection, concurrency: 1 },
  );
  logWorker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] log upload ${job?.id} failed`, err);
  });

  const wakeupWorker = new Worker(
    WAKEUPS_QUEUE,
    async (job) => {
      if (job.name === "friday-report") {
        const n = await processWeeklyReports();
        // eslint-disable-next-line no-console
        console.log(`[worker] friday report generated for ${n} workspace(s)`);
      } else if (job.name === "monday-digest") {
        const n = await processMondayDigests();
        // eslint-disable-next-line no-console
        console.log(`[worker] monday digest sent to ${n} user(s)`);
      } else if (job.name === "monthly-anonymize") {
        const n = await processAnonymizationSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] anonymized ${n} inactive lead(s)`);
      } else if (job.name === "cold-send") {
        const n = await processColdSends();
        // eslint-disable-next-line no-console
        console.log(`[worker] cold email sent ${n} message(s)`);
      } else if (job.name === "invoice-poll") {
        const n = await processInvoicePolls();
        // eslint-disable-next-line no-console
        console.log(`[worker] invoice poll marked ${n} paid`);
      } else if (job.name === "quarterly-winloss") {
        const n = await processQuarterlyWinLoss();
        // eslint-disable-next-line no-console
        console.log(`[worker] win/loss digest sent for ${n} workspace(s)`);
      } else if (job.name === "signal-weekly") {
        const n = await processSignalEngine();
        // eslint-disable-next-line no-console
        console.log(`[worker] signal engine ran for ${n} workspace(s)`);
      } else if (job.name === "mail-sync") {
        const n = await processMailSyncSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] mail sync stored ${n} message(s)`);
      } else if (job.name === "log-retention") {
        const n = await processLogRetention();
        // eslint-disable-next-line no-console
        console.log(`[worker] purged ${n} raw log upload(s)`);
      } else if (job.name === "keyword-tracking") {
        const n = await processKeywordTracking();
        // eslint-disable-next-line no-console
        console.log(`[worker] keyword tracking checked ${n} position(s)`);
      } else if (job.name === "audit-watch") {
        const n = await processAuditWatchSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] audit watch queued ${n} re-audit(s)`);
      } else if (job.name === "task-due") {
        const n = await processTaskDueSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] task-due sweep notified ${n} task(s)`);
      } else if (job.name === "notification-retention") {
        const n = await processNotificationRetention();
        // eslint-disable-next-line no-console
        console.log(`[worker] purged ${n} expired notification(s)`);
      } else if (job.name === "daily-insight") {
        const n = await processDailyInsight();
        // eslint-disable-next-line no-console
        console.log(`[worker] daily insight refreshed for ${n} workspace(s)`);
      } else {
        const n = await processWakeupSweep();
        // eslint-disable-next-line no-console
        console.log(`[worker] wake-up sweep surfaced ${n} lead(s)`);
      }
    },
    { connection },
  );
  wakeupWorker.on("failed", (_job, err) => {
    // eslint-disable-next-line no-console
    console.error("[worker] wakeup sweep failed", err);
  });

  // Task-due sweep, hourly. The dedupe key carries the day, so an overdue task
  // notifies once a day rather than once an hour (P6/1).
  await wakeupsQueue().add(
    "task-due",
    {},
    { repeat: { pattern: "0 * * * *" }, jobId: "task-due" },
  );
  // Notification retention (90 days) at 03:45, beside the other nightly purges.
  await wakeupsQueue().add(
    "notification-retention",
    {},
    { repeat: { pattern: "45 3 * * *" }, jobId: "notification-retention" },
  );
  // Daily wake-up sweep at 06:00. Idempotent — repeat jobs dedupe by key.
  await wakeupsQueue().add(
    "daily",
    {},
    { repeat: { pattern: "0 6 * * *" }, jobId: "daily-wakeup" },
  );
  // Friday report at 16:00.
  await wakeupsQueue().add(
    "friday-report",
    {},
    { repeat: { pattern: "0 16 * * 5" }, jobId: "friday-report" },
  );
  // Monday per-user digest at 07:30.
  await wakeupsQueue().add(
    "monday-digest",
    {},
    { repeat: { pattern: "30 7 * * 1" }, jobId: "monday-digest" },
  );
  // Monthly inactivity anonymization sweep — 1st of month at 03:00 (spec §10).
  await wakeupsQueue().add(
    "monthly-anonymize",
    {},
    { repeat: { pattern: "0 3 1 * *" }, jobId: "monthly-anonymize" },
  );
  // Daily cold-email send sweep — 09:00, gated + capped (spec §4.16).
  await wakeupsQueue().add(
    "cold-send",
    {},
    { repeat: { pattern: "0 9 * * *" }, jobId: "cold-send" },
  );
  // Daily invoice payment-status poll — 05:00 (spec §4.23).
  await wakeupsQueue().add(
    "invoice-poll",
    {},
    { repeat: { pattern: "0 5 * * *" }, jobId: "invoice-poll" },
  );
  // Quarterly win/loss digest — 08:00 on the 1st of Jan/Apr/Jul/Oct.
  await wakeupsQueue().add(
    "quarterly-winloss",
    {},
    { repeat: { pattern: "0 8 1 1,4,7,10 *" }, jobId: "quarterly-winloss" },
  );
  // Signal Engine — weekly, Monday 07:00 (one Sonnet call/workspace).
  await wakeupsQueue().add(
    "signal-weekly",
    {},
    { repeat: { pattern: "0 7 * * 1" }, jobId: "signal-weekly" },
  );
  // Mailbox sync every two minutes (playbook-v2 P2b). Each pass is bounded and
  // skips mailboxes that need reconnecting, so a stuck account cannot make the
  // sweep run long.
  await wakeupsQueue().add(
    "mail-sync",
    {},
    { repeat: { pattern: "*/2 * * * *" }, jobId: "mail-sync" },
  );
  // Raw access logs are personal data: sweep anything past its 7-day window
  // daily at 03:30, as the backstop for an upload whose job never ran (P2/8).
  await wakeupsQueue().add(
    "log-retention",
    {},
    { repeat: { pattern: "30 3 * * *" }, jobId: "log-retention" },
  );
  // Weekly keyword positions — Tuesday 05:00. Dormant without a provider key,
  // and every query is billed, so this is the one sweep that costs money per
  // row rather than per run (P2/7).
  await wakeupsQueue().add(
    "keyword-tracking",
    {},
    { repeat: { pattern: "0 5 * * 2" }, jobId: "keyword-tracking" },
  );
  // Daily re-audit sweep — 04:00, before the working day, so a worsening
  // signal is on the lead by the time anyone opens the queue (P2/5).
  await wakeupsQueue().add(
    "audit-watch",
    {},
    { repeat: { pattern: "0 4 * * *" }, jobId: "audit-watch" },
  );
  // Daily insight — 06:30, rotates over the weekly digest (one Haiku call/day).
  await wakeupsQueue().add(
    "daily-insight",
    {},
    { repeat: { pattern: "30 6 * * *" }, jobId: "daily-insight" },
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal", err);
  process.exit(1);
});
