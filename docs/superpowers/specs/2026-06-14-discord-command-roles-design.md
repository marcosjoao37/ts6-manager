# Restriction des commandes Discord par rôle

**Date :** 2026-06-14
**Statut :** validé, prêt pour planification

## Objectif

Permettre, depuis les réglages Discord de la WebUI, de sélectionner un ou
plusieurs rôles de la guilde. Seuls les membres possédant au moins un de ces
rôles peuvent déclencher les slash commands du bot (`play`, `stop`, `pause`,
`skip`, `next`, `prev`, `queue`, `volume`, `nowplaying`, `stats`, `join`,
`leave`).

## Décisions de conception

- **Granularité :** une seule liste de rôles, appliquée à **toutes** les
  commandes.
- **Liste vide → aucune restriction** : tout le monde peut utiliser les
  commandes (comportement actuel, rétrocompatible). La restriction ne s'active
  qu'à partir d'au moins un rôle sélectionné.
- **Bypass :** un membre avec la permission Discord *Administrateur*, ou le
  propriétaire du serveur, passe toujours, même sans rôle autorisé.
- **Refus :** réponse éphémère « ⛔ Tu n'as pas la permission d'utiliser cette
  commande. » en français, cohérent avec les autres messages du bot (qui sont
  déjà en français en dur).

## Architecture existante (contexte)

- Bridge Discord global mono-guilde (`packages/backend/src/discord/discord-bridge.ts`).
- Slash commands enregistrées dans le bridge ; dispatch via
  `handleCommand(interaction)` (switch sur `interaction.commandName`).
- Config dans la table unique `DiscordSettings` (un seul enregistrement).
- Pickers existants `GET /api/discord/guilds` et `GET /api/discord/channels`
  alimentés par `listGuilds()` / `listChannels()` sur le client en cache —
  modèle à décliner pour les rôles.

## Stockage

Nouvelle colonne sur `DiscordSettings` :

```prisma
commandRoleIds String?   // tableau JSON d'IDs de rôles Discord ; null/vide = ouvert à tous
```

Stockée en `JSON.stringify(["123","456"])`, relue en `JSON.parse`. Précédent
dans le repo : `mfaRecoveryCodes` (String contenant du JSON). Migration Prisma
+ régénération du client.

## Backend

### `discord-bridge.ts`

- **`listRoles()`** (calquée sur `listChannels()`) : renvoie
  `Array<{ id: string; name: string; color: number }>` des rôles de la guilde
  configurée, en **excluant** `@everyone` (id == guildId) et les rôles gérés
  par une intégration/bot (`role.managed`), triés par position décroissante ou
  par nom. Renvoie `[]` si le client n'est pas prêt (comme `listChannels`).
- **Garde d'autorisation** : une fonction pure et testable
  `isCommandAllowed(opts): boolean` où
  `opts = { allowedRoleIds: string[]; memberRoleIds: string[]; isAdmin: boolean; isOwner: boolean }`.
  Règle : `allowedRoleIds.length === 0` → `true` ; `isAdmin || isOwner` → `true` ;
  sinon `true` ssi `memberRoleIds` croise `allowedRoleIds`.
- Dans `handleCommand(i)`, **avant le switch** : construire les entrées depuis
  l'interaction (`i.member.roles`, `i.memberPermissions?.has(Administrator)`,
  `i.guild?.ownerId === i.user.id`) et `this.settings.commandRoleIds` (parsé).
  Si refusé → `i.reply({ content: '⛔ Tu n'as pas la permission…', ephemeral: true })`
  puis `return`. Si `i.member` est absent (cas DM, théorique pour une guild
  command) et la liste est non vide → refusé.
- `this.settings` doit exposer `commandRoleIds` (tableau parsé) à partir de la
  ligne `DiscordSettings`.

### `discord.routes.ts`

- **`GET /api/discord/roles`** → `bridge.listRoles()` (mime `/channels`).
- **`PUT`** des settings : ajouter `commandRoleIds` au destructuring et au
  mapping `data` (accepter un tableau côté requête, persister en
  `JSON.stringify`; `[]`/absent → `null`).
- **`GET`** des settings : exposer `commandRoleIds` en tableau (`JSON.parse` ou
  `[]`).

## Frontend

### `discord.api.ts`

- `getRoles()` → `GET /api/discord/roles`.
- Inclure `commandRoleIds: string[]` dans le get et le update des settings.

### Onglet Discord (réglages)

- Nouveau bloc « Rôles autorisés pour les commandes » : multi-sélection sous
  forme de liste de cases à cocher des rôles (avec pastille de couleur dérivée
  de `role.color`), texte d'aide « Vide = tout le monde peut utiliser les
  commandes ».
- Si le bot n'est pas connecté (`/roles` renvoie `[]`), afficher un message
  « connecte le bot pour lister les rôles » (comme pour les salons), avec
  éventuel bouton de rafraîchissement.

### i18n

Nouvelles clés dans les **5 langues** (en/fr/de/es/it) : titre du bloc, texte
d'aide, état « bot hors-ligne / aucun rôle disponible ».

## Cas limites

- **Bot non connecté** : `/roles` → `[]`, UI explicite. La sélection déjà
  enregistrée reste persistée et continue de filtrer côté bot.
- **Rôle supprimé sur Discord** après sélection : l'ID ne matche plus personne,
  ignoré au check ; pas de nettoyage automatique requis.
- **DM / member absent** : traité comme refusé quand la liste est non vide.

## Tests

Test unitaire de la fonction pure `isCommandAllowed` (indépendante de
discord.js) :

- liste vide → autorisé ;
- membre avec un rôle autorisé → autorisé ;
- membre sans rôle autorisé → refusé ;
- admin sans rôle autorisé → autorisé ;
- propriétaire sans rôle autorisé → autorisé ;
- intersection partielle (un rôle parmi plusieurs) → autorisé.

## Hors périmètre (YAGNI)

- Permissions par commande ou par catégorie (contrôle vs lecture seule).
- Restriction par salon Discord.
- Message de refus multilingue (gardé en français comme le reste du bot).
- Nettoyage automatique des IDs de rôles supprimés.
