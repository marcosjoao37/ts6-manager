# Per-user multi-language (i18n) — design

**Date:** 2026-06-13
Sub-project C of the (journal → Discord flow nodes → i18n) split.

Per-user UI language among English, French, German, Spanish, Italian, with
English fallback for any untranslated string.

## Stack & resolution

react-i18next + i18next + i18next-browser-languagedetector. Resolution: the
user's saved language (from their account) → browser language among the five
→ fallback `en`. Missing keys fall back to English, so pages not yet migrated
keep working unchanged.

## Per-user persistence

- `User.language` (nullable string).
- `/auth/me` returns it; `PUT /api/auth/language { language }` (authenticated)
  persists it after validating against the supported set.
- On login/me, apply the saved language. The switcher (header / Account)
  calls `changeLanguage`, writes `localStorage` (so the login screen honors
  it pre-auth), and PUTs to the API.

## Translation files

`src/frontend/src/i18n/locales/{en,fr,de,es,it}.json`, nested keys grouped by
area (`common.*`, `nav.*`, `login.*`, `setup.*`, `dashboard.*`,
`settings.*`). `src/i18n/index.ts` configures i18next (resources, fallbackLng
`en`, detection order [localStorage, navigator]); imported from `main.tsx`.

## Scope translated this pass (all 5 languages)

App shell: sidebar nav + section labels, header, login + setup, Dashboard,
the Settings chrome (tab labels, card titles, common Save/Cancel/Delete) with
the Account tab fully translated, and shared components (PageLoader,
ConfirmDialog, EmptyState). Remaining deep pages stay English via fallback,
migrated in later waves.

## Selector

A flag switcher in the header (🇬🇧 🇫🇷 🇩🇪 🇪🇸 🇮🇹) plus a setting in
Settings → Account. Hot switch, no reload.

## Backend

Unchanged except `User.language` and the persistence route; API error
messages stay English (few, technical).

## Testing

i18n config sanity (5 resources load, fallback `en`) and a key-parity check:
every key used by the migrated shell exists in all five locale files.
