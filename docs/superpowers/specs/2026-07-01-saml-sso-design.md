# Authentification SSO SAML — Design

**Date :** 2026-07-01
**Statut :** Approuvé (design), en attente de plan d'implémentation

## Objectif

Ajouter un login SSO via SAML 2.0 **en option**, à côté du login local existant
(username/mot de passe). Flux **SP-initiated** : la page de login propose un
bouton « Se connecter via SSO » ; l'utilisateur est redirigé vers l'IdP
(Authentik en cible prioritaire), qui renvoie une assertion signée au backend.
Le backend la valide, résout ou crée le compte, réévalue son rôle, puis émet une
session en réutilisant le pipeline d'authentification existant (JWT + refresh
token rotatif, gate MFA).

## Décisions produit (validées)

| Sujet | Décision |
|-------|----------|
| Cohabitation | Login local **et** SSO SAML ; SAML en option (pas de lock-out si l'IdP tombe) |
| Provisioning | Création auto (JIT) au 1er login, **activable/désactivable** (`autoProvision`) ; si désactivé, un login SAML pour un compte non pré-provisionné **échoue** |
| Rôle | Mappé depuis un attribut SAML ; **rôle par défaut configurable** (viewer par défaut) si pas d'attribut/correspondance |
| Sync rôle | **Réévalué à chaque login** (l'IdP fait autorité) — comptes SAML uniquement |
| MFA | Après SAML, on **réutilise le gate MFA existant** : MFA local forcé s'il est activé pour le compte ; sinon session directe. `mustChangePassword` ne s'applique pas aux comptes SAML |
| IdP cible | Authentik (défauts d'attributs + scénario de test) |
| SLO | **Hors périmètre v1** : logout local (révocation refresh token) |

## Bibliothèque

`@node-saml/node-saml` — successeur maintenu du cœur de passport-saml, agnostique
du framework Express. Fournit : construction de l'AuthnRequest, validation de la
SAMLResponse (signature, conditions temporelles, audience, anti-rejeu via
`InResponseTo`), génération de metadata SP. À ajouter aux dépendances backend.

## Architecture & flux

```
Login.tsx  ──(GET /api/auth/saml/status → {enabled})──> affiche le bouton SSO
   │  clic « Se connecter via SSO »
   ▼
GET /api/auth/saml/login ──(AuthnRequest + RelayState)──> IdP (Authentik)
   │                                    IdP authentifie l'utilisateur
   ▼
POST /api/auth/saml/acs  ← SAMLResponse (signée)
   │  valide signature/audience/fenêtre/anti-rejeu
   │  extrait attributs → résout/crée user → recalcule rôle
   │  crée un CODE SSO à usage unique (courte durée)
   ▼
redirect frontend /#/login/sso?code=…
   │
   ▼
POST /api/auth/saml/exchange { code }
   ├─ session directe  → { accessToken, refreshToken, user }
   └─ ou challenge MFA → { mfaRequired, mfaToken }  (flux MFA existant)
```

Le **handoff par code à usage unique** évite de faire transiter les tokens dans
l'URL/l'historique du navigateur. Le code est opaque, à courte durée de vie,
consommé une seule fois côté serveur.

## Endpoints backend (`/api/auth/saml`, publics — avant `authMiddleware`)

- `GET /status` → `{ enabled: boolean }`.
- `GET /metadata` → XML de metadata SP (entityID, ACS URL) à coller dans Authentik.
- `GET /login` → construit l'AuthnRequest, redirige (302) vers l'IdP avec RelayState.
- `POST /acs` → Assertion Consumer Service : reçoit la SAMLResponse, valide, résout
  l'utilisateur, crée le code SSO, redirige vers le frontend.
- `POST /exchange` → échange le code contre une session ou un challenge MFA.

Tous ces endpoints ne fonctionnent que si `SAMLSettings.enabled`. `/acs` et
`/exchange` sont rate-limités (réutiliser `express-rate-limit` comme les autres
endpoints d'auth).

## Modèle de données (`packages/backend/prisma/schema.prisma`)

### `User` (modification)
- Ajout `authProvider String @default("local")` (`"local"` | `"saml"`).
- Ajout `externalId String?` (nameID SAML, clé stable).
- Index unique composite `@@unique([authProvider, externalId])`.
- `passwordHash` passe de `String` à `String?` (**nullable**) : les comptes SAML
  n'ont pas de mot de passe local.

**Impact login local :** le handler de login local doit rejeter explicitement un
compte dont `passwordHash` est `null` (message générique « identifiants
invalides », pas de fuite d'information). Les endpoints de changement de mot de
passe / setup MFA restent réservés aux comptes locaux.

### `SAMLSettings` (nouveau, singleton, éditable via l'UI admin)
```prisma
model SAMLSettings {
  id              Int      @id @default(autoincrement())
  enabled         Boolean  @default(false)
  // IdP
  idpMetadataUrl  String?              // URL de metadata (optionnel)
  idpMetadataXml  String?              // XML de metadata collé (chiffré)
  idpEntityId     String?              // dérivé du metadata ou saisi
  idpSsoUrl       String?              // dérivé du metadata ou saisi
  idpCertificate  String?              // certificat de signature IdP (chiffré)
  // SP
  spEntityId      String?              // entityID du SP (défaut auto depuis FRONTEND_URL)
  // Provisioning / rôles
  autoProvision   Boolean  @default(true)
  defaultRole     String   @default("viewer")
  // Mapping d'attributs
  attrUsername    String   @default("http://schemas.goauthentik.io/2021/02/saml/username")
  attrEmail       String   @default("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress")
  attrDisplayName String   @default("http://schemas.goauthentik.io/2021/02/saml/displayname")
  attrRole        String?  // attribut/groupe portant le rôle (ex: groups)
  roleAdminValue  String?  // valeur qui accorde admin (ex: "ts6-admins")
  updatedAt       DateTime @updatedAt
}
```
> Les valeurs par défaut d'attributs ciblent Authentik ; toutes restent
> éditables pour rester agnostique. Les champs sensibles (`idpMetadataXml`,
> `idpCertificate`) sont chiffrés via le util `crypto` existant (AES-256-GCM),
> comme le `botToken` Discord.

## Résolution du compte (à chaque login SAML)

Logique isolée dans une fonction **pure et testable**
(`resolveSamlUser` / helpers), séparée de l'accès DB pour les tests :

1. Extraire de l'assertion : `nameID` (→ externalId), username, email, displayName,
   valeur(s) de rôle, selon le mapping `SAMLSettings`.
2. Calculer le rôle : si `attrRole` fourni et une de ses valeurs == `roleAdminValue`
   → `admin` ; sinon `defaultRole`.
3. Rechercher `(authProvider='saml', externalId)` :
   - **Trouvé** → si `enabled=false` sur le compte → refus ; sinon mettre à jour
     `displayName` + `role` (recalculé) + `lastLoginAt`.
   - **Non trouvé** :
     - `autoProvision=true` → créer le compte JIT (`authProvider='saml'`,
       `passwordHash=null`, username depuis l'attribut avec **désambiguïsation**
       en cas de collision — voir ci-dessous), rôle calculé.
     - `autoProvision=false` → **échec** (redirection `/#/login/sso?error=not_provisioned`).
4. Émettre la session via le gate existant (`gateAfterPassword`) → session ou
   challenge MFA.

**Désambiguïsation de username :** l'`externalId` est la clé d'identité, pas le
username. Si le username issu de l'attribut est déjà pris par un **autre** compte,
suffixer (`name`, `name-2`, `name-3`, …) jusqu'à trouver un username libre. Cela
évite qu'un compte SAML « prenne » le username d'un compte local existant.

## Frontend

### `packages/frontend/src/pages/Login.tsx`
- Au montage, appeler `GET /api/auth/saml/status` ; si `enabled`, afficher un
  bouton « Se connecter via SSO » (séparateur « ou »).
- Clic → `window.location.href = <API>/api/auth/saml/login`.

### Callback SSO (`/login/sso`)
- Nouvel écran/route qui lit `code` (ou `error`) dans l'URL.
- `error` → afficher le message (ex. « compte non provisionné ») et lien retour login.
- `code` → `POST /api/auth/saml/exchange { code }` :
  - session → `setAuth(...)` puis navigation `/dashboard`.
  - `{ mfaRequired, mfaToken }` → réutiliser l'écran/flux MFA existant (TOTP).

### `packages/frontend/src/api/auth.api.ts`
- Ajouter `samlStatus()`, `samlExchange(code)`.
- Client API admin `saml.api.ts` : `settings()`, `updateSettings(data)` (pattern `discord.api.ts`).

### Onglet Paramètres « SSO / SAML » (admin)
Nouveau tab dans `Settings.tsx` (pattern `DiscordTab`) :
- Affichage en lecture seule de l'**URL de metadata SP** et de l'**ACS URL** (à
  coller dans Authentik).
- Champs IdP : metadata URL **ou** XML collé ; entityID/SSO URL/cert (renseignés
  automatiquement si metadata fournie, sinon manuels).
- Mapping d'attributs (username/email/displayName/rôle), `roleAdminValue`.
- Case **« Provisionnement automatique des comptes authentifiés via SSO »**
  (`autoProvision`), sélecteur de **rôle par défaut**, toggle **activer SAML**.
- i18n dans les **5 langues** (FR/EN/DE/ES/IT).

## API admin des réglages (`packages/backend/src/routes`)

- `GET /api/saml/settings` (admin) → réglages sans les secrets en clair (comme
  Discord masque le token).
- `PUT /api/saml/settings` (admin) → validation + persistance ; si une metadata
  URL/XML est fournie, parser pour renseigner `idpEntityId`/`idpSsoUrl`/
  `idpCertificate`. Recharger la config SAML en mémoire à chaud.

## Sécurité

- **Validation obligatoire** de l'assertion : signature (certificat IdP),
  audience == `spEntityId`, fenêtre `NotBefore`/`NotOnOrAfter`, anti-rejeu via
  `InResponseTo` (corréler avec l'AuthnRequest émise).
- Code SSO : opaque (≥ 32 octets aléatoires), TTL court (~2 min), **usage unique**
  (supprimé à la consommation), lié à l'utilisateur résolu.
- Secrets (metadata/cert IdP) chiffrés au repos.
- Rate-limit sur `/acs` et `/exchange`.
- Comptes désactivés refusés ; `enabled=false` respecté aussi pour SAML.
- Bouton SSO masqué et endpoints inertes si `enabled=false`.

## Hors périmètre (v1)

- SAML Single Logout (SLO) — le logout reste local (révocation du refresh token).
- Signature des AuthnRequests par le SP : champs de clé SP optionnels prévus, mais
  requêtes **non signées** par défaut (accepté par Authentik).
- Provisioning avec liste blanche par domaine/groupe (le toggle on/off suffit en v1).

## Tests (vitest)

Fonctions pures testées en isolation :
- **Mapping attributs → utilisateur** : extraction username/email/displayName/rôle
  depuis un objet d'assertion, selon un `SAMLSettings` donné (y compris attributs
  multivalués et absents).
- **Résolution de rôle** : `attrRole`+`roleAdminValue` → admin ; sinon
  `defaultRole` ; valeur absente → défaut.
- **Désambiguïsation de username** : collision → suffixe incrémental.
- **Validation/normalisation des `SAMLSettings`** au PUT (types, valeurs par défaut).

Handler ACS testé avec un résultat `node-saml` **mocké** (profil d'assertion), sans
IdP réel :
- création JIT quand `autoProvision=true` ;
- échec quand `autoProvision=false` et compte inconnu ;
- recalcul du rôle à chaque login ;
- refus d'un compte désactivé.

Régression login local : rejet d'un compte dont `passwordHash` est `null`.

## Fichiers touchés (indicatif)

| Fichier | Nature |
|---------|--------|
| `packages/backend/prisma/schema.prisma` | `User` (+2 champs, nullable), `SAMLSettings`, migration |
| `packages/backend/package.json` | dépendance `@node-saml/node-saml` |
| `packages/backend/src/saml/*` (nouveau) | client SAML, résolution user (pur), config en mémoire |
| `packages/backend/src/routes/auth.routes.ts` | endpoints `/saml/*`, rejet passwordHash null |
| `packages/backend/src/routes/saml.routes.ts` (nouveau) | GET/PUT settings admin |
| `packages/backend/src/app.ts` | montage des routes SAML publiques (avant authMiddleware) |
| `packages/frontend/src/pages/Login.tsx` | bouton SSO + callback |
| `packages/frontend/src/api/auth.api.ts`, `saml.api.ts` (nouveau) | clients API |
| `packages/frontend/src/pages/Settings.tsx` | onglet SSO/SAML |
| fichiers i18n (5 langues) | libellés |
| tests vitest | couverture ci-dessus |
