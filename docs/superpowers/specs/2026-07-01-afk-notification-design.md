# Notification AFK TeamSpeak → Discord — Design

**Date :** 2026-07-01
**Statut :** Approuvé (design), en attente de plan d'implémentation

## Objectif

Envoyer une notification Discord configurable (on/off) quand un utilisateur du
canal TeamSpeak surveillé **passe AFK** ou **en revient**. La fonctionnalité
s'aligne exactement sur le pattern des notifications join/leave déjà en place.

## Contrainte technique déterminante

Le protocole ServerQuery TeamSpeak **n'émet aucun événement** quand un client
bascule son statut `client_away` sans changer de canal. Les événements
`notifycliententerview` / `notifyclientmoved` ne portent l'état away qu'au moment
d'une connexion ou d'un déplacement. Le champ `client_away` n'est donc observable
que par **sondage** de `clientlist`, et uniquement si le flag `-away` est passé.

**Conséquence :** la détection se fait par un poller périodique (~10 s) qui
compare l'état away par client d'un tick à l'autre.

## Décisions produit (validées)

| Sujet | Décision |
|-------|----------|
| Fréquence de sondage | ~10 s |
| Déclencheurs | Passage AFK **et** retour d'AFK |
| Format message | Templates personnalisables (away / back), avec `{user}`, `{channel}` |
| Portée | Filtré par canal TS (réutilise `notifyChannelId`) |
| Salon Discord destination | `notificationsChannelId` général (réutilisé) |
| Style | Respecte `notifyEmbed` et `notifAutoDeleteSeconds` existants |

## Architecture

```
DiscordBridge.start()
  ├─ startTsEventBridge()      (existant : join/leave via SSH events)
  └─ startAwayPoll()           (nouveau : setInterval 10s)
        └─ pollAwayState()
              ├─ clientlist -away  (via ConnectionPool WebQuery)
              ├─ filtre client_type=0 + cid===notifyChannelId
              ├─ diff vs clientAwayState (Map clid→isAway)
              └─ notifyAwayChange() → postToChannel(notificationsChannelId)
```

Le poller utilise le `ConnectionPool` (WebQuery), **pas** le SSH event bridge :
il fonctionne même sans credentials SSH. Il suit le modèle exact de
`statsTimer` / `startStatsPanel()` pour le cycle de vie et le hot-reload.

## Modèle de données — `packages/backend/prisma/schema.prisma`

Ajouter à `model DiscordSettings` :

```prisma
notifyAway         Boolean @default(false)  // on/off de la notif AFK
notifyAwayTemplate String?                  // template "passage AFK"
notifyBackTemplate String?                  // template "retour d'AFK"
```

Champs existants réutilisés : `notifyChannelId`, `notificationsChannelId`,
`notifyEmbed`, `notifAutoDeleteSeconds`, `serverConfigId`, `virtualServerId`.

Migration Prisma à générer.

## Backend — `packages/backend/src/discord/discord-bridge.ts`

Nouveaux champs privés :

```ts
private awayTimer: ReturnType<typeof setInterval> | null = null;
private clientAwayState = new Map<string, boolean>(); // clid → isAway
```

Constante : `const AWAY_POLL_INTERVAL_MS = 10_000;`

### `startAwayPoll()`
- Appelée dans `start()` après `startTsEventBridge()`.
- Gardes : `settings.notifyAway && settings.notificationsChannelId && settings.serverConfigId`.
- `this.awayTimer = setInterval(tick, AWAY_POLL_INTERVAL_MS)` ; le `tick` appelle
  `pollAwayState()` avec capture/vérification de `startEpoch` et `.catch()` de log.
- **Ne pas** exécuter un tick immédiat qui notifierait : l'amorçage se fait dans
  le premier tick (voir ci-dessous).

### `pollAwayState()`
1. `const list = await client.execute(virtualServerId, 'clientlist', { '-away': '' })`.
2. Construire l'ensemble courant : clients `client_type === 0`, filtrés par
   `cid === notifyChannelId` si `notifyChannelId` est défini (sinon tout le serveur).
3. Diff par clid :
   - **Premier tick** (`clientAwayState` vide) : amorcer la map sans notifier.
   - Sinon, pour chaque client présent dans l'ancienne map dont `isAway` a changé
     → `notifyAwayChange(nickname, cid, isAway)`.
   - Les clients nouvellement apparus sont enregistrés sans notifier (leur état
     away initial n'est pas un « changement »).
4. Purger de `clientAwayState` les clids absents de la liste courante.

### `notifyAwayChange(nickname, channelId, isAway)`
Calque de `notifyChannel()` :
```ts
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
await this.postToChannel(this.settings?.notificationsChannelId, payload);
```

### `stop()`
Ajouter :
```ts
if (this.awayTimer) { clearInterval(this.awayTimer); this.awayTimer = null; }
this.clientAwayState.clear();
```
(`reload()` = `stop()` + `start()`, donc l'amorçage est automatiquement refait.)

## Embeds — `packages/backend/src/discord/embeds.ts`

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
`renderTemplate` existant gère déjà `{user}`, `{channel}`, `{action}`,
`{TotalMembersOfChannel}` — aucune modification nécessaire.

## API — `packages/backend/src/routes/discord.routes.ts`

- **GET `/settings`** : exposer `notifyAway`, `notifyAwayTemplate`, `notifyBackTemplate`.
- **PUT `/settings`** : valider et persister
  - `if (notifyAway !== undefined) data.notifyAway = !!notifyAway;`
  - `if (notifyAwayTemplate !== undefined) data.notifyAwayTemplate = notifyAwayTemplate || null;`
  - `if (notifyBackTemplate !== undefined) data.notifyBackTemplate = notifyBackTemplate || null;`
  - `bridge.reload()` déjà appelé après update (hot-reload).

## Frontend

### `packages/frontend/src/api/discord.api.ts`
Ajouter à l'interface `DiscordSettings` :
```ts
notifyAway: boolean;
notifyAwayTemplate: string | null;
notifyBackTemplate: string | null;
```

### `packages/frontend/src/pages/Settings.tsx` (`DiscordTab`)
Dans la section Notifications, après le bloc join/leave :
- `Switch` lié à `form.notifyAway`.
- Quand activé, sous-panneau (même style visuel `ml-9 border-l pl-3`) avec :
  - `Input` template AFK (`notifyAwayTemplate`, placeholder = défaut).
  - `Input` template retour (`notifyBackTemplate`, placeholder = défaut).
  - Note indiquant que le canal surveillé est celui défini plus haut
    (`notifyChannelId`), et que le style embed/auto-delete est partagé.

### i18n
Nouvelles clés dans les **5 langues** (FR/EN/DE/ES/IT), sous `settings.discord.*` :
libellé du switch AFK, labels des deux templates, note d'aide.

## Tests (vitest)

- **`embeds`** : `awayStatusEmbed` (couleurs away/back), rendu des templates par
  défaut via `renderTemplate`.
- **`discord-bridge`** : logique de diff du poller avec `clientlist` mocké —
  - amorçage : premier tick ne notifie pas ;
  - passage AFK détecté (0 → 1) ;
  - retour détecté (1 → 0) ;
  - filtrage par `notifyChannelId` (clients hors canal ignorés) ;
  - purge des clids déconnectés ;
  - pas de notif si `notifyAway` désactivé.

## Points d'attention

- **Allowlist anti-flood** : +1 `clientlist` toutes les 10 s. À valider vs la
  config du serveur TS (contrainte connue du projet).
- **Amorçage** : aucune notif au 1er tick ni après reload → évite le spam.
- Le poller est indépendant du SSH event bridge (utilise le pool WebQuery).

## Fichiers touchés

| Fichier | Nature |
|---------|--------|
| `packages/backend/prisma/schema.prisma` | +3 champs + migration |
| `packages/backend/src/discord/discord-bridge.ts` | poller + notif AFK |
| `packages/backend/src/discord/embeds.ts` | templates + `awayStatusEmbed` |
| `packages/backend/src/routes/discord.routes.ts` | GET/PUT settings |
| `packages/frontend/src/api/discord.api.ts` | interface |
| `packages/frontend/src/pages/Settings.tsx` | UI DiscordTab |
| fichiers i18n (5 langues) | libellés |
| tests vitest (embeds, discord-bridge) | couverture |
