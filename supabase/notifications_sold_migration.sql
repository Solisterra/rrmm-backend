-- ============================================================
-- Add 'auction_sold' notification type (seller-facing sale alert)
-- ============================================================
-- When an auction closes with a winning bid, the seller (photographer) now gets
-- a "your auction sold" notification + email — previously only the winner and
-- losing bidders were notified. This widens the notifications.type CHECK so that
-- row can be persisted. (Until this runs, the email still sends; only the in-app
-- row insert is skipped — createNotification is resilient to the constraint.)

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'new_listing','outbid','auction_won','auction_lost','auction_sold',
    'payment_received','payout_sent','auction_ending',
    'content_approved','content_rejected'
  ));
