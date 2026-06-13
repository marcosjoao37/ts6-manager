# Discord nodes in Bot Flows — design

**Date:** 2026-06-13
Sub-project B of the (journal → Discord flow nodes → i18n) split.

Adds a Discord message trigger and a Discord send-message action to the bot
flow engine, mirroring the existing TS triggers/actions.

## Backend

- **Types** (`common/bot.ts`):
  - `DiscordMessageTriggerData` — `triggerType:'discordMessage'`, `channelId`,
    `prefix?` (only fire when the message starts with it).
  - `DiscordSendActionData` — `actionType:'discordSend'`, `channelId`,
    `message`.
- **Node normalization** (`engine.ts`): `trigger_discordMessage` and
  `action_discordSend` map to the above data shapes.
- **DiscordBridge**:
  - New `DiscordSettings.flowMessageTrigger` (bool). When on, the client adds
    the `GuildMessages` + `MessageContent` (privileged) intents and emits
    `{ channelId, content, authorId, authorName }` on MessageCreate (bots
    ignored) to a registered handler. When off, no privileged intent is
    requested.
  - `sendFlowMessage(channelId, content)` — posts to a channel (reuses
    postToChannel).
- **BotEngine**: `setDiscordBridge(bridge)`; `handleDiscordMessage(msg)`
  finds enabled flows whose trigger is `discordMessage` with a matching
  `channelId` (and `prefix`, if set), then `executeFlow(flow, nodeId,
  'discordMessage', { discord_content, discord_channel_id, discord_author,
  discord_author_id })`. SSH is not required for these triggers.
- **FlowRunner**: `setDiscordBridge(bridge)` + `executeDiscordSend` (case
  `discordSend`) resolves `{{variables}}` and sends via the bridge.
- **Wiring** (`index.ts`): after both exist,
  `botEngine.setDiscordBridge(discordBridge)`,
  `flowRunner` gets it through the engine, and
  `discordBridge.setMessageHandler(msg => botEngine.handleDiscordMessage(msg))`.

## Frontend

- **BotEditor**: a "Discord" palette category with `trigger_discordMessage`
  (channel + optional prefix) and `action_discordSend` (channel + message).
  Channels come from `/api/discord/channels` (text-channel dropdown, raw ID
  fallback).
- **Settings → Discord**: a "Enable flow message triggers" toggle with a note
  that the Message Content intent must also be enabled in the Discord
  developer portal.

## Error handling

- Message handler ignores bot authors and unwatched channels; a send to a
  missing channel/permission is logged, not fatal to the flow.
- Bridge hot-reload re-applies the intent set when the toggle changes.

## Testing

Unit test on the message→flow matching (channel match, prefix match/no-match,
disabled flows skipped).
