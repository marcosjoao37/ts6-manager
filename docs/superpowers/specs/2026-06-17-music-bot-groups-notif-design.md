# Design — Restriction par groupe, gestion des appartenances, et notif now-playing TS

Date : 2026-06-17
Statut : validé (brainstorming), prêt pour le plan d'implémentation

## Contexte

Le Music Bot expose des commandes texte dans TeamSpeak (`!play`, `!skip`,
`!move`, `!moveall`, `!channels`, etc.) gérées par `MusicCommandHandler`
(`packages/backend/src/voice/music-command-handler.ts`). Aujourd'hui ces
commandes n'ont aucun contrôle d'accès : n'importe qui dans le canal peut les
utiliser. Par ailleurs le bridge Discord poste déjà une notification
« now playing » dans un canal Discord, mais rien d'équivalent n'existe dans le
canal TeamSpeak où se trouve le bot.

Trois fonctionnalités demandées :

1. **Restreindre les commandes à un groupe serveur**, sur deux niveaux
   configurables (un groupe pour les commandes musicales, un groupe pour les
   commandes d'administration).
2. **Gérer facilement les appartenances aux groupes serveur** via la WebUI.
3. **Notifier le titre en cours dans le canal TeamSpeak** du bot, configurable
   via la WebUI et basculable via une commande `!notif`.

## Décisions de cadrage

- Restriction : **deux niveaux configurables** — `musicCommandSgid` (commandes
  musicales) et `adminCommandSgid` (commandes admin : `move`, `moveall`,
  `notif`).
- Emplacement de configuration : **global** (page Settings), partagé par tous
  les Music Bots.
- Gestion des appartenances : **dans la page ServerGroups** existante.
- Notif now-playing : **sur nouveau titre uniquement** (événement `nowPlaying`),
  comme le comportement Discord actuel.

## Hypothèse / limite assumée

Les server groups (`sgid`) sont propres à un serveur virtuel. Comme la
configuration est globale et que le déploiement est mono-serveur en pratique, le
`sgid` configuré est interprété sur le serveur du bot qui reçoit la commande
(résolu via `getServer(botId)` qui donne déjà `serverConfigId` + `sid`). Un
setup multi-serveur avec des IDs de groupe différents par serveur n'est pas
couvert ; on documentera ce point.

## 1. Modèle de données

Nouveau modèle singleton `MusicCommandSettings`, sur le patron de
`DiscordSettings` / `SpotifySettings` (`packages/backend/prisma/schema.prisma`) :

```prisma
model MusicCommandSettings {
  id               Int      @id @default(autoincrement())
  musicCommandSgid Int?     // groupe autorisé pour les commandes musicales (null = ouvert à tous)
  adminCommandSgid Int?     // groupe autorisé pour move/moveall/notif (null = ouvert à tous)
  notifyNowPlaying Boolean  @default(false) // notif now-playing dans le canal TS
  updatedAt        DateTime @updatedAt
}
```

- `null` / non défini = **ouvert à tous** (préserve le comportement actuel).
- Migration Prisma + régénération du client.
- Lecture/écriture via le pattern singleton existant (upsert sur la première
  ligne, comme les autres settings).

### API REST

- `GET /api/music-command-settings` — renvoie la ligne (créée avec valeurs par
  défaut si absente).
- `PUT /api/music-command-settings` — met à jour `musicCommandSgid`,
  `adminCommandSgid`, `notifyNowPlaying` (admin requis, cohérent avec les autres
  routes settings).

## 2. Restriction des commandes

Dans `MusicCommandHandler.onTextMessage`, avant le `switch` d'exécution :

- **Classification** de la commande :
  - Admin : `move`, `moveall`, `notif`.
  - Musicale : toutes les autres commandes contrôlant le bot.
  - Toujours autorisées : `help`, `aide` (pour que l'aide reste accessible).
- **Vérification** :
  1. Charger `MusicCommandSettings` (cache court en mémoire, invalidé sur
     `PUT` et sur `!notif`).
  2. Déterminer le `sgid` requis selon le niveau de la commande.
  3. Si aucun `sgid` n'est configuré pour ce niveau → **autorisé**.
  4. Sinon, résoudre les groupes serveur de l'émetteur : son `clid`
     (`data.invokerid`) → `clientinfo` → `client_servergroups` (liste de sgid
     séparés par des virgules). Vérifier que le `sgid` requis est présent.
  5. Si absent → réponse de refus, ex. `⛔ Commande réservée au groupe
     « <nom> ».` (le nom est résolu via `servergrouplist`, fallback sur l'ID si
     indisponible). Ne pas exécuter la commande.

Les commandes passent par le WebQuery admin (`connectionPool`), donc la
restriction est purement applicative (le bot a déjà les droits techniques).

## 3. Gestion des appartenances (page ServerGroups)

`packages/frontend/src/pages/ServerGroups.tsx` affiche déjà les membres d'un
groupe en lecture seule. Le backend expose déjà les actions
(`POST /servergroups/:sgid/members`, `DELETE /servergroups/:sgid/members/:cldbid`).

Ajouts (UI + hooks react-query uniquement) :

- **Bouton « + Ajouter un membre »** sur le panneau des membres : ouvre un dialog
  avec un sélecteur de **client connecté** (liste via `clientlist`, filtrage par
  pseudo). À la sélection → `POST` avec le `client_database_id` du client.
- **Bouton retrait** (icône poubelle) sur chaque ligne de membre → `DELETE` avec
  le `cldbid`.
- Invalidation de la query `members` du groupe après chaque action + toast de
  succès/échec.
- Nouveaux hooks : `useAddServerGroupMember`, `useRemoveServerGroupMember` dans
  `use-groups`.

Limite assumée : on ajoute des **clients connectés** (cas courant). La recherche
dans la base des clients hors-ligne (`clientdblist`) n'est pas incluse (YAGNI ;
extensible plus tard).

## 4. Notif now-playing dans le canal TS

- `MusicCommandHandler.registerBot` attache un listener `nowPlaying` sur le bot
  (en plus de `textMessage`), comme le fait `DiscordBridge.attachNowPlaying`.
- À chaque nouveau titre, si `notifyNowPlaying` est activé dans
  `MusicCommandSettings`, poster un message texte dans le canal courant du bot
  via `bot.sendChannelMessage(...)` :
  `♪ Now playing : <artiste> - <titre>` (texte simple ; le chat TS ne rend pas
  les embeds ; format aligné sur la sortie de `!np`).
- `unregisterBot` retire le listener.
- Le flag est lu depuis le cache des settings (cf. §2), invalidé par `!notif` et
  par le `PUT` de l'API.

## 5. Commande `!notif`

- Commande **admin** (soumise à `adminCommandSgid`).
- Bascule `notifyNowPlaying` en base (persistant : survit au redémarrage et se
  reflète dans la WebUI ; un changement WebUI se reflète aussi côté commande).
- Invalide le cache des settings.
- Répond avec le nouveau statut :
  - activé : `🔔 Notifications du titre en cours : activées (tous les bots).`
  - désactivé : `🔕 Notifications du titre en cours : désactivées.`
- Comme le réglage est global, la réponse précise que ça affecte tous les bots.
- Ajoutée à la liste `!help`.

## 6. WebUI — section Settings

Nouvelle section « Commandes Music Bot » dans `Settings.tsx` :

- 2 sélecteurs de **groupe serveur** (musical / admin), peuplés via
  `servergrouplist`, avec une option « Aucun (ouvert à tous) ».
- 1 switch « Notifier le titre en cours dans le canal TS ».
- Chargé/enregistré via les nouveaux hooks de `music-command-settings`.

## i18n

Nouvelles clés dans les 5 locales (`fr`, `en`, `de`, `es`, `it`) **et** dans les
fragments source de `packages/frontend/scripts/i18n-fragments/` :

- ServerGroups : ajout/retrait de membre, dialog de sélection, toasts.
- Settings : libellés de la section « Commandes Music Bot ».

## Découpage / fichiers touchés

Backend :
- `prisma/schema.prisma` (+ migration) — `MusicCommandSettings`.
- nouvelle route `routes/music-command-settings.routes.ts` + montage dans
  l'app.
- `voice/music-command-handler.ts` — classification + restriction, listener
  `nowPlaying`, commande `!notif`, cache des settings, entrée d'aide.

Frontend :
- `pages/ServerGroups.tsx` — actions ajout/retrait + dialog.
- `pages/Settings.tsx` — section « Commandes Music Bot ».
- `api/` + `hooks/` — `music-command-settings`, hooks membres de groupe.
- locales + fragments i18n.

## Tests / vérification

- Typecheck backend + frontend.
- Restriction : vérifier qu'avec un groupe configuré, un non-membre est refusé
  et un membre passe ; qu'avec `null` tout le monde passe ; que `help`/`aide`
  restent ouvertes.
- `!notif` : bascule persistée, statut renvoyé, reflété dans la WebUI.
- Notif now-playing : message posté dans le canal du bot au démarrage d'un
  titre quand le flag est actif, rien quand inactif.
- ServerGroups : ajout puis retrait d'un membre se reflètent dans la liste.

## Hors périmètre (YAGNI)

- Recherche/ajout de clients hors-ligne aux groupes.
- Configuration par bot (écartée au profit du global).
- Notif sur changement de métadonnées radio (écartée : nouveau titre seulement).
- Restriction par commande individuelle (deux niveaux suffisent).
