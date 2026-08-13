-- playbook-v2 P2(a) — the email sync data model.
--
-- These tables hold the SUBSET of a mailbox that matches a known lead or
-- company. The sync query is built from CRM addresses, so the scope of what is
-- stored is always derived from the CRM and never wider.

CREATE TABLE "mail_accounts" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'gmail',
  "account_email" TEXT NOT NULL,
  "credential_id" TEXT,
  "watermark" TIMESTAMP(3),
  "backfill_cursor" TIMESTAMP(3),
  "backfill_done" BOOLEAN NOT NULL DEFAULT false,
  "health" TEXT NOT NULL DEFAULT 'ok',
  "last_error" TEXT,
  "last_sync_at" TIMESTAMP(3),
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mail_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mail_accounts_user_id_account_email_key" ON "mail_accounts"("user_id", "account_email");
CREATE INDEX "mail_accounts_workspace_id_idx" ON "mail_accounts"("workspace_id");

CREATE TABLE "email_threads" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "provider_thread_id" TEXT NOT NULL,
  "subject" TEXT,
  "lead_id" TEXT,
  "company_id" TEXT,
  "match_type" TEXT NOT NULL DEFAULT 'address',
  "last_message_at" TIMESTAMP(3) NOT NULL,
  "message_count" INTEGER NOT NULL DEFAULT 0,
  "unread" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_threads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_threads_account_id_provider_thread_id_key"
  ON "email_threads"("account_id", "provider_thread_id");
CREATE INDEX "email_threads_workspace_id_last_message_at_idx"
  ON "email_threads"("workspace_id", "last_message_at");
CREATE INDEX "email_threads_lead_id_idx" ON "email_threads"("lead_id");
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "mail_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "email_messages" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "provider_message_id" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "from_address" TEXT NOT NULL,
  "from_name" TEXT,
  "to_addresses" JSONB NOT NULL,
  "cc_addresses" JSONB,
  "subject" TEXT,
  "snippet" TEXT,
  "body_html" TEXT,
  "body_text" TEXT,
  "has_attachments" BOOLEAN NOT NULL DEFAULT false,
  "attachments" JSONB,
  "sent_at" TIMESTAMP(3) NOT NULL,
  "analyzed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_messages_thread_id_provider_message_id_key"
  ON "email_messages"("thread_id", "provider_message_id");
CREATE INDEX "email_messages_workspace_id_sent_at_idx" ON "email_messages"("workspace_id", "sent_at");
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_thread_id_fkey"
  FOREIGN KEY ("thread_id") REFERENCES "email_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One manual correction teaches the matcher permanently; without it the
-- unmatched queue is endless manual work.
CREATE TABLE "address_links" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "lead_id" TEXT,
  "company_id" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "address_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "address_links_workspace_id_email_key" ON "address_links"("workspace_id", "email");
CREATE INDEX "address_links_workspace_id_idx" ON "address_links"("workspace_id");
