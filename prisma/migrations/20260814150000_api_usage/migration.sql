-- External API usage, alongside the existing claude_usage table.
--
-- Free APIs are recorded too: for PageSpeed and CrUX the number that matters
-- is calls against Google's per-project quota, not dollars, and a panel that
-- only showed money would report $0.00 forever while a quota quietly ran out.
CREATE TABLE "api_usage" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "calls" INTEGER NOT NULL DEFAULT 1,
  "cost" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_usage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "api_usage_workspace_id_at_idx" ON "api_usage"("workspace_id", "at");
