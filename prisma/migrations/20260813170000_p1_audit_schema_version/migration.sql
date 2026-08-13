-- P1/3d — stamp the check set an audit was scored under. Existing rows keep 1
-- (the flat, pre-category scheme) so they render as they were scored.
ALTER TABLE "audit_results" ADD COLUMN "schema_version" INTEGER NOT NULL DEFAULT 1;
