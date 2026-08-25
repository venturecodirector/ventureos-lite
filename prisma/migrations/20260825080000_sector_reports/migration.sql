-- Sector reports (playbook-v4 P12/2).
--
-- A lead magnet, a PR instrument, and — deliberately — the data-collection
-- engine for the P15 digital index: every site the batch audits lands in the
-- same AuditResult store as everything else, so a report published for
-- marketing reasons also fills the benchmark nobody could compute yet.
--
-- `stats` holds counts, medians and percentages ONLY. No company name, domain
-- or URL is ever written into it, and a test asserts that on the rendered
-- artifact. A report that identifies the businesses it measured is not a
-- report, it is a list — and publishing one would destroy the goodwill the
-- whole exercise exists to build.
--
-- Downloads carry the same dual consent as the self-serve audit: one required
-- box to deliver the file, one separate and unchecked box that is the only
-- lawful basis for writing to them afterwards.
-- CreateTable
CREATE TABLE "sector_reports" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "slug" TEXT,
    "cap" INTEGER NOT NULL DEFAULT 60,
    "foundCount" INTEGER NOT NULL DEFAULT 0,
    "auditedCount" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB,
    "narrative" JSONB,
    "pdf_path" TEXT,
    "cost_usd" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sector_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sector_report_downloads" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company_name" TEXT,
    "service_consent" BOOLEAN NOT NULL DEFAULT true,
    "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
    "consent_text_version" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "lead_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sector_report_downloads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sector_reports_slug_key" ON "sector_reports"("slug");

-- CreateIndex
CREATE INDEX "sector_reports_workspace_id_status_idx" ON "sector_reports"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "sector_report_downloads_workspace_id_report_id_idx" ON "sector_report_downloads"("workspace_id", "report_id");

-- AddForeignKey
ALTER TABLE "sector_report_downloads" ADD CONSTRAINT "sector_report_downloads_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "sector_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

