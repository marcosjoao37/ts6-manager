# Discord Member-Count Nickname + Music-Bot Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Discord bot's guild nickname shows the watched TS channel's member count (`E-Odyssey (4)`), and TS music bots are excluded from every count and every join/leave/AFK notification.

**Architecture:** A new pure module `packages/backend/src/discord/member-count.ts` holds all testable logic (music-bot matching, channel counting, nickname formatting). `DiscordBridge` builds a `MusicBotIdentity` (clids + nicknames of running voice bots) at each use, filters events and counts through it, and renames the bot via `guild.members.me.setNickname()` — triggered by TS presence events plus a 60 s refresh timer, deduplicated against the last applied name.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), discord.js v14, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-discord-member-count-nickname-design.md`.
- Nickname format: `Base (N)` when N ≥ 1, plain `Base` when N = 0. Discord nickname hard limit: 32 characters.
- Music bot = TS client whose clid matches a running voice bot's `ts3ClientId` (0 = not connected, never matches), OR whose nickname matches a running bot's configured nickname (connect-window fallback).
- Test descriptions in French (matches `away-diff.test.ts`); code comments in English.
- Commands run from the repo root; the backend package is `@ts6/backend`.

---

### Task 1: Pure module `member-count.ts`

**Files:**
- Create: `packages/backend/src/discord/member-count.ts`
- Test: `packages/backend/src/discord/member-count.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 2 and 3):
  - `interface MusicBotIdentity { clids: Set<string>; nicknames: Set<string> }`
  - `isMusicBotClient(clid: string, nickname: string, bots: MusicBotIdentity): boolean`
  - `countChannelClients(list: unknown, channelId: string, bots: MusicBotIdentity): number`
  - `stripCountSuffix(name: string): string`
  - `formatCountNickname(base: string, count: number): string`

- [ ] **Step 1: Write the failing tests**

Create `packages/backend/src/discord/member-count.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  isMusicBotClient,
  countChannelClients,
  stripCountSuffix,
  formatCountNickname,
  type MusicBotIdentity,
} from './member-count.js';

const bots = (clids: string[] = [], nicknames: string[] = []): MusicBotIdentity => ({
  clids: new Set(clids),
  nicknames: new Set(nicknames),
});

describe('isMusicBotClient', () => {
  it('reconnaît un music bot par son clid', () => {
    expect(isMusicBotClient('42', 'Peu importe', bots(['42']))).toBe(true);
  });

  it('reconnaît un music bot par son nickname (fenêtre de connexion)', () => {
    expect(isMusicBotClient('99', 'MusicBot', bots([], ['MusicBot']))).toBe(true);
  });

  it('ne matche pas un client ordinaire', () => {
    expect(isMusicBotClient('7', 'Guillaume', bots(['42'], ['MusicBot']))).toBe(false);
  });
});

describe('countChannelClients', () => {
  const list = [
    { clid: '1', cid: '5', client_type: '0', client_nickname: 'Alice' },
    { clid: '2', cid: '5', client_type: '0', client_nickname: 'Bob' },
    { clid: '3', cid: '5', client_type: '1', client_nickname: 'serveradmin' }, // query client
    { clid: '4', cid: '9', client_type: '0', client_nickname: 'Ailleurs' },   // other channel
    { clid: '42', cid: '5', client_type: '0', client_nickname: 'MusicBot' },  // music bot
  ];

  it('compte les vrais clients du canal, music bots exclus', () => {
    expect(countChannelClients(list, '5', bots(['42']))).toBe(2);
  });

  it('exclut aussi par nickname quand le clid est inconnu', () => {
    expect(countChannelClients(list, '5', bots([], ['MusicBot']))).toBe(2);
  });

  it('retourne 0 sur une réponse non-tableau', () => {
    expect(countChannelClients({ error: 'x' }, '5', bots())).toBe(0);
  });
});

describe('stripCountSuffix', () => {
  it('retire un suffixe " (N)" final', () => {
    expect(stripCountSuffix('E-Odyssey (4)')).toBe('E-Odyssey');
  });

  it('laisse un nom sans suffixe intact', () => {
    expect(stripCountSuffix('E-Odyssey')).toBe('E-Odyssey');
  });

  it('ne retire pas une parenthèse non numérique', () => {
    expect(stripCountSuffix('Team (FR)')).toBe('Team (FR)');
  });
});

describe('formatCountNickname', () => {
  it('affiche "Base (N)" quand N ≥ 1', () => {
    expect(formatCountNickname('E-Odyssey', 4)).toBe('E-Odyssey (4)');
  });

  it('affiche le nom seul quand N = 0', () => {
    expect(formatCountNickname('E-Odyssey', 0)).toBe('E-Odyssey');
  });

  it('respecte la limite Discord de 32 caractères', () => {
    const long = 'A'.repeat(32);
    const result = formatCountNickname(long, 12);
    expect(result.length).toBeLessThanOrEqual(32);
    expect(result.endsWith(' (12)')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ts6/backend test src/discord/member-count.test.ts`
Expected: FAIL — `Cannot find module './member-count.js'` (ou équivalent).

- [ ] **Step 3: Write the implementation**

Create `packages/backend/src/discord/member-count.ts`:

```ts
/** Identity of the running TS music bots, used to exclude them from
 *  member counts and presence notifications. */
export interface MusicBotIdentity {
  clids: Set<string>;
  nicknames: Set<string>;
}

/** True when the given TS client is one of our music bots — by clid, with a
 *  nickname fallback for the connect window where the clid is not yet known. */
export function isMusicBotClient(clid: string, nickname: string, bots: MusicBotIdentity): boolean {
  return bots.clids.has(clid) || bots.nicknames.has(nickname);
}

/** Number of real clients in the given channel, music bots excluded. */
export function countChannelClients(list: unknown, channelId: string, bots: MusicBotIdentity): number {
  return (Array.isArray(list) ? list : []).filter(
    (c: any) =>
      String(c.cid) === channelId &&
      String(c.client_type) === '0' &&
      !isMusicBotClient(String(c.clid), c.client_nickname || '', bots),
  ).length;
}

/** Strip a trailing " (N)" member-count suffix from a bot display name. */
export function stripCountSuffix(name: string): string {
  return name.replace(/\s*\(\d+\)$/, '');
}

const DISCORD_NICKNAME_MAX = 32;

/** "Base (N)" when N ≥ 1, plain base when 0 — capped at Discord's 32-char limit. */
export function formatCountNickname(base: string, count: number): string {
  if (count < 1) return base.slice(0, DISCORD_NICKNAME_MAX);
  const suffix = ` (${count})`;
  return base.slice(0, DISCORD_NICKNAME_MAX - suffix.length) + suffix;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ts6/backend test src/discord/member-count.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/discord/member-count.ts packages/backend/src/discord/member-count.test.ts
git commit -m "feat(discord): pure member-count helpers with music-bot exclusion"
```

---

### Task 2: Exclude music bots from counts and notifications in `DiscordBridge`

**Files:**
- Modify: `packages/backend/src/discord/discord-bridge.ts` (imports; `seedClientState`; `pollAwayState`; `onTsEvent`; `countChannelMembers`)

**Interfaces:**
- Consumes (Task 1): `isMusicBotClient`, `countChannelClients`, `MusicBotIdentity`.
- Produces (Task 3): `private musicBotIdentity(): MusicBotIdentity` and the updated `private async countChannelMembers(channelId: string): Promise<number>` (music bots already excluded).

- [ ] **Step 1: Add the import**

In `discord-bridge.ts`, after the `away-diff.js` import (line ~40):

```ts
import { isMusicBotClient, countChannelClients, type MusicBotIdentity } from './member-count.js';
```

- [ ] **Step 2: Add the `musicBotIdentity()` helper**

Just above `countChannelMembers` (section `─── TS connect/disconnect notifications` utilities, ~line 719):

```ts
/** Identity (clids + configured nicknames) of the currently running music bots. */
private musicBotIdentity(): MusicBotIdentity {
  const clids = new Set<string>();
  const nicknames = new Set<string>();
  for (const { bot } of this.voiceBotManager.getAllBots()) {
    if (bot.ts3ClientId > 0) clids.add(String(bot.ts3ClientId));
    if (bot.currentConfig.nickname) nicknames.add(bot.currentConfig.nickname);
  }
  return { clids, nicknames };
}
```

- [ ] **Step 3: Filter music bots out of `countChannelMembers`**

Replace the body's filter with the pure helper. The method becomes:

```ts
/** Number of real clients currently in the given TS channel (music bots excluded). */
private async countChannelMembers(channelId: string): Promise<number> {
  const settings = this.settings;
  if (!settings?.serverConfigId) return 0;
  try {
    const client = await this.pool.getOrLoad(settings.serverConfigId);
    const list = await client.execute(settings.virtualServerId, 'clientlist');
    return countChannelClients(list, channelId, this.musicBotIdentity());
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Skip music bots in `onTsEvent`**

In the `notifycliententerview` branch, insert the exclusion right after `nickname`/`channelId` are computed and BEFORE the `clientNicknames.set(...)` calls (music bots must never enter the tracking maps, so their later `notifyclientleftview` is a no-op):

```ts
if (isMusicBotClient(clid, nickname, this.musicBotIdentity())) return; // never track or announce music bots
```

In the `notifyclientmoved` branch, insert right after `const clid = String(data.clid);`:

```ts
if (this.musicBotIdentity().clids.has(clid)) return; // music bots move silently
```

(The `notifyclientleftview` branch needs no change: bots never enter `clientNicknames`, so the existing `if (!nickname) return;` drops them.)

- [ ] **Step 5: Skip music bots in `seedClientState` and the AFK poll**

In `seedClientState`, inside the `for` loop, after the `client_type` check:

```ts
const bots = this.musicBotIdentity();
for (const c of Array.isArray(list) ? list : []) {
  if (String(c.client_type) !== '0') continue;
  if (isMusicBotClient(String(c.clid), c.client_nickname || '', bots)) continue;
  // ... existing map seeding unchanged
```

(`bots` is computed once before the loop.)

In `pollAwayState`, filter the mapped clients:

```ts
const bots = this.musicBotIdentity();
const current: AwayClient[] = mapAwayClients(list, watchedChannel)
  .filter((c) => !isMusicBotClient(c.clid, c.nickname, bots));
```

- [ ] **Step 6: Typecheck and run the test suite**

Run: `pnpm --filter @ts6/backend typecheck && pnpm --filter @ts6/backend test`
Expected: no type errors, all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/discord/discord-bridge.ts
git commit -m "feat(discord): exclude music bots from member counts and presence notifications"
```

---

### Task 3: Dynamic member-count nickname

**Files:**
- Modify: `packages/backend/src/discord/discord-bridge.ts` (imports; constants; fields; `ClientReady` handler; `stop()`; the `tsEvent` listener in `startTsEventBridge`; new private methods)

**Interfaces:**
- Consumes (Tasks 1–2): `stripCountSuffix`, `formatCountNickname`, `countChannelMembers(channelId)`.
- Produces: nothing consumed later — terminal task.

- [ ] **Step 1: Extend the import and add the constant**

Extend the Task 2 import:

```ts
import {
  isMusicBotClient,
  countChannelClients,
  stripCountSuffix,
  formatCountNickname,
  type MusicBotIdentity,
} from './member-count.js';
```

Next to `STATS_PANEL_INTERVAL_MS` / `AWAY_POLL_INTERVAL_MS` (~line 42):

```ts
const NICKNAME_REFRESH_INTERVAL_MS = 60_000;
```

- [ ] **Step 2: Add the state fields**

Next to `statsTimer` / `awayTimer` in the class fields:

```ts
private nicknameTimer: ReturnType<typeof setInterval> | null = null;
private baseNickname: string | null = null;
private lastAppliedNickname: string | null = null;
private nicknameWarned = false;
```

- [ ] **Step 3: Add the updater methods**

New section after the AFK methods (`notifyAwayChange`, ~line 650):

```ts
// ─── Member-count nickname ──────────────────────────────────

/** Start the periodic member-count nickname refresh (watched-channel mode only). */
private startNicknameUpdater(): void {
  if (!this.settings?.notifyChannelId) return;
  const epoch = this.startEpoch;
  const tick = () => {
    if (epoch !== this.startEpoch) return;
    this.refreshMemberCountNickname().catch((err) => {
      console.error(`[Discord] Nickname refresh failed: ${err.message}`);
    });
  };
  this.nicknameTimer = setInterval(tick, NICKNAME_REFRESH_INTERVAL_MS);
  tick();
}

/** Rename the bot to "Base (N)", N = watched-channel members (music bots excluded). */
private async refreshMemberCountNickname(): Promise<void> {
  const settings = this.settings;
  if (!settings?.notifyChannelId) return;
  const me = this.guild()?.members?.me;
  if (!me) return;

  if (this.baseNickname === null) this.baseNickname = stripCountSuffix(me.displayName);
  const count = await this.countChannelMembers(settings.notifyChannelId);
  const desired = formatCountNickname(this.baseNickname, count);
  if (desired === this.lastAppliedNickname) return;

  try {
    await me.setNickname(desired);
    this.lastAppliedNickname = desired;
  } catch (err: any) {
    if (!this.nicknameWarned) {
      this.nicknameWarned = true;
      const warning = `Cannot update bot nickname: ${err.message} (missing "Change Nickname" permission?)`;
      this.warnings.push(warning);
      console.warn(`[Discord] ${warning}`);
    }
  }
}
```

- [ ] **Step 4: Wire up start, stop and event triggers**

In the `Events.ClientReady` handler, after `this.startStatsPanel();`:

```ts
this.startNicknameUpdater();
```

In `stop()`, after the `awayTimer` cleanup block:

```ts
if (this.nicknameTimer) {
  clearInterval(this.nicknameTimer);
  this.nicknameTimer = null;
}
this.baseNickname = null;
this.lastAppliedNickname = null;
this.nicknameWarned = false;
```

In `startTsEventBridge`, the `tsEvent` listener already has an `if` matching the three presence events (used for logging). Add the refresh there so every relevant TS event re-syncs the name:

```ts
this.eventBridge.on('tsEvent', (_configId, _sid, eventName, data) => {
  if (eventName === 'notifycliententerview' || eventName === 'notifyclientmoved' || eventName === 'notifyclientleftview') {
    console.log(`[Discord] TS event ${eventName}: clid=${data.clid} ctid=${data.ctid ?? ''} cfid=${data.cfid ?? ''} type=${data.client_type ?? ''}`);
    this.refreshMemberCountNickname().catch(() => { /* logged in the periodic path */ });
  }
  this.onTsEvent(eventName, data).catch((err) => {
    console.error(`[Discord] TS event handling failed: ${err.message}`);
  });
});
```

- [ ] **Step 5: Typecheck and run the test suite**

Run: `pnpm --filter @ts6/backend typecheck && pnpm --filter @ts6/backend test`
Expected: no type errors, all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/discord/discord-bridge.ts
git commit -m "feat(discord): bot nickname shows watched-channel member count"
```

---

## Manual verification (post-implementation)

On the live server (deploy per repo conventions: push, pull + rebuild on the VM):
1. Watched channel empty → bot shows `E-Odyssey` (no suffix).
2. Two users join the watched channel → bot shows `E-Odyssey (2)` within seconds; join notifications show `{totalMembers}` = 2.
3. Start the music bot into the watched channel → count unchanged, no join notification for it.
4. Music bot leaves/stops → no leave notification, count unchanged.
5. Remove the bot's "Change Nickname" permission → warning appears in Settings → Discord status, no crash.
