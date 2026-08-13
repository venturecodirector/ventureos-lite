-- P2/5 — re-audit deltas and watches.

-- What changed since the previous audit of the same URL. Null on a first run:
-- "nothing to compare against" is not a delta of zero.
ALTER TABLE "audit_results" ADD COLUMN "delta_json" JSONB;

-- One watch per company, so enabling twice updates rather than duplicates.
CREATE TABLE "audit_watches" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "frequency_days" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "next_run_at" TIMESTAMP(3) NOT NULL,
  "last_run_at" TIMESTAMP(3),
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "audit_watches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "audit_watches_company_id_key" ON "audit_watches"("company_id");
CREATE INDEX "audit_watches_workspace_id_idx" ON "audit_watches"("workspace_id");
CREATE INDEX "audit_watches_next_run_at_idx" ON "audit_watches"("next_run_at");

ALTER TABLE "audit_watches" ADD CONSTRAINT "audit_watches_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
