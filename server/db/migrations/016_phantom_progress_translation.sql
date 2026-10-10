-- Keep the voice selected for a Phantom resume. Season and episode already
-- form part of the primary key in phantom_watch_positions.
ALTER TABLE phantom_watch_positions
  ADD COLUMN IF NOT EXISTS translation_id TEXT NULL;
