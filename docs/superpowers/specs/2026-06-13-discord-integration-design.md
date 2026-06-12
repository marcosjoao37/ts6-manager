# Discord integration — design

**Date:** 2026-06-13
**Goal:** Control the TS music bots, read TS server stats, and receive TS
connect/disconnect + now-playing notifications from Discord.

Approach chosen: native backend module (`packages/backend/src/discord/`)
using discord.js v14 — a persistent gateway connection with guild-scoped
slash commands, plugged directly into the existing building blocks
(VoiceBotManager, EventBridge, WebQuery pool). Webhook-only (no commands)
and separate-microservice approaches were rejected.

## Configuration

- New Prisma model `DiscordSettings` (single row): `enabled`, `botToken`
  (AES-256-GCM encrypted, write-only in the API), `guildId`,
  `notificationsChannelId`, `statsChannelId`, `statsLiveEnabled`,
  `statsMessageId` (persisted live-panel message), `defaultMusicBotId`,
  `serverConfigId`, `virtualServerId` (stats + events source).
- WebUI: new admin tab **Settings → Discord** — enable toggle, token field
  (placeholder "unchanged"), guild ID, channel pickers populated from the
  connected bot (`GET /api/discord/channels`), default music bot select,
  live-panel toggle, connection status indicator.
- Routes (admin only): `GET/PUT /api/discord/settings`,
  `GET /api/discord/status`, `GET /api/discord/channels`.
- Saving settings hot-reloads the bridge — no backend restart, ever.

## DiscordBridge service

- Starts when `enabled` with a valid token; `Guilds` intent only (no
  privileged intents). Status (running / token error / disconnected) exposed
  for the UI. discord.js handles reconnection and rate limits.
- Registers guild-scoped slash commands (instant propagation): `/play
  <query>` (URL or YouTube search), `/stop`, `/pause` (toggle), `/skip`,
  `/queue`, `/volume <0-100>`, `/nowplaying`, `/stats`. Music commands drive
  the configured default music bot.
- Shared core: the play/queue logic (download, enqueue, history, play-or-
  queue) is extracted from MusicCommandHandler into `voice/music-ops.ts`,
  used by both the TS chat commands and Discord.
- Discord-side permissions are managed natively by Discord (Server Settings
  → Integrations); nothing to implement.

## Notifications

- TS connect/disconnect: the bridge owns its own EventBridge instance
  (independent from the flow engine's, so engine SSH cleanup can't kill it)
  connected to the configured server; on `notifycliententerview` (reasonid
  0, real clients only) / `notifyclientleftview`, posts an embed to the
  notifications channel.
- Now playing: VoiceBotManager gains an `onBotCreated` hook; the bridge
  attaches a `nowPlaying` listener to every bot and posts "🎵 Now playing"
  embeds.

## Stats

- `/stats` replies with an embed (online users, channels, uptime,
  bandwidth) using the same WebQuery commands as the dashboard.
- Optional live panel: one pinned message in `statsChannelId`, edited every
  60 s while enabled; `statsMessageId` persisted across restarts.

## Error handling

- Invalid token → status error in the UI, no crash, bridge stays stopped.
- Deleted channel / missing permissions → log once, skip that feature.
- TS SSH credentials missing → connect/disconnect notifications disabled
  with a clear warning in the status payload.

## Testing

- Unit tests on embed formatting (pure) and on the shared music-ops logic
  with mocked bot/prisma. Slash-command E2E validated manually on the real
  Discord server.
