-- ============================================================
-- Add 'content_archived' notification type (seller-facing archive alert)
-- ============================================================
-- The archive cron sweep (Ticket B3) moves a marketplace listing to 'archived'
-- after 30 days with no license sold, and notifies the photographer that the
-- rights have reverted to them. This widens the notifications.type CHECK so that
-- row can persist. (Until this runs, the email still sends; only the in-app row
-- insert is skipped — createNotification is resilient to the constraint.)
--
-- Idempotent: drops + recreates the constraint with the full type set. Includes
-- 'auction_sold' from notifications_sold_migration.sql so the set stays complete
-- regardless of migration order.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'new_listing','outbid','auction_won','auction_lost','auction_sold',
    'payment_received','payout_sent','auction_ending',
    'content_approved','content_rejected','content_archived'
  ));
