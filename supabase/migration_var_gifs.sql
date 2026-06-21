-- Support multiple VAR GIFs per league (one is chosen at random on a tie).
-- Previously a single var_gif_url was stored; now we keep an array.
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS var_gif_urls TEXT[] NOT NULL DEFAULT '{}';

-- Migrate the existing single GIF into the new array (idempotent).
UPDATE leagues
SET var_gif_urls = ARRAY[var_gif_url]
WHERE var_gif_url IS NOT NULL
  AND var_gif_url <> ''
  AND NOT (var_gif_url = ANY (var_gif_urls));
