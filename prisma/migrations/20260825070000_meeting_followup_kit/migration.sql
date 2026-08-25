-- The post-meeting follow-up kit (playbook-v4 P13/2).
--
-- The gap it closes: an outcome was logged, the lead moved to Handed off, and
-- everything that should have happened next — the thank-you, the audit PDF, the
-- quote lines that were actually discussed, the reminder — depended on somebody
-- remembering all four while the meeting was still fresh.
--
-- Stored as one JSON blob on the meeting rather than four tables because it is
-- exactly that: a note of what was assembled, at one moment, for one meeting.
-- Whether each part has been ACTED on is not stored here at all — it is read
-- from the draft's status, the quote's existence and the task's done flag, so
-- the checklist cannot disagree with the things it is describing.
-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "followup_kit" JSONB;

