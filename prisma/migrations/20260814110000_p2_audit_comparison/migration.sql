-- P2/3 — competitor side-by-side.
--
-- The audit ids live on the PROSPECT's audit: one competitor audit is reused
-- across several comparisons (that is the point of the 30-day cache), so a
-- parent pointer on the competitor row would be wrong the second time it is
-- cited.
ALTER TABLE "audit_results" ADD COLUMN "comparison_json" JSONB;

-- Where a company came from when we did not choose it as a prospect. A
-- competitor pulled in by a comparison is a real company that may become a
-- lead later, so it is stored normally and merely marked.
ALTER TABLE "companies" ADD COLUMN "source" TEXT;
