# Server-wide member-count nickname — Implementation plan

Spec: `docs/superpowers/specs/2026-07-18-server-wide-member-count-design.md`

## Task 1 — Generalize `countChannelClients` (TDD)

- RED: add tests in `member-count.test.ts` for `channelId = null`:
  server-wide count across channels, music-bot exclusion, query-client
  exclusion still apply.
- GREEN: `countChannelClients(list, channelId: string | null, bots)` —
  skip the `cid` filter when `channelId` is `null`.

## Task 2 — Wire server-wide mode in `discord-bridge.ts`

- `countChannelMembers(channelId: string | null)`.
- `refreshMemberCountNickname()`: drop the `notifyChannelId` guard, count
  via `settings.notifyChannelId ?? null`.
- `startNicknameUpdater()`: remove the early return + `clearStaleCountSuffix()`
  (dead code — the feature is now always on).
- `startTsEventBridge()`: `wantsNickname` is always true; skip the nickname
  refresh on `notifyclientmoved` when no watched channel is set.

## Task 3 — i18n hint

- Update `watchChannelHint` in fr/en/de/es/it: empty selection = server-wide
  counter.

## Verification

- Backend: `pnpm --filter @ts6/backend typecheck` + `pnpm --filter @ts6/backend test`
- Frontend: `pnpm --filter @ts6/frontend build`
- Commit + push.
