-- P2/2 — Chrome UX Report field data, cached with the audit (which already
-- expires after 30 days). Null means "no field data", which is the honest and
-- common answer for a small site, not an error.
ALTER TABLE "audit_results" ADD COLUMN "crux_json" JSONB;
