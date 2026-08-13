-- P12/1b — the teaser serves screenshots straight off the audit, so the
-- relation Prisma needs for that join is declared. audit_id already existed as
-- a plain column; this only adds the foreign key.
ALTER TABLE "public_audits" ADD CONSTRAINT "public_audits_audit_id_fkey"
  FOREIGN KEY ("audit_id") REFERENCES "audit_results"("id") ON DELETE SET NULL ON UPDATE CASCADE;
