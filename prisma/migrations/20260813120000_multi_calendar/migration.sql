-- Multiple Google accounts per host: one WRITE target for meetings, any
-- number of BUSY_ONLY accounts that only contribute busy times.

ALTER TABLE "google_credentials" ADD COLUMN "account_email" TEXT;
ALTER TABLE "google_credentials" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'WRITE';

-- The old model allowed exactly one row per user. Drop that so a host can
-- connect a second account; identity becomes (user, google account).
DROP INDEX IF EXISTS "google_credentials_user_id_key";

CREATE UNIQUE INDEX "google_credentials_user_id_account_email_key"
  ON "google_credentials"("user_id", "account_email");
CREATE INDEX "google_credentials_user_id_idx" ON "google_credentials"("user_id");
