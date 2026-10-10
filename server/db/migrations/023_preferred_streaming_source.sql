-- Per-account online playback preference. Existing accounts retain Phantom.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_streaming_source TEXT NOT NULL DEFAULT 'phantom';

UPDATE users
SET preferred_streaming_source = 'phantom'
WHERE preferred_streaming_source IS NULL
   OR preferred_streaming_source NOT IN ('phantom', 'videohub');

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_preferred_streaming_source_check;

ALTER TABLE users
  ADD CONSTRAINT users_preferred_streaming_source_check
  CHECK (preferred_streaming_source IN ('phantom', 'videohub'));
