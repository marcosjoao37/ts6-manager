# Connection journal (web + TeamSpeak) with GeoIP — design

**Date:** 2026-06-13

Logs who connects, when, from where: web logins to TS6 Manager and client
connections to the TeamSpeak server, each with login, timestamp, IP and a
GeoIP country (flag).

## Data model

`ConnectionLog` (Prisma):
- `source`: 'web' | 'teamspeak'
- `login`: username (web) or nickname (TS)
- `ip`: string
- `country`: ISO code, null for LAN/unknown
- `success`: bool (web: success/failed; TS: always true)
- `isBot`: bool (TS: the connecting client is one of our music bots)
- `serverConfigId`: int? (TS entries)
- `createdAt`: datetime, `@@index([source, createdAt])`

Retention: `AppSetting` key `journal.retentionDays` (default 90, 0 = keep
all). A purge runs at startup and once per day.

## GeoIP

`utils/geo.ts` using `geoip-lite` (bundled offline DB). `lookupCountry(ip)`
returns `{ country: ISO|null, isPrivate }`; private ranges (10/8, 172.16/12,
192.168/16, 127/8, ::1, fc00::/7) → `isPrivate`, no country. The flag is
rendered client-side from the ISO code (regional-indicator emoji), country
name on hover; LAN entries show a "LAN" chip.

## Web journal

In `/auth/login`, record every attempt with `req.ip` (trust proxy already
set): success and failure (failed = wrong password/disabled), storing the
attempted username. Recorded via a fire-and-forget helper so logging never
blocks or breaks auth.

## TeamSpeak journal

`ConnectionJournal` service owning its own `EventBridge` (mirrors the Discord
bridge), connecting to servers that have SSH credentials. On
`notifycliententerview` for real clients (client_type 0), it runs
`clientinfo clid=X` to get `connection_client_ip`, resolves the country, and
records. `isBot` is set when the clid matches a connected music bot of that
server (via VoiceBotManager). Extra SSH connection per server is acceptable
now that the source IP is allowlisted against anti-flood.

## API (admin)

- `GET /api/journal?source=web|teamspeak&hideBots=&page=&limit=` — paginated,
  newest first; `hideBots` filters out `isBot` rows.
- `GET/PUT /api/journal/retention` — retention days.

## UI

- Sidebar entry "Journal" (System section, admin), route `/journal`.
- Two tabs Web / TeamSpeak. Columns: login, date/time, IP, flag + country.
  Web adds a success/failed badge; TeamSpeak adds a "Hide bots" toggle
  (default on). Pagination.
- Settings → Users: "Connection journal retention (days)" field.

## Error handling

- GeoIP/clientinfo failures → store the row without a country, never throw.
- Journal writes are best-effort; a failure is logged, not surfaced to the
  user action that triggered it.

## Testing

Unit: `lookupCountry` (public IP → ISO, private → isPrivate) and the ISO →
flag emoji helper. SSH path validated manually.
