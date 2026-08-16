-- playbook-v2 P6/1 fix — a preference channel must be able to say "no opinion".
--
-- The columns were NOT NULL with defaults, which meant a row written with only
-- one channel set took the COLUMN defaults for the other two. Those defaults are
-- a second, competing source of truth: `email_digest` defaulted to false while
-- several types default it to TRUE in types.ts, so a partial row silently
-- switched off a channel the type turns on. Found by the P6/1 verification,
-- which wrote exactly such a row.
--
-- NULL now means "use the per-type default", which is what absence already meant
-- at the row level. The application always writes all three (it composes them
-- from the resolved state), so this is the safety net for rows written by seeds,
-- migrations, or a hand-edit.
ALTER TABLE "notification_preferences" ALTER COLUMN "in_app" DROP NOT NULL;
ALTER TABLE "notification_preferences" ALTER COLUMN "in_app" DROP DEFAULT;
ALTER TABLE "notification_preferences" ALTER COLUMN "push" DROP NOT NULL;
ALTER TABLE "notification_preferences" ALTER COLUMN "push" DROP DEFAULT;
ALTER TABLE "notification_preferences" ALTER COLUMN "email_digest" DROP NOT NULL;
ALTER TABLE "notification_preferences" ALTER COLUMN "email_digest" DROP DEFAULT;
