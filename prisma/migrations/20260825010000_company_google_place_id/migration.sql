-- Google's own id for a prospected place.
--
-- "minden google infót kiszedjen és berakja a leadbe"
--
-- ── WHY A COLUMN AND NOT A HEURISTIC ───────────────────────────────────────
--
-- "Add as lead" deduped on website domain OR phone number. Both are absent on a
-- large share of exactly the businesses this tool is FOR: of the 71 companies
-- prospected on this installation, one has a domain. A café with no site and no
-- listed number therefore matched nothing, and could be added again and again
-- with no duplicate warning at all.
--
-- The place id is the only exact key Google offers, it was already in every
-- response we paid for, and it was being discarded before it was ever read.
-- Nullable because every company created any other way has no place id, and
-- because rows added before this migration never captured one.
ALTER TABLE "companies" ADD COLUMN "google_place_id" TEXT;

-- Scoped by workspace, like every other lookup on this table: the dedupe query
-- runs through the tenant guard and never sees more than one workspace.
CREATE INDEX "companies_workspace_id_google_place_id_idx"
  ON "companies" ("workspace_id", "google_place_id");
