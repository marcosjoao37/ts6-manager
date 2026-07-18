# Server-wide member-count nickname — Design

**Date**: 2026-07-18
**Status**: Approved

## Problem

The Discord bot's member-count nickname ("E-Odyssey (4)") only works when a
watched TS channel is configured. When the setting is "Tout le serveur"
(no watched channel), the counter is disabled entirely.

## Requirement

When no watched channel is configured, the nickname counter must reflect the
total number of real clients connected to the TS server, music bots excluded.

- Watched channel set → current behaviour unchanged (channel count).
- No watched channel → server-wide count.
- 0 connected → plain base name, no suffix (unchanged rule).
- Music bots excluded by clid + active-nickname fallback (unchanged rule).
- Query clients (client_type 1) excluded (unchanged rule).

## Design

Generalize the existing helper instead of duplicating it:

1. **`member-count.ts`** — `countChannelClients(list, channelId, bots)` accepts
   `channelId: string | null`; `null` means whole server (skip the `cid`
   filter, keep `client_type === '0'` and music-bot filters).
2. **`discord-bridge.ts`**
   - `startNicknameUpdater()`: remove the no-watched-channel early return —
     the periodic refresh always runs. `clearStaleCountSuffix()` becomes dead
     code and is removed.
   - `refreshMemberCountNickname()`: count via `notifyChannelId ?? null`.
   - `countChannelMembers()`: accepts `string | null`.
   - `startTsEventBridge()`: the nickname feature always wants presence
     events, so the bridge starts whenever a TS server is configured (SSH
     credentials permitting). In whole-server mode, `notifyclientmoved`
     events do not trigger a nickname refresh (a move never changes the
     server total).
3. **Frontend/i18n** — update `watchChannelHint` in the 5 locales: empty
   selection now means the counter shows the server-wide count.
4. **Tests** — `member-count.test.ts`: `channelId = null` cases (counts across
   channels, still excludes music bots and query clients).

## Side effect (accepted)

The SSH event bridge now starts even when notifications are off and no
channel is watched — required for instant counter updates in server mode.

## Alternatives considered

Separate `countServerClients()` helper — rejected: duplicates the same
filters for no benefit.
