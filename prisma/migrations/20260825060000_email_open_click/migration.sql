-- 1:1 email open/click tracking (playbook-v3 P9/1).
--
-- For personal mail sent from the app through the user's own mailbox. Cold
-- campaign mail keeps its existing Mailgun webhooks and is deliberately NOT
-- double-instrumented.
--
-- `tracked_links` holds the links as they were at send time, in order, because
-- the redirect endpoint takes an INDEX into that array rather than a URL. A
-- redirect endpoint that accepts a URL is an open redirect, which is a phishing
-- primitive wearing our domain name.
--
-- An open is a SIGNAL, never proof: Apple Mail Privacy Protection pre-fetches
-- images and plenty of clients block them, so the number is indicative in both
-- directions. Every surface that shows it says so.

-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "tracked_links" JSONB,
ADD COLUMN     "tracking_id" TEXT;

-- CreateTable
CREATE TABLE "email_track_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "kind" TEXT NOT NULL,
    "url" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_track_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_tracking_id_key" ON "email_messages"("tracking_id");

-- CreateIndex
CREATE INDEX "email_track_events_workspace_id_message_id_idx" ON "email_track_events"("workspace_id", "message_id");

-- CreateIndex
CREATE INDEX "email_track_events_lead_id_idx" ON "email_track_events"("lead_id");

-- AddForeignKey
ALTER TABLE "email_track_events" ADD CONSTRAINT "email_track_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
