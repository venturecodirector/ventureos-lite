-- P2/8 — access-log analysis.
--
-- GDPR: log lines contain IP addresses. The raw file is processed, aggregated
-- and deleted within 7 days (purge_after + the retention job); only the
-- aggregate in analysis survives. No single log line is ever stored.
CREATE TABLE "log_uploads" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "company_id" TEXT,
  "filename" TEXT NOT NULL,
  "bytes" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "error" TEXT,
  "raw_path" TEXT,
  "purge_after" TIMESTAMP(3) NOT NULL,
  "purged_at" TIMESTAMP(3),
  "analysis" JSONB,
  "uploaded_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "log_uploads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "log_uploads_workspace_id_idx" ON "log_uploads"("workspace_id");
CREATE INDEX "log_uploads_purge_after_idx" ON "log_uploads"("purge_after");
ALTER TABLE "log_uploads" ADD CONSTRAINT "log_uploads_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
