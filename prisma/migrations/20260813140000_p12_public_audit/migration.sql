-- P12/1a — self-serve audits requested from the public landing page.
CREATE TABLE "public_audits" (
  "id"             TEXT NOT NULL,
  "workspace_id"   TEXT NOT NULL,
  "url"            TEXT NOT NULL,
  "domain"         TEXT NOT NULL,
  "audit_id"       TEXT,
  "status"         TEXT NOT NULL DEFAULT 'queued',
  "blocked_reason" TEXT,
  "ip_prefix"      TEXT,
  "user_agent"     TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "public_audits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "public_audits_workspace_id_created_at_idx" ON "public_audits"("workspace_id", "created_at");
CREATE INDEX "public_audits_domain_idx" ON "public_audits"("domain");
CREATE INDEX "public_audits_status_idx" ON "public_audits"("status");
