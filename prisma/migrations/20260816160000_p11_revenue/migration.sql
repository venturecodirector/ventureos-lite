-- playbook-v3 P11/1a — the revenue layer: client status, the recurring book,
-- and the payment ledger the commission reads.
--
-- THREE DESIGN NOTES worth having in the migration itself:
--
-- 1. There is no Deal model (v2 P4 is not started), so `subscriptions` links to
--    a COMPANY, and a company is promoted to client status by the first thing
--    that means "won" in practice: a subscription starting or an invoice being
--    paid. Adding `deal_id` later is a nullable column plus a foreign key — no
--    backfill, and none of the MRR maths changes, because it reads company_id.
--
-- 2. `subscription_events` is APPEND-ONLY. The movement chart sums its signed
--    deltas rather than reconstructing history from current state, because
--    reconstruction cannot tell "raised to 150k in March" from "started at 150k
--    in March", and it loses anything that happened and was later undone. A
--    correction is another row, never an UPDATE.
--
-- 3. `invoices` becomes the payment ledger. Commission is "10% of net actually
--    RECEIVED in that month", which needs how much (net, VAT excluded), WHEN
--    the money arrived, and from whom. None of that could be derived from the
--    linked document, because a subscription invoice has no document at all.
--    REFUNDED is a status rather than a deletion: the ledger has to SEE a
--    reversal to offset it, and a deleted invoice is a payment that silently
--    never happened.

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('PROSPECT', 'CLIENT', 'FORMER');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CHURNED');

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'REFUNDED';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "company_id" TEXT,
ADD COLUMN     "net_amount" INTEGER,
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "refunded_at" TIMESTAMP(3),
ADD COLUMN     "refunded_net" INTEGER,
ADD COLUMN     "subscription_id" TEXT;

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "plan_name" TEXT NOT NULL,
    "monthly_net" INTEGER NOT NULL,
    "billing_day" INTEGER NOT NULL DEFAULT 1,
    "start_date" TIMESTAMP(3) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "churned_at" TIMESTAMP(3),
    "churn_reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'other',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "delta_net" INTEGER NOT NULL,
    "monthly_net_after" INTEGER NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscriptions_workspace_id_status_idx" ON "subscriptions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_company_id_idx" ON "subscriptions"("company_id");

-- CreateIndex
CREATE INDEX "subscription_events_workspace_id_at_idx" ON "subscription_events"("workspace_id", "at");

-- CreateIndex
CREATE INDEX "subscription_events_subscription_id_at_idx" ON "subscription_events"("subscription_id", "at");

-- CreateIndex
CREATE INDEX "invoices_workspace_id_paid_at_idx" ON "invoices"("workspace_id", "paid_at");

-- CreateIndex
CREATE INDEX "invoices_company_id_idx" ON "invoices"("company_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Company gains the client lifecycle.
ALTER TABLE "companies" ADD COLUMN "client_status" "ClientStatus" NOT NULL DEFAULT 'PROSPECT';
ALTER TABLE "companies" ADD COLUMN "client_since" TIMESTAMP(3);
ALTER TABLE "companies" ADD COLUMN "support_flag" BOOLEAN NOT NULL DEFAULT false;
