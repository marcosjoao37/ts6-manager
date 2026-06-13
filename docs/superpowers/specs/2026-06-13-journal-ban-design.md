# Ban from the connection journal — design

**Date:** 2026-06-13

Add a ban action to the connection journal (Web and TeamSpeak tabs). From any
row, an admin can block the IP at the web login, ban it on TeamSpeak, or both,
with a configurable duration.

## Backend

**Web ban** — new Prisma model `WebBan { id, ip @unique, reason?, expiresAt?
(null = permanent), createdAt }`. In `POST /auth/login`, before
authentication, reject with 403 if `req.ip` matches an active web ban
(expiresAt null or in the future). Expired rows are ignored and best-effort
purged.

**TeamSpeak ban** — WebQuery `banadd { ip, time, banreason }` on every enabled
server with a loadable connection (sid = its virtual server 1). `time=0` =
permanent; otherwise seconds. Per-server results/errors are collected, not
fatal. These appear in the existing Bans page (revocable there).

**Endpoints (admin):**
- `POST /api/journal/ban` `{ ip, targets: ('web'|'teamspeak')[], durationMinutes, reason }`
  → applies the selected bans; web uses `expiresAt = durationMinutes>0 ?
  now + minutes : null`; teamspeak uses `time = durationMinutes*60`. Returns
  `{ web?: {...}, teamspeak?: { perServer: [...] } }`.
- `GET /api/journal/web-bans` → active web bans.
- `DELETE /api/journal/web-bans/:id` → revoke a web ban.

A reusable `isIpWebBanned(prisma, ip)` helper backs the login check.

## Frontend (Journal page)

- A ban icon button on each row → BanDialog showing the IP (read-only) and the
  login for context, two checkboxes "Block web login" / "Ban on TeamSpeak"
  (the one matching the current tab pre-checked; both selectable from either
  tab), a duration field (minutes, 0 = permanent) and a reason field. Submit →
  `POST /api/journal/ban`, toast the summary.
- A "Web bans" button in the header → dialog listing active web bans (IP,
  reason, expiry) with a revoke action each.

## Error handling

- Banning an empty/unknown IP is rejected client- and server-side.
- A TS `banadd` failure on one server is reported but doesn't abort the others
  or the web ban.

## Testing

Unit: `isIpWebBanned` (active vs expired vs absent) and the
targets→duration mapping (minutes → web expiresAt / TS seconds).
