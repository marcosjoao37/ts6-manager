# Design — Commande !lyrics (TeamSpeak) et /lyrics (Discord)

Date : 2026-07-04
Statut : validé (brainstorming), prêt pour le plan d'implémentation

## Contexte

Le Music Bot expose des commandes texte dans TeamSpeak (`!play`, `!np`,
`!info`, etc.) gérées par `MusicCommandHandler`
(`packages/backend/src/voice/music-command-handler.ts`), et des slash
commands Discord équivalentes gérées par `DiscordBridge`
(`packages/backend/src/discord/discord-bridge.ts`). La logique musicale
partagée entre les deux ponts vit dans des modules communs
(ex. `music-ops.ts`).

Fonctionnalité demandée : une commande `!lyrics` (TS) / `/lyrics` (Discord)
qui va chercher les paroles d'une chanson sur Internet et les poste dans le
canal où la commande a été tapée.

## Décisions de cadrage

- **Comportement** : sans argument → paroles de la piste en cours
  (`bot.nowPlaying`) ; avec argument → recherche libre
  (ex. `!lyrics Queen Bohemian Rhapsody`).
- **Sources** : LRCLIB (API publique, gratuite, sans clé) en premier, avec
  fallback sur lyrics.ovh (également gratuite, sans clé) si introuvable.
  Aucune clé API à configurer, aucune dépendance npm nouvelle (`fetch` natif).
- **Longueur côté TS** : envoi intégral en plusieurs messages découpés
  (~900 caractères, même budget que `!channels`), jamais tronqué.
- **Accès** : `lyrics` tombe dans le niveau « musique » existant de
  `music-command-access.ts` (comportement par défaut de `classifyCommand`) ;
  côté Discord, le `commandAllowed()` existant s'applique. Aucun changement
  de contrôle d'accès.

## 1. Module partagé `lyrics.ts`

Nouveau fichier `packages/backend/src/voice/lyrics.ts` :

### `cleanTrackTitle(title: string): string` (pure)

Retire le bruit typique des titres YouTube avant la recherche :
`(Official Video)`, `[Clip officiel]`, `(Lyrics)`, `(Audio)`, `HD`, `4K`,
mentions `MV`, etc. Nécessaire parce que `nowPlaying.title` provient souvent
de YouTube.

### `fetchLyrics(input): Promise<LyricsResult | null>`

- Entrée : `{ artist?: string; title?: string; query?: string }` —
  soit artiste/titre (piste en cours), soit une requête libre.
- Sortie : `{ artist: string; title: string; lyrics: string; source: 'lrclib' | 'lyrics.ovh'; instrumental: boolean } | null`.
- Cascade :
  1. LRCLIB `GET https://lrclib.net/api/get?artist_name=…&track_name=…`
     (correspondance exacte, seulement si artiste connu) ;
  2. LRCLIB `GET https://lrclib.net/api/search?q=…` — premier résultat avec
     `plainLyrics` non vide (ou `instrumental: true`) ;
  3. lyrics.ovh `GET https://api.lyrics.ovh/v1/{artist}/{title}` — seulement
     si artiste et titre connus.
- Chaque étape est enveloppée dans un try/catch : une erreur réseau ou un
  statut non-2xx passe à l'étape suivante. Si tout échoue → `null`.
- Timeout de 10 s par requête (`AbortSignal.timeout(10_000)`).
- En-tête `User-Agent: ts6-manager` (recommandé par LRCLIB).
- Un résultat LRCLIB `instrumental: true` renvoie un `LyricsResult` avec
  `instrumental: true` et `lyrics: ''` — les handlers affichent
  « ♪ Morceau instrumental » plutôt qu'« introuvable ».

### `chunkLyrics(header: string, lyrics: string, maxLen: number): string[]` (pure)

Découpe `header + lyrics` en morceaux ≤ `maxLen`, en coupant uniquement sur
les sauts de ligne (jamais au milieu d'une ligne ; une ligne isolée plus
longue que `maxLen` est coupée en dur, cas dégénéré). Utilisée par les deux
ponts : TS avec `header = "🎤 Artiste — Titre"` et `maxLen = 900` ; Discord
avec `header = ''` et `maxLen = 4096` (le titre vit dans l'embed).

### Tests `lyrics.test.ts` (colocalisé)

- `cleanTrackTitle` : cas YouTube typiques.
- `chunkLyrics` : respect de `maxLen`, coupe sur lignes, header dans le
  premier chunk, cas dégénérés (vide, ligne unique très longue).
- `fetchLyrics` : cascade et fallbacks avec `fetch` mocké (succès étape 1,
  échec 1 → succès 2, échec 1+2 → succès 3, tout échoue → null,
  instrumental).

## 2. Intégration TeamSpeak (`!lyrics`)

Dans `music-command-handler.ts` :

- Ajout de `lyrics` et de l'alias `paroles` au set `MUSIC_COMMANDS`.
- Nouveau `handleLyrics(bot, reply, args)` :
  - Sans argument → `bot.nowPlaying` ; si rien ne joue :
    « Aucune musique en cours. Usage : !lyrics [artiste - titre] ».
    Sinon `fetchLyrics({ artist: np.artist, title: cleanTrackTitle(np.title) })`.
  - Avec argument → `fetchLyrics({ query: args })`.
  - Répond immédiatement « Recherche des paroles… » (pattern `Loading...`
    de `!play`), puis envoie les chunks séquentiellement via `reply()` —
    donc dans le canal si la commande vient du canal, en privé sinon.
  - Premier chunk préfixé `🎤 Artiste — Titre` ; introuvable →
    « Paroles introuvables pour "…" ».
- Ajout d'une ligne `!lyrics [recherche]` dans `handleHelp`.

## 3. Intégration Discord (`/lyrics`)

Dans `discord-bridge.ts` :

- `registerCommands()` : `/lyrics` avec option string **optionnelle**
  `query` (« Artiste et titre — vide = piste en cours »).
- `handleCommand()` : `deferReply()` (la cascade d'API peut prendre
  plusieurs secondes), puis même résolution que côté TS (sans query →
  `nowPlaying` du bot musique par défaut via `musicBot()`, sinon recherche).
- Affichage : un embed avec titre `🎤 Artiste — Titre` et paroles en
  description (≤ 4096 caractères). Si plus long : embeds supplémentaires en
  `followUp` dans le même canal. Introuvable → `editReply` « Paroles
  introuvables pour "…" » (le defer public ne permet plus l'éphémère,
  message court acceptable).
- Pas de changement de permissions : `commandAllowed()` existant.

## Gestion d'erreurs

- Toutes les erreurs réseau/API sont absorbées dans `fetchLyrics` (cascade) ;
  `null` → message « introuvable », jamais de stack utilisateur.
- Les erreurs imprévues restantes suivent les chemins d'erreur existants des
  deux handlers (catch global TS avec `reply('Error: …')`, catch
  d'interaction Discord avec `❌ …`).

## Hors périmètre

- Paroles synchronisées (LRC/karaoké) — LRCLIB les fournit mais on n'utilise
  que `plainLyrics`.
- Configuration WebUI (aucun réglage nécessaire).
- Cache des résultats (volume attendu faible, appels à la demande).
