-- P2/1 — the multi-page crawl result for an audit.
-- Nullable on purpose: every existing row, every public and self-serve audit,
-- and any internal run with the crawl toggle off has no crawl, and "no crawl"
-- must stay distinguishable from "a crawl that found nothing".
ALTER TABLE "audit_results" ADD COLUMN "crawl_json" JSONB;
