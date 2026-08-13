-- P1/1e — extension capture: avatar, bio, person brief, and the token the
-- extension authenticates with (it runs on linkedin.com and cannot use the
-- app session cookie).
ALTER TABLE "leads" ADD COLUMN "avatar_path"  TEXT;
ALTER TABLE "leads" ADD COLUMN "bio"          TEXT;
ALTER TABLE "leads" ADD COLUMN "person_brief" TEXT;
ALTER TABLE "leads" ADD COLUMN "brief_at"     TIMESTAMP(3);

CREATE TABLE "capture_tokens" (
  "id"           TEXT NOT NULL,
  "user_id"      TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "token_hash"   TEXT NOT NULL,
  "label"        TEXT,
  "last_used_at" TIMESTAMP(3),
  "revoked_at"   TIMESTAMP(3),
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capture_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "capture_tokens_token_hash_key" ON "capture_tokens"("token_hash");
CREATE INDEX "capture_tokens_user_id_idx" ON "capture_tokens"("user_id");
CREATE INDEX "capture_tokens_workspace_id_idx" ON "capture_tokens"("workspace_id");
ALTER TABLE "capture_tokens" ADD CONSTRAINT "capture_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
