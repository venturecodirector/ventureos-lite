-- playbook-v2 P3/3 — tasks as a first-class object.
--
-- Polymorphic link (entity_type + entity_id) rather than four nullable foreign
-- keys, so a task can hang off a lead now and a deal once P4 exists without a
-- schema change. The trade-off is no cascade: eraseLeadData deletes a lead's
-- tasks explicitly, and the model comment says so.
CREATE TABLE "tasks" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'todo',
  "title" TEXT NOT NULL,
  "note" TEXT,
  "due_at" TIMESTAMP(3),
  "entity_type" TEXT,
  "entity_id" TEXT,
  "assignee_id" TEXT,
  "done_at" TIMESTAMP(3),
  "source" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);
-- The three ways tasks are read: my open list by due date, everything on one
-- entity, and one person's workload.
CREATE INDEX "tasks_workspace_id_done_at_due_at_idx" ON "tasks"("workspace_id", "done_at", "due_at");
CREATE INDEX "tasks_workspace_id_entity_type_entity_id_idx" ON "tasks"("workspace_id", "entity_type", "entity_id");
CREATE INDEX "tasks_assignee_id_done_at_idx" ON "tasks"("assignee_id", "done_at");
