-- Audit progress and failure reason.
--
-- The runner advertised three steps ("Queued", "Loading the site in a
-- browser", "Scoring and screenshots") and derived the current one from
-- `status`. But `status` only ever holds queued / running / done / error, so
-- the third step was unreachable: every audit stalled visibly at step 2 of 3
-- and, once the poller's timeout elapsed, simply stopped — no result, no
-- error, no explanation.
--
-- `stage` is the fix, and it is a column of its own rather than a new `status`
-- value because several queries key off `status`'s exact set (the public-audit
-- reuse lookup among them); a mid-flight audit must stay `running` to those.
--
-- `error_message` gives a failed run something to say. Before it, "failed" was
-- the entire report.
-- AlterTable
ALTER TABLE "audit_results" ADD COLUMN "stage" TEXT;
ALTER TABLE "audit_results" ADD COLUMN "error_message" TEXT;
