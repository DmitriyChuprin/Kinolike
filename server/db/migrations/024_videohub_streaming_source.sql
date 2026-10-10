ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_preferred_streaming_source_check;

-- Replace the retired Zetflix preference only after the former check has
-- been removed; otherwise PostgreSQL rejects the intermediate value.
UPDATE users
SET preferred_streaming_source = 'videohub'
WHERE preferred_streaming_source = 'zetflix';

ALTER TABLE users
  ADD CONSTRAINT users_preferred_streaming_source_check
  CHECK (preferred_streaming_source IN ('phantom', 'videohub'));
