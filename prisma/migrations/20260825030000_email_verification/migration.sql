-- Email verification before a cold send (playbook-v3 P9/2).
--
-- Cold email lives or dies on bounce rate, and a few dead addresses in an early
-- campaign cost the SENDING DOMAIN's reputation — which no apology recovers.
-- The circuit breaker already stops a campaign that IS bouncing; this is the
-- check that happens before it ever sends.
--
-- The verdict lives on the CONTACT, with the date it was taken, so an address
-- checked for one campaign is not re-checked (or re-paid for) by the next, and
-- so it can go stale on its own after 90 days.
--
-- The campaign recipient keeps a SNAPSHOT of the verdict it was armed on,
-- plus who accepted a risky address and when. An audit of "why did we mail
-- that" needs what was known at the time, not what is known now.

-- AlterTable
ALTER TABLE "campaign_recipients" ADD COLUMN     "risk_accepted_at" TIMESTAMP(3),
ADD COLUMN     "risk_accepted_by" TEXT,
ADD COLUMN     "verify_reason" TEXT,
ADD COLUMN     "verify_status" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "email_checked_at" TIMESTAMP(3),
ADD COLUMN     "email_reason" TEXT,
ADD COLUMN     "email_status" TEXT;

