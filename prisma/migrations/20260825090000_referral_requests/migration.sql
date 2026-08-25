-- Referral activation (playbook-v4 P13/3).
--
-- Timing is the whole feature. Fourteen days after a client confirms the work
-- is finished is the satisfaction peak; a month later the same message is an
-- awkward request, and most of the time nobody sends it at all because the
-- moment passed unnoticed.
--
-- `acknowledged_at` is its own column rather than `updated_at`, which moves
-- whenever anything touches the row — including the job that would then be
-- reading it. A clock that resets itself is not a clock.
--
-- Nothing here sends: the job drafts a message and raises a task, and a person
-- reads it and decides.
-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "acknowledged_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "referral_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "company_id" TEXT,
    "message_id" TEXT,
    "task_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'drafted',
    "referrer_id" TEXT,
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_requests_document_id_key" ON "referral_requests"("document_id");

-- CreateIndex
CREATE INDEX "referral_requests_workspace_id_status_idx" ON "referral_requests"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "referral_requests_workspace_id_company_id_created_at_idx" ON "referral_requests"("workspace_id", "company_id", "created_at");

