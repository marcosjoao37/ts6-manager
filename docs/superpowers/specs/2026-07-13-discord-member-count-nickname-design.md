# Discord member-count nickname + music-bot exclusion — design

**Date:** 2026-07-13
**Goal:** The Discord bot's guild nickname reflects the number of clients
connected to the watched TS channel (e.g. `E-Odyssey (4)`), and the TS music
bots are never counted anywhere — neither in the nickname count nor in the
join/leave/AFK notifications (counter or triggered events).

Approach chosen: event-driven updates with a periodic resync — reuse the
existing EventBridge events (enter/move/left on the watched channel) as
triggers, plus a 60 s refresh to self-heal drift. A dedicated polling loop
was rejected (redundant with the event infrastructure already in place).

## Music-bot identification

- A TS client is a music bot when its `clid` matches the `ts3ClientId` of a
  running bot in `voiceBotManager.getAllBots()`. The clid set is rebuilt at
  each use (trivial in-memory operation).
- Fallback (connect window where the clid is not yet known): a client whose
  nickname equals a configured music bot nickname is also excluded.

## Counting exclusion

- `countChannelMembers()` filters out music-bot clids in addition to the
  existing `client_type === '0'` filter. This automatically fixes
  `{totalMembers}` in join/leave and AFK notifications.

## Notification exclusion

- In `onTsEvent()`, any event (enter/move/left) whose `clid` is a music bot
  is ignored — no Discord notification is emitted for it.
- Same exclusion in the AFK diff (`pollAwayState`).

## Dynamic bot nickname

- Updated via `guild.members.me.setNickname()`.
- Base name: the bot's current display name with any trailing ` (N)` suffix
  stripped (regex), captured once at bridge start.
- Format: `Base (N)` when N ≥ 1, plain `Base` when N = 0.
- Triggers: after each TS event affecting the watched channel, plus the 60 s
  periodic refresh.
- Anti-spam: no API call when the computed name equals the last applied one
  (Discord rate-limits nickname changes).
- Missing "Change Nickname" permission → warning in the status payload, no
  crash.
- Active only when a watched channel (`notifyChannelId`) is configured.

## Testing

- Pure logic extracted into testable functions (same pattern as
  `away-diff.ts`): nickname formatting, suffix stripping, music-bot
  filtering of a clientlist. Unit tests on those; live behaviour validated
  manually on the real Discord server.
