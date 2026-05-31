-- Add avatar_url to teams table (manager photo)
ALTER TABLE teams ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Add var_gif_url to leagues table (VAR review GIF)
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS var_gif_url TEXT;

-- Create storage bucket for draft media (run in Supabase Dashboard if bucket doesn't exist)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('draft-media', 'draft-media', true)
-- ON CONFLICT (id) DO NOTHING;
