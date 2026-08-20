-- A person's own photo, and the platform operator.
--
-- "A settings oldal szedd ketté: a settings maradjon a saját profil beállításai,
-- plusz tegyél ide profilkép feltöltési lehetőséget és legyen egy külön admin
-- settings ami a szoftver beállításait tartalmazza — ezt csak én láthatom mint
-- super admin."
--
-- ── WHY A COLUMN AND NOT A ROLE ────────────────────────────────────────────
--
-- Role (OWNER/ADMIN/BDR) lives on the MEMBERSHIP and answers "what may this
-- person do inside this workspace". Super admin is a different question — "who
-- administers this installation" — and putting it in the Role enum would have
-- made it grantable by anyone who can already edit memberships, which is an
-- Owner. An Owner who can grant super admin can grant it to themselves.
--
-- So it is a column on the user with no UI that writes it. It is set from the
-- server shell with scripts/set-super-admin.ts.
ALTER TABLE "users" ADD COLUMN "avatar_path" TEXT;
ALTER TABLE "users" ADD COLUMN "is_super_admin" BOOLEAN NOT NULL DEFAULT false;

-- Bootstrap: the account that has been here longest.
--
-- Without this, nobody can reach the admin page after deploy and the only way
-- in is a shell — including for the person who asked for the page. On this
-- installation the oldest account is the owner's, which is the honest answer to
-- "who administers this installation" for a self-hosted single-operator
-- deployment. A later super admin is appointed by an existing one.
UPDATE "users"
SET "is_super_admin" = true
WHERE "id" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC LIMIT 1);
