-- playbook-v2 P6/1 — the notification centre.
--
-- Three tables:
--
--   notifications          one thing that happened, addressed to ONE person.
--                          Per-user rather than a shared workspace feed,
--                          because "your lead replied" is not news to everyone
--                          and a shared row cannot carry a per-person read
--                          state.
--   notification_preferences  per user, per type, per channel. A row exists
--                          ONLY once someone changes something: absence means
--                          "the defaults in types.ts", so changing a default
--                          reaches everyone who never expressed an opinion.
--   push_subscriptions     one Web Push endpoint per device.
--
-- `type` is TEXT, not an enum: retiring a type stays a code change, and
-- resolveChannels() answers "all channels off" for a type it does not know, so
-- an orphaned row degrades to silence rather than breaking a render.
CREATE TABLE "notifications" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  -- Stored rather than derived, so an old notification still points somewhere
  -- sensible after the route that produced it has moved.
  "href" TEXT NOT NULL,
  "entity_type" TEXT,
  "entity_id" TEXT,
  "read_at" TIMESTAMP(3),
  "dedupe_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- The bell's query: this person's unread, newest first.
CREATE INDEX "notifications_workspace_id_user_id_read_at_created_at_idx" ON "notifications"("workspace_id", "user_id", "read_at", "created_at");
-- The 90-day retention sweep, which scans by age across all workspaces.
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");
-- One event, one notification: a retried job or a repeating sweep cannot stack
-- duplicates in someone's bell.
CREATE UNIQUE INDEX "notifications_workspace_id_user_id_dedupe_key_key" ON "notifications"("workspace_id", "user_id", "dedupe_key");

CREATE TABLE "notification_preferences" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "in_app" BOOLEAN NOT NULL DEFAULT true,
  "push" BOOLEAN NOT NULL DEFAULT false,
  "email_digest" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notification_preferences_workspace_id_user_id_idx" ON "notification_preferences"("workspace_id", "user_id");
CREATE UNIQUE INDEX "notification_preferences_workspace_id_user_id_type_key" ON "notification_preferences"("workspace_id", "user_id", "type");

CREATE TABLE "push_subscriptions" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  -- sha256(endpoint). The uniqueness key, because a TEXT column cannot carry a
  -- unique index on MySQL without a prefix length and the schema must run on
  -- both flavours (CLAUDE.md).
  "endpoint_hash" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "user_agent" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3),
  -- Set when the push service reports the endpoint gone (404/410). The sender
  -- prunes these instead of retrying a subscription that no longer exists.
  "failed_at" TIMESTAMP(3),
  CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_hash_key" ON "push_subscriptions"("endpoint_hash");
CREATE INDEX "push_subscriptions_workspace_id_user_id_idx" ON "push_subscriptions"("workspace_id", "user_id");
