-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "number" TEXT;

-- CreateIndex
CREATE INDEX "documents_workspace_id_number_idx" ON "documents"("workspace_id", "number");


-- Backfill from the JSON payload so existing documents are searchable too.
UPDATE "documents"
SET "number" = COALESCE(
  "payload_json"->>'quoteNumber',
  "payload_json"->>'contractNumber',
  "payload_json"->>'certNumber'
)
WHERE "number" IS NULL AND "payload_json" IS NOT NULL;
