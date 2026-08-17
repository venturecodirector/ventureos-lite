-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTISELECT', 'CHECKBOX', 'URL');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "deals" ADD COLUMN     "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "custom_fields" JSONB;

-- CreateTable
CREATE TABLE "custom_field_defs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "help" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_defs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_field_defs_workspace_id_entity_position_idx" ON "custom_field_defs"("workspace_id", "entity", "position");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_defs_workspace_id_entity_key_key" ON "custom_field_defs"("workspace_id", "entity", "key");

