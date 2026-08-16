-- playbook-v2 P3/2 — filters, saved views and bulk actions on the leads table.
--
-- Two additions:
--
--   1. leads.owner_id. The filter builder offers "owner" and the bulk actions
--      offer "assign owner", and neither had a column to work with — leads had
--      no notion of ownership at all. A plain TEXT column rather than a foreign
--      key to users, matching activities.by_user_id and tasks.assignee_id:
--      users are global while leads are tenant-scoped, so a real FK would tie a
--      business table across the tenancy boundary. NULL means unassigned, which
--      is a state worth filtering FOR rather than hiding.
--
--   2. saved_views. A named filter set + column selection + sort over a list
--      surface. `entity` is 'lead' today and exists so the deals and companies
--      tables of P4/P5 get their own tabs without a schema change.
--
-- filters/columns/sort are JSON because the condition list is variable-length.
-- Everything written to them goes through a zod schema first, so a hand-edited
-- row cannot reach the evaluator with a shape it does not expect.
ALTER TABLE "leads" ADD COLUMN "owner_id" TEXT;

-- "whose leads are these" — the owner filter and the my-leads view.
CREATE INDEX "leads_workspace_id_owner_id_idx" ON "leads"("workspace_id", "owner_id");

CREATE TABLE "saved_views" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "entity" TEXT NOT NULL DEFAULT 'lead',
  "owner_id" TEXT NOT NULL,
  "shared" BOOLEAN NOT NULL DEFAULT false,
  "filters" JSONB NOT NULL DEFAULT '{}',
  "columns" JSONB NOT NULL DEFAULT '[]',
  "sort" JSONB,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- The tab strip reads by workspace + entity, in tab order, on every page load.
CREATE INDEX "saved_views_workspace_id_entity_position_idx" ON "saved_views"("workspace_id", "entity", "position");
-- A person's own views, for the personal/shared split.
CREATE INDEX "saved_views_workspace_id_owner_id_idx" ON "saved_views"("workspace_id", "owner_id");
-- Two tabs with the same name from the same person is a UI bug, not a feature.
-- Scoped to the owner so two people may each have a "My leads".
CREATE UNIQUE INDEX "saved_views_workspace_id_entity_owner_id_name_key" ON "saved_views"("workspace_id", "entity", "owner_id", "name");
