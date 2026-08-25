-- Delivery after the deal is won (playbook-v3 P11/2).
--
-- The chain quote → contract → certificate existed, and nothing carried a
-- project between the signature and the certificate. In practice that is where
-- the money gets stuck: the work is done, the certificate is never issued, and
-- the invoice waits on a document nobody remembered to generate.
--
-- ── A MILESTONE IS A TASK ──────────────────────────────────────────────────
--
-- The `milestones` table holds a position, a kind, and a foreign key. Title,
-- due date, owner, note and done state live on the Task it points at, because
-- the playbook is explicit ("reuse, don't duplicate") and because it is the
-- feature rather than the tidiness: a milestone shows up in Today Queue, in My
-- Tasks, in the overdue sweep and in the Monday digest with no code teaching
-- any of them what a milestone is, and there is exactly ONE done flag, so a
-- completed milestone and a completed task can never disagree.

-- CreateTable
CREATE TABLE "project_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "milestones" JSONB NOT NULL DEFAULT '[]',
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "company_id" TEXT,
    "lead_id" TEXT,
    "name" TEXT NOT NULL,
    "template_id" TEXT,
    "template_version" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestones" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_templates_workspace_id_status_idx" ON "project_templates"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "projects_deal_id_key" ON "projects"("deal_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_closed_at_idx" ON "projects"("workspace_id", "closed_at");

-- CreateIndex
CREATE UNIQUE INDEX "milestones_task_id_key" ON "milestones"("task_id");

-- CreateIndex
CREATE INDEX "milestones_workspace_id_project_id_idx" ON "milestones"("workspace_id", "project_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "project_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

