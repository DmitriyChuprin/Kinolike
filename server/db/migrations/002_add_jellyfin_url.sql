-- Миграция: добавляем jellyfin_url в streaming_links
ALTER TABLE streaming_links ADD COLUMN IF NOT EXISTS jellyfin_url TEXT DEFAULT NULL;
