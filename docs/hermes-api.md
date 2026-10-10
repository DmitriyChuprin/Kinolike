# KinoLike REST API for Hermes Agent

The `/api/v1` adapter reuses KinoLike's `media_metadata`, `user_lists`, taste profile, recommendation history, TMDB cache, and personal recommendation pipeline. Hermes receives a bounded, already ranked result set; it does not download the catalog and rank it itself.

## Configuration

Copy the API variables from `.env.example` to `.env`. Generate the token with `openssl rand -hex 32`, set `KINOLIKE_API_USER_ID` to the existing KinoLike user whose library Hermes may manage, and restart the app. Never put the token in source control or a URL.

For a Hermes container on the same Compose network, set:

```env
KINOLIKE_API_URL=http://app:3000/api/v1
KINOLIKE_API_TOKEN=<same secret as KinoLike>
```

From the Docker host, the default URL is `http://localhost:${KINOLIKE_PORT:-3001}/api/v1`. The API uses `Authorization: Bearer ...` on every data endpoint.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/recommendations` | Natural-language and structured personalized recommendations |
| GET | `/profile/preferences` | Aggregated taste profile without account PII |
| GET | `/search?q=...` | Local search with optional TMDB fallback |
| GET | `/media/{id}` | Details and the user's watched/watchlist/rating status |
| GET | `/watchlist` | List Want to Watch items |
| POST | `/watchlist` | Add by local ID, TMDB identity, or title |
| DELETE | `/watchlist/{id}` | Remove by local media ID |
| POST | `/watched` | Mark watched or update rating/date |

`POST /watchlist` and `POST /watched` return `409 AMBIGUOUS_MEDIA` plus candidates when a title is not unique. The agent should show those choices and repeat the request with `media_id` or `tmdb_id` plus `media_type`.

## Examples

```bash
export KINOLIKE_API_URL=http://localhost:3001/api/v1
export KINOLIKE_API_TOKEN='replace-me'

curl -sS -X POST "$KINOLIKE_API_URL/recommendations" \
  -H "Authorization: Bearer $KINOLIKE_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"Хочу детективный мини-сериал последних пяти лет","limit":10}'

curl -sS "$KINOLIKE_API_URL/profile/preferences" \
  -H "Authorization: Bearer $KINOLIKE_API_TOKEN"

curl -sS --get "$KINOLIKE_API_URL/search" --data-urlencode 'q=Дюна 2' \
  -H "Authorization: Bearer $KINOLIKE_API_TOKEN"

curl -sS "$KINOLIKE_API_URL/media/123" \
  -H "Authorization: Bearer $KINOLIKE_API_TOKEN"

curl -sS "$KINOLIKE_API_URL/watchlist" \
  -H "Authorization: Bearer $KINOLIKE_API_TOKEN"

curl -sS -X POST "$KINOLIKE_API_URL/watchlist" \
  -H "Authorization: Bearer $KINOLIKE_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Дюна 2","media_type":"movie"}'

curl -sS -X DELETE "$KINOLIKE_API_URL/watchlist/123" \
  -H "Authorization: Bearer $KINOLIKE_API_TOKEN"

curl -sS -X POST "$KINOLIKE_API_URL/watched" \
  -H "Authorization: Bearer $KINOLIKE_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"media_id":123,"rating":8,"watched_at":"2026-09-20"}'
```

## OpenAPI and verification

The source specification is `docs/openapi.v1.json`; at runtime it is served from `/api/v1/openapi.json`. Swagger UI is available at `/api/v1/docs` in development, or in production when `KINOLIKE_API_DOCS=true`.

Run:

```bash
npm test
docker compose up -d --build
curl -i "$KINOLIKE_API_URL/search?q=test" -H "Authorization: Bearer $KINOLIKE_API_TOKEN"
```

Expected errors always use `{ "error": { "code": "...", "message": "..." } }`. Rate-limit responses also include standard limit headers and `Retry-After` when applicable.
