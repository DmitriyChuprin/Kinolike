ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS locale TEXT;

ALTER TABLE user_lists DROP CONSTRAINT IF EXISTS user_lists_status_check;

DELETE FROM user_lists
WHERE status IN ('watching', 'on_hold');

ALTER TABLE user_lists
  ADD CONSTRAINT user_lists_status_check
  CHECK(status IN ('want_to_watch', 'watched', 'not_interested'));
