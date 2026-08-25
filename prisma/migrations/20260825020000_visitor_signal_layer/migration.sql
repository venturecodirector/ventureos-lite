-- The signal layer: who is reading the pages we publish (playbook-v3 P8).
--
-- Until now a shared audit report carried one integer — `open_count` — and a
-- quote carried nothing at all. "Did the client actually read the offer, and
-- which part did they stop on?" was unanswerable, which is the single question
-- a salesperson asks most often between sending and calling.
--
-- ── PRIVACY IS THE DESIGN, NOT A DISCLAIMER ────────────────────────────────
--
-- No cookie is set: session continuity comes from a random token held in
-- sessionStorage, so this is measurement rather than tracking and needs a
-- notice line, not a consent banner.
--
-- `ip_raw` exists only so the enrichment worker can do a reverse-DNS lookup.
-- The nightly purge deletes it within 24 hours and a test asserts that; what
-- survives is a salted hash and the RESULT of the lookup. A visitor who sends
-- Do-Not-Track or Global-Privacy-Control gets a bare view row: no duration, no
-- sections, no address, not even a hash.

-- CreateTable
CREATE TABLE "page_visits" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "page_type" TEXT NOT NULL,
    "page_slug" TEXT NOT NULL,
    "lead_id" TEXT,
    "company_id" TEXT,
    "document_id" TEXT,
    "audit_id" TEXT,
    "session_token" TEXT NOT NULL,
    "referrer" TEXT,
    "viewport" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "scroll_pct" INTEGER NOT NULL DEFAULT 0,
    "sections" JSONB NOT NULL DEFAULT '{}',
    "ip_hash" TEXT,
    "ip_raw" TEXT,
    "enriched_at" TIMESTAMP(3),
    "org_name" TEXT,
    "guess_company_id" TEXT,
    "confidence" TEXT,
    "do_not_track" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "page_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_signals" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "lead_id" TEXT,
    "visit_id" TEXT NOT NULL,
    "page_type" TEXT NOT NULL,
    "page_slug" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warm_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visitor_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "page_visits_workspace_id_page_type_page_slug_idx" ON "page_visits"("workspace_id", "page_type", "page_slug");

-- CreateIndex
CREATE INDEX "page_visits_workspace_id_started_at_idx" ON "page_visits"("workspace_id", "started_at");

-- CreateIndex
CREATE INDEX "page_visits_workspace_id_session_token_page_slug_idx" ON "page_visits"("workspace_id", "session_token", "page_slug");

-- CreateIndex
CREATE INDEX "page_visits_lead_id_idx" ON "page_visits"("lead_id");

-- CreateIndex
CREATE INDEX "visitor_signals_workspace_id_at_idx" ON "visitor_signals"("workspace_id", "at");

-- CreateIndex
CREATE INDEX "visitor_signals_workspace_id_company_id_idx" ON "visitor_signals"("workspace_id", "company_id");

-- CreateIndex
CREATE INDEX "visitor_signals_lead_id_idx" ON "visitor_signals"("lead_id");

