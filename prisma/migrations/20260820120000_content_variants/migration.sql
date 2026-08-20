-- One card per TOPIC, holding a text per channel.
--
-- "Content hubban lehessen egy témában egy kártyán belül linkeden/blog/newsletter
-- is, ne kelljen fajtánként új kártya ugyanarra a témára."
--
-- Before this, `content_posts.channel` meant a post WAS a channel: publishing the
-- same subject three ways meant three cards, each moving through review
-- separately, with nothing tying them together. So the text moves down one level:
-- a post is the topic and the editorial decision, a variant is one channel's
-- rendering of it.
--
-- What moves, and why each one:
--   body, channel        the text and where it goes — the whole point
--   ai_drafted,          "did a human edit Claude's draft?" is asked of a TEXT,
--   ai_draft_body        and each channel has its own
--   published_url        each channel is posted separately, to its own URL
--
-- What stays on the post: title, status, author, the approval, review_note, and
-- published_at as the date a human marked the topic done.
CREATE TABLE "content_variants" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "ai_drafted" BOOLEAN NOT NULL DEFAULT false,
    "ai_draft_body" TEXT,
    "published_at" TIMESTAMP(3),
    "published_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_variants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "content_variants_post_id_channel_key" ON "content_variants"("post_id", "channel");
CREATE INDEX "content_variants_workspace_id_idx" ON "content_variants"("workspace_id");

ALTER TABLE "content_variants"
  ADD CONSTRAINT "content_variants_post_id_fkey"
  FOREIGN KEY ("post_id") REFERENCES "content_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing post becomes a topic with exactly one variant, the
-- one it already was. The id is derived from the post's so the statement is
-- idempotent — re-running it inserts nothing rather than duplicating.
INSERT INTO "content_variants" (
  "id", "workspace_id", "post_id", "channel", "body",
  "ai_drafted", "ai_draft_body", "published_at", "published_url",
  "created_at", "updated_at"
)
SELECT
  'cv_' || "id",
  "workspace_id",
  "id",
  COALESCE("channel", 'linkedin'),
  COALESCE("body", ''),
  COALESCE("ai_drafted", false),
  "ai_draft_body",
  "published_at",
  "published_url",
  "created_at",
  "updated_at"
FROM "content_posts"
ON CONFLICT ("post_id", "channel") DO NOTHING;

-- Only now that the data is copied.
ALTER TABLE "content_posts" DROP COLUMN "body";
ALTER TABLE "content_posts" DROP COLUMN "channel";
ALTER TABLE "content_posts" DROP COLUMN "ai_drafted";
ALTER TABLE "content_posts" DROP COLUMN "ai_draft_body";
ALTER TABLE "content_posts" DROP COLUMN "published_url";
