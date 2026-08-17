-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "merged_at" TIMESTAMP(3),
ADD COLUMN     "merged_into_id" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "merged_at" TIMESTAMP(3),
ADD COLUMN     "merged_into_id" TEXT;

-- CreateTable
CREATE TABLE "merge_records" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "survivor_id" TEXT NOT NULL,
    "loser_id" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "choices" JSONB,
    "performed_by" TEXT,
    "revert_until" TIMESTAMP(3) NOT NULL,
    "reverted_at" TIMESTAMP(3),
    "reverted_by" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merge_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_merged_into_id_idx" ON "leads"("merged_into_id");

-- CreateIndex
CREATE INDEX "merge_records_workspace_id_at_idx" ON "merge_records"("workspace_id", "at");

-- CreateIndex
CREATE INDEX "merge_records_workspace_id_entity_survivor_id_idx" ON "merge_records"("workspace_id", "entity", "survivor_id");

-- CreateIndex
CREATE INDEX "merge_records_loser_id_idx" ON "merge_records"("loser_id");
