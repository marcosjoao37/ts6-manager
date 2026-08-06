# Changelog

Notable changes to TS6 Manager. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Started at the 2026-08-06 security review; earlier history is in the git log.

## [Unreleased]

### Security

Full security review of the codebase. Twelve issues, three of them high severity.

- **MFA bypass via JWT token-class confusion** (high). Access, MFA-challenge and
  forced-password-change tokens were all HS256 over the same secret with no
  discriminator any verifier read. The challenge token issued after the password
  step alone was therefore accepted as a full session, so knowing a password was
  enough to reach admin without the second factor. Tokens now carry a `typ`
  claim, asserted in `authMiddleware`, both short-lived token verifiers and the
  WebSocket handshake; `req.user` is built field by field instead of spreading
  the payload. Regression cover in `middleware/auth.test.ts`.
- **Bot-flow secrets readable by any account** (high). `GET /api/bots` and
  `GET /api/bots/:id` had no role guard while the writes did, exposing webhook
  secrets — the only control on the unauthenticated webhook endpoint — plus
  HTTP-action `Authorization` headers and channel passwords. Router is admin-only.
- **yt-dlp argument injection** (high). A URL beginning with `-` was parsed as an
  option; `--config-location` loads a config file that can carry `--exec`,
  giving command execution on the host. Every call site now rejects such URLs and
  places a literal `--` before the positional.
- **WebSocket had no authorization.** It accepted any signed token, never
  re-checked whether the account was still enabled, and broadcast every server's
  events to every socket. It now verifies the token class, confirms the account,
  and scopes each event by `serverConfigId`.
- **SSH host key was never verified.** Without a `hostVerifier`, ssh2 accepts any
  host key, handing the ServerQuery password to a machine-in-the-middle. The
  SHA-256 fingerprint is pinned on first connect and a change is refused.
- **Unguarded reads that crossed a privilege boundary.** `privilegekeylist`
  (redeemable as TeamSpeak Server Admin), the widget list (tokens for every
  server), and `clientdblist` / `clientdbinfo` / `banlist` / `logview` (the
  client IPs the existing control on `clientlist` deliberately withholds) are
  now admin-only.
- **SSRF from music commands.** `!play` / `!queue` / `!stream` reach yt-dlp and
  the sidecar's ffmpeg and are open to any TeamSpeak or Discord user when no
  command server-group is configured. URLs are now checked with `validateUrl`,
  matching the radio path.
- **MFA recovery codes had 32 bits of entropy** for a credential that replaces
  the second factor outright. Raised to 64 bits; comparison is constant-time.
- **Media sidecar.** Accepted local filesystem paths as an ffmpeg input, letting
  a caller relay host files to stream viewers, and served unauthenticated
  requests when `SIDECAR_TOKEN` was unset. Restricted to `http(s)` and fails
  closed; the backend mints a random token per spawn, so local mode needs no
  configuration.

### Changed

- **BREAKING — `JWT_SECRET` and `ENCRYPTION_KEY` are now required in every
  environment**, minimum 32 characters. They previously fell back to a published
  default, and the guard only fired when `NODE_ENV` was exactly `production`,
  so any deployment run directly, under pm2 or under systemd shipped a known
  signing key. The backend now refuses to start without them.
- **BREAKING — `SIDECAR_TOKEN` is required when the sidecar runs as its own
  container** (`SIDECAR_URL` set). Generate one with `openssl rand -hex 32`.
  Not needed when the backend spawns the sidecar itself.
- `ENCRYPTION_KEY` no longer falls back to `JWT_SECRET`. Existing values stay
  readable: `decrypt` retains its legacy-key path.

### Fixed

- Self-service MFA enrolment always returned 401. `/mfa/setup` and `/mfa/enable`
  sit on the public `/api/auth` mount, so `authMiddleware` never ran and
  `req.user` was always undefined, leaving MFA effectively impossible to turn on
  from the Account tab.

### Added

- `packages/sidecar/ts6-media-sidecar[.exe]` is gitignored, so the compiled Go
  binary cannot be committed.
