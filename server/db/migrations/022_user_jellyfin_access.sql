-- Per-account Jellyfin access. Existing accounts stay intact; only the
-- service administrator keeps the previously available Jellyfin access.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS jellyfin_enabled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users
SET is_admin = TRUE,
    jellyfin_enabled = TRUE
WHERE lower(email) = 'chuprin-dmitriy@yandex.ru';
