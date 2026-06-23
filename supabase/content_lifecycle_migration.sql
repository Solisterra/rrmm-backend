-- ============================================================
-- RRMM — Content Lifecycle Migration (Ticket B1)
-- Run in Supabase SQL Editor after schema.sql + earlier migrations.
-- ============================================================
-- Adds a second life for content that doesn't sell at auction: a fixed-price,
-- non-exclusive **Marketplace**, a 30-day archive for stale marketplace items,
-- and a self-service **marketplace buyer tier**. The existing auction flow is
-- unchanged. See docs/content-lifecycle-scope.md (frontend repo) §3.
--
-- Lifecycle:
--   ACTIVE ─ no winning bid + fallback_price ─► MARKETPLACE ─ 30d, 0 sales ─► ARCHIVED
--
-- This migration is idempotent — safe to re-run.
-- ============================================================

-- ── users.buyer_tier ─────────────────────────────────────────
-- 'marketplace' = self-service tier, fixed-price buys only (cannot bid).
-- 'verified'    = full auction buyer (the existing verify-to-bid flow).
-- Default 'marketplace' is the lowest-privilege tier; the bid API additionally
-- gates on bid_status='verified' (capabilities_migration.sql), so existing
-- verified bidders are unaffected by the default.
ALTER TABLE users ADD COLUMN IF NOT EXISTS buyer_tier TEXT NOT NULL DEFAULT 'marketplace'
  CHECK (buyer_tier IN ('marketplace','verified'));

-- ── auctions (now also "listings") ───────────────────────────
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS fallback_price    NUMERIC(10,2),  -- optional marketplace fixed price; NULL => stays unsold
  ADD COLUMN IF NOT EXISTS marketplace_since TIMESTAMPTZ,    -- clock for the 30-day archive sweep
  ADD COLUMN IF NOT EXISTS license_count     INTEGER NOT NULL DEFAULT 0;  -- "12 licensed" social proof

-- ── auctions.status enum: add 'marketplace' and 'archived' ───
-- Drop + recreate the CHECK constraint. Constraint name is the Postgres default
-- generated for the inline CHECK in schema.sql (auctions_status_check).
ALTER TABLE auctions DROP CONSTRAINT IF EXISTS auctions_status_check;
ALTER TABLE auctions ADD CONSTRAINT auctions_status_check
  CHECK (status IN (
    'pending','active','closing','sold','unsold','cancelled',
    'marketplace','archived'
  ));

-- ── license_acceptances ──────────────────────────────────────
-- Cloned from the attestations pattern (immutable, versioned, audited), with one
-- key difference: attestations are 1:1 with an auction (FK on auctions). License
-- acceptances are MANY-per-listing — one per non-exclusive purchase — so they link
-- to transaction_id and there is intentionally NO back-reference column on auctions.
CREATE TABLE IF NOT EXISTS license_acceptances (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  buyer_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_id          UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  transaction_id      UUID NOT NULL REFERENCES transactions(id),  -- many per content

  -- Click-through acceptance of the non-exclusive license. Must be TRUE to persist.
  agreement_accepted  BOOLEAN NOT NULL DEFAULT FALSE
                        CHECK (agreement_accepted = TRUE),

  -- Immutable audit fields — never updated after insert
  accepted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address          TEXT,        -- captured server-side from req headers
  user_agent          TEXT,        -- browser/device fingerprint
  session_id          TEXT,        -- Supabase auth session ID at time of acceptance

  -- Legal text snapshot — exact wording shown to the buyer at time of acceptance,
  -- so there's no ambiguity if license terms change later.
  license_version     TEXT NOT NULL DEFAULT 'v1.0',
  legal_text_snapshot TEXT NOT NULL DEFAULT
    'v1.0: Non-exclusive license. The buyer is granted a non-exclusive, non-transferable license to use this content. The photographer retains ownership and may license the same content to other buyers. Resale or sublicensing of the underlying content is prohibited.'
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_license_acceptances_buyer       ON license_acceptances(buyer_id);
CREATE INDEX IF NOT EXISTS idx_license_acceptances_content     ON license_acceptances(content_id);
CREATE INDEX IF NOT EXISTS idx_license_acceptances_transaction ON license_acceptances(transaction_id);
CREATE INDEX IF NOT EXISTS idx_license_acceptances_accepted_at ON license_acceptances(accepted_at);

-- ── RLS: buyer sees own; photographer sees acceptances on their content; admin sees all ──
ALTER TABLE license_acceptances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "license_acceptances_read_own" ON license_acceptances;
CREATE POLICY "license_acceptances_read_own" ON license_acceptances
  FOR SELECT USING (
    buyer_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
  );

DROP POLICY IF EXISTS "license_acceptances_read_photographer" ON license_acceptances;
CREATE POLICY "license_acceptances_read_photographer" ON license_acceptances
  FOR SELECT USING (
    content_id IN (
      SELECT a.id FROM auctions a
      JOIN users u ON u.id = a.photographer_id
      WHERE u.auth_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "license_acceptances_admin_all" ON license_acceptances;
CREATE POLICY "license_acceptances_admin_all" ON license_acceptances
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE auth_id = auth.uid() AND role = 'admin')
  );

-- License records are INSERT-only — never updated or deleted.
DROP POLICY IF EXISTS "license_acceptances_insert_own" ON license_acceptances;
CREATE POLICY "license_acceptances_insert_own" ON license_acceptances
  FOR INSERT WITH CHECK (
    buyer_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
  );

-- ── Trigger: prevent any UPDATE or DELETE on license_acceptances ──
-- Once recorded, a license acceptance is immutable.
CREATE OR REPLACE FUNCTION block_license_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'License acceptance records are immutable and cannot be modified or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_no_license_update ON license_acceptances;
CREATE TRIGGER trg_no_license_update
  BEFORE UPDATE ON license_acceptances
  FOR EACH ROW EXECUTE FUNCTION block_license_mutation();

DROP TRIGGER IF EXISTS trg_no_license_delete ON license_acceptances;
CREATE TRIGGER trg_no_license_delete
  BEFORE DELETE ON license_acceptances
  FOR EACH ROW EXECUTE FUNCTION block_license_mutation();

-- ── View: admin license audit log ────────────────────────────
CREATE OR REPLACE VIEW license_acceptance_audit_log AS
  SELECT
    la.id              AS license_id,
    la.content_id,
    au.title           AS content_title,
    au.category,
    bu.handle          AS buyer_handle,
    bu.email           AS buyer_email,
    ph.handle          AS photographer_handle,
    ph.email           AS photographer_email,
    la.transaction_id,
    t.gross_amount,
    la.accepted_at,
    la.ip_address,
    la.user_agent,
    la.license_version,
    au.status          AS content_status
  FROM license_acceptances la
  JOIN auctions au     ON au.id = la.content_id
  JOIN users bu        ON bu.id = la.buyer_id
  JOIN users ph        ON ph.id = au.photographer_id
  LEFT JOIN transactions t ON t.id = la.transaction_id
  ORDER BY la.accepted_at DESC;

-- ── NOTE (follow-up, not B1): RLS public read of marketplace listings ──
-- schema.sql's "auctions_public_read" policy only exposes status='active'. When
-- the marketplace list/detail endpoints (B8) read via the anon key rather than the
-- service role, widen that policy to:
--   status IN ('active','marketplace')
-- Backend reads currently use the service role (which bypasses RLS), so this is
-- deferred to B8 rather than included here.
