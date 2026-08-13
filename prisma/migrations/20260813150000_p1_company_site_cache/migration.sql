-- P1/1c — cached homepage text used to enrich the research prompt.
ALTER TABLE "companies" ADD COLUMN "site_text" TEXT;
ALTER TABLE "companies" ADD COLUMN "site_fetched_at" TIMESTAMP(3);
