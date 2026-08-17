-- CreateTable
CREATE TABLE "workflow_rules" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "trigger_config" JSONB NOT NULL DEFAULT '{}',
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "status" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "results" JSONB NOT NULL DEFAULT '[]',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_rules_workspace_id_enabled_idx" ON "workflow_rules"("workspace_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_rules_workspace_id_name_key" ON "workflow_rules"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "workflow_runs_workspace_id_at_idx" ON "workflow_runs"("workspace_id", "at");

-- CreateIndex
CREATE INDEX "workflow_runs_rule_id_at_idx" ON "workflow_runs"("rule_id", "at");

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "workflow_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

