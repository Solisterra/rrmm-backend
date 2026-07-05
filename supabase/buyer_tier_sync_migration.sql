-- ============================================================
-- Buyer-tier sync migration (B6/B10 follow-up)
-- Hand-apply after content_lifecycle_migration.sql.
--
-- 1. Backfill: buyer_tier was added with DEFAULT 'marketplace' and deliberately
--    not backfilled, so pre-existing verified bidders still carry the
--    self-service tier. Now that capability approval promotes the tier
--    (pages/api/admin/capabilities.ts) and the bid API rejects the marketplace
--    tier explicitly (B6, pages/api/auctions/[id]/bid.ts), align existing rows.
-- 2. legal_text_snapshot default: replace the placeholder one-liner with the
--    full v1.0 license text buyers actually see and accept (lib/license.ts —
--    the single source of truth; the accept endpoint always writes the snapshot
--    explicitly, so this default is only a safety net).
-- ============================================================

-- ── 1. Promote existing verified bidders out of the self-service tier ─────────
UPDATE users
SET buyer_tier = 'verified'
WHERE role = 'buyer'
  AND bid_status = 'verified'
  AND buyer_tier = 'marketplace';

-- ── 2. Align the snapshot default with the displayed v1.0 license text ────────
ALTER TABLE license_acceptances
  ALTER COLUMN legal_text_snapshot SET DEFAULT
'RRMM NON-EXCLUSIVE CONTENT LICENSE (v1.0)

This Non-Exclusive Content License ("License") is granted by the photographer ("Licensor") to the licensing buyer ("Licensee") through the Rocket Ranch Media Marketplace ("RRMM") upon completion of payment.

1. GRANT. Licensor grants Licensee a worldwide, perpetual, non-exclusive, non-transferable license to use, reproduce, and display the licensed content across Licensee''s own media and marketing channels.

2. NON-EXCLUSIVITY. This License is non-exclusive. Licensor may license the same content to any number of other parties. Licensee acquires no ownership of, or exclusive rights in, the content or its copyright.

3. RESTRICTIONS. Licensee may not resell, redistribute, sublicense, or otherwise make the raw content file available to third parties as stock, templates, or for further licensing. Licensee may not represent the content as its own original work for purposes of further licensing.

4. OWNERSHIP. Licensor retains all copyright and ownership of the content and may continue to sell, license, or exploit it without restriction.

5. FEES. The license fee is the marketplace price shown at checkout. RRMM retains a 20% platform commission; the remaining 80% is paid to Licensor. All sales are final.

6. WARRANTY & LIABILITY. Licensor warrants it holds the rights to license the content. RRMM provides the marketplace "as is" and is not liable for misuse of licensed content by either party.

By accepting, Licensee agrees to be bound by the terms of this License as of the acceptance date.';
