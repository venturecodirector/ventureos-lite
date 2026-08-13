-- P12/1b, 1c — the self-serve report request, and the consent behind it.

-- A lead that came to us, rather than one we found.
ALTER TYPE "LeadSource" ADD VALUE 'SELF_SERVE_AUDIT';

-- Evidence, not a preference flag: "did they consent" is easy, "what wording
-- did they agree to, when, and from where" is the question that gets asked.
CREATE TABLE "public_audit_consents" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "public_audit_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "company_name" TEXT,
  "service_consent" BOOLEAN NOT NULL DEFAULT true,
  "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
  "consent_text_version" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'hu',
  "ip" TEXT,
  "user_agent" TEXT,
  "lead_id" TEXT,
  "report_sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "public_audit_consents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "public_audit_consents_workspace_id_created_at_idx"
  ON "public_audit_consents"("workspace_id", "created_at");
CREATE INDEX "public_audit_consents_public_audit_id_idx"
  ON "public_audit_consents"("public_audit_id");
CREATE INDEX "public_audit_consents_email_idx" ON "public_audit_consents"("email");
