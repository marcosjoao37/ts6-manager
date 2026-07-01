# AFK Notification (TeamSpeak → Discord) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Envoyer une notification Discord configurable (on/off) quand un utilisateur du canal TeamSpeak surveillé passe AFK ou en revient.

**Architecture :** Le protocole ServerQuery n'émet aucun événement sur le toggle `client_away`. On ajoute donc un poller périodique (~10 s) dans `DiscordBridge` qui interroge `clientlist -away` via le `ConnectionPool` (WebQuery), compare l'état away par client d'un tick à l'autre, et poste une notification dans le salon Discord général au changement. Le poller suit le modèle du `statsTimer` existant (cycle de vie hot-reloadable via `start()`/`stop()`).

**Tech Stack :** TypeScript 5.9 (strict), Node 20+, Express 4, Prisma 6 + SQLite, discord.js 14, React 18 + Vite, TanStack Query, Radix UI, react-i18next, vitest, pnpm workspace.

## Global Constraints

- Monorepo pnpm : backend `packages/backend`, frontend `packages/frontend`, types partagés `packages/common`.
- TypeScript strict ; imports backend ESM avec extension `.js`.
- Les embeds de `discord/embeds.ts` sont des fonctions **pures** (aucun import discord.js).
- i18n : toute nouvelle clé UI doit exister dans les **5 langues** FR/EN/DE/ES/IT.
- Le sondage `clientlist` doit passer le flag `{ '-away': '' }` (sinon `client_away` absent de la réponse).
- Amorçage anti-spam : aucune notification au premier tick ni après un reload.
- Templates par défaut : `💤 {user} est passé AFK` (away) et `✅ {user} est de retour` (back).
- Réglages réutilisés (ne pas dupliquer) : `notifyChannelId` (canal TS surveillé), `notificationsChannelId` (salon Discord), `notifyEmbed`, `notifAutoDeleteSeconds`, `serverConfigId`, `virtualServerId`.
- Commandes : `pnpm --filter @ts6/backend test` / `pnpm --filter @ts6/frontend test` (adapter au nom réel des packages, cf. `package.json`). Prisma : `pnpm --filter @ts6/backend exec prisma migrate dev`.

---

### Task 1: Schéma Prisma + migration

Ajoute les 3 champs de configuration à `DiscordSettings` et génère la migration/client Prisma. C'est le socle : toutes les autres tâches lisent ou écrivent ces champs.

**Files:**
- Modify: `packages/backend/prisma/schema.prisma` (model `DiscordSettings`, ~lignes 269-292)
- Generated (gitignorés, NE PAS commiter) : `packages/backend/generated/prisma/*`, `packages/backend/prisma/migrations/*`

> Convention repo : `generated/prisma` et `prisma/migrations` sont **gitignorés**. La migration/le client sont régénérés localement ; seul `schema.prisma` est versionné.

**Interfaces:**
- Consumes: rien.
- Produces: champs `notifyAway: boolean` (default false), `notifyAwayTemplate: string | null`, `notifyBackTemplate: string | null` sur le type Prisma `DiscordSettings`.

- [ ] **Step 1: Ajouter les champs au schéma**

Dans `packages/backend/prisma/schema.prisma`, model `DiscordSettings`, après `notifyEmbed` / `notifAutoDeleteSeconds` :

```prisma
  notifyAway             Boolean  @default(false)
  notifyAwayTemplate     String?
  notifyBackTemplate     String?
```

- [ ] **Step 2: Générer la migration + le client**

Run: `pnpm --filter @ts6/backend exec prisma migrate dev --name add_afk_notification`
Expected: migration créée (localement, gitignorée), `generated/prisma` régénéré, exit 0.

- [ ] **Step 3: Vérifier la compilation des types**

Run: `pnpm --filter @ts6/backend exec tsc --noEmit`
Expected: PASS (aucune erreur ; le type `DiscordSettings` expose désormais les 3 champs).

- [ ] **Step 4: Commit**

```bash
git add packages/backend/prisma/schema.prisma
git commit -m "feat(discord): add AFK notification settings columns"
```
(migrations et `generated/prisma` sont gitignorés — rien d'autre à ajouter.)

---

### Task 2: Embeds & templates AFK

Ajoute les templates par défaut et le builder d'embed pur pour la notification AFK. Testable en isolation (fonctions pures).

**Files:**
- Modify: `packages/backend/src/discord/embeds.ts`
- Test: `packages/backend/src/discord/embeds.test.ts` (créer si absent, sinon y ajouter)

**Interfaces:**
- Consumes: `COLORS`, `renderTemplate` (déjà dans `embeds.ts`).
- Produces:
  - `export const DEFAULT_AWAY_TEMPLATE = '💤 {user} est passé AFK'`
  - `export const DEFAULT_BACK_TEMPLATE = '✅ {user} est de retour'`
  - `export function awayStatusEmbed(message: string, isAway: boolean): { color: number; description: string; timestamp: string }`

- [ ] **Step 1: Écrire le test qui échoue**

Dans `packages/backend/src/discord/embeds.test.ts` (créer le fichier s'il n'existe pas, avec l'entête d'import ci-dessous ; sinon ajouter le bloc `describe`) :

```ts
import { describe, it, expect } from 'vitest';
import {
  awayStatusEmbed,
  renderTemplate,
  DEFAULT_AWAY_TEMPLATE,
  DEFAULT_BACK_TEMPLATE,
} from './embeds.js';

describe('awayStatusEmbed', () => {
  it('colore en violet et garde le message quand AFK', () => {
    const e = awayStatusEmbed('Bob est passé AFK', true);
    expect(e.color).toBe(0x9b59b6);
    expect(e.description).toBe('Bob est passé AFK');
    expect(typeof e.timestamp).toBe('string');
  });

  it('colore en vert quand de retour', () => {
    const e = awayStatusEmbed('Bob est de retour', false);
    expect(e.color).toBe(0x2ecc71);
  });
});

describe('templates AFK par défaut', () => {
  it('rend le template away avec le pseudo', () => {
    const msg = renderTemplate(DEFAULT_AWAY_TEMPLATE, { user: 'Bob', channel: 'Lobby', totalMembers: 3, action: '💤' });
    expect(msg).toBe('💤 Bob est passé AFK');
  });

  it('rend le template back avec le pseudo', () => {
    const msg = renderTemplate(DEFAULT_BACK_TEMPLATE, { user: 'Bob', channel: 'Lobby', totalMembers: 3, action: '✅' });
    expect(msg).toBe('✅ Bob est de retour');
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `pnpm --filter @ts6/backend exec vitest run src/discord/embeds.test.ts`
Expected: FAIL (`awayStatusEmbed`/`DEFAULT_AWAY_TEMPLATE` non exportés).

- [ ] **Step 3: Implémenter dans `embeds.ts`**

Après `DEFAULT_LEAVE_TEMPLATE` (~ligne 66) :

```ts
export const DEFAULT_AWAY_TEMPLATE = '💤 {user} est passé AFK';
export const DEFAULT_BACK_TEMPLATE = '✅ {user} est de retour';

/** AFK status notification (embed style) from an already-rendered message. */
export function awayStatusEmbed(message: string, isAway: boolean) {
  return {
    color: isAway ? COLORS.purple : COLORS.green,
    description: message,
    timestamp: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `pnpm --filter @ts6/backend exec vitest run src/discord/embeds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/discord/embeds.ts packages/backend/src/discord/embeds.test.ts
git commit -m "feat(discord): AFK embed builder and default templates"
```

---

### Task 3: Logique de diff du poller (unité pure) + intégration bridge

Extrait la logique de comparaison d'état away dans une fonction pure testable, puis câble le poller (`setInterval`) et l'envoi de notification dans `DiscordBridge`. La fonction pure permet de tester le comportement (amorçage, passage AFK, retour, filtrage, purge) sans discord.js ni réseau.

**Files:**
- Create: `packages/backend/src/discord/away-diff.ts`
- Test: `packages/backend/src/discord/away-diff.test.ts`
- Modify: `packages/backend/src/discord/discord-bridge.ts`

**Interfaces:**
- Consumes: `awayStatusEmbed`, `DEFAULT_AWAY_TEMPLATE`, `DEFAULT_BACK_TEMPLATE`, `renderTemplate` (Task 2) ; `postToChannel`, `resolveChannelName`, `countChannelMembers`, `this.pool`, `this.settings`, `this.startEpoch` (existants).
- Produces:
  - `export interface AwayClient { clid: string; cid: string; isAway: boolean; nickname: string }`
  - `export interface AwayChange { clid: string; cid: string; nickname: string; isAway: boolean }`
  - `export function diffAwayState(prev: Map<string, boolean>, current: AwayClient[]): { changes: AwayChange[]; next: Map<string, boolean>; seeded: boolean }`
    - Si `prev` est vide → `seeded: true`, `changes: []`, `next` = map amorcée depuis `current`.
    - Sinon `changes` = clients présents dans `prev` dont `isAway` a changé ; nouveaux clients enregistrés dans `next` sans changement ; clids absents de `current` purgés.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `packages/backend/src/discord/away-diff.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { diffAwayState, type AwayClient } from './away-diff.js';

const c = (clid: string, isAway: boolean, cid = '5', nickname = `U${clid}`): AwayClient => ({ clid, cid, isAway, nickname });

describe('diffAwayState', () => {
  it('amorce sans changement quand prev est vide', () => {
    const { changes, next, seeded } = diffAwayState(new Map(), [c('1', false), c('2', true)]);
    expect(seeded).toBe(true);
    expect(changes).toEqual([]);
    expect(next.get('1')).toBe(false);
    expect(next.get('2')).toBe(true);
  });

  it('détecte le passage AFK (false → true)', () => {
    const prev = new Map([['1', false]]);
    const { changes } = diffAwayState(prev, [c('1', true)]);
    expect(changes).toEqual([{ clid: '1', cid: '5', nickname: 'U1', isAway: true }]);
  });

  it('détecte le retour (true → false)', () => {
    const prev = new Map([['1', true]]);
    const { changes } = diffAwayState(prev, [c('1', false)]);
    expect(changes[0].isAway).toBe(false);
  });

  it("n'émet rien quand l'état est inchangé", () => {
    const prev = new Map([['1', false]]);
    const { changes } = diffAwayState(prev, [c('1', false)]);
    expect(changes).toEqual([]);
  });

  it("enregistre un nouveau client sans le notifier", () => {
    const prev = new Map([['1', false]]);
    const { changes, next } = diffAwayState(prev, [c('1', false), c('2', true)]);
    expect(changes).toEqual([]);
    expect(next.get('2')).toBe(true);
  });

  it('purge les clids disparus de la liste courante', () => {
    const prev = new Map([['1', false], ['2', true]]);
    const { next } = diffAwayState(prev, [c('1', false)]);
    expect(next.has('2')).toBe(false);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `pnpm --filter @ts6/backend exec vitest run src/discord/away-diff.test.ts`
Expected: FAIL (module `away-diff` introuvable).

- [ ] **Step 3: Implémenter `away-diff.ts`**

Créer `packages/backend/src/discord/away-diff.ts` :

```ts
export interface AwayClient {
  clid: string;
  cid: string;
  isAway: boolean;
  nickname: string;
}

export interface AwayChange {
  clid: string;
  cid: string;
  nickname: string;
  isAway: boolean;
}

/**
 * Compare the previous away-state map against the current client list.
 * On first run (empty prev) it seeds without emitting changes, to avoid
 * spamming a notification for every already-away client at startup/reload.
 */
export function diffAwayState(
  prev: Map<string, boolean>,
  current: AwayClient[],
): { changes: AwayChange[]; next: Map<string, boolean>; seeded: boolean } {
  const next = new Map<string, boolean>();
  const seeded = prev.size === 0;
  const changes: AwayChange[] = [];

  for (const client of current) {
    next.set(client.clid, client.isAway);
    if (seeded) continue;
    const was = prev.get(client.clid);
    if (was !== undefined && was !== client.isAway) {
      changes.push({ clid: client.clid, cid: client.cid, nickname: client.nickname, isAway: client.isAway });
    }
  }

  return { changes, next, seeded };
}
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `pnpm --filter @ts6/backend exec vitest run src/discord/away-diff.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Câbler le poller dans `discord-bridge.ts` — imports & champs**

Ajouter aux imports depuis `./embeds.js` : `awayStatusEmbed, DEFAULT_AWAY_TEMPLATE, DEFAULT_BACK_TEMPLATE`.
Ajouter un import : `import { diffAwayState, type AwayClient } from './away-diff.js';`
Sous `const STATS_PANEL_INTERVAL_MS = 60_000;` ajouter : `const AWAY_POLL_INTERVAL_MS = 10_000;`
Dans la classe, à côté de `private statsTimer`, ajouter :

```ts
  private awayTimer: ReturnType<typeof setInterval> | null = null;
  private clientAwayState = new Map<string, boolean>(); // clid → isAway
```

- [ ] **Step 6: Câbler le poller — méthodes**

Après `startTsEventBridge()` (ou dans la section notifications), ajouter :

```ts
  // ─── AFK (away) notifications ───────────────────────────────

  private startAwayPoll(): void {
    const settings = this.settings;
    if (!settings?.notifyAway) return;
    if (!settings.notificationsChannelId || !settings.serverConfigId) return;
    const epoch = this.startEpoch;
    this.clientAwayState.clear();
    const tick = () => {
      if (epoch !== this.startEpoch) return;
      this.pollAwayState().catch((err) => {
        console.error(`[Discord] Away poll failed: ${err.message}`);
      });
    };
    this.awayTimer = setInterval(tick, AWAY_POLL_INTERVAL_MS);
    tick();
  }

  private async pollAwayState(): Promise<void> {
    const settings = this.settings;
    if (!settings?.serverConfigId) return;
    const watchedChannel = settings.notifyChannelId;

    const client = await this.pool.getOrLoad(settings.serverConfigId);
    const list = await client.execute(settings.virtualServerId, 'clientlist', { '-away': '' });
    const current: AwayClient[] = (Array.isArray(list) ? list : [])
      .filter((c: any) => String(c.client_type) === '0')
      .filter((c: any) => !watchedChannel || String(c.cid) === watchedChannel)
      .map((c: any) => ({
        clid: String(c.clid),
        cid: String(c.cid),
        isAway: Number(c.client_away) === 1,
        nickname: c.client_nickname || `Client #${c.clid}`,
      }));

    const { changes, next } = diffAwayState(this.clientAwayState, current);
    this.clientAwayState = next;
    for (const change of changes) {
      await this.notifyAwayChange(change.nickname, change.cid, change.isAway);
    }
  }

  private async notifyAwayChange(nickname: string, channelId: string, isAway: boolean): Promise<void> {
    const channel = await this.resolveChannelName(channelId);
    const totalMembers = await this.countChannelMembers(channelId);
    const template = isAway
      ? (this.settings?.notifyAwayTemplate || DEFAULT_AWAY_TEMPLATE)
      : (this.settings?.notifyBackTemplate || DEFAULT_BACK_TEMPLATE);
    const action = isAway ? '💤' : '✅';
    const message = renderTemplate(template, { user: nickname, channel, totalMembers, action });
    const payload = this.settings?.notifyEmbed
      ? { embeds: [awayStatusEmbed(message, isAway)] }
      : { content: message };
    console.log(`[Discord] notify away=${isAway} → channel=${this.settings?.notificationsChannelId} msg="${message}"`);
    await this.postToChannel(this.settings?.notificationsChannelId, payload);
  }
```

- [ ] **Step 7: Démarrer/arrêter le poller dans le cycle de vie**

Dans `start()`, après `await this.startTsEventBridge();` (fin de méthode, ~ligne 175) :

```ts
    this.startAwayPoll();
```

Dans `stop()`, à côté du `clearInterval(this.statsTimer)` (~ligne 180) :

```ts
    if (this.awayTimer) {
      clearInterval(this.awayTimer);
      this.awayTimer = null;
    }
    this.clientAwayState.clear();
```

- [ ] **Step 8: Vérifier compilation + suite de tests backend**

Run: `pnpm --filter @ts6/backend exec tsc --noEmit && pnpm --filter @ts6/backend exec vitest run`
Expected: PASS (compilation OK, tous les tests verts).

- [ ] **Step 9: Commit**

```bash
git add packages/backend/src/discord/away-diff.ts packages/backend/src/discord/away-diff.test.ts packages/backend/src/discord/discord-bridge.ts
git commit -m "feat(discord): poll TS away state and notify Discord on AFK change"
```

---

### Task 4: API settings (GET/PUT)

Expose et persiste les 3 nouveaux champs via les routes settings. Le `bridge.reload()` déjà présent après le PUT applique le changement à chaud.

**Files:**
- Modify: `packages/backend/src/routes/discord.routes.ts` (GET `/settings` ~18-43, PUT `/settings` ~45-86)

**Interfaces:**
- Consumes: colonnes Prisma de Task 1.
- Produces: `notifyAway`, `notifyAwayTemplate`, `notifyBackTemplate` dans le JSON GET et acceptés au PUT.

- [ ] **Step 1: Exposer les champs dans GET `/settings`**

Dans la réponse `res.json({ ... })` de GET, ajouter à côté des autres `notify*` :

```ts
      notifyAway: s.notifyAway,
      notifyAwayTemplate: s.notifyAwayTemplate,
      notifyBackTemplate: s.notifyBackTemplate,
```
(Utiliser le nom de variable des settings tel qu'il est dans le fichier — `s` ci-dessus est indicatif.)

- [ ] **Step 2: Accepter les champs dans PUT `/settings`**

Là où les autres champs sont extraits de `req.body` et affectés à `data`, ajouter :

```ts
    if (req.body.notifyAway !== undefined) data.notifyAway = !!req.body.notifyAway;
    if (req.body.notifyAwayTemplate !== undefined) data.notifyAwayTemplate = req.body.notifyAwayTemplate || null;
    if (req.body.notifyBackTemplate !== undefined) data.notifyBackTemplate = req.body.notifyBackTemplate || null;
```
(Adapter au style existant du fichier : destructuration en tête ou accès direct `req.body.*`.)

- [ ] **Step 3: Vérifier la compilation**

Run: `pnpm --filter @ts6/backend exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Vérification manuelle rapide (optionnel mais recommandé)**

Démarrer le backend, `PUT /api/discord/settings` avec `{"notifyAway":true,"notifyAwayTemplate":"x {user}"}`, puis `GET /api/discord/settings` et confirmer que les valeurs reviennent.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routes/discord.routes.ts
git commit -m "feat(discord): expose AFK notification settings in API"
```

---

### Task 5: Client API frontend

Ajoute les 3 champs à l'interface TypeScript côté frontend pour que l'UI puisse les lire/écrire de manière typée.

**Files:**
- Modify: `packages/frontend/src/api/discord.api.ts` (interface `DiscordSettings`)

**Interfaces:**
- Consumes: JSON de Task 4.
- Produces: `notifyAway: boolean`, `notifyAwayTemplate: string | null`, `notifyBackTemplate: string | null` sur l'interface `DiscordSettings`.

- [ ] **Step 1: Ajouter les champs à l'interface**

Dans `packages/frontend/src/api/discord.api.ts`, interface `DiscordSettings`, à côté des autres `notify*` :

```ts
  notifyAway: boolean;
  notifyAwayTemplate: string | null;
  notifyBackTemplate: string | null;
```

- [ ] **Step 2: Vérifier la compilation frontend**

Run: `pnpm --filter @ts6/frontend exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/api/discord.api.ts
git commit -m "feat(web): AFK notification fields on DiscordSettings type"
```

---

### Task 6: UI DiscordTab + i18n

Ajoute le switch AFK et le sous-panneau de templates dans l'onglet Discord des paramètres, avec les clés i18n dans les 5 langues.

**Files:**
- Modify: `packages/frontend/src/pages/Settings.tsx` (fonction `DiscordTab`, section Notifications ~1004-1069)
- Modify: fichiers de traduction (localiser via recherche de la clé existante `settings.discord.notifyConnections` / `notifyNowPlaying`), pour FR/EN/DE/ES/IT.

**Interfaces:**
- Consumes: champs de l'interface `DiscordSettings` (Task 5) ; pattern `form`/`setForm` existant.
- Produces: contrôles UI liés à `form.notifyAway`, `form.notifyAwayTemplate`, `form.notifyBackTemplate`.

- [ ] **Step 1: Localiser les clés i18n existantes**

Run: `rg "notifyNowPlaying" packages/frontend/src` (repérer les fichiers de langue et le namespace exact utilisé par `t('settings.discord.*')`).
Expected: liste des 5 fichiers de traduction + usage dans `Settings.tsx`.

- [ ] **Step 2: Ajouter les clés i18n dans les 5 langues**

Sous `settings.discord`, ajouter dans chaque fichier de langue (adapter la casse/structure au fichier) :

- FR : `awayStatus: "Notifier les passages AFK"`, `awayTemplate: "Message passage AFK"`, `backTemplate: "Message retour d'AFK"`, `awayHint: "Utilise le canal surveillé et le style définis ci-dessus."`
- EN : `awayStatus: "Notify AFK status changes"`, `awayTemplate: "AFK message"`, `backTemplate: "Back message"`, `awayHint: "Uses the watched channel and style set above."`
- DE : `awayStatus: "AFK-Statuswechsel melden"`, `awayTemplate: "AFK-Nachricht"`, `backTemplate: "Zurück-Nachricht"`, `awayHint: "Verwendet den oben festgelegten überwachten Kanal und Stil."`
- ES : `awayStatus: "Notificar cambios de estado AFK"`, `awayTemplate: "Mensaje AFK"`, `backTemplate: "Mensaje de regreso"`, `awayHint: "Usa el canal vigilado y el estilo definidos arriba."`
- IT : `awayStatus: "Notifica i cambi di stato AFK"`, `awayTemplate: "Messaggio AFK"`, `backTemplate: "Messaggio di ritorno"`, `awayHint: "Usa il canale monitorato e lo stile impostati sopra."`

- [ ] **Step 3: Ajouter le switch + sous-panneau dans `DiscordTab`**

Dans la section Notifications, après le bloc `notifyNowPlaying` (avant le champ `notifAutoDeleteSeconds`), en imitant le style existant :

```tsx
<div className="flex items-center gap-2">
  <Switch
    checked={!!form.notifyAway}
    onCheckedChange={(v) => setForm((f) => ({ ...f, notifyAway: v }))}
  />
  <Label className="text-xs font-normal">{t('settings.discord.awayStatus')}</Label>
</div>

{form.notifyAway && (
  <div className="ml-9 space-y-2 border-l border-border pl-3">
    <div className="space-y-1.5">
      <Label className="text-[11px]">{t('settings.discord.awayTemplate')}</Label>
      <Input
        className="h-8 text-xs"
        placeholder="💤 {user} est passé AFK"
        value={form.notifyAwayTemplate || ''}
        onChange={(e) => setForm((f) => ({ ...f, notifyAwayTemplate: e.target.value || null }))}
      />
    </div>
    <div className="space-y-1.5">
      <Label className="text-[11px]">{t('settings.discord.backTemplate')}</Label>
      <Input
        className="h-8 text-xs"
        placeholder="✅ {user} est de retour"
        value={form.notifyBackTemplate || ''}
        onChange={(e) => setForm((f) => ({ ...f, notifyBackTemplate: e.target.value || null }))}
      />
    </div>
    <p className="text-[10px] text-muted-foreground">{t('settings.discord.awayHint')}</p>
  </div>
)}
```

- [ ] **Step 4: Vérifier compilation + build frontend**

Run: `pnpm --filter @ts6/frontend exec tsc --noEmit`
Expected: PASS (aucune clé/prop manquante).

- [ ] **Step 5: Vérification visuelle rapide**

Lancer le frontend, ouvrir Paramètres → Discord, activer le switch AFK, vérifier l'apparition des deux champs de template et de la note. Sauvegarder et confirmer le toast de succès.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/pages/Settings.tsx packages/frontend/src/**/locales
git commit -m "feat(web): AFK notification toggle and templates in Discord settings"
```

---

### Task 7: Vérification finale

Vérifie que l'ensemble compile et que toute la suite passe, des deux côtés.

**Files:** aucun (vérification).

- [ ] **Step 1: Backend**

Run: `pnpm --filter @ts6/backend exec tsc --noEmit && pnpm --filter @ts6/backend exec vitest run`
Expected: PASS.

- [ ] **Step 2: Frontend**

Run: `pnpm --filter @ts6/frontend exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Test manuel bout-en-bout (si serveur TS accessible)**

Activer la notif AFK dans l'UI, définir un canal surveillé, passer un client TS en AFK, vérifier la réception de la notification Discord (~10 s), puis le retour d'AFK. Vérifier le respect de `notifyEmbed` et `notifAutoDeleteSeconds`.

---

## Notes d'exécution

- Adapter les noms de packages pnpm (`--filter @ts6/backend` / `--filter @ts6/frontend`) aux noms réels dans les `package.json` respectifs.
- Vérifier le nom exact de la méthode du pool (`getOrLoad` est utilisée dans `discord-bridge.ts` : `seedClientState`, `countChannelMembers`). Réutiliser la même.
- Si `embeds.test.ts` n'existe pas, Task 2 le crée ; le pattern de test vitest est déjà utilisé ailleurs dans le backend.
