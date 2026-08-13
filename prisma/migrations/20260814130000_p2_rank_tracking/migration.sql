-- P2/7 — keyword rank tracking behind a paid SERP provider.
--
-- Known terms only: there is no keyword-research or search-volume table here
-- on purpose, and the UI says so.
CREATE TABLE "tracked_keywords" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "keyword" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'hu-HU',
  "location" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tracked_keywords_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tracked_keywords_company_id_keyword_locale_key"
  ON "tracked_keywords"("company_id", "keyword", "locale");
CREATE INDEX "tracked_keywords_workspace_id_idx" ON "tracked_keywords"("workspace_id");
ALTER TABLE "tracked_keywords" ADD CONSTRAINT "tracked_keywords_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- position NULL means "not in the first hundred" — a real answer, and storing
-- it as 101 would quietly average into the trend as if it were a rank.
CREATE TABLE "keyword_positions" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "keyword_id" TEXT NOT NULL,
  "position" INTEGER,
  "url" TEXT,
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "keyword_positions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "keyword_positions_workspace_id_idx" ON "keyword_positions"("workspace_id");
CREATE INDEX "keyword_positions_keyword_id_checked_at_idx"
  ON "keyword_positions"("keyword_id", "checked_at");
ALTER TABLE "keyword_positions" ADD CONSTRAINT "keyword_positions_keyword_id_fkey"
  FOREIGN KEY ("keyword_id") REFERENCES "tracked_keywords"("id") ON DELETE CASCADE ON UPDATE CASCADE;
