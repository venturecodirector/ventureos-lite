-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'BDR');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('PROSPECTOR', 'LINKEDIN', 'MANUAL', 'REFERRAL', 'COLD_EMAIL');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('RESEARCHED', 'CONTACTED', 'ACCEPTED', 'REPLIED', 'QUALIFIED', 'MEETING_BOOKED', 'HANDED_OFF', 'NOT_NOW', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "Lang" AS ENUM ('HU', 'EN');

-- CreateEnum
CREATE TYPE "TemplateType" AS ENUM ('QUOTE', 'CONTRACT', 'CERTIFICATE', 'EMAIL');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('QUOTE', 'CONTRACT', 'CERTIFICATE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SIGNED', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'DELIVERED', 'OPENED', 'BOUNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('NO_ANSWER', 'CALLBACK_REQUESTED', 'INTERESTED', 'NOT_INTERESTED', 'WRONG_NUMBER');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PAUSED', 'ACTIVE', 'COMPLETED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ReferrerKind" AS ENUM ('PERSON', 'COMPANY');

-- CreateEnum
CREATE TYPE "DealResult" AS ENUM ('WON', 'LOST', 'POSTPONED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PREPARED', 'SUBMITTED', 'ISSUED', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditVerdict" AS ENUM ('STRONG', 'POSSIBLE', 'SKIP');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('LINKEDIN', 'EMAIL', 'COLD_EMAIL');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('DRAFT', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "FrameStatus" AS ENUM ('DRAFT', 'PROPOSED', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InsightKind" AS ENUM ('DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "ProposalKind" AS ENUM ('FRAME_PROMOTION', 'SCORE_WEIGHT');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "totp_secret" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expiry_date" TIMESTAMP(3),
    "scope" TEXT,
    "calendar_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'BDR',
    "grants" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "brand_json" JSONB,
    "mailgun_config" JSONB,
    "icp_config" JSONB,
    "audit_config" JSONB,
    "claude_budget" DECIMAL(65,30) NOT NULL DEFAULT 2,
    "retention_days" INTEGER NOT NULL DEFAULT 365,
    "feature_flags" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT,
    "industry" TEXT,
    "size_band" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "tax_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "company_id" TEXT,
    "referrer_id" TEXT,
    "contact_name" TEXT,
    "title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "linkedin_url" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'MANUAL',
    "stage" "Stage" NOT NULL DEFAULT 'RESEARCHED',
    "stage_entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stage_reason" TEXT,
    "icp_score" INTEGER,
    "score_breakdown" JSONB,
    "signals" JSONB NOT NULL DEFAULT '[]',
    "qualification" JSONB,
    "escalated_at" TIMESTAMP(3),
    "notes" TEXT,
    "wake_up_at" TIMESTAMP(3),
    "last_activity_at" TIMESTAMP(3),
    "anonymized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "by_user_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "channel" "MessageChannel" NOT NULL DEFAULT 'LINKEDIN',
    "kind" TEXT,
    "body" TEXT NOT NULL,
    "ai_drafted" BOOLEAN NOT NULL DEFAULT false,
    "human_edited" BOOLEAN NOT NULL DEFAULT false,
    "analysis" JSONB,
    "status" "MessageStatus" NOT NULL DEFAULT 'DRAFT',
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "frames" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "segment" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "FrameStatus" NOT NULL DEFAULT 'DRAFT',
    "metrics" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "frames_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "host_user_id" TEXT,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "duration_min" INTEGER NOT NULL DEFAULT 30,
    "type" TEXT,
    "google_event_id" TEXT,
    "event_url" TEXT,
    "brief" TEXT,
    "brief_status" TEXT NOT NULL DEFAULT 'none',
    "brief_pdf_path" TEXT,
    "outcome" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insights" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" "InsightKind" NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" "ProposalKind" NOT NULL,
    "title" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "n" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by_user_id" TEXT,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "week_label" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "commentary" TEXT,
    "comment" TEXT,
    "pdf_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "targets" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "meta" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_searches" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "radius" TEXT,
    "cost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "results_json" JSONB,
    "ran_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_results" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "company_id" TEXT,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "score" INTEGER NOT NULL DEFAULT 0,
    "verdict" "AuditVerdict" NOT NULL DEFAULT 'SKIP',
    "checks_json" JSONB,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "pitch_summary" TEXT,
    "screenshots" JSONB NOT NULL DEFAULT '[]',
    "pdf_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_shares" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "audit_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "slug" TEXT NOT NULL,
    "first_opened_at" TIMESTAMP(3),
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "type" "TemplateType" NOT NULL,
    "lang" "Lang" NOT NULL DEFAULT 'HU',
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "template_version_id" TEXT,
    "chain_parent_id" TEXT,
    "type" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "watermark" BOOLEAN NOT NULL DEFAULT true,
    "payload_json" JSONB,
    "totals_json" JSONB,
    "pdf_url" TEXT,
    "accept_slug" TEXT,
    "finalized_at" TIMESTAMP(3),
    "finalized_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "document_id" TEXT,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "mailgun_id" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "outcome" "CallOutcome" NOT NULL,
    "note" TEXT,
    "duration" INTEGER,
    "callback_at" TIMESTAMP(3),
    "callback_done_at" TIMESTAMP(3),
    "by_user_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "frame_id" TEXT,
    "name" TEXT NOT NULL,
    "segment_query" JSONB,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "compliance_note" TEXT,
    "daily_cap" INTEGER NOT NULL DEFAULT 20,
    "started_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_steps" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "step_number" INTEGER NOT NULL,
    "delay_days" INTEGER NOT NULL DEFAULT 0,
    "subject" TEXT,
    "body" TEXT NOT NULL,

    CONSTRAINT "campaign_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "email" TEXT NOT NULL,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "bounced" BOOLEAN NOT NULL DEFAULT false,
    "step_sent" INTEGER NOT NULL DEFAULT 0,
    "replied_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "kind" "ReferrerKind" NOT NULL,
    "name" TEXT NOT NULL,
    "linked_company_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_data" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "tax_id" TEXT,
    "reg_number" TEXT,
    "legal_name" TEXT,
    "headcount_band" TEXT,
    "revenue_band" TEXT,
    "status_flags" JSONB NOT NULL DEFAULT '[]',
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registry_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_outcomes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "result" "DealResult" NOT NULL,
    "reason" TEXT,
    "value" INTEGER,
    "competitor" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_pages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "host_user_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT,
    "meeting_types_json" JSONB NOT NULL DEFAULT '[]',
    "config" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_acceptances" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "accepted_by_name" TEXT NOT NULL,
    "company" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "document_id" TEXT,
    "szamlazz_id" TEXT,
    "number" TEXT,
    "pdf_url" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PREPARED',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppressions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claude_usage" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "use_case" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claude_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "google_credentials_user_id_key" ON "google_credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "memberships_workspace_id_idx" ON "memberships"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_workspace_id_key" ON "memberships"("user_id", "workspace_id");

-- CreateIndex
CREATE INDEX "companies_workspace_id_idx" ON "companies"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "companies_workspace_id_tax_id_key" ON "companies"("workspace_id", "tax_id");

-- CreateIndex
CREATE INDEX "leads_workspace_id_idx" ON "leads"("workspace_id");

-- CreateIndex
CREATE INDEX "leads_company_id_idx" ON "leads"("company_id");

-- CreateIndex
CREATE INDEX "activities_workspace_id_idx" ON "activities"("workspace_id");

-- CreateIndex
CREATE INDEX "activities_lead_id_idx" ON "activities"("lead_id");

-- CreateIndex
CREATE INDEX "messages_workspace_id_idx" ON "messages"("workspace_id");

-- CreateIndex
CREATE INDEX "messages_lead_id_idx" ON "messages"("lead_id");

-- CreateIndex
CREATE INDEX "frames_workspace_id_idx" ON "frames"("workspace_id");

-- CreateIndex
CREATE INDEX "meetings_workspace_id_idx" ON "meetings"("workspace_id");

-- CreateIndex
CREATE INDEX "meetings_lead_id_idx" ON "meetings"("lead_id");

-- CreateIndex
CREATE INDEX "insights_workspace_id_idx" ON "insights"("workspace_id");

-- CreateIndex
CREATE INDEX "proposals_workspace_id_idx" ON "proposals"("workspace_id");

-- CreateIndex
CREATE INDEX "reports_workspace_id_idx" ON "reports"("workspace_id");

-- CreateIndex
CREATE INDEX "targets_workspace_id_idx" ON "targets"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "targets_workspace_id_metric_period_key" ON "targets"("workspace_id", "metric", "period");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_idx" ON "audit_logs"("workspace_id");

-- CreateIndex
CREATE INDEX "prospect_searches_workspace_id_idx" ON "prospect_searches"("workspace_id");

-- CreateIndex
CREATE INDEX "audit_results_workspace_id_idx" ON "audit_results"("workspace_id");

-- CreateIndex
CREATE INDEX "audit_results_company_id_idx" ON "audit_results"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_shares_slug_key" ON "audit_shares"("slug");

-- CreateIndex
CREATE INDEX "audit_shares_workspace_id_idx" ON "audit_shares"("workspace_id");

-- CreateIndex
CREATE INDEX "audit_shares_audit_id_idx" ON "audit_shares"("audit_id");

-- CreateIndex
CREATE INDEX "templates_workspace_id_idx" ON "templates"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_accept_slug_key" ON "documents"("accept_slug");

-- CreateIndex
CREATE INDEX "documents_workspace_id_idx" ON "documents"("workspace_id");

-- CreateIndex
CREATE INDEX "documents_lead_id_idx" ON "documents"("lead_id");

-- CreateIndex
CREATE INDEX "email_logs_workspace_id_idx" ON "email_logs"("workspace_id");

-- CreateIndex
CREATE INDEX "calls_workspace_id_idx" ON "calls"("workspace_id");

-- CreateIndex
CREATE INDEX "calls_lead_id_idx" ON "calls"("lead_id");

-- CreateIndex
CREATE INDEX "campaigns_workspace_id_idx" ON "campaigns"("workspace_id");

-- CreateIndex
CREATE INDEX "campaign_steps_workspace_id_idx" ON "campaign_steps"("workspace_id");

-- CreateIndex
CREATE INDEX "campaign_steps_campaign_id_idx" ON "campaign_steps"("campaign_id");

-- CreateIndex
CREATE INDEX "campaign_recipients_workspace_id_idx" ON "campaign_recipients"("workspace_id");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaign_id_idx" ON "campaign_recipients"("campaign_id");

-- CreateIndex
CREATE INDEX "referrers_workspace_id_idx" ON "referrers"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "registry_data_company_id_key" ON "registry_data"("company_id");

-- CreateIndex
CREATE INDEX "registry_data_workspace_id_idx" ON "registry_data"("workspace_id");

-- CreateIndex
CREATE INDEX "deal_outcomes_workspace_id_idx" ON "deal_outcomes"("workspace_id");

-- CreateIndex
CREATE INDEX "deal_outcomes_lead_id_idx" ON "deal_outcomes"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_pages_slug_key" ON "booking_pages"("slug");

-- CreateIndex
CREATE INDEX "booking_pages_workspace_id_idx" ON "booking_pages"("workspace_id");

-- CreateIndex
CREATE INDEX "quote_acceptances_workspace_id_idx" ON "quote_acceptances"("workspace_id");

-- CreateIndex
CREATE INDEX "quote_acceptances_document_id_idx" ON "quote_acceptances"("document_id");

-- CreateIndex
CREATE INDEX "invoices_workspace_id_idx" ON "invoices"("workspace_id");

-- CreateIndex
CREATE INDEX "suppressions_workspace_id_idx" ON "suppressions"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppressions_workspace_id_address_key" ON "suppressions"("workspace_id", "address");

-- CreateIndex
CREATE INDEX "claude_usage_workspace_id_idx" ON "claude_usage"("workspace_id");

-- AddForeignKey
ALTER TABLE "google_credentials" ADD CONSTRAINT "google_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "referrers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_results" ADD CONSTRAINT "audit_results_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_shares" ADD CONSTRAINT "audit_shares_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "audit_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_chain_parent_id_fkey" FOREIGN KEY ("chain_parent_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_frame_id_fkey" FOREIGN KEY ("frame_id") REFERENCES "frames"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrers" ADD CONSTRAINT "referrers_linked_company_id_fkey" FOREIGN KEY ("linked_company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_data" ADD CONSTRAINT "registry_data_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_outcomes" ADD CONSTRAINT "deal_outcomes_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_acceptances" ADD CONSTRAINT "quote_acceptances_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

