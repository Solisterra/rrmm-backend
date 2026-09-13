WITH demo_auction_ids AS (
  SELECT a.id
  FROM auctions a
  LEFT JOIN users u ON u.id = a.photographer_id
  WHERE lower(trim(a.title)) IN ('test', 'seam marketplace item')
     OR lower(trim(coalesce(u.handle, ''))) IN ('test', '@test', 'seam_photog', '@seam_photog')
     OR lower(trim(coalesce(u.display_name, ''))) IN ('test', 'seam_photog')
     OR a.preview_url ILIKE 'https://placehold.co/%'
     OR a.preview_url ILIKE 'http://placehold.co/%'
     OR a.preview_url ILIKE 'https://www.placehold.co/%'
     OR a.preview_url ILIKE 'http://www.placehold.co/%'
     OR a.preview_url ILIKE 'https://example.com/%'
     OR a.preview_url ILIKE 'http://example.com/%'
     OR a.preview_url ILIKE 'https://www.example.com/%'
     OR a.preview_url ILIKE 'http://www.example.com/%'
)
DELETE FROM notifications
WHERE auction_id IN (SELECT id FROM demo_auction_ids);

WITH demo_auction_ids AS (
  SELECT a.id
  FROM auctions a
  LEFT JOIN users u ON u.id = a.photographer_id
  WHERE lower(trim(a.title)) IN ('test', 'seam marketplace item')
     OR lower(trim(coalesce(u.handle, ''))) IN ('test', '@test', 'seam_photog', '@seam_photog')
     OR lower(trim(coalesce(u.display_name, ''))) IN ('test', 'seam_photog')
     OR a.preview_url ILIKE 'https://placehold.co/%'
     OR a.preview_url ILIKE 'http://placehold.co/%'
     OR a.preview_url ILIKE 'https://www.placehold.co/%'
     OR a.preview_url ILIKE 'http://www.placehold.co/%'
     OR a.preview_url ILIKE 'https://example.com/%'
     OR a.preview_url ILIKE 'http://example.com/%'
     OR a.preview_url ILIKE 'https://www.example.com/%'
     OR a.preview_url ILIKE 'http://www.example.com/%'
)
DELETE FROM transactions
WHERE auction_id IN (SELECT id FROM demo_auction_ids);

WITH demo_auction_ids AS (
  SELECT a.id
  FROM auctions a
  LEFT JOIN users u ON u.id = a.photographer_id
  WHERE lower(trim(a.title)) IN ('test', 'seam marketplace item')
     OR lower(trim(coalesce(u.handle, ''))) IN ('test', '@test', 'seam_photog', '@seam_photog')
     OR lower(trim(coalesce(u.display_name, ''))) IN ('test', 'seam_photog')
     OR a.preview_url ILIKE 'https://placehold.co/%'
     OR a.preview_url ILIKE 'http://placehold.co/%'
     OR a.preview_url ILIKE 'https://www.placehold.co/%'
     OR a.preview_url ILIKE 'http://www.placehold.co/%'
     OR a.preview_url ILIKE 'https://example.com/%'
     OR a.preview_url ILIKE 'http://example.com/%'
     OR a.preview_url ILIKE 'https://www.example.com/%'
     OR a.preview_url ILIKE 'http://www.example.com/%'
)
DELETE FROM auctions
WHERE id IN (SELECT id FROM demo_auction_ids);
