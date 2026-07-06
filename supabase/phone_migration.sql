-- ============================================================
-- RRMM — users.phone migration
-- Run in Supabase SQL Editor after content_lifecycle_migration.sql.
-- ============================================================
-- SMS delivery (Twilio) needs a number to send to. Optional — set at
-- registration or from profile settings; notifications that request SMS
-- (e.g. the 30-day archive notice) silently skip users without one.
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;  -- E.164, e.g. +15551234567
