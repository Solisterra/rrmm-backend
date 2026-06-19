-- ============================================================
-- Dual capabilities — verify-to-bid + members can hold both roles
-- ============================================================
-- Bidding and selling are now gated by per-capability status rather than the
-- single (role, verified) pair, so one account can be BOTH a verified buyer
-- (can bid) and a verified photographer (can sell).
--
--   bid_status  — 'none' (can't bid) → 'pending' (requested) → 'verified' / 'rejected'
--   sell_status — same lifecycle for creating listings
--
-- `role` is kept as the account's primary/signup role (and for admin).

ALTER TABLE users ADD COLUMN IF NOT EXISTS bid_status TEXT NOT NULL DEFAULT 'none'
  CHECK (bid_status IN ('none','pending','verified','rejected'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS sell_status TEXT NOT NULL DEFAULT 'none'
  CHECK (sell_status IN ('none','pending','verified','rejected'));

-- Backfill from the legacy role/verified model
UPDATE users SET sell_status = CASE WHEN verified THEN 'verified' ELSE 'pending' END
  WHERE role = 'photographer';
UPDATE users SET bid_status = 'verified'
  WHERE role = 'buyer' AND verified = TRUE;
