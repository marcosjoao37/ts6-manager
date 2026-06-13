# « PC de confiance » — auto-login 30 jours via cookie

**Date :** 2026-06-13
**Statut :** validé, prêt pour planification

## Objectif

Ajouter une case « Cet ordinateur est un PC de confiance » sur l'écran de
connexion. Quand elle est cochée, un cookie permet, pendant **30 jours**, de
**contourner à la fois le mot de passe et le MFA** sur cet appareil
(auto-login complet). Une note d'information multilingue explique le
comportement lorsque la case est cochée.

## Décisions de conception

- **Portée du bypass :** mot de passe **ET** MFA (auto-login complet).
- **Déclenchement :** à l'ouverture de l'app, l'écran de login **reconnaît**
  l'utilisateur et propose un bouton « Continuer en tant que X » (pas de
  saisie). Un lien « Se connecter avec un autre compte » revient au formulaire.
- **Gestion :** onglet Compte → liste des appareils de confiance avec
  révocation d'un appareil ou de tous.

### Note de sécurité (choix assumé)

Le cookie donne un accès complet au compte sans mot de passe ni MFA pendant
30 jours s'il est exfiltré du poste. Le découpage selector/verifier, le flag
`httpOnly` et la révocation limitent le risque, mais ce bypass total est plus
permissif que le pattern « MFA seulement ». Choix explicite de l'utilisateur.

## Modèle de données

Nouvelle table `TrustedDevice` avec un token découpé **selector.verifier**
(le secret n'est jamais stocké en clair ; la ligne se retrouve par `selector`
sans scan, et `verifier` est comparé en temps constant) :

```prisma
model TrustedDevice {
  id           Int      @id @default(autoincrement())
  userId       Int
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  selector     String   @unique          // identifiant public du cookie (hex)
  verifierHash String                    // sha256(verifier)
  expiresAt    DateTime                  // createdAt + 30 jours
  createdAt    DateTime @default(now())
  lastUsedAt   DateTime @default(now())
  userAgent    String?                   // affiché dans la liste
  ipAddress    String?                   // IP approximative à la création
}
```

- Relation `trustedDevices TrustedDevice[]` ajoutée sur `User`.
- Migration Prisma (+ régénération du client).

## Cookie

- Nom `ts6_trusted`, valeur `selector.verifier` (aléatoire : selector 16 octets
  hex, verifier 32 octets hex).
- Attributs : `httpOnly`, `secure` (en prod), `sameSite: 'lax'`,
  `path: '/api/auth'`, `maxAge: 30 jours`.
- Ajout de la dépendance **`cookie-parser`** côté backend (absente
  aujourd'hui). CORS a déjà `credentials: true`. Ajout de `withCredentials` sur
  les appels axios concernés.

## Endpoints backend (`auth.routes.ts`)

- `POST /login`, `POST /login/mfa`, `POST /login/change-password` : acceptent un
  flag **`trustDevice`**. Au moment où `issueSession` émet réellement la session,
  si `trustDevice` est vrai → création d'un `TrustedDevice` et pose du cookie.
  Le flag est transmis depuis l'écran mot de passe à travers toutes les étapes.
- `GET /auth/trusted/peek` (sans auth) : lit le cookie, valide, renvoie
  **uniquement** `{ username, displayName }` du compte reconnu, ou 401. Ne crée
  pas de session. Sert à afficher « Continuer en tant que X ».
- `POST /auth/trusted/session` (sans auth) : valide le cookie → `issueSession`
  → renvoie tokens + user. Met à jour `lastUsedAt`.
- `GET /auth/trusted` (auth) : liste des appareils de l'utilisateur (date de
  création, expiration, navigateur, IP, indicateur « appareil courant »).
- `DELETE /auth/trusted/:id` (auth) : révoquer un appareil.
- `DELETE /auth/trusted` (auth) : révoquer tous les appareils.

### Gating de l'auto-login (peek + session)

Refus (avec nettoyage du cookie et retour au login normal) si l'une des
conditions est vraie :

- compte désactivé ;
- IP web-bannie (`isIpWebBanned`) ;
- `mustChangePassword` actif ;
- `mfaRequired && !mfaEnabled` (enrôlement MFA jamais effectué).

L'auto-login ne contourne le MFA que lorsque le MFA est **déjà** configuré —
c'est l'objectif. Les tokens expirés sont ignorés et purgés à la volée.

### Révocation automatique

- Au changement de mot de passe (`/login/change-password` et `/auth/password`),
  en plus de la purge des refresh tokens déjà en place, suppression de tous les
  `TrustedDevice` de l'utilisateur.
- À la désactivation/suppression du compte : cascade via la relation.

## Frontend

### `Login.tsx`

- Nouvel état `trustDevice`. Composant **Checkbox** (shadcn — seul `switch.tsx`
  existe aujourd'hui, à ajouter) sur l'étape `password`, avec un encadré
  d'information affiché quand la case est cochée.
- Au montage : appel `trustedPeek()`. Si un compte est reconnu → nouvel état
  `step = 'trusted'` affichant « Continuer en tant que **X** »
  (→ `trustedSession()` → dashboard) et un lien retour au formulaire mot de
  passe.
- `trustDevice` transmis à `login` / `loginMfa` / `loginChangePassword`.

### `Settings.tsx` → `AccountTab`

- Nouvelle `Card` « PC de confiance » listant les appareils (badge
  « Cet appareil »), bouton révoquer par ligne et bouton « Tout révoquer ».
  Données via React Query, invalidation après révocation.

### `auth.api.ts`

- `trustedPeek`, `trustedSession`, `trustedList`, `trustedRevoke(id)`,
  `trustedRevokeAll` (avec `withCredentials` là où le cookie doit circuler).

## i18n (5 langues : en / fr / de / es / it)

Nouvelles clés (couverture complète des 5 locales) :

- `login.trustDevice` — label de la case.
- `login.trustDeviceInfo` — note affichée quand la case est cochée : explique
  les 30 jours, l'absence de mot de passe et de MFA sur cet appareil, et
  l'avertissement de ne l'utiliser que sur un appareil personnel.
- `login.continueAs` — « Continuer en tant que {{name}} ».
- `login.useAnotherAccount` — lien de repli.
- `settings.account.trustedDevices.*` — titre, en-têtes/colonnes, « cet
  appareil », révoquer, tout révoquer, état liste vide, toasts succès/erreur.

## Tests

Tests backend (style `mfa.test.ts`) :

- création, validation et expiration du token selector/verifier ;
- refus de l'auto-login si compte désactivé ou `mustChangePassword` ;
- révocation d'un appareil et de tous ;
- purge des `TrustedDevice` au changement de mot de passe.

## Hors périmètre (YAGNI)

- Rotation du verifier à chaque usage (replay window réduite) — non retenu pour
  la v1 ; token fixe sur 30 jours.
- Géolocalisation / nommage manuel des appareils au-delà du `userAgent`.
