-- Support multiple VAR review GIFs per league.
-- On each tie, the client picks ONE at random from this array.
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS var_gif_urls JSONB DEFAULT '[]'::jsonb;

-- Backfill: migrate the existing single var_gif_url into the new array
UPDATE leagues
SET var_gif_urls = jsonb_build_array(var_gif_url)
WHERE var_gif_url IS NOT NULL
  AND (var_gif_urls IS NULL OR var_gif_urls = '[]'::jsonb);
