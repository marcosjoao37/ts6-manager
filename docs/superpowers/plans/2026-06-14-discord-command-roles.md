# Discord Command Role Restriction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pick one or more Discord guild roles in the WebUI so that only members holding one of those roles (or Discord admins/owner) can trigger the bot's slash commands.

**Architecture:** A new JSON-string column `commandRoleIds` on the single `DiscordSettings` row stores the allowed role IDs. A pure, testable `isCommandAllowed()` function encodes the gating rule (empty list = open, admin/owner bypass, otherwise role intersection). The bridge calls it at the top of `handleCommand` and exposes the guild's roles via `listRoles()` for a multi-select picker in the Discord settings tab.

**Tech Stack:** Express + Prisma (SQLite), discord.js, React + react-query + react-i18next, vitest.

---

## Task 1: Add `commandRoleIds` to DiscordSettings and migrate

**Files:**
- Modify: `packages/backend/prisma/schema.prisma`

- [ ] **Step 1: Add the column**

In `packages/backend/prisma/schema.prisma`, inside `model DiscordSettings { ... }`, add a line after `flowMessageTrigger`:
```prisma
  flowMessageTrigger     Boolean  @default(false)
  commandRoleIds         String?  // JSON array of Discord role IDs; null/empty = open to everyone
```

- [ ] **Step 2: Create and apply the migration**

Run from `packages/backend` (a `DATABASE_URL` may need to be supplied inline if no `.env` is present — use `DATABASE_URL="file:./data/ts6webui.db"` matching `.env.example`):
```bash
pnpm prisma migrate dev --name discord-command-roles
```
Expected: a new migration folder under `packages/backend/prisma/migrations/`, "Your database is now in sync with your schema", Prisma client regenerated.

Note: `packages/backend/prisma/migrations/` is gitignored in this repo (deployment uses `prisma db push` from `schema.prisma`), so only the schema change gets committed.

- [ ] **Step 3: Commit**

```bash
git add packages/backend/prisma/schema.prisma
git commit -m "feat(discord): add commandRoleIds to DiscordSettings"
```
(End every commit message with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`)

---

## Task 2: Pure permission module (TDD)

A standalone, discord.js-free module with the gating rule and a safe JSON parser.

**Files:**
- Create: `packages/backend/src/discord/command-permissions.ts`
- Test: `packages/backend/src/discord/command-permissions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/discord/command-permissions.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { isCommandAllowed, parseRoleIds } from './command-permissions.js';

describe('parseRoleIds', () => {
  it('returns [] for null, undefined, empty, or malformed JSON', () => {
    expect(parseRoleIds(null)).toEqual([]);
    expect(parseRoleIds(undefined)).toEqual([]);
    expect(parseRoleIds('')).toEqual([]);
    expect(parseRoleIds('not json')).toEqual([]);
    expect(parseRoleIds('{"a":1}')).toEqual([]);
  });

  it('parses a JSON array of string ids and drops non-strings', () => {
    expect(parseRoleIds('["1","2"]')).toEqual(['1', '2']);
    expect(parseRoleIds('["1",2,null,"3"]')).toEqual(['1', '3']);
  });
});

describe('isCommandAllowed', () => {
  const base = { allowedRoleIds: [] as string[], memberRoleIds: [] as string[], isAdmin: false, isOwner: false };

  it('allows everyone when the allow-list is empty', () => {
    expect(isCommandAllowed({ ...base, allowedRoleIds: [], memberRoleIds: [] })).toBe(true);
  });

  it('allows a member holding one of the allowed roles', () => {
    expect(isCommandAllowed({ ...base, allowedRoleIds: ['a', 'b'], memberRoleIds: ['x', 'b'] })).toBe(true);
  });

  it('denies a member holding none of the allowed roles', () => {
    expect(isCommandAllowed({ ...base, allowedRoleIds: ['a', 'b'], memberRoleIds: ['x', 'y'] })).toBe(false);
  });

  it('allows a Discord admin even without an allowed role', () => {
    expect(isCommandAllowed({ ...base, allowedRoleIds: ['a'], memberRoleIds: [], isAdmin: true })).toBe(true);
  });

  it('allows the guild owner even without an allowed role', () => {
    expect(isCommandAllowed({ ...base, allowedRoleIds: ['a'], memberRoleIds: [], isOwner: true })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/backend`): `pnpm vitest run src/discord/command-permissions.test.ts`
Expected: FAIL — cannot find module `./command-permissions.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/backend/src/discord/command-permissions.ts`:
```typescript
export interface CommandPermissionInput {
  allowedRoleIds: string[];
  memberRoleIds: string[];
  isAdmin: boolean;
  isOwner: boolean;
}

/**
 * Gating rule for Discord slash commands:
 *  - empty allow-list  → open to everyone (backward compatible)
 *  - Discord admin / guild owner → always allowed
 *  - otherwise allowed iff the member holds at least one allowed role
 */
export function isCommandAllowed(input: CommandPermissionInput): boolean {
  if (input.allowedRoleIds.length === 0) return true;
  if (input.isAdmin || input.isOwner) return true;
  return input.memberRoleIds.some((r) => input.allowedRoleIds.includes(r));
}

/** Safely parse the JSON-string column into an array of role-id strings. */
export function parseRoleIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/discord/command-permissions.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/discord/command-permissions.ts packages/backend/src/discord/command-permissions.test.ts
git commit -m "feat(discord): pure command-permission gating module"
```

---

## Task 3: Bridge — `listRoles()` and the command gate

**Files:**
- Modify: `packages/backend/src/discord/discord-bridge.ts`

- [ ] **Step 1: Add imports**

At the top of `discord-bridge.ts`, add the permission helpers import near the other local imports (e.g., after the `embeds` import group):
```typescript
import { isCommandAllowed, parseRoleIds } from './command-permissions.js';
```
Then ensure `PermissionFlagsBits` is imported from `discord.js`. Find the existing `discord.js` import (it already imports things like `GatewayIntentBits`, `Events`, `ChannelType`, `SlashCommandBuilder`, `type GuildMember`, `type ChatInputCommandInteraction`). Add `PermissionFlagsBits` to that import list.

- [ ] **Step 2: Add `listRoles()`**

In `discord-bridge.ts`, immediately AFTER the `listChannels()` method (which ends with the `return { text: ..., voice: ... };` block), add:
```typescript
  /** Selectable guild roles for the command-permission picker. Excludes
   *  @everyone and integration/bot-managed roles. Empty if not connected. */
  listRoles(): Array<{ id: string; name: string; color: number }> {
    const guild = this.guild();
    if (!guild) return [];
    return guild.roles.cache
      .filter((r) => r.id !== guild.id && !r.managed)
      .map((r) => ({ id: r.id, name: r.name, color: r.color }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
```

- [ ] **Step 3: Add the gate helper**

In `discord-bridge.ts`, add this private method right BEFORE `private async handleCommand(...)`:
```typescript
  /** Whether the interaction's author may run commands, per configured roles. */
  private commandAllowed(i: ChatInputCommandInteraction): boolean {
    const allowedRoleIds = parseRoleIds(this.settings?.commandRoleIds);
    if (allowedRoleIds.length === 0) return true;
    const member = i.member as GuildMember | null;
    const memberRoleIds =
      member && 'roles' in member && member.roles?.cache ? [...member.roles.cache.keys()] : [];
    const isAdmin = !!i.memberPermissions?.has(PermissionFlagsBits.Administrator);
    const isOwner = !!i.guild && i.guild.ownerId === i.user.id;
    return isCommandAllowed({ allowedRoleIds, memberRoleIds, isAdmin, isOwner });
  }
```

- [ ] **Step 4: Wire the gate into `handleCommand`**

In `handleCommand`, the body currently begins:
```typescript
  private async handleCommand(i: ChatInputCommandInteraction): Promise<void> {
    switch (i.commandName) {
```
Insert the gate between the signature and the `switch`:
```typescript
  private async handleCommand(i: ChatInputCommandInteraction): Promise<void> {
    if (!this.commandAllowed(i)) {
      await i.reply({ content: '⛔ Tu n\'as pas la permission d\'utiliser cette commande.', ephemeral: true });
      return;
    }
    switch (i.commandName) {
```

- [ ] **Step 5: Type-check**

Run (from repo root): `pnpm --filter @ts6/backend exec tsc --noEmit`
Expected: no errors. (`this.settings` is the `DiscordSettings` row, which now has `commandRoleIds` after Task 1's client regen.)

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/discord/discord-bridge.ts
git commit -m "feat(discord): gate slash commands by allowed roles; expose listRoles"
```

---

## Task 4: Routes — `/roles` and settings get/put

**Files:**
- Modify: `packages/backend/src/routes/discord.routes.ts`

- [ ] **Step 1: Import the parser**

At the top of `discord.routes.ts`, after the existing imports, add:
```typescript
import { parseRoleIds } from '../discord/command-permissions.js';
```

- [ ] **Step 2: Expose `commandRoleIds` in GET /settings**

In the `GET '/settings'` handler's `res.json({ ... })`, add a field after `flowMessageTrigger: s.flowMessageTrigger,`:
```typescript
      flowMessageTrigger: s.flowMessageTrigger,
      commandRoleIds: parseRoleIds(s.commandRoleIds),
```

- [ ] **Step 3: Accept `commandRoleIds` in PUT /settings**

In the `PUT '/settings'` handler, add `commandRoleIds` to the destructuring list:
```typescript
    const { enabled, botToken, guildId, notificationsChannelId, statsChannelId, voiceChannelId, statsLiveEnabled, notifyConnections, notifyNowPlaying, notifyChannelId, notifyJoinTemplate, notifyLeaveTemplate, notifyEmbed, notifAutoDeleteSeconds, flowMessageTrigger, defaultMusicBotId, serverConfigId, virtualServerId, commandRoleIds } = req.body;
```
Then add a mapping line after the `flowMessageTrigger` mapping:
```typescript
    if (flowMessageTrigger !== undefined) data.flowMessageTrigger = !!flowMessageTrigger;
    if (commandRoleIds !== undefined) {
      data.commandRoleIds = Array.isArray(commandRoleIds) && commandRoleIds.length
        ? JSON.stringify(commandRoleIds.map(String))
        : null;
    }
```

- [ ] **Step 4: Add the GET /roles endpoint**

After the `GET '/channels'` route, add:
```typescript
// GET /api/discord/roles — selectable guild roles for the command-permission picker
discordRoutes.get('/roles', (req: Request, res: Response) => {
  const bridge: DiscordBridge | undefined = req.app.locals.discordBridge;
  res.json(bridge?.listRoles() ?? []);
});
```

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @ts6/backend exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/routes/discord.routes.ts
git commit -m "feat(discord): roles endpoint + persist commandRoleIds"
```

---

## Task 5: Frontend API client

**Files:**
- Modify: `packages/frontend/src/api/discord.api.ts`

- [ ] **Step 1: Add the field to the interface**

In `DiscordSettings`, add after `flowMessageTrigger: boolean;`:
```typescript
  flowMessageTrigger: boolean;
  commandRoleIds: string[];
```

- [ ] **Step 2: Add the `roles` method**

In the `discordApi` object, after the `channels` method, add:
```typescript
  roles: (): Promise<Array<{ id: string; name: string; color: number }>> =>
    api.get('/discord/roles').then((r) => r.data),
```

- [ ] **Step 3: Type-check**

Run (from repo root): `pnpm --filter @ts6/frontend exec tsc --noEmit`
Expected: no errors (`commandRoleIds` is now required on `DiscordSettings`; the DiscordTab `form` is `Partial<DiscordSettings>` so existing code still compiles).

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/api/discord.api.ts
git commit -m "feat(discord): frontend API for roles + commandRoleIds"
```

---

## Task 6: DiscordTab — roles multi-select

**Files:**
- Modify: `packages/frontend/src/pages/Settings.tsx`

- [ ] **Step 1: Confirm Checkbox import**

The Checkbox component exists at `@/components/ui/checkbox` (added in a prior feature). Check whether `Settings.tsx` already imports it:
```bash
grep -n "components/ui/checkbox" packages/frontend/src/pages/Settings.tsx
```
If absent, add near the other UI imports at the top of `Settings.tsx`:
```typescript
import { Checkbox } from '@/components/ui/checkbox';
```

- [ ] **Step 2: Add the roles query**

In `DiscordTab()`, after the `discord-guilds` query block (the `const { data: guilds = [] } = useQuery({ ... })`), add:
```typescript
  const { data: roles = [] } = useQuery({
    queryKey: ['discord-roles'],
    queryFn: discordApi.roles,
    enabled: !!status?.running,
  });
```

- [ ] **Step 3: Invalidate roles on save**

In the `save` mutation's `onSuccess`, after `qc.invalidateQueries({ queryKey: ['discord-channels'] });` add:
```typescript
      qc.invalidateQueries({ queryKey: ['discord-channels'] });
      qc.invalidateQueries({ queryKey: ['discord-roles'] });
```

- [ ] **Step 4: Add a role-toggle helper**

Inside `DiscordTab`, after the `channelField` helper definition (after its closing `);`), add:
```typescript
  const toggleRole = (id: string) =>
    setForm((f) => {
      const cur = f.commandRoleIds ?? [];
      return { ...f, commandRoleIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });
```

- [ ] **Step 5: Render the roles section**

In the returned JSX, immediately AFTER the three `channelField(...)` calls (after the `voiceChannel` one at the `{channelField(t('settings.discord.voiceChannel'), ...)}` line), insert:
```tsx
        <div className="space-y-1.5 pt-1">
          <Label className="text-xs font-medium">{t('settings.discord.commandRoles')}</Label>
          <p className="text-[10px] text-muted-foreground">{t('settings.discord.commandRolesHint')}</p>
          {roles.length > 0 ? (
            <div className="space-y-1.5 max-h-48 overflow-y-auto rounded-md border border-border/50 p-2">
              {roles.map((r) => (
                <label key={r.id} className="flex items-center gap-2 cursor-pointer select-none">
                  <Checkbox
                    checked={(form.commandRoleIds ?? []).includes(r.id)}
                    onCheckedChange={() => toggleRole(r.id)}
                  />
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full shrink-0 border border-border/50"
                    style={{ backgroundColor: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : 'transparent' }}
                  />
                  <span className="text-xs truncate">{r.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground italic">{t('settings.discord.commandRolesOffline')}</p>
          )}
        </div>
```

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @ts6/frontend exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/pages/Settings.tsx
git commit -m "feat(discord): roles multi-select in the Discord settings tab"
```

---

## Task 7: i18n keys (5 locales)

**Files:**
- Modify: `packages/frontend/src/i18n/locales/en.json`
- Modify: `packages/frontend/src/i18n/locales/fr.json`
- Modify: `packages/frontend/src/i18n/locales/de.json`
- Modify: `packages/frontend/src/i18n/locales/es.json`
- Modify: `packages/frontend/src/i18n/locales/it.json`

- [ ] **Step 1: Add three keys to the `settings.discord` object in each locale**

Insert these keys inside the existing `"settings": { "discord": { ... } }` object (mind the commas — add a comma to the preceding last key). Use the per-language translations below.

**en.json:**
```json
    "commandRoles": "Allowed roles for commands",
    "commandRolesHint": "Empty = everyone can use the commands. Pick roles to restrict who can. Discord admins and the server owner are always allowed.",
    "commandRolesOffline": "Connect the bot to list its roles."
```
**fr.json:**
```json
    "commandRoles": "Rôles autorisés pour les commandes",
    "commandRolesHint": "Vide = tout le monde peut utiliser les commandes. Choisis des rôles pour restreindre. Les administrateurs Discord et le propriétaire du serveur sont toujours autorisés.",
    "commandRolesOffline": "Connecte le bot pour lister ses rôles."
```
**de.json:**
```json
    "commandRoles": "Erlaubte Rollen für Befehle",
    "commandRolesHint": "Leer = alle dürfen die Befehle nutzen. Wähle Rollen, um den Zugriff einzuschränken. Discord-Administratoren und der Server-Inhaber sind immer erlaubt.",
    "commandRolesOffline": "Verbinde den Bot, um seine Rollen aufzulisten."
```
**es.json:**
```json
    "commandRoles": "Roles permitidos para los comandos",
    "commandRolesHint": "Vacío = todos pueden usar los comandos. Elige roles para restringir el acceso. Los administradores de Discord y el propietario del servidor siempre tienen permiso.",
    "commandRolesOffline": "Conecta el bot para listar sus roles."
```
**it.json:**
```json
    "commandRoles": "Ruoli autorizzati per i comandi",
    "commandRolesHint": "Vuoto = tutti possono usare i comandi. Scegli i ruoli per limitarne l'accesso. Gli amministratori di Discord e il proprietario del server sono sempre autorizzati.",
    "commandRolesOffline": "Connetti il bot per elencare i suoi ruoli."
```

- [ ] **Step 2: Validate JSON + keys present**

Run:
```bash
node -e "['en','fr','de','es','it'].forEach(l=>{const o=JSON.parse(require('fs').readFileSync('packages/frontend/src/i18n/locales/'+l+'.json','utf8'));['commandRoles','commandRolesHint','commandRolesOffline'].forEach(k=>{if(!o.settings.discord[k])throw new Error(l+' missing '+k)});});console.log('ALL OK')"
```
Expected: `ALL OK`.

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/i18n/locales
git commit -m "feat(i18n): Discord command-roles strings (5 locales)"
```

---

## Task 8: Verification pass

- [ ] **Step 1: Backend type-check + full test suite**

Run:
```bash
pnpm --filter @ts6/backend exec tsc --noEmit && pnpm --filter @ts6/backend exec vitest run
```
Expected: no type errors; all tests pass (existing + the new `command-permissions` tests).

- [ ] **Step 2: Frontend type-check**

Run:
```bash
pnpm --filter @ts6/frontend exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Lint the feature's own files**

Run:
```bash
pnpm --filter @ts6/backend exec eslint src/discord/command-permissions.ts src/discord/command-permissions.test.ts src/discord/discord-bridge.ts src/routes/discord.routes.ts
pnpm --filter @ts6/frontend exec eslint src/api/discord.api.ts src/pages/Settings.tsx
```
Expected: no NEW errors in these files (the repo has pre-existing lint errors in unrelated files; only the feature's files matter here — Settings.tsx has pre-existing errors unrelated to this change, so confirm no new ones were introduced around the added code).

- [ ] **Step 4: Manual smoke (with a connected bot)**

1. Settings → Discord: with the bot connected, the "Allowed roles for commands" list shows the guild roles with colour dots.
2. Leave all unchecked, save → run `/nowplaying` from any account → works (open).
3. Check one role you do NOT have (and you are not a Discord admin) → save → run a command → get the ephemeral "⛔ …" denial.
4. As a Discord admin or with an allowed role → command works.
5. Switch the UI language → the labels/hint are translated.

- [ ] **Step 5: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "chore(discord): command-roles verification fixes"
```

---

## Notes for the implementer

- **`this.settings` is the raw Prisma `DiscordSettings` row** (not a transformed object), so `this.settings?.commandRoleIds` is the JSON string column directly. Parse it with `parseRoleIds`.
- **`interaction.member` typing:** for guild slash commands it's a `GuildMember` with `.roles.cache`; the defensive `'roles' in member && member.roles?.cache` guard handles the rare `APIInteractionGuildMember` shape (no cache) by treating it as "no roles", which then relies on admin/owner bypass or denies — acceptable and safe.
- **Denial message is intentionally French** (hardcoded), matching the other bot-facing strings in `discord-bridge.ts`. UI strings (settings tab) are fully i18n'd.
- **Role colour `0`** means "no colour" in Discord → rendered as a transparent dot.
- The roles list, like channels/guilds, is only populated when the bridge is connected (`enabled: !!status?.running`); the stored `commandRoleIds` still filter commands even while the settings UI can't list roles.
