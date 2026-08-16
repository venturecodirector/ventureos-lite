-- audit-v2 item 6 — pin the branding a document was rendered under.
--
-- Same reason `template_version_id` pins the wording: a document that has been
-- sent to a client is a RECORD of what was sent. Re-rendering it after the
-- workspace changed its letterhead would quietly reissue it with a different
-- identity on it — a different company name on a signed contract, in the worst
-- case. NULL means "never rendered"; the first render captures the snapshot.
ALTER TABLE "documents" ADD COLUMN "brand_snapshot" JSONB;
ALTER TABLE "documents" ADD COLUMN "brand_version" INTEGER;
