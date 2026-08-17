-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "import_batch_id" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "import_batch_id" TEXT;

-- CreateTable
CREATE TABLE "import_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT,
    "mapping" JSONB NOT NULL,
    "coercions" JSONB NOT NULL DEFAULT '{}',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "filename" TEXT,
    "template_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "records" JSONB NOT NULL,
    "rollback_until" TIMESTAMP(3) NOT NULL,
    "rolled_back_at" TIMESTAMP(3),
    "rolled_back_by" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_templates_workspace_id_idx" ON "import_templates"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_templates_workspace_id_name_key" ON "import_templates"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "import_batches_workspace_id_created_at_idx" ON "import_batches"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "import_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

