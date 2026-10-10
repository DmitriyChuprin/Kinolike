-- Re-resolve older cached trailers so the new Rutube-first source priority
-- takes effect without waiting for the previous cache TTL to expire.
UPDATE trailer_cache
SET available = FALSE, checked_at = NOW()
WHERE source <> 'rutube' AND available = TRUE;
