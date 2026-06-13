# Trusted Device (30-day auto-login) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "This is a trusted computer" checkbox at login that sets an `httpOnly` cookie allowing full auto-login (password + MFA bypass) on that device for 30 days, with user-facing device management and revocation.

**Architecture:** A new `TrustedDevice` table stores a split `selector.verifier` token (selector indexed for lookup, verifier stored only as a SHA-256 hash). The cookie holds `selector.verifier`. When the login flow issues a session and `trustDevice` is set, a row is minted and the cookie is set. On app load the frontend "peeks" the cookie to recognize the user and offers a "Continue as X" button that exchanges the cookie for a real JWT session. Revocation lives in the Account tab.

**Tech Stack:** Express + Prisma (SQLite) backend, React + Zustand + react-query + react-i18next frontend, vitest for backend unit tests, `cookie-parser` (new dep).

---

## Task 1: Add the `TrustedDevice` Prisma model and migrate

**Files:**
- Modify: `packages/backend/prisma/schema.prisma` (User model + new model)

- [ ] **Step 1: Add the relation to the User model**

In `packages/backend/prisma/schema.prisma`, inside `model User { ... }`, next to the existing `refreshTokens RefreshToken[]` line, add:

```prisma
  refreshTokens RefreshToken[]
  trustedDevices TrustedDevice[]
```

- [ ] **Step 2: Add the new model**

Add at the end of the file (after the `RefreshToken` model):

```prisma
model TrustedDevice {
  id           Int      @id @default(autoincrement())
  userId       Int
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  selector     String   @unique
  verifierHash String
  expiresAt    DateTime
  createdAt    DateTime @default(now())
  lastUsedAt   DateTime @default(now())
  userAgent    String?
  ipAddress    String?
}
```

- [ ] **Step 3: Create and apply the migration**

Run (from `packages/backend`):
```bash
pnpm prisma migrate dev --name trusted-device
```
Expected: a new migration folder under `packages/backend/prisma/migrations/`, and "Your database is now in sync with your schema." The Prisma client is regenerated.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/prisma/schema.prisma packages/backend/prisma/migrations
git commit -m "feat(auth): add TrustedDevice model"
```

---

## Task 2: Trusted-device token utility (TDD)

A small pure module that mints and validates `selector.verifier` tokens, mirroring the style of `utils/mfa.ts`.

**Files:**
- Create: `packages/backend/src/utils/trusted-device.ts`
- Test: `packages/backend/src/utils/trusted-device.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/utils/trusted-device.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mintTrustedToken, hashVerifier, splitTrustedToken, TRUSTED_DEVICE_TTL_MS } from './trusted-device.js';

describe('trusted-device token', () => {
  it('mints a selector.verifier token plus the verifier hash', () => {
    const { selector, verifier, cookieValue, verifierHash } = mintTrustedToken();
    expect(cookieValue).toBe(`${selector}.${verifier}`);
    expect(selector).toMatch(/^[0-9a-f]{32}$/);  // 16 bytes hex
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);   // 32 bytes hex
    expect(verifierHash).toBe(hashVerifier(verifier));
  });

  it('splits a cookie value into selector and verifier', () => {
    expect(splitTrustedToken('aaaa.bbbb')).toEqual({ selector: 'aaaa', verifier: 'bbbb' });
  });

  it('returns null for a malformed cookie value', () => {
    expect(splitTrustedToken('no-dot')).toBeNull();
    expect(splitTrustedToken('a.b.c')).toBeNull();
    expect(splitTrustedToken('')).toBeNull();
  });

  it('hashes the verifier deterministically', () => {
    expect(hashVerifier('abc')).toBe(hashVerifier('abc'));
    expect(hashVerifier('abc')).not.toBe(hashVerifier('abd'));
  });

  it('exposes a 30-day TTL in ms', () => {
    expect(TRUSTED_DEVICE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/backend`): `pnpm vitest run src/utils/trusted-device.test.ts`
Expected: FAIL — cannot find module `./trusted-device.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/backend/src/utils/trusted-device.ts`:

```typescript
import crypto from 'crypto';

export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const TRUSTED_COOKIE_NAME = 'ts6_trusted';

export function hashVerifier(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('hex');
}

/** Mint a fresh trusted-device token. The verifier hash is what gets stored. */
export function mintTrustedToken(): {
  selector: string;
  verifier: string;
  cookieValue: string;
  verifierHash: string;
} {
  const selector = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('hex');
  return { selector, verifier, cookieValue: `${selector}.${verifier}`, verifierHash: hashVerifier(verifier) };
}

/** Split a `selector.verifier` cookie value; null if malformed. */
export function splitTrustedToken(value: string): { selector: string; verifier: string } | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { selector: parts[0], verifier: parts[1] };
}

/** Constant-time compare of a presented verifier against the stored hash. */
export function verifierMatches(verifier: string, storedHash: string): boolean {
  const a = Buffer.from(hashVerifier(verifier), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Add the `verifierMatches` test**

Append to `trusted-device.test.ts`:

```typescript
import { verifierMatches } from './trusted-device.js';

describe('verifierMatches', () => {
  it('accepts the right verifier and rejects a wrong one', () => {
    const { verifier, verifierHash } = mintTrustedToken();
    expect(verifierMatches(verifier, verifierHash)).toBe(true);
    expect(verifierMatches('deadbeef', verifierHash)).toBe(false);
  });
});
```
(Add `verifierMatches` to the existing import line from `./trusted-device.js`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/utils/trusted-device.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/utils/trusted-device.ts packages/backend/src/utils/trusted-device.test.ts
git commit -m "feat(auth): trusted-device token utility"
```

---

## Task 3: Add `cookie-parser` and a trusted-device service module (backend)

This isolates all DB + cookie logic so the routes stay thin.

**Files:**
- Modify: `packages/backend/package.json` (dependency)
- Modify: `packages/backend/src/app.ts:52` (mount cookie-parser)
- Create: `packages/backend/src/utils/trusted-device-service.ts`

- [ ] **Step 1: Install cookie-parser**

Run (from `packages/backend`):
```bash
pnpm add cookie-parser && pnpm add -D @types/cookie-parser
```

- [ ] **Step 2: Mount cookie-parser in app.ts**

In `packages/backend/src/app.ts`, add the import near the other imports at the top:
```typescript
import cookieParser from 'cookie-parser';
```
Then, immediately after the `app.use(express.json({ limit: '10mb' }));` line (currently line 52), add:
```typescript
  app.use(cookieParser());
```

- [ ] **Step 3: Create the service module**

Create `packages/backend/src/utils/trusted-device-service.ts`:

```typescript
import type { Response } from 'express';
import { config } from '../config.js';
import {
  mintTrustedToken,
  splitTrustedToken,
  verifierMatches,
  TRUSTED_DEVICE_TTL_MS,
  TRUSTED_COOKIE_NAME,
} from './trusted-device.js';

const COOKIE_OPTS = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: 'lax' as const,
  path: '/api/auth',
};

/** Create a TrustedDevice row for the user and set the cookie on the response. */
export async function createTrustedDevice(
  prisma: any,
  res: Response,
  userId: number,
  userAgent: string | undefined,
  ipAddress: string | undefined,
): Promise<void> {
  const { selector, cookieValue, verifierHash } = mintTrustedToken();
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_MS);
  await prisma.trustedDevice.create({
    data: { userId, selector, verifierHash, expiresAt, userAgent: userAgent ?? null, ipAddress: ipAddress ?? null },
  });
  res.cookie(TRUSTED_COOKIE_NAME, cookieValue, { ...COOKIE_OPTS, maxAge: TRUSTED_DEVICE_TTL_MS });
}

/** Clear the trusted cookie on the response. */
export function clearTrustedCookie(res: Response): void {
  res.clearCookie(TRUSTED_COOKIE_NAME, COOKIE_OPTS);
}

/**
 * Resolve a trusted-device cookie to its user.
 * Returns the user row on success, or null (and deletes any stale row) on failure.
 * Does NOT apply account-state gating — callers do that.
 */
export async function resolveTrustedCookie(prisma: any, cookieValue: string | undefined): Promise<any | null> {
  if (!cookieValue) return null;
  const split = splitTrustedToken(cookieValue);
  if (!split) return null;

  const device = await prisma.trustedDevice.findUnique({
    where: { selector: split.selector },
    include: { user: true },
  });
  if (!device) return null;

  if (device.expiresAt < new Date() || !verifierMatches(split.verifier, device.verifierHash)) {
    await prisma.trustedDevice.delete({ where: { id: device.id } }).catch(() => {});
    return null;
  }

  await prisma.trustedDevice.update({ where: { id: device.id }, data: { lastUsedAt: new Date() } });
  return device.user;
}
```

- [ ] **Step 4: Verify config has `nodeEnv`**

Run: `grep -n "nodeEnv" packages/backend/src/config.ts`
Expected: a `nodeEnv` field exists. If it does NOT, instead use `process.env.NODE_ENV === 'production'` in `COOKIE_OPTS.secure` and drop the `config` import.

- [ ] **Step 5: Type-check**

Run (from repo root): `pnpm --filter @ts6/backend exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/package.json packages/backend/pnpm-lock.yaml packages/backend/src/app.ts packages/backend/src/utils/trusted-device-service.ts
git commit -m "feat(auth): cookie-parser + trusted-device service"
```

---

## Task 4: Mint the cookie when `trustDevice` is set during login

Thread a `trustDevice` flag through the three session-issuing endpoints. The cookie is set only when a full session is actually issued.

**Files:**
- Modify: `packages/backend/src/routes/auth.routes.ts`

- [ ] **Step 1: Import the service**

At the top of `auth.routes.ts`, after the existing imports, add:
```typescript
import { createTrustedDevice, clearTrustedCookie, resolveTrustedCookie } from '../utils/trusted-device-service.js';
import { TRUSTED_COOKIE_NAME } from '../utils/trusted-device.js';
```

- [ ] **Step 2: Add a helper to optionally mint the cookie**

In `auth.routes.ts`, just after the `issueSession` function (ends ~line 45), add:
```typescript
// If the client asked to trust this device, mint a trusted-device cookie.
// Safe no-op when trustDevice is falsy.
async function maybeTrustDevice(prisma: any, req: Request, res: Response, userId: number, trustDevice: unknown) {
  if (trustDevice === true) {
    await createTrustedDevice(prisma, res, userId, req.headers['user-agent'], req.ip);
  }
}
```

- [ ] **Step 3: Set the cookie in the `/login` direct-session path**

In the `/login` handler, replace:
```typescript
    res.json(await gateAfterPassword(prisma, user));
```
with:
```typescript
    const result = await gateAfterPassword(prisma, user);
    if ((result as any).accessToken) await maybeTrustDevice(prisma, req, res, user.id, req.body.trustDevice);
    res.json(result);
```

- [ ] **Step 4: Set the cookie in the `/login/mfa` path**

In the `/login/mfa` handler, replace:
```typescript
    res.json(await issueSession(prisma, user));
```
with:
```typescript
    await maybeTrustDevice(prisma, req, res, user.id, req.body.trustDevice);
    res.json(await issueSession(prisma, user));
```

- [ ] **Step 5: Set the cookie in the `/login/change-password` path**

In the `/login/change-password` handler, replace:
```typescript
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    res.json(await gateAfterPassword(prisma, updated));
```
with:
```typescript
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    const result = await gateAfterPassword(prisma, updated);
    if ((result as any).accessToken) await maybeTrustDevice(prisma, req, res, user.id, req.body.trustDevice);
    res.json(result);
```

Note: a forced password change happening here means the device becomes trusted only once auth fully completes (no MFA pending). Correct behavior.

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @ts6/backend exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/routes/auth.routes.ts
git commit -m "feat(auth): set trusted-device cookie when trustDevice is requested"
```

---

## Task 5: Auto-login endpoints — `peek` and `session`

Both read the cookie and apply identical account-state gating. `peek` only reveals the display name; `session` issues real tokens.

**Files:**
- Modify: `packages/backend/src/routes/auth.routes.ts`

- [ ] **Step 1: Add a shared gating helper**

In `auth.routes.ts`, add near the other helpers (after `gateAfterPassword`):
```typescript
// An account is eligible for cookie auto-login only if it's fully provisioned:
// enabled, not IP-banned, no forced password change, and MFA already set up if required.
async function trustedLoginAllowed(prisma: any, user: any, ip: string): Promise<boolean> {
  if (!user || !user.enabled) return false;
  if (await isIpWebBanned(prisma, ip)) return false;
  if (user.mustChangePassword) return false;
  if (user.mfaRequired && !user.mfaEnabled) return false;
  return true;
}
```

- [ ] **Step 2: Add the `peek` route**

Add to `auth.routes.ts` (after the `/login/change-password` handler):
```typescript
// Recognize a trusted device WITHOUT issuing a session. Returns the display
// identity so the login screen can offer "Continue as X".
authRoutes.get('/trusted/peek', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await resolveTrustedCookie(prisma, req.cookies?.[TRUSTED_COOKIE_NAME]);
    if (!user || !(await trustedLoginAllowed(prisma, user, req.ip || ''))) {
      clearTrustedCookie(res);
      res.json({ trusted: false });
      return;
    }
    res.json({ trusted: true, username: user.username, displayName: user.displayName });
  } catch (err) { next(err); }
});
```

- [ ] **Step 3: Add the `session` route**

Add right after `peek`:
```typescript
// Exchange a valid trusted-device cookie for a full session (bypasses password + MFA).
authRoutes.post('/trusted/session', async (req: Request, res: Response, next) => {
  const journal = req.app.locals.connectionJournal;
  try {
    const prisma = req.app.locals.prisma;
    const user = await resolveTrustedCookie(prisma, req.cookies?.[TRUSTED_COOKIE_NAME]);
    if (!user || !(await trustedLoginAllowed(prisma, user, req.ip || ''))) {
      clearTrustedCookie(res);
      throw new AppError(401, 'Trusted device not recognized');
    }
    journal?.recordWebLogin(user.username, req.ip || '', true);
    res.json(await issueSession(prisma, user));
  } catch (err) { next(err); }
});
```

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @ts6/backend exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

Run the backend dev server, then:
```bash
# No cookie -> trusted:false
curl -s http://localhost:3000/api/auth/trusted/peek
```
Expected: `{"trusted":false}`.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/routes/auth.routes.ts
git commit -m "feat(auth): trusted-device peek + auto-login session endpoints"
```

---

## Task 6: Device management endpoints (list / revoke one / revoke all)

**Files:**
- Modify: `packages/backend/src/routes/auth.routes.ts`

- [ ] **Step 1: Add the list route**

Add to `auth.routes.ts` (these use `authMiddleware`, place them near `/me`):
```typescript
// List the current user's trusted devices. `current` flags the calling device.
authRoutes.get('/trusted', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const split = (req.cookies?.[TRUSTED_COOKIE_NAME] || '').split('.')[0] || null;
    const devices = await prisma.trustedDevice.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      devices: devices.map((d: any) => ({
        id: d.id,
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt,
        expiresAt: d.expiresAt,
        userAgent: d.userAgent,
        ipAddress: d.ipAddress,
        current: split !== null && d.selector === split,
      })),
    });
  } catch (err) { next(err); }
});
```

- [ ] **Step 2: Add the revoke-one and revoke-all routes**

```typescript
// Revoke ALL trusted devices for the current user.
authRoutes.delete('/trusted', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    await req.app.locals.prisma.trustedDevice.deleteMany({ where: { userId: req.user!.id } });
    clearTrustedCookie(res);
    res.status(204).send();
  } catch (err) { next(err); }
});

// Revoke a single trusted device by id (must belong to the current user).
authRoutes.delete('/trusted/:id', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new AppError(400, 'Invalid id');
    const prisma = req.app.locals.prisma;
    const device = await prisma.trustedDevice.findUnique({ where: { id } });
    if (!device || device.userId !== req.user!.id) throw new AppError(404, 'Not found');
    const isCurrent = (req.cookies?.[TRUSTED_COOKIE_NAME] || '').split('.')[0] === device.selector;
    await prisma.trustedDevice.delete({ where: { id } });
    if (isCurrent) clearTrustedCookie(res);
    res.status(204).send();
  } catch (err) { next(err); }
});
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @ts6/backend exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/routes/auth.routes.ts
git commit -m "feat(auth): list and revoke trusted devices"
```

---

## Task 7: Revoke trusted devices on password change

When a password changes, trusted devices must die alongside refresh tokens.

**Files:**
- Modify: `packages/backend/src/routes/auth.routes.ts` (two spots)

- [ ] **Step 1: In `/login/change-password`**

The refresh-token purge there was already edited in Task 4 Step 5. Update that same block to also purge trusted devices. Replace:
```typescript
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    const result = await gateAfterPassword(prisma, updated);
```
with:
```typescript
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await prisma.trustedDevice.deleteMany({ where: { userId: user.id } });
    clearTrustedCookie(res);
    const result = await gateAfterPassword(prisma, updated);
```

- [ ] **Step 2: In `/password` (self-service change)**

In the `PUT /password` handler, replace:
```typescript
    // Revoke all refresh tokens on password change
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
```
with:
```typescript
    // Revoke all refresh tokens AND trusted devices on password change
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    await prisma.trustedDevice.deleteMany({ where: { userId: user.id } });
    clearTrustedCookie(res);
```

- [ ] **Step 3: Type-check & commit**

Run: `pnpm --filter @ts6/backend exec tsc --noEmit` (expect no errors).
```bash
git add packages/backend/src/routes/auth.routes.ts
git commit -m "feat(auth): revoke trusted devices on password change"
```

---

## Task 8: Frontend API client methods

**Files:**
- Modify: `packages/frontend/src/api/auth.api.ts`

- [ ] **Step 1: Add the trusted-device methods**

In `auth.api.ts`, the trusted-cookie endpoints must send/receive the cookie. Since `baseURL` is `/api` (same origin), cookies are sent automatically, but set `withCredentials: true` explicitly for safety. Add inside the `authApi` object:

```typescript
  // Trusted device — cookie-based auto-login
  trustedPeek: () =>
    api.get('/auth/trusted/peek', { withCredentials: true }).then((r) => r.data),
  trustedSession: () =>
    api.post('/auth/trusted/session', {}, { withCredentials: true }).then((r) => r.data),
  trustedList: () =>
    api.get('/auth/trusted').then((r) => r.data),
  trustedRevoke: (id: number) =>
    api.delete(`/auth/trusted/${id}`),
  trustedRevokeAll: () =>
    api.delete('/auth/trusted'),
```

Also thread `trustDevice` through the existing login calls. Replace the existing `login`, `loginMfa`, and `loginChangePassword` methods with:
```typescript
  login: (username: string, password: string, trustDevice = false) =>
    api.post('/auth/login', { username, password, trustDevice }, { withCredentials: true }).then((r) => r.data),
```
```typescript
  loginMfa: (mfaToken: string, code: string, trustDevice = false) =>
    api.post('/auth/login/mfa', { mfaToken, code, trustDevice }, { withCredentials: true }).then((r) => r.data),
```
```typescript
  loginChangePassword: (changeToken: string, currentPassword: string, newPassword: string, trustDevice = false) =>
    api.post('/auth/login/change-password', { changeToken, currentPassword, newPassword, trustDevice }, { withCredentials: true }).then((r) => r.data),
```

- [ ] **Step 2: Type-check**

Run (from repo root): `pnpm --filter @ts6/frontend exec tsc --noEmit`
Expected: no errors (callers still compile — `trustDevice` is optional).

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/api/auth.api.ts
git commit -m "feat(auth): frontend API for trusted devices"
```

---

## Task 9: Add a Checkbox UI component

Only `switch.tsx` exists; add a shadcn-style Checkbox. Verify whether `@radix-ui/react-checkbox` is installed first.

**Files:**
- Create: `packages/frontend/src/components/ui/checkbox.tsx`

- [ ] **Step 1: Check for the radix dependency**

Run: `grep -n "react-checkbox" packages/frontend/package.json`
- If present, skip Step 2.
- If absent, run Step 2.

- [ ] **Step 2: Install radix checkbox (only if absent)**

Run (from `packages/frontend`): `pnpm add @radix-ui/react-checkbox`

- [ ] **Step 3: Create the component**

Create `packages/frontend/src/components/ui/checkbox.tsx`:
```typescript
import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn('flex items-center justify-center text-current')}>
      <Check className="h-3.5 w-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
```

- [ ] **Step 4: Verify `cn` import path**

Run: `grep -rn "from '@/lib/utils'" packages/frontend/src/components/ui/switch.tsx`
Expected: confirms `cn` is imported from `@/lib/utils`. If `switch.tsx` uses a different path, match it.

- [ ] **Step 5: Type-check & commit**

Run: `pnpm --filter @ts6/frontend exec tsc --noEmit` (expect no errors).
```bash
git add packages/frontend/src/components/ui/checkbox.tsx packages/frontend/package.json packages/frontend/pnpm-lock.yaml
git commit -m "feat(ui): add Checkbox component"
```

---

## Task 10: i18n keys for trusted device (all 5 locales)

**Files:**
- Modify: `packages/frontend/src/i18n/locales/en.json`
- Modify: `packages/frontend/src/i18n/locales/fr.json`
- Modify: `packages/frontend/src/i18n/locales/de.json`
- Modify: `packages/frontend/src/i18n/locales/es.json`
- Modify: `packages/frontend/src/i18n/locales/it.json`

- [ ] **Step 1: Add `login.*` keys**

In each locale file, add these keys inside the `"login": { ... }` object (before its closing `}`; add a comma to the previous last key). Use the translations below.

**en.json:**
```json
    "trustDevice": "This is a trusted computer",
    "trustDeviceInfo": "For 30 days, this device will sign you in automatically — no password and no two-factor code. Only use this on a private device you control. You can revoke it anytime from Settings → Account.",
    "continueAs": "Continue as {{name}}",
    "useAnotherAccount": "Sign in with a different account"
```

**fr.json:**
```json
    "trustDevice": "Cet ordinateur est un PC de confiance",
    "trustDeviceInfo": "Pendant 30 jours, cet appareil vous connectera automatiquement, sans mot de passe ni code à deux facteurs. À n'utiliser que sur un appareil personnel que vous contrôlez. Vous pouvez le révoquer à tout moment depuis Paramètres → Compte.",
    "continueAs": "Continuer en tant que {{name}}",
    "useAnotherAccount": "Se connecter avec un autre compte"
```

**de.json:**
```json
    "trustDevice": "Dies ist ein vertrauenswürdiger Computer",
    "trustDeviceInfo": "30 Tage lang meldet dich dieses Gerät automatisch an – ohne Passwort und ohne Zwei-Faktor-Code. Nutze dies nur auf einem privaten Gerät, das du kontrollierst. Du kannst es jederzeit unter Einstellungen → Konto widerrufen.",
    "continueAs": "Als {{name}} fortfahren",
    "useAnotherAccount": "Mit einem anderen Konto anmelden"
```

**es.json:**
```json
    "trustDevice": "Este es un ordenador de confianza",
    "trustDeviceInfo": "Durante 30 días, este dispositivo iniciará sesión automáticamente, sin contraseña ni código de doble factor. Úsalo solo en un dispositivo privado que controles. Puedes revocarlo en cualquier momento desde Ajustes → Cuenta.",
    "continueAs": "Continuar como {{name}}",
    "useAnotherAccount": "Iniciar sesión con otra cuenta"
```

**it.json:**
```json
    "trustDevice": "Questo è un computer attendibile",
    "trustDeviceInfo": "Per 30 giorni questo dispositivo effettuerà l'accesso automaticamente, senza password né codice a due fattori. Usalo solo su un dispositivo privato che controlli. Puoi revocarlo in qualsiasi momento da Impostazioni → Account.",
    "continueAs": "Continua come {{name}}",
    "useAnotherAccount": "Accedi con un altro account"
```

- [ ] **Step 2: Add `settings.account.trustedDevices.*` keys**

In each locale, inside `"settings": { "account": { ... } }`, add a nested `trustedDevices` object. Translations:

**en.json:**
```json
    "trustedDevices": {
      "title": "Trusted devices",
      "description": "Devices that sign in automatically for 30 days without a password or two-factor code.",
      "empty": "No trusted devices.",
      "thisDevice": "This device",
      "added": "Added",
      "lastUsed": "Last used",
      "expires": "Expires",
      "revoke": "Revoke",
      "revokeAll": "Revoke all",
      "revoked": "Trusted device revoked",
      "revokedAll": "All trusted devices revoked",
      "revokeError": "Could not revoke the device"
    }
```

**fr.json:**
```json
    "trustedDevices": {
      "title": "PC de confiance",
      "description": "Appareils qui se connectent automatiquement pendant 30 jours, sans mot de passe ni code à deux facteurs.",
      "empty": "Aucun appareil de confiance.",
      "thisDevice": "Cet appareil",
      "added": "Ajouté",
      "lastUsed": "Dernière utilisation",
      "expires": "Expire",
      "revoke": "Révoquer",
      "revokeAll": "Tout révoquer",
      "revoked": "Appareil de confiance révoqué",
      "revokedAll": "Tous les appareils de confiance ont été révoqués",
      "revokeError": "Impossible de révoquer l'appareil"
    }
```

**de.json:**
```json
    "trustedDevices": {
      "title": "Vertrauenswürdige Geräte",
      "description": "Geräte, die sich 30 Tage lang automatisch ohne Passwort oder Zwei-Faktor-Code anmelden.",
      "empty": "Keine vertrauenswürdigen Geräte.",
      "thisDevice": "Dieses Gerät",
      "added": "Hinzugefügt",
      "lastUsed": "Zuletzt verwendet",
      "expires": "Läuft ab",
      "revoke": "Widerrufen",
      "revokeAll": "Alle widerrufen",
      "revoked": "Vertrauenswürdiges Gerät widerrufen",
      "revokedAll": "Alle vertrauenswürdigen Geräte widerrufen",
      "revokeError": "Gerät konnte nicht widerrufen werden"
    }
```

**es.json:**
```json
    "trustedDevices": {
      "title": "Dispositivos de confianza",
      "description": "Dispositivos que inician sesión automáticamente durante 30 días, sin contraseña ni código de doble factor.",
      "empty": "No hay dispositivos de confianza.",
      "thisDevice": "Este dispositivo",
      "added": "Añadido",
      "lastUsed": "Último uso",
      "expires": "Caduca",
      "revoke": "Revocar",
      "revokeAll": "Revocar todos",
      "revoked": "Dispositivo de confianza revocado",
      "revokedAll": "Todos los dispositivos de confianza revocados",
      "revokeError": "No se pudo revocar el dispositivo"
    }
```

**it.json:**
```json
    "trustedDevices": {
      "title": "Dispositivi attendibili",
      "description": "Dispositivi che accedono automaticamente per 30 giorni, senza password né codice a due fattori.",
      "empty": "Nessun dispositivo attendibile.",
      "thisDevice": "Questo dispositivo",
      "added": "Aggiunto",
      "lastUsed": "Ultimo utilizzo",
      "expires": "Scade",
      "revoke": "Revoca",
      "revokeAll": "Revoca tutti",
      "revoked": "Dispositivo attendibile revocato",
      "revokedAll": "Tutti i dispositivi attendibili sono stati revocati",
      "revokeError": "Impossibile revocare il dispositivo"
    }
```

- [ ] **Step 3: Validate JSON**

Run: `node -e "['en','fr','de','es','it'].forEach(l=>JSON.parse(require('fs').readFileSync('packages/frontend/src/i18n/locales/'+l+'.json','utf8')))" && echo OK`
Expected: `OK` (no parse errors — confirms commas were placed correctly).

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/i18n/locales
git commit -m "feat(i18n): trusted-device strings (5 locales)"
```

---

## Task 11: Login screen — checkbox, info note, and "Continue as X" step

**Files:**
- Modify: `packages/frontend/src/pages/Login.tsx`

- [ ] **Step 1: Add imports and state**

In `Login.tsx`, add to the imports:
```typescript
import { useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Info } from 'lucide-react';
```
(Merge `useEffect` into the existing `import { useState } from 'react';` → `import { useState, useEffect } from 'react';`.)

Extend the `Step` type:
```typescript
type Step = 'password' | 'setup' | 'code' | 'changePassword' | 'trusted';
```

Add state near the other `useState` calls:
```typescript
  const [trustDevice, setTrustDevice] = useState(false);
  const [trustedName, setTrustedName] = useState('');
```

- [ ] **Step 2: Peek for a trusted device on mount**

After the `isAuthenticated` line and before `finish`, add (note: the early `return <Navigate>` must stay above hooks — place this `useEffect` BEFORE that return; see Step 2b):

```typescript
  useEffect(() => {
    authApi.trustedPeek()
      .then((res) => {
        if (res.trusted) { setTrustedName(res.displayName || res.username); setStep('trusted'); }
      })
      .catch(() => { /* no trusted device */ });
  }, []);
```

- [ ] **Step 2b: Fix hook ordering**

React hooks must run unconditionally. Move the early-return so it sits AFTER all hooks. Replace:
```typescript
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
```
with just:
```typescript
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated());
```
and add, immediately after the `useEffect` from Step 2:
```typescript
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
```

- [ ] **Step 3: Add the auto-login handler**

Add near the other handlers:
```typescript
  const handleTrustedContinue = async () => {
    setError('');
    setBusy(true);
    try {
      finish(await authApi.trustedSession());
    } catch {
      setError(t('login.invalidCredentials'));
      setStep('password');
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 4: Thread `trustDevice` into the login calls**

In `handlePassword`, replace:
```typescript
      await routeAuth(await authApi.login(username, password));
```
with:
```typescript
      await routeAuth(await authApi.login(username, password, trustDevice));
```

In `handleChangePassword`, replace:
```typescript
      await routeAuth(await authApi.loginChangePassword(changeToken, curPw, newPw));
```
with:
```typescript
      await routeAuth(await authApi.loginChangePassword(changeToken, curPw, newPw, trustDevice));
```

In `handleCode`, replace:
```typescript
      finish(await authApi.loginMfa(mfaToken, code));
```
with:
```typescript
      finish(await authApi.loginMfa(mfaToken, code, trustDevice));
```

- [ ] **Step 5: Add the checkbox + info note to the password form**

In the `step === 'password'` form, between the password field `</div>` and the submit `<Button>`, insert:
```tsx
                <div className="space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <Checkbox checked={trustDevice} onCheckedChange={(v) => setTrustDevice(v === true)} />
                    <span className="text-xs text-muted-foreground">{t('login.trustDevice')}</span>
                  </label>
                  {trustDevice && (
                    <div className="flex items-start gap-2 text-[11px] text-muted-foreground bg-muted/40 rounded-md px-3 py-2">
                      <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>{t('login.trustDeviceInfo')}</span>
                    </div>
                  )}
                </div>
```

- [ ] **Step 6: Update the header title for the trusted step**

In the `<CardHeader>` title expression, replace:
```tsx
              {step === 'password' ? t('login.signInToContinue')
```
with:
```tsx
              {step === 'trusted' ? t('login.signInToContinue')
                : step === 'password' ? t('login.signInToContinue')
```

- [ ] **Step 7: Render the trusted step**

After the `{step === 'changePassword' && ( ... )}` block (before the closing `</CardContent>`), add:
```tsx
            {step === 'trusted' && (
              <div className="space-y-4">
                <Button onClick={handleTrustedContinue} className="w-full" disabled={busy}>
                  {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> {t('login.signingIn')}</> : t('login.continueAs', { name: trustedName })}
                </Button>
                <button
                  type="button"
                  onClick={() => setStep('password')}
                  className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('login.useAnotherAccount')}
                </button>
              </div>
            )}
```

- [ ] **Step 8: Type-check**

Run: `pnpm --filter @ts6/frontend exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Manual test**

Build/run the frontend. Verify: checking the box reveals the info note (try several languages via the LanguageSwitcher); logging in with the box checked, then reloading the app, shows the "Continue as X" screen.

- [ ] **Step 10: Commit**

```bash
git add packages/frontend/src/pages/Login.tsx
git commit -m "feat(login): trusted-device checkbox, info note, and auto-login step"
```

---

## Task 12: Account tab — trusted devices card

**Files:**
- Modify: `packages/frontend/src/pages/Settings.tsx`

- [ ] **Step 1: Confirm imports available**

`Settings.tsx` already imports `Card, CardContent, CardHeader, CardTitle`, `useMutation`, `useTranslation`, `toast`, `Button`. Add `useQuery` and `useQueryClient` to the existing `@tanstack/react-query` import. Run:
```bash
grep -n "@tanstack/react-query" packages/frontend/src/pages/Settings.tsx
```
Update that import line to include `useQuery, useQueryClient` alongside `useMutation`.

- [ ] **Step 2: Add the `TrustedDevicesCard` component**

In `Settings.tsx`, add a new component (place it right after the `AccountTab` function definition):
```tsx
function TrustedDevicesCard() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['trusted-devices'], queryFn: () => authApi.trustedList() });
  const devices: any[] = data?.devices ?? [];

  const fmt = (d: string) => new Date(d).toLocaleDateString(i18n.resolvedLanguage);

  const revoke = useMutation({
    mutationFn: (id: number) => authApi.trustedRevoke(id),
    onSuccess: () => { toast.success(t('settings.account.trustedDevices.revoked')); qc.invalidateQueries({ queryKey: ['trusted-devices'] }); },
    onError: () => toast.error(t('settings.account.trustedDevices.revokeError')),
  });
  const revokeAll = useMutation({
    mutationFn: () => authApi.trustedRevokeAll(),
    onSuccess: () => { toast.success(t('settings.account.trustedDevices.revokedAll')); qc.invalidateQueries({ queryKey: ['trusted-devices'] }); },
    onError: () => toast.error(t('settings.account.trustedDevices.revokeError')),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t('settings.account.trustedDevices.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('settings.account.trustedDevices.description')}</p>
        {devices.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('settings.account.trustedDevices.empty')}</p>
        ) : (
          <div className="space-y-2">
            {devices.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">
                    {d.userAgent || '—'}{d.current && <span className="ml-2 text-[10px] text-primary">({t('settings.account.trustedDevices.thisDevice')})</span>}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {t('settings.account.trustedDevices.added')}: {fmt(d.createdAt)} · {t('settings.account.trustedDevices.expires')}: {fmt(d.expiresAt)}
                    {d.ipAddress ? ` · ${d.ipAddress}` : ''}
                  </div>
                </div>
                <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(d.id)}>
                  {t('settings.account.trustedDevices.revoke')}
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" disabled={revokeAll.isPending} onClick={() => revokeAll.mutate()}>
              {t('settings.account.trustedDevices.revokeAll')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Render it in the Account tab**

In `AccountTab`'s returned JSX, replace:
```tsx
      <MfaCard />
    </div>
```
with:
```tsx
      <MfaCard />
      <TrustedDevicesCard />
    </div>
```

- [ ] **Step 4: Verify `Button` supports `variant`/`size`**

Run: `grep -n "variant\|size" packages/frontend/src/components/ui/button.tsx | head`
Expected: the Button component accepts `variant` and `size` props. If `size="sm"` is unavailable, drop the `size` prop.

- [ ] **Step 5: Type-check**

Run: `pnpm --filter @ts6/frontend exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/pages/Settings.tsx
git commit -m "feat(settings): trusted devices management card"
```

---

## Task 13: Backend integration test for trusted-device gating

Cover the security-critical gating logic with a focused unit test of `resolveTrustedCookie` plus the gating predicate, using a fake prisma.

**Files:**
- Create: `packages/backend/src/utils/trusted-device-service.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/backend/src/utils/trusted-device-service.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { resolveTrustedCookie } from './trusted-device-service.js';
import { mintTrustedToken } from './trusted-device.js';

function fakePrisma(device: any) {
  return {
    trustedDevice: {
      findUnique: vi.fn().mockResolvedValue(device),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

describe('resolveTrustedCookie', () => {
  it('returns null for a missing or malformed cookie', async () => {
    const prisma = fakePrisma(null);
    expect(await resolveTrustedCookie(prisma, undefined)).toBeNull();
    expect(await resolveTrustedCookie(prisma, 'malformed')).toBeNull();
  });

  it('returns the user for a valid, unexpired token', async () => {
    const { selector, verifier, cookieValue, verifierHash } = mintTrustedToken();
    const user = { id: 7, username: 'alice', enabled: true };
    const prisma = fakePrisma({
      id: 1, selector, verifierHash,
      expiresAt: new Date(Date.now() + 1000), user,
    });
    const result = await resolveTrustedCookie(prisma, cookieValue);
    expect(result).toEqual(user);
    expect(prisma.trustedDevice.update).toHaveBeenCalled(); // lastUsedAt bumped
  });

  it('rejects and deletes an expired token', async () => {
    const { cookieValue, selector, verifierHash } = mintTrustedToken();
    const prisma = fakePrisma({
      id: 2, selector, verifierHash,
      expiresAt: new Date(Date.now() - 1000), user: { id: 1 },
    });
    expect(await resolveTrustedCookie(prisma, cookieValue)).toBeNull();
    expect(prisma.trustedDevice.delete).toHaveBeenCalled();
  });

  it('rejects a tampered verifier', async () => {
    const { selector, verifierHash } = mintTrustedToken();
    const prisma = fakePrisma({
      id: 3, selector, verifierHash,
      expiresAt: new Date(Date.now() + 1000), user: { id: 1 },
    });
    const tampered = `${selector}.${'0'.repeat(64)}`;
    expect(await resolveTrustedCookie(prisma, tampered)).toBeNull();
    expect(prisma.trustedDevice.delete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test**

Run (from `packages/backend`): `pnpm vitest run src/utils/trusted-device-service.test.ts`
Expected: PASS (4 cases). Note `resolveTrustedCookie` imports only `config`/crypto-free helpers; if importing `config.js` triggers env loading in the test, the test still passes because `COOKIE_OPTS` isn't exercised here.

- [ ] **Step 3: Run the full backend test suite**

Run: `pnpm vitest run`
Expected: all tests pass (existing mfa tests + new trusted-device tests).

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/utils/trusted-device-service.test.ts
git commit -m "test(auth): trusted-device cookie resolution gating"
```

---

## Task 14: Full verification pass

- [ ] **Step 1: Backend type-check + tests**

Run:
```bash
pnpm --filter @ts6/backend exec tsc --noEmit && pnpm --filter @ts6/backend exec vitest run
```
Expected: no type errors, all tests pass.

- [ ] **Step 2: Frontend type-check + lint**

Run:
```bash
pnpm --filter @ts6/frontend exec tsc --noEmit && pnpm lint
```
Expected: no type errors, lint clean.

- [ ] **Step 3: End-to-end manual smoke**

With backend + frontend running:
1. Log in (no MFA user) with the box checked → lands on dashboard, `ts6_trusted` cookie present (DevTools → Application → Cookies).
2. Reload the app at `/login` → "Continue as X" appears → click → dashboard.
3. Settings → Account → Trusted devices: the device is listed with "This device". Revoke it.
4. Reload `/login` → no "Continue as X" (cookie gone).
5. Repeat with an MFA-enabled user: box checked, complete TOTP → reload → "Continue as X" skips both password and TOTP.
6. Change the password → confirm trusted devices are cleared and auto-login no longer offered.

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "chore(auth): trusted-device verification fixes"
```

---

## Notes / gotchas for the implementer

- **`req.cookies` requires `cookie-parser`** (Task 3). Without it, `req.cookies` is `undefined` and `req.cookies?.[...]` safely yields `undefined`.
- **Cookie `path` is `/api/auth`** — the cookie is only sent to auth routes, which is all we need (peek/session/list/revoke all live under `/api/auth`). Keep it consistent in set and clear (`COOKIE_OPTS`).
- **`secure` cookie in dev:** with `secure: true` the cookie won't be set over plain HTTP. The service ties `secure` to production only, so local HTTP dev works.
- **Same-origin:** frontend talks to `/api` (same origin via proxy), so cookies flow without CORS complications; `withCredentials` is set defensively.
- **Rate limiting:** `/api/auth/login` and `/api/auth/refresh` have a stricter limiter; `/trusted/*` falls under the global API limiter, which is fine.
