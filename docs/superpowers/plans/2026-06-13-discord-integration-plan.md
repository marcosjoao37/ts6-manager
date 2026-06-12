# Discord integration — implementation plan

Spec: `docs/superpowers/specs/2026-06-13-discord-integration-design.md`

## Task 1 — Data model & dependency
1. Prisma: add `DiscordSettings` model (single row, fields per spec).
2. `pnpm --filter @ts6/backend add discord.js`.

## Task 2 — Shared music ops
1. Create `voice/music-ops.ts`: `resolvePlayQuery(query)` (URL passthrough
   or YouTube search → first result), `downloadAndEnqueue(prisma, bot,
   url)` (download, QueueItem, history save, play-or-queue decision).
2. Refactor `MusicCommandHandler.handlePlay`/`handleQueue` to use it
   (behavior unchanged).

## Task 3 — DiscordBridge
1. `discord/embeds.ts`: pure builders — connect/disconnect, now-playing,
   stats, queue (testable without discord.js).
2. `discord/discord-bridge.ts`: lifecycle (start/stop/reload/status),
   guild slash-command registration, interaction dispatch → music ops /
   stats, own EventBridge for TS events, now-playing via
   `VoiceBotManager.onBotCreated`, live stats panel timer.
3. `VoiceBotManager`: add `onBotCreated(cb)` hook next to the existing
   music-command-handler registration.

## Task 4 — API & wiring
1. `routes/discord.routes.ts` (admin): GET/PUT settings (token encrypted,
   masked on read; PUT triggers `bridge.reload()`), GET status, GET
   channels.
2. Mount in app.ts; instantiate + start bridge in index.ts; graceful stop
   on shutdown.

## Task 5 — Frontend
1. `api/discord.api.ts` + Settings → Discord tab (admin only): form,
   status badge, channel dropdowns from `/api/discord/channels`.

## Task 6 — Validation
Unit tests (embeds, music-ops with mocks), typecheck backend + frontend,
full test suite, commit, push. Manual E2E on the user's Discord (token
created on the Discord Developer Portal, bot invited with
`applications.commands` + `bot` scopes).
