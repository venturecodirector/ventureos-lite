-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED');

-- CreateTable
CREATE TABLE "content_posts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'linkedin',
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "ai_drafted" BOOLEAN NOT NULL DEFAULT false,
    "ai_draft_body" TEXT,
    "author_user_id" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "published_url" TEXT,
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_posts_workspace_id_idx" ON "content_posts"("workspace_id");

-- CreateIndex
CREATE INDEX "content_posts_workspace_id_status_idx" ON "content_posts"("workspace_id", "status");

