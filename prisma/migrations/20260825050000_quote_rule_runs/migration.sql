-- Quote behaviour → suggested next step (playbook-v4 P14/3).
--
-- P8 made a quote page observable: reading sessions, time on the price against
-- time on the scope, whether anyone reached the bottom, when they last looked.
-- Those numbers sat on a panel waiting to be noticed. This table is what turns
-- them into a suggestion at the moment they mean something — and then records
-- whether the suggestion worked.
--
-- The unique key is the once-per-quote-per-rule guarantee: without it a daily
-- sweep would raise the same task every day until somebody signed.
--
-- `accepted_at` is the point of the feature. A rule engine that only counts its
-- own firings tells you which rules are loudest; this one can say which ones
-- were followed by a signature.
-- CreateTable
CREATE TABLE "quote_rule_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "task_id" TEXT,
    "draft_id" TEXT,
    "fired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "quote_rule_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_rule_runs_workspace_id_fired_at_idx" ON "quote_rule_runs"("workspace_id", "fired_at");

-- CreateIndex
CREATE UNIQUE INDEX "quote_rule_runs_document_id_rule_id_key" ON "quote_rule_runs"("document_id", "rule_id");

