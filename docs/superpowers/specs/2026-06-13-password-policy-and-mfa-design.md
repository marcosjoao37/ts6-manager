# Configurable password policy + TOTP MFA — design

**Date:** 2026-06-13

## Part A — Configurable password policy

Two global settings stored as `AppSetting` key/value rows, editable by admins
in Settings → Users:

- `password.minLength` (int, default 12)
- `password.requireComplexity` ("true"/"false", default "true") — when on,
  require uppercase + lowercase + digit + special character.

`validatePassword(password, policy)` becomes policy-driven: minimum length is
always enforced; the four character-class checks run only when complexity is
required. `loadPasswordPolicy(prisma)` reads the two keys with defaults.

Enforced at the three existing entry points, all already calling
`validatePassword`: setup (first admin), users create/edit (admin "reset"),
auth change-password. New admin routes `GET/PUT /api/users/password-policy`.

UI: a "Password policy" card in the Users tab — min-length number field and a
"Require strong passwords (uppercase, lowercase, digit, special char)"
checkbox.

## Part B — TOTP MFA (self-enroll + admin, with recovery codes)

New `User` fields: `mfaEnabled` (bool, default false), `mfaSecret` (encrypted
TOTP secret, nullable), `mfaPendingSecret` (encrypted, during enrollment),
`mfaRecoveryCodes` (encrypted JSON of hashed one-time codes, nullable),
`mfaRequired` (bool, default false — admin-forced).

Libraries: `otplib` (TOTP) + `qrcode` (data-URL QR). Secret and recovery
codes encrypted with the existing AES-256-GCM helper; recovery codes hashed
(sha256) and removed on use.

### Self-enrollment (Account tab)
- `POST /api/auth/mfa/setup` → generate secret, store as pending, return
  otpauth URL + QR data URL.
- `POST /api/auth/mfa/enable { code }` → verify code against pending secret →
  set mfaEnabled, move pending→secret, generate + return 10 recovery codes
  (shown once).
- `POST /api/auth/mfa/disable { password }` → verify password → clear MFA.

### Admin (Users → Edit)
- "Require MFA" toggle → sets `mfaRequired`.
- "Reset MFA" → clears mfaEnabled/secret/recovery (lost device). If
  mfaRequired stays set, the user must re-enroll at next login.
- The secret is never exposed to the admin.

### Login flow
- `POST /api/auth/login` (username+password):
  - mfaEnabled → return `{ mfaRequired: true, mfaToken }` (short-lived ~5min
    signed challenge token, not an access token).
  - mfaRequired && !mfaEnabled → return `{ mfaSetupRequired: true, mfaToken }`.
  - else → issue access+refresh tokens as today.
- `POST /api/auth/login/mfa { mfaToken, code }` → verify TOTP (window ±1) or a
  recovery code → issue tokens. Recovery code consumed on use.
- During forced setup, the mfaToken authorizes the setup/enable calls, then a
  normal login completes.

## Error handling

- Invalid/expired mfaToken → 401, restart login.
- Wrong TOTP/recovery code → 401 with attempts left to the message; auth rate
  limiter already covers brute force.
- Policy load failure → fall back to defaults (min 12, complexity on).

## Testing

- Unit: `validatePassword` across policy combinations; recovery-code
  hashing/consumption; TOTP verify wrapper.
- Manual: full login-with-MFA, enrollment, admin require/reset, recovery-code
  login.

## Implementation order

1. Part A (password policy) — one commit.
2. Part B (TOTP MFA) — one commit.
