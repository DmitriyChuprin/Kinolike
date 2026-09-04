ALTER TABLE user_lists DROP CONSTRAINT IF EXISTS user_lists_status_check;
ALTER TABLE user_lists ADD CONSTRAINT user_lists_status_check CHECK(status IN ('want_to_watch','watching','watched','on_hold','not_interested'));
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS matched_movies JSONB NOT NULL DEFAULT '[]'::jsonb;
