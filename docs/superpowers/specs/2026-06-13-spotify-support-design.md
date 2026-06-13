# Spotify link support — design

**Date:** 2026-06-13
**Goal:** Play Spotify track/album links from TS chat (`!play`) and Discord
(`/play`). Adapted from upstream PR #70 (vinookie:feature/spotify-links).

## Principle

Spotify does not allow audio downloads. We use the Spotify Web API only to
resolve **metadata** (title, artist, album, duration, ISRC) from a track or
album link, then find the best matching YouTube video and play from there
via the existing yt-dlp pipeline. Playback is always YouTube; Spotify is a
metadata source.

Divergence from the PR: configuration lives in the DB and is edited in the
WebUI (no `.env`), consistent with the Discord/connection settings.

## Configuration

- New Prisma model `SpotifySettings` (single row): `enabled`, `clientId`,
  `clientSecret` (AES-256-GCM encrypted, write-only in the API),
  `maxAlbumTracks` (default 50).
- Settings → Spotify tab (admin): enable toggle, client ID, client secret
  (placeholder "unchanged"), max album tracks. A note explains playback is
  via YouTube and links to the Spotify developer dashboard.
- Routes (admin): `GET/PUT /api/spotify/settings`. No hot-reload object
  needed — config is read from the DB per request, token cached in-process.

## Resolver (`voice/audio/spotify.ts`)

- `resolveSpotifyInput(input, config)`: parses track/album URL or URI,
  fetches metadata via the client-credentials API (token cached, with
  album pagination), returns `{ type, name, tracks[] }`.
- `findBestYouTubeForSpotify(track)`: multi-query YouTube search, scores
  candidates (title/artist token overlap, duration proximity, penalties for
  live/cover/remix/reaction), throws if no reliable match (score < 20).
- Functions take an explicit `SpotifyConfig` (clientId, clientSecret,
  requestTimeoutMs); token cache keyed by clientId. No `process.env`.

## Integration (`voice/music-ops.ts`)

- `loadSpotifyConfig(prisma)`: returns config or null (disabled / not set).
- `isSpotifyUrl(s)`: cheap detection.
- `enqueueSpotify(prisma, bot, config, url)`: resolve → cap at
  maxAlbumTracks → per track, find YouTube + `downloadAndEnqueue` (first
  track plays if idle, rest queue — reusing existing logic). Returns a
  summary `{ type, name, added, failed }`. Per-track failures are collected,
  not fatal.
- TS `handlePlay` and Discord `/play` detect Spotify URLs and route to
  `enqueueSpotify`; otherwise the current path is unchanged. A `!spotify`
  alias is kept on TS for discoverability.

## Error handling

- Spotify not configured → friendly message ("Spotify non configuré dans
  Settings → Spotify"), no crash.
- Invalid link / no YouTube match → reported per track; album continues.
- API/token errors surface the HTTP status.

## Testing

Unit tests on URL parsing and candidate scoring (pure logic); resolver/API
paths validated manually with real credentials.
