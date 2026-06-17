# Music Bot — Group Restriction, Membership UI & TS Now-Playing Notif — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add (1) two-tier server-group restriction on Music Bot chat commands, (2) add/remove server-group members from the ServerGroups WebUI page, and (3) an optional "now playing" notification posted in the bot's TeamSpeak channel, toggleable via WebUI and a `!notif` command.

**Architecture:** A new global singleton `MusicCommandSettings` table holds the two restriction group IDs and the notify flag. `MusicCommandHandler` (which already handles `!`-commands over each bot's TS connection) gains: a short-lived settings cache, a pre-execution access check using pure helpers in a new `music-command-access.ts` module, a `!notif` toggle, and a `nowPlaying` listener that posts to the bot's channel. The frontend adds a Settings tab and member add/remove actions on the existing ServerGroups page (backend member routes already exist).

**Tech Stack:** TypeScript, Prisma 6 (singleton settings pattern), Express, React + react-query, Radix UI, Vitest, i18next (5 locales + source fragments).

**Spec:** `docs/superpowers/specs/2026-06-17-music-bot-groups-notif-design.md`

---

## File Structure

Backend:
- `packages/backend/prisma/schema.prisma` — add `MusicCommandSettings` model (+ migration).
- `packages/backend/src/voice/music-command-access.ts` — **new**, pure helpers (classification, required sgid, group-id parsing). Unit-tested.
- `packages/backend/src/voice/music-command-access.test.ts` — **new**, Vitest unit tests.
- `packages/backend/src/routes/music-command-settings.routes.ts` — **new**, GET/PUT singleton (admin).
- `packages/backend/src/app.ts` — import + mount the new route.
- `packages/backend/src/voice/music-command-handler.ts` — settings cache, access check, `!notif`, `nowPlaying` listener, help entry.

Frontend:
- `packages/frontend/src/api/music-command-settings.api.ts` — **new**.
- `packages/frontend/src/hooks/use-groups.ts` — add member add/remove mutation hooks.
- `packages/frontend/src/pages/ServerGroups.tsx` — add-member dialog + remove buttons.
- `packages/frontend/src/pages/Settings.tsx` — new "Music Bot" tab + `MusicCommandsTab`.
- `packages/frontend/src/i18n/locales/{fr,en,de,es,it}.json` — new keys.
- `packages/frontend/scripts/i18n-fragments/{serverGroups,settings-musicCommands}.json` — source fragments.

---

## Task 1: Prisma model `MusicCommandSettings`

**Files:**
- Modify: `packages/backend/prisma/schema.prisma` (after the `SpotifySettings` model, ~line 301)

> **Deployment note:** the backend container creates/updates tables at startup
> via `npx prisma db push` (see `Dockerfile.backend` CMD), **not** `migrate
> deploy`. So no migration file is needed — the new table is created from
> `schema.prisma` on the VM at container start. Locally there is no database
> and no `.env`, so we only regenerate the Prisma **client** (no DB required);
> do **not** run `prisma migrate dev` (it would fail without a database).

- [ ] **Step 1: Add the model**

Insert after the `SpotifySettings` model block:

```prisma
model MusicCommandSettings {
  id               Int      @id @default(autoincrement())
  musicCommandSgid Int?     // server group allowed to run music commands (null = open to all)
  adminCommandSgid Int?     // server group allowed to run move/moveall/notif (null = open to all)
  notifyNowPlaying Boolean  @default(false) // post "now playing" in the bot's TS channel
  updatedAt        DateTime @updatedAt
}
```

- [ ] **Step 2: Regenerate the Prisma client (no DB needed)**

Run (from `packages/backend`):
```bash
npx prisma generate
```
Expected: `Generated Prisma Client ... to ./generated/prisma`. The client now
includes `MusicCommandSettings`, so `prisma.musicCommandSettings` is available.

- [ ] **Step 3: Verify the type exists**

Run (from `packages/backend`):
```bash
npx tsc --noEmit
```
Expected: PASS (no errors). The generated client now includes `MusicCommandSettings`.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/prisma/schema.prisma packages/backend/generated
git commit -m "feat(db): add MusicCommandSettings singleton model"
```

---

## Task 2: Pure access-control helpers (TDD)

These are the only pieces with branching logic, so they get real unit tests. The handler will import them.

**Files:**
- Create: `packages/backend/src/voice/music-command-access.ts`
- Test: `packages/backend/src/voice/music-command-access.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/voice/music-command-access.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyCommand, requiredSgid, parseServerGroupIds } from './music-command-access.js';

describe('classifyCommand', () => {
  it('treats help/aide as open', () => {
    expect(classifyCommand('help')).toBe('open');
    expect(classifyCommand('aide')).toBe('open');
  });
  it('treats move/moveall/notif as admin', () => {
    expect(classifyCommand('move')).toBe('admin');
    expect(classifyCommand('moveall')).toBe('admin');
    expect(classifyCommand('notif')).toBe('admin');
  });
  it('treats everything else as music', () => {
    expect(classifyCommand('play')).toBe('music');
    expect(classifyCommand('channels')).toBe('music');
  });
});

describe('requiredSgid', () => {
  const settings = { musicCommandSgid: 10, adminCommandSgid: 20 };
  it('returns null for open commands', () => {
    expect(requiredSgid('help', settings)).toBeNull();
  });
  it('returns the admin group for admin commands', () => {
    expect(requiredSgid('moveall', settings)).toBe(20);
  });
  it('returns the music group for music commands', () => {
    expect(requiredSgid('play', settings)).toBe(10);
  });
  it('returns null when the relevant group is unset (open)', () => {
    expect(requiredSgid('play', { musicCommandSgid: null, adminCommandSgid: 20 })).toBeNull();
    expect(requiredSgid('move', { musicCommandSgid: 10, adminCommandSgid: null })).toBeNull();
  });
});

describe('parseServerGroupIds', () => {
  it('parses a comma-separated list', () => {
    expect(parseServerGroupIds('6,7,8')).toEqual([6, 7, 8]);
  });
  it('handles spaces and empties', () => {
    expect(parseServerGroupIds(' 6 , 7 ')).toEqual([6, 7]);
    expect(parseServerGroupIds('')).toEqual([]);
    expect(parseServerGroupIds(undefined)).toEqual([]);
    expect(parseServerGroupIds(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `packages/backend`):
```bash
npx vitest run src/voice/music-command-access.test.ts
```
Expected: FAIL — `Cannot find module './music-command-access.js'`.

- [ ] **Step 3: Implement the module**

Create `packages/backend/src/voice/music-command-access.ts`:

```ts
/** Pure helpers for Music Bot command access control. No I/O. */

export type CommandTier = 'open' | 'music' | 'admin';

/** Commands that manage users/notifications — gated by the admin group. */
const ADMIN_COMMANDS = new Set(['move', 'moveall', 'notif']);
/** Commands that are always allowed regardless of configuration. */
const ALWAYS_OPEN = new Set(['help', 'aide']);

export function classifyCommand(command: string): CommandTier {
  if (ALWAYS_OPEN.has(command)) return 'open';
  if (ADMIN_COMMANDS.has(command)) return 'admin';
  return 'music';
}

export interface MusicCommandAccessSettings {
  musicCommandSgid: number | null;
  adminCommandSgid: number | null;
}

/**
 * The server-group id required to run `command`, or null when unrestricted
 * (open command, or no group configured for its tier).
 */
export function requiredSgid(command: string, settings: MusicCommandAccessSettings): number | null {
  const tier = classifyCommand(command);
  if (tier === 'open') return null;
  if (tier === 'admin') return settings.adminCommandSgid ?? null;
  return settings.musicCommandSgid ?? null;
}

/** Parse a TS `client_servergroups` field ("6,7,8") into a number[]. */
export function parseServerGroupIds(raw: string | undefined | null): number[] {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `packages/backend`):
```bash
npx vitest run src/voice/music-command-access.test.ts
```
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/voice/music-command-access.ts packages/backend/src/voice/music-command-access.test.ts
git commit -m "feat(voice): pure helpers for music command access control"
```

---

## Task 3: Backend route `music-command-settings`

**Files:**
- Create: `packages/backend/src/routes/music-command-settings.routes.ts`
- Modify: `packages/backend/src/app.ts` (import block ~line 38, mount block ~line 135)

- [ ] **Step 1: Create the route file**

Create `packages/backend/src/routes/music-command-settings.routes.ts`:

```ts
import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';

export const musicCommandSettingsRoutes: Router = Router();

musicCommandSettingsRoutes.use(requireRole('admin'));

async function getOrCreate(prisma: any) {
  const existing = await prisma.musicCommandSettings.findFirst();
  if (existing) return existing;
  return prisma.musicCommandSettings.create({ data: {} });
}

/** Normalise an incoming sgid value: '', null, 0 → null; else a positive int. */
function normSgid(v: any): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// GET /api/music-command-settings
musicCommandSettingsRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const s = await getOrCreate(req.app.locals.prisma);
    res.json({
      musicCommandSgid: s.musicCommandSgid,
      adminCommandSgid: s.adminCommandSgid,
      notifyNowPlaying: s.notifyNowPlaying,
    });
  } catch (err) { next(err); }
});

// PUT /api/music-command-settings
musicCommandSettingsRoutes.put('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await getOrCreate(prisma);
    const { musicCommandSgid, adminCommandSgid, notifyNowPlaying } = req.body;

    const data: any = {};
    if (musicCommandSgid !== undefined) data.musicCommandSgid = normSgid(musicCommandSgid);
    if (adminCommandSgid !== undefined) data.adminCommandSgid = normSgid(adminCommandSgid);
    if (notifyNowPlaying !== undefined) data.notifyNowPlaying = !!notifyNowPlaying;

    await prisma.musicCommandSettings.update({ where: { id: current.id }, data });
    res.json({ success: true });
  } catch (err) { next(err); }
});
```

- [ ] **Step 2: Import the route in `app.ts`**

After line 37 (`import { spotifyRoutes } ...`) add:

```ts
import { musicCommandSettingsRoutes } from './routes/music-command-settings.routes.js';
```

- [ ] **Step 3: Mount the route in `app.ts`**

After line 137 (`app.use('/api/spotify', spotifyRoutes);`) add:

```ts
  app.use('/api/music-command-settings', musicCommandSettingsRoutes);
```

(It sits after the global `app.use('/api', authMiddleware)` so it is authenticated; `requireRole('admin')` inside enforces admin.)

- [ ] **Step 4: Typecheck**

Run (from `packages/backend`):
```bash
npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routes/music-command-settings.routes.ts packages/backend/src/app.ts
git commit -m "feat(api): music-command-settings GET/PUT singleton route"
```

---

## Task 4: Wire restriction + `!notif` into `MusicCommandHandler`

**Files:**
- Modify: `packages/backend/src/voice/music-command-handler.ts`

Reference: the existing `MUSIC_COMMANDS` set, the `onTextMessage` switch, the `getServer(botId)` helper (returns `{ client, sid }`), and the `reply` function are already in place from prior work.

- [ ] **Step 1: Add imports and settings type**

At the top of `music-command-handler.ts`, add to the imports:

```ts
import { requiredSgid, parseServerGroupIds, type MusicCommandAccessSettings } from './music-command-access.js';
```

Add `'notif'` to the `MUSIC_COMMANDS` set so the command is dispatched:

```ts
const MUSIC_COMMANDS = new Set([
  'radio', 'play', 'spotify', 'stop', 'pause', 'skip', 'next', 'prev',
  'vol', 'volume', 'np', 'nowplaying', 'queue', 'add',
  'stream', 'stopstream', 'viewers',
  'move', 'moveall', 'channels', 'notif',
  'help', 'aide', 'info',
]);
```

- [ ] **Step 2: Add a settings cache + loader (class fields and methods)**

Add fields near the existing `sidCache` field:

```ts
  // Short-lived cache of the global MusicCommandSettings row. WebUI edits are
  // picked up within the TTL; !notif invalidates it immediately.
  private settingsCache: { at: number; value: MusicCommandSettingsRow } | null = null;
  private static readonly SETTINGS_TTL_MS = 5000;
```

Add this type above the class (after the `tokenizeArgs` helper):

```ts
interface MusicCommandSettingsRow extends MusicCommandAccessSettings {
  notifyNowPlaying: boolean;
}
```

Add these methods (e.g. just after `getServer`):

```ts
  /** Load the global command settings, cached for SETTINGS_TTL_MS. */
  private async getSettings(): Promise<MusicCommandSettingsRow> {
    if (this.settingsCache && Date.now() - this.settingsCache.at < MusicCommandHandler.SETTINGS_TTL_MS) {
      return this.settingsCache.value;
    }
    const row = await this.prisma.musicCommandSettings.findFirst();
    const value: MusicCommandSettingsRow = {
      musicCommandSgid: row?.musicCommandSgid ?? null,
      adminCommandSgid: row?.adminCommandSgid ?? null,
      notifyNowPlaying: row?.notifyNowPlaying ?? false,
    };
    this.settingsCache = { at: Date.now(), value };
    return value;
  }

  private invalidateSettings(): void {
    this.settingsCache = null;
  }

  /** Resolve a server group's display name (best-effort, for messages). */
  private async groupName(client: WebQueryClient, sid: number, sgid: number): Promise<string> {
    try {
      const res = await client.execute(sid, 'servergrouplist');
      const arr = Array.isArray(res) ? res : res ? [res] : [];
      const g = arr.find((x: any) => Number(x.sgid) === sgid);
      return g?.name ? String(g.name) : `#${sgid}`;
    } catch {
      return `#${sgid}`;
    }
  }

  /**
   * Returns true if the invoker may run `command`. On denial it replies with a
   * message and returns false. Open/unconfigured tiers always pass.
   */
  private async checkAccess(botId: number, command: string, userClid: number, reply: ReplyFn): Promise<boolean> {
    const settings = await this.getSettings();
    const required = requiredSgid(command, settings);
    if (required == null) return true;

    const { client, sid } = await this.getServer(botId);
    const info = await client.execute(sid, 'clientinfo', { clid: String(userClid) });
    const entry = Array.isArray(info) ? info[0] : info;
    const groups = parseServerGroupIds(entry?.client_servergroups);
    if (groups.includes(required)) return true;

    const name = await this.groupName(client, sid, required);
    reply(`⛔ Commande réservée au groupe « ${name} ».`);
    return false;
  }
```

- [ ] **Step 3: Enforce the check before dispatch**

In `onTextMessage`, immediately before the `try { switch (command) {` block, insert:

```ts
    // Access control: music vs admin tier, gated by configured server groups.
    if (!(await this.checkAccess(botId, command, userClid, reply))) return;
```

- [ ] **Step 4: Add the `!notif` case in the switch**

In the `switch (command)` block, add alongside the other admin cases:

```ts
        case 'notif':
          await this.handleNotif(reply);
          break;
```

- [ ] **Step 5: Implement `handleNotif`**

Add the method (near `handleMoveAll`):

```ts
  private async handleNotif(reply: ReplyFn): Promise<void> {
    const row = await this.prisma.musicCommandSettings.findFirst();
    const next = !(row?.notifyNowPlaying ?? false);
    if (row) {
      await this.prisma.musicCommandSettings.update({ where: { id: row.id }, data: { notifyNowPlaying: next } });
    } else {
      await this.prisma.musicCommandSettings.create({ data: { notifyNowPlaying: next } });
    }
    this.invalidateSettings();
    reply(next
      ? '🔔 Notifications du titre en cours : activées (tous les bots).'
      : '🔕 Notifications du titre en cours : désactivées.');
  }
```

- [ ] **Step 6: Add `!notif` to the help text**

In `handleHelp`, add a line near the other admin commands:

```ts
      '  !notif               Activer/désactiver la notif du titre en cours (canal TS)',
```

- [ ] **Step 7: Typecheck**

Run (from `packages/backend`):
```bash
npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/voice/music-command-handler.ts
git commit -m "feat(voice): server-group restriction + !notif toggle for music commands"
```

---

## Task 5: TS now-playing notification listener

**Files:**
- Modify: `packages/backend/src/voice/music-command-handler.ts`

The class already has `registerBot(botId, bot)` (attaches the `textMessage` listener) and `unregisterBot(botId)`.

- [ ] **Step 1: Add a listener registry field**

Near the other private fields add:

```ts
  // nowPlaying listeners, kept so they can be detached in unregisterBot.
  private nowPlayingListeners = new Map<number, { bot: VoiceBot; listener: (item: QueueItem) => void }>();
```

- [ ] **Step 2: Attach the listener in `registerBot`**

Inside `registerBot`, after the existing `bot.on('textMessage', ...)` registration, add:

```ts
    const npListener = (item: QueueItem) => {
      this.onNowPlaying(bot, item).catch((err) =>
        console.error(`[MusicCmd] now-playing notif failed on bot ${botId}: ${err.message}`));
    };
    bot.on('nowPlaying', npListener);
    this.nowPlayingListeners.set(botId, { bot, listener: npListener });
```

- [ ] **Step 3: Detach in `unregisterBot`**

Replace the body of `unregisterBot` with:

```ts
  unregisterBot(botId: number): void {
    this.registeredBots.delete(botId);
    const entry = this.nowPlayingListeners.get(botId);
    if (entry) {
      entry.bot.off('nowPlaying', entry.listener);
      this.nowPlayingListeners.delete(botId);
    }
  }
```

- [ ] **Step 4: Implement `onNowPlaying`**

Add the method (near `getSettings`):

```ts
  /** Post a "now playing" line in the bot's current TS channel when enabled. */
  private async onNowPlaying(bot: VoiceBot, item: QueueItem): Promise<void> {
    const settings = await this.getSettings();
    if (!settings.notifyNowPlaying) return;
    const artist = item.artist ? `${item.artist} - ` : '';
    bot.sendChannelMessage(`♪ Now playing : ${artist}${item.title}`);
  }
```

- [ ] **Step 5: Typecheck**

Run (from `packages/backend`):
```bash
npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 6: Run the full backend test suite (no regressions)**

Run (from `packages/backend`):
```bash
npx vitest run
```
Expected: PASS (including the new `music-command-access.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/voice/music-command-handler.ts
git commit -m "feat(voice): post now-playing notification to the bot's TS channel"
```

---

## Task 6: Frontend API client for music-command settings

**Files:**
- Create: `packages/frontend/src/api/music-command-settings.api.ts`

- [ ] **Step 1: Create the API module**

```ts
import api from './client';

export interface MusicCommandSettings {
  musicCommandSgid: number | null;
  adminCommandSgid: number | null;
  notifyNowPlaying: boolean;
}

export const musicCommandSettingsApi = {
  get: (): Promise<MusicCommandSettings> =>
    api.get('/music-command-settings').then((r) => r.data),
  update: (data: Partial<MusicCommandSettings>) =>
    api.put('/music-command-settings', data).then((r) => r.data),
};
```

- [ ] **Step 2: Typecheck**

Run (from `packages/frontend`):
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/api/music-command-settings.api.ts
git commit -m "feat(web): music-command-settings api client"
```

---

## Task 7: Settings — "Music Bot" tab

**Files:**
- Modify: `packages/frontend/src/pages/Settings.tsx`

- [ ] **Step 1: Add imports**

After line 8 (`import { spotifyApi } ...`) add:

```ts
import { musicCommandSettingsApi } from '@/api/music-command-settings.api';
import { useServerGroups } from '@/hooks/use-groups';
```

Add `Bot` to the existing `lucide-react` import on line 24 (append `, Bot` before the closing brace).

- [ ] **Step 2: Add the tab trigger**

After line 46 (the spotify `TabsTrigger`) add:

```tsx
          {isAdmin && <TabsTrigger value="musicCommands"><Bot className="h-3.5 w-3.5 mr-1" /> {t('settings.tabs.musicCommands')}</TabsTrigger>}
```

- [ ] **Step 3: Add the tab content**

After the spotify `TabsContent` block (ends ~line 81) add:

```tsx
        {isAdmin && (
          <TabsContent value="musicCommands" className="mt-4">
            <MusicCommandsTab />
          </TabsContent>
        )}
```

- [ ] **Step 4: Add the `MusicCommandsTab` component**

Add after the `SpotifyTab` function (ends ~line 1187):

```tsx
// ─── Music Bot Commands Tab ──────────────────────────────────

const NO_GROUP = 'none';

function MusicCommandsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['music-command-settings'],
    queryFn: musicCommandSettingsApi.get,
  });
  const { data: groupsData } = useServerGroups();
  const groups = Array.isArray(groupsData) ? groupsData : [];

  const [form, setForm] = useState<{ musicCommandSgid: string; adminCommandSgid: string; notifyNowPlaying: boolean }>({
    musicCommandSgid: NO_GROUP, adminCommandSgid: NO_GROUP, notifyNowPlaying: false,
  });

  useEffect(() => {
    if (settings) setForm({
      musicCommandSgid: settings.musicCommandSgid ? String(settings.musicCommandSgid) : NO_GROUP,
      adminCommandSgid: settings.adminCommandSgid ? String(settings.adminCommandSgid) : NO_GROUP,
      notifyNowPlaying: settings.notifyNowPlaying,
    });
  }, [settings]);

  const save = useMutation({
    mutationFn: () => musicCommandSettingsApi.update({
      musicCommandSgid: form.musicCommandSgid === NO_GROUP ? null : parseInt(form.musicCommandSgid),
      adminCommandSgid: form.adminCommandSgid === NO_GROUP ? null : parseInt(form.adminCommandSgid),
      notifyNowPlaying: form.notifyNowPlaying,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['music-command-settings'] });
      toast.success(t('settings.musicCommands.toastSaved'));
    },
    onError: (err: any) => toast.error(err.response?.data?.error || t('settings.musicCommands.toastSaveFailed')),
  });

  if (isLoading || !settings) return <PageLoader />;

  const groupSelect = (value: string, onChange: (v: string) => void) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_GROUP}>{t('settings.musicCommands.openToAll')}</SelectItem>
        {groups.map((g: any) => (
          <SelectItem key={g.sgid} value={String(g.sgid)}>{g.name} (#{g.sgid})</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t('settings.musicCommands.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 max-w-xl">
        <p className="text-[11px] text-muted-foreground">{t('settings.musicCommands.description')}</p>

        {groups.length === 0 && (
          <p className="text-[11px] text-amber-500">{t('settings.musicCommands.noServerHint')}</p>
        )}

        <div className="space-y-1.5">
          <Label className="text-xs">{t('settings.musicCommands.musicGroup')}</Label>
          {groupSelect(form.musicCommandSgid, (v) => setForm((f) => ({ ...f, musicCommandSgid: v }))) }
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">{t('settings.musicCommands.adminGroup')}</Label>
          {groupSelect(form.adminCommandSgid, (v) => setForm((f) => ({ ...f, adminCommandSgid: v }))) }
        </div>

        <div className="flex items-center gap-2">
          <Switch checked={form.notifyNowPlaying} onCheckedChange={(v) => setForm((f) => ({ ...f, notifyNowPlaying: v }))} />
          <Label className="text-xs">{t('settings.musicCommands.notifyNowPlaying')}</Label>
        </div>

        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? t('settings.musicCommands.saving') : t('settings.musicCommands.save')}
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Typecheck**

Run (from `packages/frontend`):
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS (i18n keys resolve at runtime; types are fine).

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/pages/Settings.tsx
git commit -m "feat(web): Music Bot settings tab (command groups + now-playing notif)"
```

---

## Task 8: ServerGroups — add/remove members

**Files:**
- Modify: `packages/frontend/src/hooks/use-groups.ts`
- Modify: `packages/frontend/src/pages/ServerGroups.tsx`

The backend routes and `groupsApi.addServerGroupMember` / `removeServerGroupMember` already exist.

- [ ] **Step 1: Add membership mutation hooks**

Append to `packages/frontend/src/hooks/use-groups.ts`:

```ts
export function useAddServerGroupMember() {
  const qc = useQueryClient();
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  return useMutation({
    mutationFn: ({ sgid, cldbid }: { sgid: number; cldbid: number }) =>
      groupsApi.addServerGroupMember(c!, s!, sgid, cldbid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['server-group-members'] }),
  });
}

export function useRemoveServerGroupMember() {
  const qc = useQueryClient();
  const { selectedConfigId: c, selectedSid: s } = useServerStore();
  return useMutation({
    mutationFn: ({ sgid, cldbid }: { sgid: number; cldbid: number }) =>
      groupsApi.removeServerGroupMember(c!, s!, sgid, cldbid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['server-group-members'] }),
  });
}
```

- [ ] **Step 2: Update imports in `ServerGroups.tsx`**

Change the `use-groups` import (line 2) to add the two new hooks:

```ts
import { useServerGroups, useServerGroupMembers, useCreateServerGroup, useDeleteServerGroup, useAddServerGroupMember, useRemoveServerGroupMember } from '@/hooks/use-groups';
```

Add a clients hook import after it:

```ts
import { useClients } from '@/hooks/use-clients';
```

Add icons `UserPlus` and `X` to the `lucide-react` import (line 15):

```ts
import { Shield, Plus, Trash2, Users, ChevronRight, UserPlus, X } from 'lucide-react';
```

- [ ] **Step 3: Add state + hooks inside the component**

After the existing `const [newName, setNewName] = useState('');` (~line 29) add:

```tsx
  const [showAddMember, setShowAddMember] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const addMember = useAddServerGroupMember();
  const removeMember = useRemoveServerGroupMember();
  const { data: clientsData } = useClients();
```

- [ ] **Step 4: Add the "+ Add member" button**

In the members `CardHeader`, replace the single delete-group button area so both buttons show when a group is selected. Replace the block:

```tsx
              {selectedGroup && (
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => {
                  const g = groups.find((g: any) => g.sgid === selectedGroup);
                  if (g) setDeleteTarget({ sgid: g.sgid, name: g.name });
                }}>
                  <Trash2 className="h-3 w-3 mr-1" /> {t('serverGroups.deleteGroup')}
                </Button>
              )}
```

with:

```tsx
              {selectedGroup && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setMemberSearch(''); setShowAddMember(true); }}>
                    <UserPlus className="h-3 w-3 mr-1" /> {t('serverGroups.addMember')}
                  </Button>
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => {
                    const g = groups.find((g: any) => g.sgid === selectedGroup);
                    if (g) setDeleteTarget({ sgid: g.sgid, name: g.name });
                  }}>
                    <Trash2 className="h-3 w-3 mr-1" /> {t('serverGroups.deleteGroup')}
                  </Button>
                </div>
              )}
```

- [ ] **Step 5: Add a remove button on each member row**

Replace the member row block:

```tsx
                    members.map((m: any, i: number) => (
                      <div key={i} className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted/30 transition-colors">
                        <div className="flex items-center gap-2">
                          <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-mono-data text-primary">
                            {m.client_nickname?.[0]?.toUpperCase() || '?'}
                          </div>
                          <span className="text-sm">{m.client_nickname || `DBID: ${m.cldbid}`}</span>
                        </div>
                        <span className="text-xs text-muted-foreground font-mono-data">DBID: {m.cldbid}</span>
                      </div>
                    ))
```

with:

```tsx
                    members.map((m: any, i: number) => (
                      <div key={i} className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted/30 transition-colors group">
                        <div className="flex items-center gap-2">
                          <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-mono-data text-primary">
                            {m.client_nickname?.[0]?.toUpperCase() || '?'}
                          </div>
                          <span className="text-sm">{m.client_nickname || `DBID: ${m.cldbid}`}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground font-mono-data">DBID: {m.cldbid}</span>
                          <button
                            className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                            title={t('serverGroups.removeMember')}
                            onClick={() => removeMember.mutate({ sgid: selectedGroup!, cldbid: Number(m.cldbid) }, {
                              onSuccess: () => toast.success(t('serverGroups.memberRemoved')),
                              onError: () => toast.error(t('serverGroups.memberActionFailed')),
                            })}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    ))
```

- [ ] **Step 6: Add the "add member" dialog**

Before the final closing `</div>` of the component (just after the `ConfirmDialog`, ~line 136) add:

```tsx
      <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('serverGroups.addMemberTitle')}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder={t('serverGroups.searchClient')} autoFocus />
            <ScrollArea className="h-[300px]">
              <div className="space-y-1">
                {(Array.isArray(clientsData) ? clientsData : [])
                  .filter((c: any) => String(c.client_type) === '0')
                  .filter((c: any) => (c.client_nickname || '').toLowerCase().includes(memberSearch.toLowerCase()))
                  .map((c: any) => (
                    <button
                      key={c.clid}
                      className="flex items-center justify-between w-full rounded-md px-3 py-2 text-sm hover:bg-muted/50 transition-colors text-left"
                      onClick={() => addMember.mutate({ sgid: selectedGroup!, cldbid: Number(c.client_database_id) }, {
                        onSuccess: () => { toast.success(t('serverGroups.memberAdded')); setShowAddMember(false); },
                        onError: () => toast.error(t('serverGroups.memberActionFailed')),
                      })}
                    >
                      <span className="truncate">{c.client_nickname}</span>
                      <span className="text-xs text-muted-foreground font-mono-data">DBID: {c.client_database_id}</span>
                    </button>
                  ))}
              </div>
            </ScrollArea>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddMember(false)}>{t('serverGroups.cancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 7: Typecheck**

Run (from `packages/frontend`):
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/hooks/use-groups.ts packages/frontend/src/pages/ServerGroups.tsx
git commit -m "feat(web): add/remove server group members from the ServerGroups page"
```

---

## Task 9: i18n keys (5 locales + source fragments)

**Files:**
- Modify: `packages/frontend/src/i18n/locales/{fr,en,de,es,it}.json`
- Modify: `packages/frontend/scripts/i18n-fragments/serverGroups.json` (if present; otherwise skip the fragment for serverGroups)
- Create: `packages/frontend/scripts/i18n-fragments/settings-musicCommands.json`

> Add the `settings.tabs.musicCommands` key inside the existing `settings.tabs` object, the `settings.musicCommands.*` keys inside `settings`, and the `serverGroups.*` keys inside the existing `serverGroups` object — in **each** of the 5 locale files. Use the values below.

- [ ] **Step 1: Add `settings.tabs.musicCommands` in each locale**

Add to the `settings.tabs` object:
- fr: `"musicCommands": "Music Bot"`
- en: `"musicCommands": "Music Bot"`
- de: `"musicCommands": "Music-Bot"`
- es: `"musicCommands": "Music Bot"`
- it: `"musicCommands": "Music Bot"`

- [ ] **Step 2: Add the `settings.musicCommands` block in each locale**

fr:
```json
"musicCommands": {
  "title": "Commandes Music Bot",
  "description": "Restreindre les commandes du Music Bot à des groupes serveur, et activer la notification du titre en cours dans le canal TeamSpeak. Les groupes sont ceux du serveur actuellement sélectionné.",
  "noServerHint": "Sélectionnez un serveur pour lister les groupes.",
  "musicGroup": "Groupe pour les commandes musicales (!play, !skip, …)",
  "adminGroup": "Groupe pour les commandes d'admin (!move, !moveall, !notif)",
  "openToAll": "Aucun (ouvert à tous)",
  "notifyNowPlaying": "Notifier le titre en cours dans le canal TS",
  "save": "Enregistrer",
  "saving": "Enregistrement...",
  "toastSaved": "Réglages enregistrés",
  "toastSaveFailed": "Échec de l'enregistrement"
}
```

en:
```json
"musicCommands": {
  "title": "Music Bot Commands",
  "description": "Restrict Music Bot commands to server groups, and enable now-playing notifications in the TeamSpeak channel. Groups are those of the currently selected server.",
  "noServerHint": "Select a server to list its groups.",
  "musicGroup": "Group for music commands (!play, !skip, …)",
  "adminGroup": "Group for admin commands (!move, !moveall, !notif)",
  "openToAll": "None (open to all)",
  "notifyNowPlaying": "Announce the current track in the TS channel",
  "save": "Save",
  "saving": "Saving...",
  "toastSaved": "Settings saved",
  "toastSaveFailed": "Failed to save"
}
```

de:
```json
"musicCommands": {
  "title": "Music-Bot-Befehle",
  "description": "Music-Bot-Befehle auf Servergruppen beschränken und die Wiedergabe-Benachrichtigung im TeamSpeak-Kanal aktivieren. Es gelten die Gruppen des aktuell ausgewählten Servers.",
  "noServerHint": "Wählen Sie einen Server, um die Gruppen anzuzeigen.",
  "musicGroup": "Gruppe für Musikbefehle (!play, !skip, …)",
  "adminGroup": "Gruppe für Admin-Befehle (!move, !moveall, !notif)",
  "openToAll": "Keine (für alle offen)",
  "notifyNowPlaying": "Aktuellen Titel im TS-Kanal ankündigen",
  "save": "Speichern",
  "saving": "Wird gespeichert...",
  "toastSaved": "Einstellungen gespeichert",
  "toastSaveFailed": "Speichern fehlgeschlagen"
}
```

es:
```json
"musicCommands": {
  "title": "Comandos del Music Bot",
  "description": "Restringe los comandos del Music Bot a grupos de servidor y activa la notificación del tema actual en el canal de TeamSpeak. Los grupos son los del servidor seleccionado.",
  "noServerHint": "Selecciona un servidor para listar los grupos.",
  "musicGroup": "Grupo para comandos de música (!play, !skip, …)",
  "adminGroup": "Grupo para comandos de admin (!move, !moveall, !notif)",
  "openToAll": "Ninguno (abierto a todos)",
  "notifyNowPlaying": "Anunciar el tema actual en el canal TS",
  "save": "Guardar",
  "saving": "Guardando...",
  "toastSaved": "Ajustes guardados",
  "toastSaveFailed": "Error al guardar"
}
```

it:
```json
"musicCommands": {
  "title": "Comandi Music Bot",
  "description": "Limita i comandi del Music Bot a gruppi server e attiva la notifica del brano in riproduzione nel canale TeamSpeak. I gruppi sono quelli del server attualmente selezionato.",
  "noServerHint": "Seleziona un server per elencare i gruppi.",
  "musicGroup": "Gruppo per i comandi musicali (!play, !skip, …)",
  "adminGroup": "Gruppo per i comandi admin (!move, !moveall, !notif)",
  "openToAll": "Nessuno (aperto a tutti)",
  "notifyNowPlaying": "Annuncia il brano corrente nel canale TS",
  "save": "Salva",
  "saving": "Salvataggio...",
  "toastSaved": "Impostazioni salvate",
  "toastSaveFailed": "Salvataggio non riuscito"
}
```

- [ ] **Step 3: Add the `serverGroups.*` member keys in each locale**

Add inside the existing `serverGroups` object:

fr:
```json
"addMember": "Ajouter un membre",
"addMemberTitle": "Ajouter un membre au groupe",
"removeMember": "Retirer du groupe",
"searchClient": "Rechercher un client connecté...",
"memberAdded": "Membre ajouté",
"memberRemoved": "Membre retiré",
"memberActionFailed": "Action sur le membre échouée"
```

en:
```json
"addMember": "Add member",
"addMemberTitle": "Add a member to the group",
"removeMember": "Remove from group",
"searchClient": "Search a connected client...",
"memberAdded": "Member added",
"memberRemoved": "Member removed",
"memberActionFailed": "Member action failed"
```

de:
```json
"addMember": "Mitglied hinzufügen",
"addMemberTitle": "Mitglied zur Gruppe hinzufügen",
"removeMember": "Aus Gruppe entfernen",
"searchClient": "Verbundenen Client suchen...",
"memberAdded": "Mitglied hinzugefügt",
"memberRemoved": "Mitglied entfernt",
"memberActionFailed": "Mitgliederaktion fehlgeschlagen"
```

es:
```json
"addMember": "Añadir miembro",
"addMemberTitle": "Añadir un miembro al grupo",
"removeMember": "Quitar del grupo",
"searchClient": "Buscar un cliente conectado...",
"memberAdded": "Miembro añadido",
"memberRemoved": "Miembro eliminado",
"memberActionFailed": "Acción sobre el miembro fallida"
```

it:
```json
"addMember": "Aggiungi membro",
"addMemberTitle": "Aggiungi un membro al gruppo",
"removeMember": "Rimuovi dal gruppo",
"searchClient": "Cerca un client connesso...",
"memberAdded": "Membro aggiunto",
"memberRemoved": "Membro rimosso",
"memberActionFailed": "Azione sul membro non riuscita"
```

- [ ] **Step 4: Update the source fragments**

If `packages/frontend/scripts/i18n-fragments/serverGroups.json` exists, add the same `serverGroups.*` member keys (all 5 locales) to its `keys` object, mirroring the locale edits. Create `packages/frontend/scripts/i18n-fragments/settings-musicCommands.json` capturing the `settings.tabs.musicCommands` + `settings.musicCommands.*` keys for all 5 locales (follow the structure of an existing fragment such as `settings-autodelete.json`). These fragments are the regeneration source of truth; keep them in sync with the locale files.

- [ ] **Step 5: Validate JSON + typecheck**

Run (from `packages/frontend`):
```bash
node -e "for (const l of ['fr','en','de','es','it']) JSON.parse(require('fs').readFileSync('src/i18n/locales/'+l+'.json','utf8')); console.log('locales OK')"
npx tsc --noEmit -p tsconfig.json
```
Expected: `locales OK` then PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/i18n/locales packages/frontend/scripts/i18n-fragments
git commit -m "i18n: music bot command settings + server group member management"
```

---

## Task 10: Final verification

- [ ] **Step 1: Backend — typecheck + tests**

Run (from `packages/backend`):
```bash
npx tsc --noEmit && npx vitest run
```
Expected: PASS.

- [ ] **Step 2: Frontend — typecheck + build**

Run (from `packages/frontend`):
```bash
npx tsc --noEmit -p tsconfig.json && npm run build
```
Expected: PASS (build succeeds).

- [ ] **Step 3: Manual smoke test (on the VM after deploy)**

Deploy: `cd /opt/ts6-manager-private && git pull && docker compose up -d --build backend frontend`, then hard-reload the WebUI.

Verify:
1. Settings → "Music Bot" tab loads; selecting a music group + admin group + toggling the notif and saving persists (reload shows saved values).
2. With a music group set, a non-member running `!play` in the bot's channel gets the `⛔` denial; a member runs it fine. With no group set, anyone can.
3. `!notif` toggles and replies with the new status; the Settings switch reflects the change after reload; on a new track the bot posts `♪ Now playing : …` in its channel when enabled.
4. ServerGroups page: select a group → "Add member" lists connected clients → adding one shows it in the member list; the X button removes it.

- [ ] **Step 4: Push**

```bash
git push origin main
```
Then tell the user to `git pull` + rebuild on the VM.

---

## Self-Review notes (verified during planning)

- **Spec coverage:** §1 model → Task 1; §2 restriction → Tasks 2+4; §3 membership UI → Task 8; §4 notif → Task 5; §5 `!notif` → Task 4; §6 Settings UI → Task 7; i18n → Task 9. All covered.
- **Type consistency:** `MusicCommandAccessSettings` (music-command-access.ts) is extended by `MusicCommandSettingsRow` (handler) adding `notifyNowPlaying`; `requiredSgid`/`parseServerGroupIds`/`classifyCommand` signatures match between definition (Task 2) and use (Task 4). API `MusicCommandSettings` shape matches the route's GET/PUT payload.
- **No placeholders:** every code step contains full code; i18n provided for all 5 locales.
- **Assumption:** `clientinfo` returns `client_servergroups` (comma-separated sgids) — consistent with the field used elsewhere in the codebase (`safe-expr.test.ts` scope).
