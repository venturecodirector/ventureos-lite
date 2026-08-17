-- CreateTable
CREATE TABLE "undo_entries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "inverse" JSONB NOT NULL,
    "expected" JSONB NOT NULL,
    "undone_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "undo_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "undo_entries_workspace_id_user_id_created_at_idx" ON "undo_entries"("workspace_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "undo_entries_expires_at_idx" ON "undo_entries"("expires_at");

