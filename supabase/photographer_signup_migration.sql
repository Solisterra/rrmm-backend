-- ============================================================
-- Photographer self-serve signup — add portfolio link
-- ============================================================
-- Photographers now sign up by filling out a profile (name, handle, portfolio,
-- what they shoot, reach, and a short bio) instead of being invited. The bio,
-- follower_count, and handle columns already exist; this adds the portfolio URL
-- captured on the signup form and shown to admins during account review.

ALTER TABLE users ADD COLUMN IF NOT EXISTS portfolio_url TEXT;
